import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Loader, Check, X, RefreshCw, AlertTriangle, ExternalLink, FlaskConical, DollarSign, Settings as Cog, Image as ImageIcon, Store } from 'lucide-react';
import { supabase, apiFetch } from './lib/supabase.js';
import { resizeForUpload } from './lib/image.js';
import CropImg from './lib/CropImg.jsx';
import { buildTitle, buildDescription, summarizeTrial, REVIEW_LABELS, SNAP_DEFAULTS, MAX_LISTING_PHOTOS, listingPhotoPaths, GAME_LABELS, liveChanges, isSoldOut } from '../netlify/lib/snap-logic.js';
import { allRows } from '../netlify/lib/db-pages.js';
import { MODEL_LABELS, MODEL_PRICES, monthStart } from '../netlify/lib/ai-usage.js';
import { splitCost } from '../netlify/lib/cost-split.js';
import { askConfirm, askValue, askChoice } from './lib/dialog.jsx';
import { chipsFor, saleSentence, currentListings } from '../netlify/lib/marketplace-text.js';
import { CONDITION_LABELS as WN_CONDITIONS } from '../netlify/lib/marketplaces/whatnot-info.js';
import { PhotoStrip, PhotoEditor } from './PhotoEditor.jsx';

const money = (n, d = 2) => (n == null || !Number.isFinite(Number(n)) ? '—' : `$${Number(n).toFixed(d)}`);
const fee = (n) => (n == null ? '—' : Number(n) < 0.01 ? `$${Number(n).toFixed(4)}` : `$${Number(n).toFixed(2)}`);
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
const OPEN = ['uploaded', 'identifying', 'ready', 'needs_review', 'failed', 'approved', 'listed'];
const DONE = ['approved', 'listed'];
// The model trial compares each model alone and the Haiku-first routing.
const ARM_LABELS = { ...MODEL_LABELS, auto: 'Auto: Haiku, Opus when needed' };
const ROUTE_REASONS = { not_a_card: 'not sure it was a card', low_confidence: 'unsure of the card', not_english: 'not in English', no_catalog_match: 'no catalog match', other_game: 'other game' };
// Editing any of these after the eBay check means the check no longer describes the listing.
const LISTING_FIELDS = ['photo_path', 'title', 'price', 'quantity', 'condition', 'finish', 'card_name', 'catalog_set', 'catalog_number', 'misprint_confirmed', 'extra_photo_paths', 'game', 'rarity', 'extraction', 'description'];
const FINISHES = [['normal', 'Normal'], ['holo', 'Holo'], ['reverse_holo', 'Reverse holo'], ['foil', 'Foil'], ['unknown', 'Unknown']];
const CONDS = ['NM', 'LP', 'MP', 'HP', 'DMG'];
// The card's top-left word. A card that sold out, or whose eBay listing we took down, no longer says ON EBAY.
function cardHeader(it, listings = []) {
  if (DONE.includes(it.status) && isSoldOut(it)) return ['SOLD', 'var(--good)'];
  const eb = currentListings(listings).find((l) => l.marketplace === 'ebay');
  if (it.status === 'listed' && eb?.status === 'sold') return ['SOLD ON EBAY', 'var(--good)'];
  if (it.status === 'listed' && eb?.status === 'ended' && ['seller', 'sold_elsewhere', 'sold_out'].includes(eb.ended_reason)) return ['ENDED ON EBAY', 'var(--ink-dim)'];
  return STATUS[it.status] || [it.status, 'var(--ink-dim)'];
}
const STATUS = {
  uploaded: ['QUEUED', 'var(--ink-dim)'], identifying: ['READING…', 'var(--warn)'], ready: ['READY', 'var(--good)'],
  needs_review: ['CHECK', 'var(--warn)'], failed: ['FAILED', 'var(--bad)'], approved: ['APPROVED', 'var(--info)'], listed: ['ON EBAY', 'var(--good)'],
};

async function postJson(path, body) {
  const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// Runs async jobs a few at a time.
function useQueue(concurrency = 2) {
  const q = useRef([]);
  const running = useRef(0);
  const pump = useCallback(() => {
    while (running.current < concurrency && q.current.length) {
      const job = q.current.shift();
      running.current += 1;
      job().finally(() => { running.current -= 1; pump(); });
    }
  }, [concurrency]);
  return useCallback((job) => { q.current.push(job); pump(); }, [pump]);
}

export default function SnapTab({ userId, settings, setSettings }) {
  const s = { ...SNAP_DEFAULTS, ...settings };
  const [panel, setPanel] = useState('queue');
  const [items, setItems] = useState([]);
  const [photoUrls, setPhotoUrls] = useState({});
  const [filter, setFilter] = useState('open');
  const [msg, setMsg] = useState(null);
  const [uploading, setUploading] = useState(0);
  const [usage, setUsage] = useState({ month: [], allTime: 0 });
  const fileInput = useRef(null);
  const enqueue = useQueue(2);
  const budgetHit = useRef(false);

  const loadItems = useCallback(async () => {
    const { data, error } = await supabase.from('snap_items').select('*').in('status', OPEN).order('created_at', { ascending: false }).limit(1500);
    if (error) { setMsg({ type: 'error', text: `Couldn't load the queue: ${error.message}` }); return; }
    setItems(data || []);
  }, []);

  const loadUsage = useCallback(async () => {
    const [m, all] = await Promise.all([
      supabase.from('api_usage').select('created_at, model, purpose, cost_usd, input_tokens, output_tokens, latency_ms, ok, error')
        .gte('created_at', monthStart()).order('created_at', { ascending: false }).limit(5000),
      supabase.from('api_usage').select('cost_usd').limit(100000),
    ]);
    setUsage({ month: m.data || [], allTime: (all.data || []).reduce((t, r) => t + Number(r.cost_usd || 0), 0) });
  }, []);

  // ---------- other marketplaces (Whatnot): where each card is listed, and the connection ----------
  const [mp, setMp] = useState({ listings: [], whatnot: null });
  const loadMarketplaces = useCallback(async () => {
    // Quietly empty when the tables aren't there yet or nothing is connected: the card looks as before.
    const [rows, acct] = await Promise.all([
      // Paged: Supabase returns at most 1,000 rows a request, and a volume seller has more eBay rows.
      allRows(() => supabase.from('marketplace_listings').select('*').order('created_at', { ascending: false }).order('id')).catch(() => []),
      apiFetch('/api/marketplaces').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    setMp({ listings: rows, whatnot: acct?.marketplaces?.find((m) => m.marketplace === 'whatnot' && m.connected) || null });
  }, []);
  useEffect(() => { loadItems(); loadUsage(); loadMarketplaces(); }, [loadItems, loadUsage, loadMarketplaces]);
  const listingsByCard = useMemo(() => {
    const m = new Map();
    for (const l of mp.listings) if (l.snap_item_id) m.set(l.snap_item_id, [...(m.get(l.snap_item_id) || []), l]);
    return m;
  }, [mp.listings]);
  const liveOn = (it, market) => (listingsByCard.get(it.id) || []).find((l) => l.marketplace === market && ['active', 'ending'].includes(l.status));
  const whatnotOn = !!mp.whatnot;
  // Games Whatnot can take a listing for yet (Whatnot needs a card category per game).
  const whatnotReady = (it) => (mp.whatnot?.readyGames || []).includes(it.game);
  const putListing = (l) => setMp((x) => ({ ...x, listings: [l, ...x.listings.filter((y) => y.id !== l.id)] }));


  const patchLocal = (id, patch) => setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...patch } : x)));

  const identify = useCallback((id) => {
    patchLocal(id, { status: 'identifying', error: null });
    enqueue(async () => {
      if (budgetHit.current) { patchLocal(id, { status: 'uploaded' }); return; }
      const r = await postJson('/api/snap-identify', { id }).catch((e) => ({ ok: false, data: { error: e.message } }));
      if (r.ok) {
        patchLocal(id, r.data.item);
      } else {
        if (r.status === 429) budgetHit.current = true;
        patchLocal(id, { status: r.status === 429 ? 'uploaded' : 'failed', error: r.data.error || `Failed (${r.status})` });
        setMsg({ type: 'error', text: r.data.error || `Identify failed (${r.status})` });
      }
      loadUsage();
    });
  }, [enqueue, loadUsage]);

  async function addPhotos(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    budgetHit.current = false;
    setMsg(null);
    const batch = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
    setUploading((n) => n + files.length);
    for (const file of files) {
      try {
        const blob = await resizeForUpload(file);
        const id = crypto.randomUUID();
        const path = `${userId}/${batch}/${id}.jpg`;
        const up = await supabase.storage.from('snap-photos').upload(path, blob, { contentType: 'image/jpeg' });
        if (up.error) throw new Error(up.error.message);
        const row = { id, user_id: userId, batch_id: batch, photo_path: path, status: 'uploaded' };
        const ins = await supabase.from('snap_items').insert(row);
        if (ins.error) throw new Error(ins.error.message);
        setPhotoUrls((u) => ({ ...u, [path]: URL.createObjectURL(blob) }));
        setItems((xs) => [{ ...row, created_at: new Date().toISOString(), review_reasons: [] }, ...xs]);
        identify(id);
      } catch (e) {
        setMsg({ type: 'error', text: `Upload failed for ${file.name}: ${e.message}` });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function save(id, patch) {
    const cur = items.find((x) => x.id === id);
    if (cur && ['checked', 'check_failed'].includes(cur.publish_state) && Object.keys(patch).some((k) => LISTING_FIELDS.includes(k) && patch[k] !== cur[k])) {
      patch = { ...patch, publish_state: null, publish_check: null };
    }
    patchLocal(id, patch);
    const { error } = await supabase.from('snap_items').update(patch).eq('id', id);
    if (error) setMsg({ type: 'error', text: `Couldn't save: ${error.message}` });
  }

  async function approve(item) {
    if (!(Number(item.price) > 0) || !item.title) { setMsg({ type: 'error', text: 'Set a price and title before approving.' }); return; }
    // Save what's on screen with the approval, in case a field was still being edited.
    await save(item.id, { status: 'approved', price: Number(item.price), title: item.title });
  }

  async function approveAllReady() {
    const ready = items.filter((i) => i.status === 'ready' && Number(i.price) > 0 && i.title);
    if (!ready.length) return;
    const ids = ready.map((i) => i.id);
    setItems((xs) => xs.map((x) => (ids.includes(x.id) ? { ...x, status: 'approved' } : x)));
    const { error } = await supabase.from('snap_items').update({ status: 'approved' }).in('id', ids);
    setMsg(error ? { type: 'error', text: error.message } : { type: 'ok', text: `Approved ${ids.length} card${ids.length === 1 ? '' : 's'}. Open "Approved" to check and publish them on eBay.` });
  }

  // ---------- eBay: extra photos, free check, publish ----------
  // The first photo identifies the card and leads the listing; these go on eBay after it, in order.
  const extrasOf = (item) => listingPhotoPaths(item).filter((p) => p !== item.photo_path);
  async function addExtraPhotos(item, fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('image/'));
    const room = MAX_LISTING_PHOTOS - listingPhotoPaths(item).length;
    if (!files.length) return;
    if (room <= 0) { setMsg({ type: 'error', text: `A listing can have up to ${MAX_LISTING_PHOTOS} photos.` }); return; }
    const added = [];
    try {
      for (const file of files.slice(0, room)) {
        const blob = await resizeForUpload(file);
        const path = `${userId}/${item.batch_id || 'snap'}/${item.id}-x-${crypto.randomUUID().slice(0, 8)}.jpg`;
        const up = await supabase.storage.from('snap-photos').upload(path, blob, { contentType: 'image/jpeg' });
        if (up.error) throw new Error(up.error.message);
        setPhotoUrls((u) => ({ ...u, [path]: URL.createObjectURL(blob) }));
        added.push(path);
      }
    } catch (e) { setMsg({ type: 'error', text: `Photo failed: ${e.message}` }); }
    if (added.length) await save(item.id, { extra_photo_paths: [...extrasOf(item), ...added], back_photo_path: null, ebay_picture_urls: null });
    if (files.length > room) setMsg({ type: 'error', text: `Added ${added.length} of ${files.length}: a listing can have up to ${MAX_LISTING_PHOTOS} photos.` });
    // Straighten the new photos too. Close-ups with no whole card in them are simply left as they are.
    if (s.snapAutoCrop !== false && added.length) await autoFixPhotos(item, added, { quiet: true });
  }

  // The AI straightens each photo in turn. Photos without one whole card in them (close-ups) are left as they are.
  async function autoFixPhotos(item, paths, { quiet = false } = {}) {
    let fixed = 0, noCard = 0;
    for (const [n, path] of paths.entries()) {
      setPhotoBusy((b) => ({ ...b, [item.id]: paths.length > 1 ? `Straightening ${n + 1} of ${paths.length}…` : 'Straightening…' }));
      const r = await postJson('/api/snap-photos', { id: item.id, action: 'autocrop', path }).catch((e) => ({ ok: false, data: { error: e.message } }));
      if (r.ok) { fixed += 1; patchLocal(item.id, r.data.item); continue; }
      if (r.status === 422) { noCard += 1; continue; }
      setMsg({ type: 'error', text: r.data.error || `Auto-fix failed (${r.status})` });
      break;
    }
    setPhotoBusy((b) => { const x = { ...b }; delete x[item.id]; return x; });
    loadUsage();
    if (!quiet && fixed + noCard > 0) setMsg({ type: 'ok', text: `Straightened ${fixed} photo${fixed === 1 ? '' : 's'}.${noCard ? ` ${noCard} didn't show one whole card (a close-up?) and ${noCard === 1 ? 'was' : 'were'} left as ${noCard === 1 ? 'it was' : 'they were'}; use Straighten & crop to do ${noCard === 1 ? 'it' : 'them'} by hand.` : ''}` });
  }

  // ---------- photo edits: straighten & crop, undo, order, remove (server keeps the originals) ----------
  const [photoBusy, setPhotoBusy] = useState({});   // card id -> what's happening
  const [editing, setEditing] = useState(null);      // { id, path }
  async function photoCall(item, body, label, { quiet = false, raise = false } = {}) {
    setPhotoBusy((b) => ({ ...b, [item.id]: label }));
    const r = await postJson('/api/snap-photos', { id: item.id, ...body }).catch((e) => ({ ok: false, data: { error: e.message } }));
    setPhotoBusy((b) => { const n = { ...b }; delete n[item.id]; return n; });
    if (r.ok) { patchLocal(item.id, r.data.item); if (body.action === 'autocrop') loadUsage(); return r.data.item; }
    const text = r.data.error || `Photo change failed (${r.status})`;
    if (raise) throw new Error(text);
    if (!(quiet && r.status === 422)) setMsg({ type: 'error', text });
    return null;
  }
  const photoHandlers = (it) => ({
    onOrder: (paths) => photoCall(it, { action: 'order', paths }, 'Saving…'),
    onAuto: (path) => photoCall(it, { action: 'autocrop', path }, 'Straightening…'),
    onAutoAll: (paths) => autoFixPhotos(it, paths),
    onUndo: (path) => photoCall(it, { action: 'undo', path }, 'Undoing…'),
    onEdit: (path) => setEditing({ id: it.id, path }),
  });
  async function sendChangesToEbay(item) {
    const ch = liveChanges(item);
    if (!ch.length) return;
    const n = listingPhotoPaths(item).length;
    const lines = [
      ch.includes('photos') && `Photos: replaced with these ${n} photo${n === 1 ? '' : 's'}.`,
      ch.includes('title') && `Title: "${item.title}"`,
      ch.includes('description') && `Description: replaced with the text on this card.${item.imported_from_ebay_at ? ' The old listing\'s layout and styling are not kept.' : ''}`,
    ].filter(Boolean);
    if (!(await askConfirm(`Update your live eBay listing #${item.ebay_item_id}?\n\n${lines.join('\n')}\n\nBuyers see the changes right away. Price and everything else stay the same.`,
      { title: 'Update on eBay', confirmLabel: 'Update on eBay' }))) return;
    const done = await photoCall(item, { action: 'update_ebay' }, 'Sending to eBay…');
    if (done) setMsg({ type: 'ok', text: `eBay listing #${item.ebay_item_id} updated: ${ch.join(', ')}.` });
  }

  // Cards from a buy-offer binder page start with only part of the page photo; this swaps in a real one.
  async function replacePhoto(item, file) {
    try {
      const blob = await resizeForUpload(file);
      const path = `${userId}/${item.batch_id || 'snap'}/${item.id}-front-${Date.now()}.jpg`;
      const up = await supabase.storage.from('snap-photos').upload(path, blob, { contentType: 'image/jpeg' });
      if (up.error) throw new Error(up.error.message);
      setPhotoUrls((u) => ({ ...u, [path]: URL.createObjectURL(blob) }));
      const reasons = (item.review_reasons || []).filter((r) => r !== 'page_photo');
      await save(item.id, { photo_path: path, photo_crop: null, review_reasons: reasons, ebay_picture_urls: null, publish_state: null, publish_check: null,
        ...(item.status === 'needs_review' && !reasons.length ? { status: 'ready' } : {}) });
    } catch (e) { setMsg({ type: 'error', text: `Photo failed: ${e.message}` }); }
  }

  const [ebayBusy, setEbayBusy] = useState(null); // { label, done, total }
  async function ebayLoop(label, list, action) {
    setEbayBusy({ label, done: 0, total: list.length }); setMsg(null);
    let ok = 0; const problems = []; const promoProblems = [];
    for (const [n, it] of list.entries()) {
      patchLocal(it.id, { publish_state: action === 'check' ? 'checking' : 'publishing' });
      const r = await postJson('/api/snap-publish', { action, id: it.id }).catch((e) => ({ ok: false, data: { error: e.message } }));
      if (r.ok && action === 'check') {
        // The request worked; whether eBay would accept the listing is in the check itself.
        patchLocal(it.id, r.data.item);
        if (r.data.item?.publish_check?.ok) ok += 1;
        else problems.push(`${it.title || it.card_name}: ${(r.data.item?.publish_check?.errors || ['eBay check failed'])[0]}`);
      } else if (r.ok) {
        ok += 1;
        patchLocal(it.id, { status: 'listed', publish_state: 'listed', ebay_item_id: r.data.result.itemId, ebay_url: r.data.result.url,
          promoted_at: r.data.result.promoted ? new Date().toISOString() : null, promo_error: r.data.result.promoError || null });
        if (r.data.result.promoError) promoProblems.push(r.data.result.promoError);
      } else {
        problems.push(`${it.title || it.card_name}: ${r.data.error || r.status}`);
        patchLocal(it.id, { publish_state: action === 'check' ? 'check_failed' : 'failed', publish_error: r.data.error });
        if (r.status === 409 && /learn your listing setup|connect your ebay/i.test(r.data.error || '')) { setMsg({ type: 'error', text: r.data.error }); break; }
      }
      setEbayBusy({ label, done: n + 1, total: list.length });
    }
    setEbayBusy(null);
    await loadItems();
    return { ok, problems, promoProblems };
  }

  async function checkApproved() {
    const list = items.filter((i) => i.status === 'approved' && i.publish_state !== 'checked' && !isSoldOut(i));
    const { ok, problems } = await ebayLoop('Checking with eBay', list, 'check');
    setMsg(problems.length ? { type: 'error', text: `${ok} passed, ${problems.length} need fixing: ${problems.slice(0, 3).join(' | ')}` } : { type: 'ok', text: `All ${ok} passed eBay's check. Nothing is listed yet.` });
  }

  async function publishChecked() {
    const list = items.filter((i) => i.status === 'approved' && i.publish_state === 'checked' && i.publish_check?.ok && !isSoldOut(i));
    if (!list.length) return;
    const fees = list.reduce((t, i) => t + Number(i.publish_check?.fees?.total || 0), 0);
    const value = list.reduce((t, i) => t + Number(i.price || 0), 0);
    if (!(await askConfirm(`Publish ${list.length} listing${list.length === 1 ? '' : 's'} on eBay now?\n\nTotal list price: $${value.toFixed(2)}\nListing fees from eBay's check: $${fees.toFixed(2)}\n\nThey go live immediately as Buy It Now (Good 'Til Cancelled).`,
      { title: 'Publish to eBay', confirmLabel: `Publish ${list.length} to eBay` }))) return;
    const { ok, problems, promoProblems } = await ebayLoop('Publishing to eBay', list, 'publish');
    setMsg(problems.length ? { type: 'error', text: `${ok} listed, ${problems.length} failed: ${problems.slice(0, 3).join(' | ')}` } : { type: 'ok', text: `${ok} card${ok === 1 ? '' : 's'} listed on eBay and added to inventory with their cost.${promoProblems.length ? ` Not promoted: ${[...new Set(promoProblems)][0]}` : ''}` });
  }

  // ---------- Whatnot: list, change, end ----------
  const photoCount = (it) => Math.max(listingPhotoPaths(it).length, (it.ebay_picture_urls || []).length);
  const parseMoney = (raw) => Number(String(raw ?? '').replace(/[$,]/g, '').trim());
  async function createOnWhatnot(it, price) {
    const r = await postJson('/api/marketplace-listings', { action: 'create', marketplace: 'whatnot', snapItemId: it.id, price, quantity: Number(it.quantity) || 1 })
      .catch((e) => ({ ok: false, data: { error: e.message } }));
    if (r.ok) putListing(r.data.listing);
    return r;
  }
  async function listOnWhatnot(it) {
    const raw = await askValue('Whatnot price ($)', { title: 'Whatnot price', confirmLabel: 'Next', inputMode: 'decimal', initial: Number(it.price || 0).toFixed(2) });
    if (raw == null) return;
    const price = parseMoney(raw);
    if (!(price >= 1)) { setMsg({ type: 'error', text: 'Enter a Whatnot price of at least $1.00, e.g. 12.50' }); return; }
    const n = photoCount(it); const q = Number(it.quantity) || 1;
    if (!(await askConfirm(`List on Whatnot now?\n\n${it.title} · ${money(price)} · Qty ${q} · ${WN_CONDITIONS[it.condition] || 'Near Mint'} · ${n} photo${n === 1 ? '' : 's'}\n\nIt goes live in your Whatnot shop as Buy It Now right away.`,
      { title: 'List on Whatnot', confirmLabel: 'List on Whatnot' }))) return;
    setEbayBusy({ label: 'Listing on Whatnot', done: 0, total: 1 });
    const r = await createOnWhatnot(it, price);
    setEbayBusy(null);
    if (r.ok) setMsg({ type: 'ok', text: 'Listed on Whatnot.' });
    else { setMsg({ type: 'error', text: r.data.error || `Whatnot listing failed (${r.status})` }); loadMarketplaces(); }
  }
  async function listAllOnWhatnot(list) {
    if (!list.length) return;
    const total = list.reduce((t, i) => t + Number(i.price || 0), 0);
    if (!(await askConfirm(`List ${list.length} card${list.length === 1 ? '' : 's'} on Whatnot now?\n\nTotal price: ${money(total)} (each at its card price)\n\nThey go live in your Whatnot shop as Buy It Now right away.`,
      { title: 'List on Whatnot', confirmLabel: `List ${list.length} on Whatnot` }))) return;
    setEbayBusy({ label: 'Listing on Whatnot', done: 0, total: list.length }); setMsg(null);
    let ok = 0; const problems = [];
    for (const [n, it] of list.entries()) {
      const r = await createOnWhatnot(it, Number(it.price));
      if (r.ok) ok += 1; else {
        problems.push(`${it.title || it.card_name}: ${r.data.error || r.status}`);
        if (r.status === 402 || r.data.code === 'reconnect' || r.data.code === 'not_set_up') break;
      }
      setEbayBusy({ label: 'Listing on Whatnot', done: n + 1, total: list.length });
    }
    setEbayBusy(null);
    await loadMarketplaces();
    setMsg(problems.length ? { type: 'error', text: `${ok} listed on Whatnot, ${problems.length} didn't: ${problems.slice(0, 3).join(' | ')}` } : { type: 'ok', text: `${ok} card${ok === 1 ? '' : 's'} listed on Whatnot.` });
  }
  async function listingCall(body, okText) {
    const r = await postJson('/api/marketplace-listings', body).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (r.ok) { if (r.data.listing) putListing(r.data.listing); setMsg({ type: 'ok', text: okText }); } else setMsg({ type: 'error', text: r.data.error || `Failed (${r.status})` });
    return r;
  }
  async function endListing(it, l) {
    const where = l.marketplace === 'ebay' ? 'eBay' : 'Whatnot';
    if (!(await askConfirm(l.marketplace === 'whatnot' ? 'Take this card down from your Whatnot shop?' : `End your eBay listing #${l.external_id}?`, { title: `End on ${where}`, confirmLabel: `End on ${where}`, danger: true }))) return;
    const r = await listingCall({ action: 'end', listingId: l.id }, `Ended on ${where}.`);
    if (r.ok) { await loadItems(); await loadMarketplaces(); }
  }
  async function onChip(it, l) {
    if (l.marketplace !== 'whatnot' || !['active', 'ending'].includes(l.status)) { if (l.url) window.open(l.url, '_blank', 'noopener'); return; }
    const pick = await askChoice(`${it.title}\nOn Whatnot at ${money(l.price)}, ${l.quantity ?? 1} available.`,
      [{ value: 'end', label: 'End on Whatnot' }, ...(l.url ? [{ value: 'open', label: 'Open on Whatnot' }] : []), { value: 'qty', label: 'Change quantity' }, { value: 'price', label: 'Change price' }], { title: 'Whatnot listing' });
    if (pick === 'open') window.open(l.url, '_blank', 'noopener');
    if (pick === 'end') await endListing(it, l);
    if (pick === 'qty') await changeQuantity(it, null);
    if (pick === 'price') {
      const raw = await askValue('New Whatnot price ($)', { title: 'Change price', confirmLabel: 'Next', inputMode: 'decimal', initial: Number(l.price || 0).toFixed(2) });
      if (raw == null) return;
      const price = parseMoney(raw);
      if (!(price >= 1)) { setMsg({ type: 'error', text: 'Enter a Whatnot price of at least $1.00.' }); return; }
      if (!(await askConfirm(`Change the Whatnot price to ${money(price)}?\n\nBuyers see it right away. Your eBay price stays the same.`, { title: 'Change price', confirmLabel: 'Change on Whatnot' }))) return;
      await listingCall({ action: 'update', listingId: l.id, price }, `Whatnot price is now ${money(price)}.`);
    }
  }
  // The card's stock. With live listings it is pushed to every one of them after a yes.
  async function changeQuantity(it, value) {
    let q = value;
    if (q == null) {
      const raw = await askValue('How many of this card do you have?', { title: 'Change quantity', confirmLabel: 'Next', inputMode: 'numeric', initial: String(it.quantity ?? 1) });
      if (raw == null) return false;
      q = Number(String(raw).trim());
    }
    if (!Number.isInteger(q) || q < 1 || q > 999) { setMsg({ type: 'error', text: 'Enter a whole number from 1 to 999. To stop selling, end the listing.' }); return false; }
    const live = (listingsByCard.get(it.id) || []).filter((l) => l.status === 'active');
    if (!live.length) { await save(it.id, { quantity: q }); return true; }
    const where = [...new Set(live.map((l) => (l.marketplace === 'ebay' ? 'eBay' : 'Whatnot')))].join(' and ');
    if (!(await askConfirm(`Change stock to ${q} on ${where}?`, { title: 'Change quantity', confirmLabel: `Change on ${where}` }))) return false;
    const r = await postJson('/api/marketplace-listings', { action: 'stock', snapItemId: it.id, quantity: q }).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (!r.ok) { setMsg({ type: 'error', text: r.data.error || `Failed (${r.status})` }); return false; }
    patchLocal(it.id, { quantity: q, sold_out_at: null });
    const bad = r.data.results.filter((x) => !x.ok);
    setMsg(bad.length ? { type: 'error', text: `Stock is ${q}, but ${bad.map((b) => `${b.marketplace === 'ebay' ? 'eBay' : 'Whatnot'} didn't change: ${b.error}`).join(' | ')}` } : { type: 'ok', text: `Stock is ${q} on ${where}.` });
    await loadMarketplaces();
    return true;
  }

  // One order's total (cards + shipping + tax) split across the cards on screen by market value.
  async function batchPurchase() {
    const cards = visible.filter((i) => !['uploaded', 'identifying'].includes(i.status));
    if (!cards.length) return;
    const raw = await askValue(`Total you paid for these ${cards.length} cards, including shipping and tax ($):`, { title: 'Purchase cost', confirmLabel: 'Split the cost', placeholder: 'e.g. 24.50', inputMode: 'decimal' });
    if (raw == null) return;
    const total = Number(String(raw).replace(/[$,]/g, '').trim());
    if (!Number.isFinite(total) || total < 0) { setMsg({ type: 'error', text: 'Enter a dollar amount, e.g. 24.50' }); return; }
    const purchaseId = crypto.randomUUID();
    const p = await supabase.from('purchases').insert({ id: purchaseId, user_id: userId, total_paid: total, split_method: 'market', source: 'Snap to List batch' });
    if (p.error) { setMsg({ type: 'error', text: p.error.message }); return; }
    const split = splitCost(total, cards.map((c) => ({ id: c.id, weight: c.market_price ?? c.price })));
    for (const [id, cost] of split) await save(id, { cost_basis: cost, cost_source: 'purchase', purchase_id: purchaseId });
    setMsg({ type: 'ok', text: `Split $${total.toFixed(2)} across ${cards.length} cards by market value.` });
  }

  async function discard(item) {
    setItems((xs) => xs.filter((x) => x.id !== item.id));
    const { error } = await supabase.from('snap_items').update({ status: 'discarded' }).eq('id', item.id);
    if (error) { setMsg({ type: 'error', text: error.message }); loadItems(); }
  }

  // A card that has sold out (on any marketplace) moves from Approved / On eBay to Sold.
  const group = (i) => (DONE.includes(i.status) && isSoldOut(i) ? 'sold' : i.status);
  const counts = useMemo(() => Object.fromEntries([...OPEN, 'sold'].map((st) => [st, items.filter((i) => group(i) === st).length])), [items]); // eslint-disable-line react-hooks/exhaustive-deps
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState(24);
  useEffect(() => { setPageSize(24); }, [filter, search]);
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matching = items.filter((i) => (filter === 'open' ? !DONE.includes(i.status) : filter === 'changed' ? liveChanges(i).length > 0 : filter === 'whatnot' ? !!liveOn(i, 'whatnot') : group(i) === filter)
    && words.every((w) => `${i.title || ''} ${i.card_name || ''} ${i.ebay_item_id || ''} ${i.sku || ''}`.toLowerCase().includes(w)));
  const visible = matching.slice(0, pageSize);
  const changedCount = useMemo(() => items.filter((i) => liveChanges(i).length > 0).length, [items]);
  const whatnotCount = items.filter((i) => liveOn(i, 'whatnot')).length;
  const toWhatnot = whatnotOn && ['approved', 'listed'].includes(filter)
    ? matching.filter((i) => DONE.includes(i.status) && !liveOn(i, 'whatnot') && !(listingsByCard.get(i.id) || []).some((l) => l.marketplace === 'whatnot' && l.status === 'creating') && !isSoldOut(i) && whatnotReady(i) && Number(i.price) >= 1 && !i.photo_crop) : [];
  const wnReconnect = mp.whatnot?.status === 'reconnect' && mp.listings.some((l) => l.marketplace === 'whatnot' && l.status === 'active');

  // Signed links for the photos of the cards on screen (valid for an hour).
  const visibleKey = visible.map((i) => listingPhotoPaths(i).join(',')).join('|');
  useEffect(() => {
    const need = [...new Set(visible.flatMap(listingPhotoPaths))].filter((p) => !photoUrls[p]);
    if (!need.length) return;
    supabase.storage.from('snap-photos').createSignedUrls(need, 3600).then(({ data }) => {
      if (data) setPhotoUrls((u) => ({ ...u, ...Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl])) }));
    });
  }, [visibleKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // A card that sold out on another marketplace is never checked or published to eBay again.
  const toCheck = items.filter((i) => i.status === 'approved' && i.publish_state !== 'checked' && !isSoldOut(i)).length;
  const toPublish = items.filter((i) => i.status === 'approved' && i.publish_state === 'checked' && i.publish_check?.ok && !isSoldOut(i)).length;
  const monthSpend = usage.month.reduce((t, r) => t + Number(r.cost_usd || 0), 0);
  const budget = Number(s.aiMonthlyBudget) || 0;

  const tabBtn = (key, icon, label) => (
    <button className="btn-ghost" onClick={() => setPanel(key)} style={{ padding: '8px 12px', fontSize: '0.75rem', display: 'inline-flex', gap: 6, alignItems: 'center', borderColor: panel === key ? 'var(--active)' : undefined, color: panel === key ? 'var(--active)' : undefined }}>{icon}{label}</button>
  );

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <section className="bg-card" style={{ padding: 16, display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <input ref={fileInput} type="file" accept="image/*" capture="environment" multiple style={{ display: 'none' }}
          onChange={(e) => { addPhotos(e.target.files); e.target.value = ''; }} />
        <button className="btn-primary" onClick={() => fileInput.current?.click()} style={{ padding: '14px 22px', fontSize: '1.1rem', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          {uploading ? <Loader size={18} className="spin" /> : <Camera size={18} />} SNAP CARDS
        </button>
        <div className="ink-dim" style={{ fontSize: '0.75rem', flex: '1 1 220px' }}>
          One card per photo, front side, flat and in focus. Pick several from the camera roll at once for a batch.
          {uploading > 0 && <span className="accent-amber"> Uploading {uploading}…</span>}
        </div>
        <div style={{ fontSize: '0.75rem', textAlign: 'right' }}>
          <div className="ink-faint">AI THIS MONTH</div>
          <div style={{ fontWeight: 700 }} className={budget && monthSpend >= budget * 0.8 ? 'accent-amber' : ''}>{fee(monthSpend)}{budget ? ` / ${money(budget)}` : ''}</div>
        </div>
      </section>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {tabBtn('queue', <ImageIcon size={14} />, `Review queue (${items.filter((i) => !DONE.includes(i.status)).length})`)}
        {tabBtn('fees', <DollarSign size={14} />, 'API fees')}
        {tabBtn('trial', <FlaskConical size={14} />, 'Model trial')}
        {tabBtn('settings', <Cog size={14} />, 'Settings')}
      </div>

      {msg && <div style={{ padding: '10px 14px', border: `1px solid ${msg.type === 'error' ? 'var(--bad)' : 'var(--good)'}`, color: msg.type === 'error' ? 'var(--bad)' : 'var(--good)', fontSize: '0.8rem', display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span>{msg.text}</span><button className="btn-icon" onClick={() => setMsg(null)}><X size={14} /></button></div>}

      {panel === 'queue' && (
        <>
          {wnReconnect && (
            <div role="alert" style={{ padding: '10px 14px', border: '1px solid var(--warn)', fontSize: '0.8rem', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="accent-amber" style={{ flex: 1, minWidth: 180 }}>Whatnot stopped accepting your token, so we can't see Whatnot sales. Paste a new one.</span>
              <a className="btn-primary" href="?tab=listings" style={{ padding: '6px 12px', fontSize: '0.75rem', textDecoration: 'none' }}>Open Marketplaces</a>
            </div>
          )}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {[['open', `To do (${items.filter((i) => !DONE.includes(i.status)).length})`], ['needs_review', `Check (${counts.needs_review})`], ['ready', `Ready (${counts.ready})`], ['failed', `Failed (${counts.failed})`], ['approved', `Approved (${counts.approved})`], ['listed', `On eBay (${counts.listed})`], ...(counts.sold ? [['sold', `Sold (${counts.sold})`]] : []), ...(changedCount ? [['changed', `Not on eBay yet (${changedCount})`]] : []), ...(whatnotOn ? [['whatnot', `On Whatnot (${whatnotCount})`]] : [])].map(([k, l]) => (
              <button key={k} className="btn-ghost" onClick={() => setFilter(k)} style={{ padding: '6px 10px', fontSize: '0.7rem', borderColor: filter === k ? 'var(--active)' : undefined, color: filter === k ? 'var(--active)' : undefined }}>{l}</button>
            ))}
            <span style={{ flex: 1 }} />
            <button className="btn-ghost" onClick={loadItems} title="Reload" style={{ padding: '6px 10px' }}><RefreshCw size={14} /></button>
            <button className="btn-ghost" disabled={!visible.length} onClick={batchPurchase} title="Split what you paid for these cards across them" style={{ padding: '6px 10px', fontSize: '0.7rem' }}>$ Purchase cost</button>
            {!['approved', 'listed', 'sold'].includes(filter) && <button className="btn-primary" disabled={!counts.ready} onClick={approveAllReady} style={{ padding: '8px 14px', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Check size={14} /> APPROVE ALL READY ({counts.ready})</button>}
            {toWhatnot.length > 0 && <button className="btn-ghost" disabled={!!ebayBusy} onClick={() => listAllOnWhatnot(toWhatnot)} style={{ padding: '8px 12px', fontSize: '0.75rem' }}>LIST {toWhatnot.length} ON WHATNOT</button>}
            {filter === 'approved' && <>
              <button className="btn-ghost" disabled={!toCheck || !!ebayBusy} onClick={checkApproved} title="Uploads photos and runs eBay's free listing check. Nothing goes live." style={{ padding: '8px 12px', fontSize: '0.75rem' }}>CHECK {toCheck} WITH EBAY</button>
              <button className="btn-primary" disabled={!toPublish || !!ebayBusy} onClick={publishChecked} style={{ padding: '8px 14px', display: 'inline-flex', gap: 6, alignItems: 'center' }}><Store size={14} /> PUBLISH {toPublish} TO EBAY</button>
            </>}
          </div>
          {ebayBusy && <div className="accent-amber" style={{ fontSize: '0.8rem' }}><Loader size={12} className="spin" /> {ebayBusy.label}: {ebayBusy.done} of {ebayBusy.total}…</div>}
          {(filter === 'listed' || filter === 'changed') && <ImportPanel onDone={loadItems} onPhotosChanged={() => setPhotoUrls({})} />}
          {(filter === 'listed' || filter === 'changed' || items.length > 40) && (
            <input className="bg-input" type="search" aria-label="Search cards" placeholder="Search title, item number or SKU" value={search} onChange={(e) => setSearch(e.target.value)} style={{ padding: '8px 12px', fontSize: '0.85rem' }} />
          )}
          {visible.length === 0 ? (
            <div className="bg-card ink-faint" style={{ padding: 48, textAlign: 'center' }}>
              {words.length ? 'No cards match that search.' : items.length ? 'Nothing here.' : 'No cards yet. Tap "snap cards" to photograph a stack.'}
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
              {visible.map((it) => <SnapCard key={it.id} it={it} listings={listingsByCard.get(it.id) || []} whatnotOn={whatnotOn} mp_={{ busy: !!ebayBusy, ready: whatnotReady(it), onList: () => listOnWhatnot(it), onChip: (l) => onChip(it, l), onEnd: (l) => endListing(it, l), onQuantity: (q) => changeQuantity(it, q) }} photo={photoUrls[it.photo_path]} photoUrls={photoUrls} photoBusy={photoBusy[it.id]} photo_={photoHandlers(it)} onSendPhotos={() => sendChangesToEbay(it)} onSave={save} onApprove={approve} onDiscard={discard} onRetry={() => identify(it.id)} onAddPhotos={(fs) => addExtraPhotos(it, fs)} onReplace={(f) => replacePhoto(it, f)} />)}
            </div>
          )}
          {matching.length > visible.length && (
            <button className="btn-ghost" onClick={() => setPageSize((n) => n + 48)} style={{ padding: '10px 14px', justifySelf: 'center' }}>Show more ({matching.length - visible.length} left)</button>
          )}
          <div className="ink-faint" style={{ fontSize: '0.7rem' }}>
            Approved cards: "check" uploads the photos and runs eBay's free listing check (nothing goes live). "publish" lists the cards that passed, using your learned listing setup (Snap settings).
          </div>
        </>
      )}

      {editing && (() => {
        const it = items.find((x) => x.id === editing.id);
        if (!it || !listingPhotoPaths(it).includes(editing.path)) return null;
        return <PhotoEditor key={editing.path} it={it} path={editing.path} onClose={() => setEditing(null)}
          onApply={(path, corners) => photoCall(it, { action: 'crop', path, corners }, 'Straightening…', { raise: true })}
          onAuto={(path) => photoCall(it, { action: 'autocrop', path }, 'Straightening…', { raise: true })} />;
      })()}

      {panel === 'fees' && <FeePanel usage={usage} budget={budget} onReload={loadUsage} />}
      {panel === 'trial' && <TrialPanel settings={s} setSettings={setSettings} onUsage={loadUsage} />}
      {panel === 'settings' && <SnapSettings s={s} settings={settings} setSettings={setSettings} />}
    </div>
  );
}

function SnapCard({ it, listings = [], whatnotOn = false, mp_ = {}, photo, photoUrls = {}, photoBusy = null, photo_ = {}, onSendPhotos, onSave, onApprove, onDiscard, onRetry, onAddPhotos, onReplace }) {
  const frontInput = useRef(null);
  const [d, setD] = useState(it);
  useEffect(() => { setD(it); }, [it]);
  const [label, color] = cardHeader(it, listings);
  const busy = it.status === 'identifying' || it.status === 'uploaded';
  const field = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const commit = (patch) => onSave(it.id, patch);
  const rebuildTitle = () => { const t = buildTitle(d); field('title', t); commit({ title: t }); };
  const rebuildDescription = () => { const t = buildDescription(d); field('description', t); commit({ description: t }); };
  const inp = { padding: '6px 8px', fontSize: '0.8rem' };

  return (
    <div className="bg-card" style={{ padding: 12, display: 'grid', gap: 8, borderColor: it.status === 'needs_review' || it.status === 'failed' ? color : undefined }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.7rem' }}>
        <span style={{ color, fontWeight: 700, letterSpacing: '0.1em' }}>{busy && <Loader size={11} className="spin" />} {label}</span>
        <span className="ink-faint" style={{ textAlign: 'right' }} title={it.extraction?.route ? `Read by Haiku first, then ${MODEL_LABELS[it.model] || it.model}: ${ROUTE_REASONS[it.extraction.route.escalated] || it.extraction.route.escalated}` : undefined}>{it.model ? (it.extraction?.route && !it.extraction.route.failed ? `Haiku → ${(MODEL_LABELS[it.model] || it.model).replace('Claude ', '')}` : (MODEL_LABELS[it.model] || it.model)) : ''}{it.confidence != null ? ` · ${Math.round(it.confidence * 100)}% sure` : ''}</span>
      </div>
      {DONE.includes(it.status) && <SaleNote it={it} listings={listings} onEnd={mp_.onEnd} />}
      {DONE.includes(it.status) && (whatnotOn || listings.some((l) => l.marketplace !== 'ebay')) && <MarketChips it={it} listings={listings} whatnotOn={whatnotOn} mp_={mp_} />}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        <div style={{ aspectRatio: '5 / 7', background: 'var(--well)', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0, overflow: 'hidden' }}>
          {photo ? (it.photo_crop ? <CropImg url={photo} box={it.photo_crop} alt="Your photo (from a binder page)" /> : <img src={photo} alt="Your photo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />) : <Loader size={14} className="spin ink-faint" />}
        </div>
        <div style={{ aspectRatio: '5 / 7', background: 'var(--well)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative', minWidth: 0, overflow: 'hidden' }}>
          {it.catalog_image_url
            ? <img src={it.catalog_image_url} alt="Catalog match" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
            : <span className="ink-faint" style={{ fontSize: '0.7rem', textAlign: 'center', padding: 8 }}>{busy ? '' : it.catalog_source ? <>Matched in the catalog, no picture:<br />{[it.catalog_set, it.catalog_number, it.rarity].filter(Boolean).join(' · ')}</> : it.imported_from_ebay_at ? 'From your eBay listing' : 'No catalog match'}</span>}
          {it.catalog_source && <span style={{ position: 'absolute', bottom: 2, right: 4, fontSize: '0.6rem' }} className="ink-faint">{it.catalog_source}</span>}
        </div>
      </div>
      {!busy && it.status !== 'listed' && it.photo_crop && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.7rem' }}>
          <input ref={frontInput} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={(e) => { if (e.target.files[0]) onReplace(e.target.files[0]); e.target.value = ''; }} />
          <button className="btn-primary" onClick={() => frontInput.current?.click()} style={{ padding: '4px 8px', fontSize: '0.7rem', display: 'inline-flex', gap: 4, alignItems: 'center' }}><Camera size={12} /> Replace photo</button>
        </div>
      )}

      {!busy && (
        <PhotoStrip it={it} paths={listingPhotoPaths(it)} urls={photoUrls} max={MAX_LISTING_PHOTOS} busy={photoBusy} locked={false} onAdd={onAddPhotos} {...photo_} />
      )}
      {liveChanges(it).length > 0 && (
        <div role="status" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: '0.75rem', padding: 8, border: '1px dashed var(--warn)' }}>
          <span className="accent-amber" style={{ flex: 1, minWidth: 160 }}>Not on eBay yet: {liveChanges(it).join(', ')}. The live listing still shows the old {liveChanges(it).length === 1 ? 'one' : 'ones'}.</span>
          <button className="btn-primary" disabled={!!photoBusy} onClick={onSendPhotos} style={{ padding: '6px 12px', fontSize: '0.75rem' }}>Update on eBay</button>
        </div>
      )}

      {it.error && <div className="accent-red" style={{ fontSize: '0.75rem' }}>{it.error}</div>}
      {(it.review_reasons || []).length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {it.review_reasons.map((r) => <span key={r} style={{ fontSize: '0.65rem', padding: '2px 6px', border: '1px solid var(--warn)', color: 'var(--warn)' }}>{REVIEW_LABELS[r] || r}</span>)}
        </div>
      )}
      {it.duplicate_item_id && <a className="ink-dim" style={{ fontSize: '0.7rem' }} href={`https://www.ebay.com/itm/${it.duplicate_item_id}`} target="_blank" rel="noreferrer">Your listing #{it.duplicate_item_id} <ExternalLink size={10} /></a>}
      {it.misprint_flag && (
        <div style={{ fontSize: '0.75rem', padding: 6, border: '1px dashed var(--warn)' }}>
          <div className="accent-amber"><AlertTriangle size={11} /> AI noticed: {it.misprint_notes || 'possible misprint'}</div>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', textTransform: 'none', letterSpacing: 0, margin: '4px 0 0', color: 'var(--ink)' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!d.misprint_confirmed} onChange={(e) => { field('misprint_confirmed', e.target.checked); commit({ misprint_confirmed: e.target.checked }); }} />
            I checked it: it's a real misprint (adds it to the title)
          </label>
        </div>
      )}

      {it.status === 'listed' && (
        <div style={{ fontSize: '0.8rem', padding: 8, border: '1px solid var(--good)' }}>
          <div className="accent-green" style={{ fontWeight: 600 }}>{it.title}</div>
          <div className="ink-dim">{money(it.price)}{it.cost_basis != null ? ` · cost ${money(it.cost_basis)}` : ''} · listed {it.listed_at ? new Date(it.listed_at).toLocaleDateString() : ''}</div>
          {it.promoted_at && <div className="accent-green" style={{ fontSize: '0.7rem' }}>Promoted Listings: on</div>}
          {it.promo_error && <div className="accent-amber" style={{ fontSize: '0.7rem' }}>{it.promo_error}</div>}
          {it.ebay_url && <a href={it.ebay_url} target="_blank" rel="noreferrer" className="accent-green" style={{ fontSize: '0.75rem' }}>View on eBay #{it.ebay_item_id} <ExternalLink size={10} /></a>}
          {it.imported_from_ebay_at && <div className="ink-faint" style={{ fontSize: '0.65rem' }}>Brought in from eBay {new Date(it.imported_from_ebay_at).toLocaleDateString()}</div>}
        </div>
      )}
      {it.status === 'listed' && (
        <div style={{ display: 'grid', gap: 4 }}>
          <input className="bg-input" style={inp} value={d.title || ''} aria-label="eBay title" placeholder="eBay title" maxLength={80} onChange={(e) => field('title', e.target.value)} onBlur={() => d.title !== it.title && commit({ title: d.title })} />
          <div className="ink-faint" style={{ fontSize: '0.65rem' }}>Title {String(d.title || '').length}/80</div>
          <textarea className="bg-input" style={{ ...inp, minHeight: 92, resize: 'vertical', lineHeight: 1.4 }} value={d.description || ''} aria-label="eBay description"
            placeholder={it.imported_from_ebay_at ? 'eBay description' : 'Written from the card\'s details (as on eBay). Type here to replace it.'}
            onChange={(e) => field('description', e.target.value)} onBlur={() => (d.description || '') !== (it.description || '') && commit({ description: d.description })} />
          <div className="ink-faint" style={{ fontSize: '0.65rem' }}>Edits here go to eBay when you tap "Update on eBay". Change the price in Prices.</div>
          {(whatnotOn || Number(it.quantity ?? 1) !== 1) && <QtyField it={it} onQuantity={mp_.onQuantity} />}
        </div>
      )}
      {it.status === 'approved' && <PublishStatus it={it} />}

      {!busy && it.status !== 'failed' && it.status !== 'listed' && (
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 6 }}>
          <input className="bg-input" style={inp} value={d.card_name || ''} placeholder="Card name" onChange={(e) => field('card_name', e.target.value)} onBlur={() => commit({ card_name: d.card_name })} />
          <input className="bg-input" style={inp} value={d.catalog_number || d.collector_number || ''} placeholder="Number" onChange={(e) => field('catalog_number', e.target.value)} onBlur={() => commit({ catalog_number: d.catalog_number })} />
          <input className="bg-input" style={{ ...inp, gridColumn: 'span 2' }} value={d.catalog_set || d.set_name || ''} placeholder="Set" onChange={(e) => field('catalog_set', e.target.value)} onBlur={() => commit({ catalog_set: d.catalog_set })} />
          <select className="bg-input" style={{ ...inp, gridColumn: ['pokemon', 'mtg'].includes(d.game) ? 'span 2' : undefined }} aria-label="Game" value={d.game || 'pokemon'} onChange={(e) => { field('game', e.target.value); commit({ game: e.target.value }); }}>
            {Object.entries(GAME_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {!['pokemon', 'mtg'].includes(d.game) && <input className="bg-input" style={inp} value={d.rarity || ''} placeholder="Rarity" aria-label="Rarity" onChange={(e) => field('rarity', e.target.value)} onBlur={() => commit({ rarity: d.rarity || null })} />}
          {d.game === 'other' && (
            <input className="bg-input" style={{ ...inp, gridColumn: 'span 2' }} value={d.extraction?.game_name || ''} placeholder="Game name, e.g. Digimon Card Game" aria-label="Game name"
              onChange={(e) => field('extraction', { ...(d.extraction || {}), game_name: e.target.value })} onBlur={() => commit({ extraction: d.extraction })} />
          )}
          <select className="bg-input" style={inp} value={d.finish || 'unknown'} onChange={(e) => { field('finish', e.target.value); commit({ finish: e.target.value }); }}>{FINISHES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          <select className="bg-input" style={inp} value={d.condition || 'NM'} onChange={(e) => { field('condition', e.target.value); commit({ condition: e.target.value }); }}>{CONDS.map((c) => <option key={c}>{c}</option>)}</select>
          <div style={{ gridColumn: 'span 2', display: 'flex', gap: 4 }}>
            <input className="bg-input" style={{ ...inp, flex: 1 }} value={d.title || ''} placeholder="eBay title" maxLength={80} onChange={(e) => field('title', e.target.value)} onBlur={() => commit({ title: d.title })} />
            <button className="btn-icon" title="Rebuild title from the fields" onClick={rebuildTitle}><RefreshCw size={13} /></button>
          </div>
          <div className="ink-faint" style={{ gridColumn: 'span 2', fontSize: '0.65rem', marginTop: -2 }}>Title {String(d.title || '').length}/80{String(d.title || '').length < 70 ? ' · aim for 70 to 80' : ''}</div>
          <div style={{ gridColumn: 'span 2', display: 'flex', gap: 4, alignItems: 'flex-start' }}>
            <textarea className="bg-input" style={{ ...inp, flex: 1, minHeight: 92, resize: 'vertical', lineHeight: 1.4 }} value={d.description || ''} placeholder="eBay description" aria-label="eBay description"
              onChange={(e) => field('description', e.target.value)} onBlur={() => commit({ description: d.description })} />
            <button className="btn-icon" title="Rewrite the description from the fields" onClick={rebuildDescription}><RefreshCw size={13} /></button>
          </div>
          <div style={{ gridColumn: 'span 2', display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.75rem' }}>
            <span className="ink-faint">Price $</span>
            <input className="bg-input" style={{ ...inp, width: 90 }} type="number" step="0.01" min="0.99" value={d.price ?? ''} onChange={(e) => field('price', e.target.value)} onBlur={() => commit({ price: d.price === '' ? null : Number(d.price) })} />
            {it.suggested_price != null && Number(d.price) !== Number(it.suggested_price) && <button className="btn-ghost" style={{ padding: '3px 6px', fontSize: '0.65rem' }} onClick={() => { field('price', it.suggested_price); commit({ price: it.suggested_price }); }}>Use {money(it.suggested_price)}</button>}
            <span className="ink-faint" title={it.price_source || ''}>market {money(it.market_price)}</span>
          </div>
          {(whatnotOn || Number(it.quantity ?? 1) !== 1) && <QtyField it={it} onQuantity={mp_.onQuantity} />}
          <div style={{ gridColumn: 'span 2', display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.75rem', flexWrap: 'wrap' }}>
            <span className="ink-faint">Cost $</span>
            <input className="bg-input" style={{ ...inp, width: 90 }} type="number" step="0.01" min="0" placeholder="paid" value={d.cost_basis ?? ''} onChange={(e) => field('cost_basis', e.target.value)}
              onBlur={() => { const none = d.cost_basis === '' || d.cost_basis == null; commit({ cost_basis: none ? null : Number(d.cost_basis), cost_source: none ? null : 'entered', purchase_id: null }); }} />
            {it.cost_source === 'purchase' && <span style={{ fontSize: '0.65rem', color: 'var(--info)' }}>from purchase</span>}
            {it.catalog_url && <a className="ink-faint" href={it.catalog_url} target="_blank" rel="noreferrer"><ExternalLink size={11} /></a>}
          </div>
        </div>
      )}

      {it.status !== 'listed' && <div style={{ display: 'flex', gap: 6 }}>
        {it.status !== 'approved' && <button className="btn-primary" disabled={busy || it.status === 'failed'} onClick={() => onApprove({ ...it, ...d })} style={{ padding: '6px 10px', flex: 1, display: 'inline-flex', gap: 4, alignItems: 'center', justifyContent: 'center' }}><Check size={13} /> Approve</button>}
        {it.status === 'approved' && <button className="btn-ghost" onClick={() => onSave(it.id, { status: 'needs_review' })} style={{ padding: '6px 10px', flex: 1, fontSize: '0.75rem' }}>Undo approve</button>}
        <button className="btn-ghost" disabled={busy || it.status === 'approved'} onClick={onRetry} title="Read the photo again (costs another AI call)" style={{ padding: '6px 10px' }}><RefreshCw size={13} /></button>
        <button className="btn-ghost" disabled={['checking', 'publishing'].includes(it.publish_state)} onClick={() => onDiscard(it)} title="Discard" style={{ padding: '6px 10px' }}><X size={13} /></button>
      </div>}
    </div>
  );
}

// Where the card is listed: a chip per marketplace, and "List on Whatnot".
function MarketChips({ it, listings, whatnotOn, mp_ }) {
  const chips = chipsFor(listings);
  const tone = { live: ['var(--good)', 'var(--ink)'], warn: ['var(--warn)', 'var(--warn)'], sold: ['var(--good)', 'var(--good)'], ended: ['var(--line)', 'var(--ink-faint)'], bad: ['var(--bad)', 'var(--bad)'] };
  const wnNow = currentListings(listings).find((l) => l.marketplace === 'whatnot');
  const canList = whatnotOn && mp_.ready !== false && !['creating', 'active', 'ending'].includes(wnNow?.status) && !isSoldOut(it) && !it.photo_crop;
  return (
    <div style={{ display: 'grid', gap: 4 }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
        {chips.map((c) => (
          <button key={c.id} type="button" className="btn-ghost" onClick={() => mp_.onChip?.(listings.find((l) => l.id === c.id))}
            disabled={!c.live && !c.url} aria-label={c.live && c.marketplace === 'whatnot' ? `${c.text}: change or end` : c.text}
            style={{ padding: '3px 8px', fontSize: '0.7rem', borderColor: tone[c.tone][0], color: tone[c.tone][1], whiteSpace: 'nowrap' }}>{c.text}</button>
        ))}
        {canList && <button type="button" className="btn-primary" disabled={mp_.busy} onClick={mp_.onList} style={{ padding: '4px 10px', fontSize: '0.7rem' }}>List on Whatnot</button>}
      </div>
      {wnNow?.status === 'failed' && wnNow.last_error && (
        <div className="accent-red" style={{ fontSize: '0.72rem', display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 140 }}>{wnNow.last_error}</span>
          {canList && <button type="button" className="btn-ghost" disabled={mp_.busy} onClick={mp_.onList} style={{ padding: '3px 8px', fontSize: '0.7rem' }}>Try again</button>}
        </div>
      )}
    </div>
  );
}

// What happened when the card sold on one marketplace (top line of the card).
function SaleNote({ it, listings, onEnd }) {
  const s = saleSentence(it, listings);
  if (!s) return null;
  const color = s.tone === 'bad' ? 'var(--bad)' : s.tone === 'ok' ? 'var(--good)' : 'var(--warn)';
  return (
    <div role="status" style={{ fontSize: '0.75rem', padding: 8, border: `1px solid ${color}`, color, display: 'grid', gap: 6 }}>
      <span>{s.text}</span>
      {(s.endButtons.length > 0 || s.orders.length > 1) && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {s.endButtons.map((b) => <button key={b.listingId} type="button" className="btn-primary" onClick={() => onEnd?.(listings.find((l) => l.id === b.listingId))} style={{ padding: '4px 10px', fontSize: '0.7rem' }}>{b.label}</button>)}
          {s.tone === 'bad' && s.orders.map((o, i) => <a key={i} href={o.url} target="_blank" rel="noreferrer" style={{ fontSize: '0.7rem', color }}>{o.marketplace === 'ebay' ? 'eBay' : 'Whatnot'} order <ExternalLink size={10} /></a>)}
        </div>
      )}
    </div>
  );
}

// How many of this card the seller has (default 1).
function QtyField({ it, onQuantity }) {
  const [v, setV] = useState(String(it.quantity ?? 1));
  useEffect(() => { setV(String(it.quantity ?? 1)); }, [it.quantity]);
  const commit = async () => {
    if (String(it.quantity ?? 1) === v.trim()) return;
    const ok = await onQuantity?.(Number(v.trim()));
    if (!ok) setV(String(it.quantity ?? 1));
  };
  return (
    <div style={{ gridColumn: 'span 2', display: 'flex', gap: 6, alignItems: 'center', fontSize: '0.75rem' }}>
      <span className="ink-faint">Quantity</span>
      <input className="bg-input" aria-label="Quantity" style={{ padding: '6px 8px', fontSize: '0.8rem', width: 70 }} type="number" min="1" max="999" step="1" inputMode="numeric"
        value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      {Number(it.quantity) === 0 && <span className="accent-amber">sold out</span>}
    </div>
  );
}

// eBay check / publish state for an approved card.
function PublishStatus({ it }) {
  const c = it.publish_check;
  if (it.publish_state === 'checking' || it.publish_state === 'publishing') {
    return <div className="accent-amber" style={{ fontSize: '0.75rem' }}><Loader size={11} className="spin" /> {it.publish_state === 'checking' ? 'Checking with eBay…' : 'Publishing…'}</div>;
  }
  if (it.publish_state === 'failed') return <div className="accent-red" style={{ fontSize: '0.75rem' }}>Publish failed: {it.publish_error}</div>;
  if (!c) {
    return <div className="ink-faint" style={{ fontSize: '0.7rem' }}>{it.publish_error ? <span className="accent-red">{it.publish_error}</span> : 'Not checked with eBay yet.'}</div>;
  }
  return (
    <div style={{ fontSize: '0.72rem', padding: 6, border: `1px solid ${c.ok ? 'var(--good)' : 'var(--bad)'}` }}>
      {c.ok
        ? <div className="accent-green">Passed eBay's check · listing fee {money(c.fees?.total || 0)}{c.shippingProfile ? ` · ${c.shippingProfile.replace(/\s*\(\d+\)\s*$/, '')}` : ''}</div>
        : <div className="accent-red">eBay would reject this listing:</div>}
      {(c.errors || []).map((e, i) => <div key={`e${i}`} className="accent-red">• {e}</div>)}
      {(c.warnings || []).slice(0, 3).map((w, i) => <div key={`w${i}`} className="accent-amber">• {w}</div>)}
    </div>
  );
}

function FeePanel({ usage, budget, onReload }) {
  const rows = usage.month;
  const total = rows.reduce((t, r) => t + Number(r.cost_usd || 0), 0);
  const today = new Date().toISOString().slice(0, 10);
  const todaySpend = rows.filter((r) => r.created_at.slice(0, 10) === today).reduce((t, r) => t + Number(r.cost_usd || 0), 0);
  const group = (key) => {
    const m = new Map();
    for (const r of rows) {
      const k = r[key];
      const g = m.get(k) || { calls: 0, cost: 0, inTok: 0, outTok: 0 };
      g.calls += 1; g.cost += Number(r.cost_usd || 0); g.inTok += r.input_tokens || 0; g.outTok += r.output_tokens || 0;
      m.set(k, g);
    }
    return [...m.entries()].sort((a, b) => b[1].cost - a[1].cost);
  };
  const ids = rows.filter((r) => r.purpose === 'snap_identify' && r.ok);
  const perCard = ids.length ? ids.reduce((t, r) => t + Number(r.cost_usd || 0), 0) / ids.length : null;
  const usedPct = budget ? Math.min(1, total / budget) : null;

  return (
    <section className="bg-card" style={{ padding: 0 }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 className="display-font" style={{ margin: 0, fontSize: '1.3rem' }}>API FEES · THIS MONTH</h2>
        <button className="btn-ghost" onClick={onReload} style={{ padding: '6px 10px' }}><RefreshCw size={14} /></button>
      </div>
      <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, padding: 16 }}>
        <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem' }}>THIS MONTH</div><div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{fee(total)}</div><div className="ink-dim" style={{ fontSize: '0.7rem' }}>{budget ? `of ${money(budget)} budget` : 'no budget limit'}</div>
          {usedPct != null && <div style={{ height: 4, background: 'var(--line)', marginTop: 6 }}><div style={{ height: 4, width: `${usedPct * 100}%`, background: usedPct >= 0.8 ? 'var(--warn)' : 'var(--good)' }} /></div>}</div>
        <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem' }}>TODAY</div><div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{fee(todaySpend)}</div></div>
        <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem' }}>PER CARD IDENTIFIED</div><div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{fee(perCard)}</div><div className="ink-dim" style={{ fontSize: '0.7rem' }}>{ids.length} cards this month</div></div>
        <div className="stat-box"><div className="ink-faint" style={{ fontSize: '0.7rem' }}>ALL TIME</div><div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{fee(usage.allTime)}</div><div className="ink-dim" style={{ fontSize: '0.7rem' }}>{rows.length} calls this month</div></div>
      </div>
      <div className="responsive-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, padding: '0 16px 16px' }}>
        {[['model', 'By model'], ['purpose', 'By use']].map(([k, label]) => (
          <div key={k} style={{ border: '1px solid var(--line)' }}>
            <div className="ink-faint" style={{ fontSize: '0.7rem', padding: '8px 12px', letterSpacing: '0.1em' }}>{label.toUpperCase()}</div>
            {group(k).map(([name, g]) => (
              <div key={name} className="grid-row" style={{ gridTemplateColumns: '1fr 60px 80px', padding: '8px 12px' }}>
                <div>{k === 'model' ? (MODEL_LABELS[name] || name) : name === 'snap_identify' ? 'Snap to List' : name === 'model_trial' ? 'Model trial' : name}
                  <div className="ink-faint" style={{ fontSize: '0.65rem' }}>{(g.inTok / 1000).toFixed(1)}k in · {(g.outTok / 1000).toFixed(1)}k out tokens</div></div>
                <div className="ink-dim" style={{ textAlign: 'right' }}>{g.calls}</div>
                <div style={{ textAlign: 'right', fontWeight: 600 }}>{fee(g.cost)}</div>
              </div>
            ))}
            {!rows.length && <div className="ink-faint" style={{ padding: 12, fontSize: '0.8rem' }}>No AI calls yet this month.</div>}
          </div>
        ))}
      </div>
      <div style={{ borderTop: '1px solid var(--line)' }}>
        <div className="ink-faint" style={{ fontSize: '0.7rem', padding: '10px 20px', letterSpacing: '0.1em' }}>RECENT CALLS</div>
        {rows.slice(0, 15).map((r, i) => (
          <div key={i} className="grid-row" style={{ gridTemplateColumns: '130px 1fr 70px 70px', fontSize: '0.75rem', padding: '6px 20px' }}>
            <div className="ink-faint">{new Date(r.created_at).toLocaleString()}</div>
            <div>{MODEL_LABELS[r.model] || r.model} · {r.purpose === 'snap_identify' ? 'snap' : 'trial'}{!r.ok && <span className="accent-red"> · failed</span>}</div>
            <div className="ink-dim" style={{ textAlign: 'right' }}>{r.latency_ms ? `${(r.latency_ms / 1000).toFixed(1)}s` : ''}</div>
            <div style={{ textAlign: 'right' }}>{fee(r.cost_usd)}</div>
          </div>
        ))}
      </div>
      <div className="ink-faint" style={{ fontSize: '0.7rem', padding: '12px 20px', borderTop: '1px solid var(--line)' }}>
        Estimated from Anthropic's published per-token prices (Opus 5.5: ${MODEL_PRICES['claude-opus-5-5'].input}/${MODEL_PRICES['claude-opus-5-5'].output} per million input/output tokens; Haiku 5.5: ${MODEL_PRICES['claude-haiku-5-5'].input}/${MODEL_PRICES['claude-haiku-5-5'].output}). Your Anthropic Console invoice is the final number. Months are calendar months in UTC.
      </div>
    </section>
  );
}

function TrialPanel({ settings, setSettings, onUsage }) {
  const autoOn = settings.snapAutoRoute !== false && settings.snapModel !== 'claude-haiku-5-5';
  const [rows, setRows] = useState([]);
  const [trialId, setTrialId] = useState(null);
  const [running, setRunning] = useState(null); // { done, total }
  const [err, setErr] = useState(null);
  const stop = useRef(false);

  const loadLatest = useCallback(async () => {
    const { data: last } = await supabase.from('model_trial_results').select('trial_id').order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (!last) return;
    const { data } = await supabase.from('model_trial_results').select('*').eq('trial_id', last.trial_id).order('item_id');
    setTrialId(last.trial_id); setRows(data || []);
  }, []);
  useEffect(() => { loadLatest(); }, [loadLatest]);

  async function run() {
    setErr(null);
    const res = await apiFetch('/api/snap-trial?n=60');
    const plan = await res.json().catch(() => ({}));
    if (!res.ok) { setErr(plan.error || `Couldn't start (${res.status})`); return; }
    if (!plan.items?.length) { setErr('No single-card listings with photos to test on. Sync your eBay listings first.'); return; }
    const est = plan.models.map((m) => `${ARM_LABELS[m]} about ${fee(plan.estimate[m])}`).join(', ');
    if (!(await askConfirm(`Run ${plan.items.length} of your listing photos through ${plan.models.length === 2 ? 'both models' : 'each option'}?\n\nEstimated cost: ${est}.\n\nBilled to your Anthropic API key.`, { title: 'Model trial', confirmLabel: 'Run the trial' }))) return;
    const id = `t${Date.now()}`;
    setTrialId(id); setRows([]); stop.current = false;
    const jobs = plan.items.flatMap((it) => plan.models.map((m) => ({ model: m, itemId: it.item_id })));
    let done = 0;
    setRunning({ done, total: jobs.length });
    const worker = async () => {
      while (jobs.length && !stop.current) {
        const j = jobs.shift();
        const r = await postJson('/api/snap-trial', { trialId: id, ...j }).catch((e) => ({ ok: false, data: { error: e.message } }));
        if (r.ok) setRows((xs) => [...xs, r.data.result]);
        else if (r.status === 429 || r.status === 503) { stop.current = true; setErr(r.data.error); }
        done += 1; setRunning({ done, total: done + jobs.length });
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setRunning(null); onUsage();
  }

  const summary = useMemo(() => summarizeTrial(rows), [rows]);
  const byItem = useMemo(() => {
    const m = new Map();
    for (const r of rows) { if (!m.has(r.item_id)) m.set(r.item_id, { title: r.expected_title, image: r.image_url, listed: r.listed_price, market: r.market_price }); m.get(r.item_id)[r.model] = r; }
    return [...m.values()];
  }, [rows]);
  const misses = byItem.filter((x) => Object.keys(ARM_LABELS).some((k) => x[k] && (x[k].error || !x[k].correct)));
  const ratios = byItem.map((x) => Number(x.listed) / Number(x.market)).filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  const medianRatio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;

  return (
    <section className="bg-card" style={{ padding: 0 }}>
      <div style={{ padding: '14px 20px', borderBottom: '1px solid var(--line)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 className="display-font" style={{ margin: 0, fontSize: '1.3rem' }}>MODEL TRIAL</h2>
          <div className="ink-dim" style={{ fontSize: '0.75rem' }}>Runs up to 60 of your own eBay listing photos through Opus, Haiku, and Auto (Haiku first, Opus only for hard cards), and checks each answer against your listing title.</div>
        </div>
        {running
          ? <button className="btn-ghost" onClick={() => { stop.current = true; }} style={{ padding: '8px 14px' }}><Loader size={14} className="spin" /> {running.done}/{running.total} · Stop</button>
          : <button className="btn-primary" onClick={run} style={{ padding: '10px 16px', display: 'inline-flex', gap: 6, alignItems: 'center' }}><FlaskConical size={14} /> RUN TRIAL</button>}
      </div>
      {err && <div className="accent-red" style={{ padding: '10px 20px', fontSize: '0.8rem' }}>{err}</div>}
      {!rows.length ? <div className="ink-faint" style={{ padding: 32, textAlign: 'center', fontSize: '0.85rem' }}>No trial results yet.</div> : (
        <>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 760 }}>
              <div className="grid-row" style={{ gridTemplateColumns: '170px repeat(5, 1fr) 90px 90px 70px 120px', fontSize: '0.65rem', letterSpacing: '0.08em', color: 'var(--ink-dim)' }}>
                <div>MODEL</div><div>FULLY RIGHT</div><div>NAME</div><div>NUMBER</div><div>SET</div><div>CATALOG</div><div style={{ textAlign: 'right' }}>PER CARD</div><div style={{ textAlign: 'right' }}>TOTAL</div><div style={{ textAlign: 'right' }}>TIME</div><div></div>
              </div>
              {summary.map((m) => (
                <div key={m.model} className="grid-row" style={{ gridTemplateColumns: '170px repeat(5, 1fr) 90px 90px 70px 120px' }}>
                  <div style={{ fontWeight: 600 }}>{ARM_LABELS[m.model] || m.model}<div className="ink-faint" style={{ fontSize: '0.65rem' }}>{m.cards} cards{m.errors ? ` · ${m.errors} errors` : ''}</div></div>
                  <div style={{ fontWeight: 700 }} className={m.correct >= 0.9 ? 'accent-green' : 'accent-amber'}>{pct(m.correct)}</div>
                  <div>{pct(m.name)}</div><div>{pct(m.number)}</div><div>{pct(m.set)}</div><div>{pct(m.catalog)}</div>
                  <div style={{ textAlign: 'right' }}>{fee(m.costPerCard)}</div>
                  <div style={{ textAlign: 'right' }}>{fee(m.totalCost)}</div>
                  <div style={{ textAlign: 'right' }} className="ink-dim">{m.medianLatencyMs ? `${(m.medianLatencyMs / 1000).toFixed(1)}s` : '—'}</div>
                  <div style={{ textAlign: 'right' }}>{(m.model === 'auto' ? autoOn : !autoOn && settings.snapModel === m.model)
                    ? <span className="accent-green" style={{ fontSize: '0.7rem' }}>In use</span>
                    : <button className="btn-ghost" onClick={() => setSettings(m.model === 'auto' ? { ...settings, snapAutoRoute: true, snapModel: 'claude-opus-5-5' } : { ...settings, snapAutoRoute: false, snapModel: m.model })} style={{ padding: '4px 8px', fontSize: '0.7rem' }}>Use this</button>}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="ink-dim" style={{ fontSize: '0.75rem', padding: '10px 20px', borderTop: '1px solid var(--line-soft)' }}>
            Trial {trialId}. "Fully right" = card name and number both match your title (number only counts where the title has one).
            {medianRatio != null && <> Your listed prices are a median <strong>{medianRatio.toFixed(1)}×</strong> the catalog market price on these cards.</>}
          </div>
          {misses.length > 0 && (
            <div style={{ borderTop: '1px solid var(--line)' }}>
              <div className="ink-faint" style={{ fontSize: '0.7rem', padding: '10px 20px', letterSpacing: '0.1em' }}>CARDS A MODEL GOT WRONG ({misses.length})</div>
              {misses.map((x, i) => (
                <div key={i} className="grid-row" style={{ gridTemplateColumns: '48px 1.4fr repeat(3, 1fr)', fontSize: '0.75rem', padding: '8px 20px' }}>
                  <img src={x.image} alt="" style={{ width: 44, height: 60, objectFit: 'contain', background: 'var(--well)' }} />
                  <div>{x.title}</div>
                  {Object.keys(ARM_LABELS).filter((k) => byItem.some((y) => y[k])).map((k) => {
                    const r = x[k];
                    if (!r) return <div key={k} />;
                    const e = r.extraction || {};
                    return <div key={k} className={r.correct ? 'ink-dim' : 'accent-red'}><span className="ink-faint">{(k === 'auto' ? 'Auto' : ARM_LABELS[k].replace('Claude ', ''))}: </span>{r.error || `${e.card_name || '?'} ${e.collector_number || ''}`}</div>;
                  })}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function SnapSettings({ s, settings, setSettings }) {
  const set = (k, v) => setSettings({ ...settings, [k]: v });
  return (
    <section className="bg-card" style={{ padding: 20, display: 'grid', gap: 12, maxWidth: 620 }}>
      <h2 className="display-font" style={{ margin: 0, fontSize: '1.3rem' }}>SNAP SETTINGS</h2>
      <div><label>AI model</label>
        <select className="bg-input" value={s.snapModel} onChange={(e) => set('snapModel', e.target.value)}>
          {Object.entries(MODEL_LABELS).map(([k, l]) => <option key={k} value={k}>{l} (${MODEL_PRICES[k].input} / ${MODEL_PRICES[k].output} per M tokens)</option>)}
        </select>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: '8px 0 0', fontSize: '0.8rem', textTransform: 'none', letterSpacing: 0, color: 'var(--ink)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={s.snapAutoRoute !== false && s.snapModel !== 'claude-haiku-5-5'} disabled={s.snapModel === 'claude-haiku-5-5'} onChange={(e) => set('snapAutoRoute', e.target.checked)} />
          Read with Haiku first; use {MODEL_LABELS[s.snapModel] || s.snapModel} only for hard cards
        </label>
        <div className="ink-faint" style={{ fontSize: '0.7rem', marginTop: 4 }}>Hard cards: not in English, unsure of the card, no catalog match, or another game. On your cards Haiku was as accurate as Opus at a small fraction of the cost. Run the model trial to compare on your own cards.</div></div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
        <div><label>Markup over market %</label><input className="bg-input" type="number" step="1" value={s.snapMarkupPct} onChange={(e) => set('snapMarkupPct', e.target.value === '' ? 0 : Number(e.target.value))} /></div>
        <div><label>Minimum price $</label><input className="bg-input" type="number" step="0.01" value={s.snapMinPrice} onChange={(e) => set('snapMinPrice', e.target.value === '' ? 0 : Number(e.target.value))} /></div>
        <div><label>Price ending</label>
          <select className="bg-input" value={s.snapEnding} onChange={(e) => set('snapEnding', e.target.value)}>
            {[['0.89', '.89'], ['0.98', '.98'], ['0.99', '.99'], ['0.49', '.49'], ['cents', 'Exact cents']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select></div>
      </div>
      <div><label>Monthly AI budget $ (0 = no limit)</label><input className="bg-input" type="number" step="1" value={s.aiMonthlyBudget} onChange={(e) => set('aiMonthlyBudget', e.target.value === '' ? 0 : Number(e.target.value))} />
        <div className="ink-faint" style={{ fontSize: '0.7rem', marginTop: 4 }}>New AI calls stop when this month's estimated spend reaches the budget. Nothing already done is affected.</div></div>
      <div className="ink-faint" style={{ fontSize: '0.7rem' }}>Example: market $0.27 → {s.snapMinPrice ? `$${Number(s.snapMinPrice).toFixed(2)}` : ''} (minimum). Market $4.74 → rounded up to the {s.snapEnding === 'cents' ? 'cent' : `next ${s.snapEnding.slice(1)}`} after markup.</div>
      <ListingSetup s={s} set={set} />
      <AiConnector />
    </section>
  );
}

// The Claude app connector: where to point it, and which AI apps currently have access.
function AiConnector() {
  const url = `${window.location.origin}/mcp`;
  const [grants, setGrants] = useState(null);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);
  const load = useCallback(async () => {
    const { data, error } = await supabase.auth.oauth.listGrants();
    if (error) { setErr(/not enabled|not found|404/i.test(error.message) ? 'Sign-in for AI apps is not switched on in Supabase yet (see the setup steps).' : error.message); setGrants([]); return; }
    setGrants(Array.isArray(data) ? data : []);
  }, []);
  useEffect(() => { load(); }, [load]);
  async function revoke(g) {
    if (!(await askConfirm(`Disconnect ${g.client?.name || 'this app'}? It loses access to CardDesk right away.`, { title: 'Disconnect app', confirmLabel: 'Disconnect', danger: true }))) return;
    const { error } = await supabase.auth.oauth.revokeGrant({ clientId: g.client.id });
    if (error) setErr(error.message); else load();
  }
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, display: 'grid', gap: 10 }}>
      <h3 className="display-font" style={{ margin: 0, fontSize: '1.1rem' }}>AI APP CONNECTOR</h3>
      <div className="ink-dim" style={{ fontSize: '0.75rem' }}>
        Let an AI app work CardDesk by chatting: review, price, approve, check and publish snapped cards; your collection and its alerts; prices and Best Offer on live listings; profit questions.
        Claude: Settings → Connectors → Add custom connector, paste this address, then sign in with CardDesk. Muse, Grok and other apps: give them this address and an access key from below.
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="bg-input" readOnly value={url} onFocus={(e) => e.target.select()} style={{ flex: 1, padding: '8px 10px', fontSize: '0.8rem' }} />
        <button className="btn-ghost" onClick={() => { navigator.clipboard?.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1500); }} style={{ padding: '8px 12px', fontSize: '0.75rem' }}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <div className="ink-faint" style={{ fontSize: '0.7rem' }}>Photos are still taken here on your phone; Claude works on the queue. Publishing always asks you first.</div>
      <div style={{ fontSize: '0.75rem' }}>
        <div className="ink-faint" style={{ letterSpacing: '0.1em', fontSize: '0.65rem', marginBottom: 4 }}>CONNECTED APPS</div>
        {grants === null ? <Loader size={13} className="spin ink-faint" /> : grants.length === 0 ? <div className="ink-faint">None connected.</div>
          : grants.map((g) => (
            <div key={g.client?.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <div style={{ flex: 1 }}>{g.client?.name || 'App'}<div className="ink-faint" style={{ fontSize: '0.65rem' }}>since {new Date(g.granted_at).toLocaleDateString()}</div></div>
              <button className="btn-ghost" onClick={() => revoke(g)} style={{ padding: '4px 10px', fontSize: '0.7rem' }}>Disconnect</button>
            </div>
          ))}
        {err && <div className="accent-amber" style={{ fontSize: '0.7rem', marginTop: 4 }}>{err}</div>}
      </div>
      <AccessKeys url={url} />
    </div>
  );
}

// Personal access keys for AI apps that can't run "Sign in with CardDesk" (Muse, Grok...).
function AccessKeys({ url }) {
  const [keys, setKeys] = useState(null);
  const [name, setName] = useState('Muse');
  const [fresh, setFresh] = useState(null);       // the new key, shown once
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);
  const call = async (method, body, qs = '') => {
    const res = await apiFetch(`/api/access-keys${qs}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
    return data;
  };
  const load = useCallback(async () => { try { setKeys((await call('GET')).keys || []); } catch (e) { setErr(e.message); setKeys([]); } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  async function create() {
    setBusy(true); setErr(null); setCopied(false);
    try { const r = await call('POST', { name }); setFresh(r.key); load(); } catch (e) { setErr(e.message); }
    setBusy(false);
  }
  async function revoke(k) {
    if (!(await askConfirm(`Revoke the key "${k.name}" (${k.prefix}…)? Any app using it loses access to CardDesk right away.`, { title: 'Revoke key', confirmLabel: 'Revoke key', danger: true }))) return;
    try { await call('DELETE', null, `?id=${encodeURIComponent(k.id)}`); if (fresh?.id === k.id) setFresh(null); load(); } catch (e) { setErr(e.message); }
  }
  return (
    <div style={{ fontSize: '0.75rem', display: 'grid', gap: 8 }}>
      <div className="ink-faint" style={{ letterSpacing: '0.1em', fontSize: '0.65rem' }}>ACCESS KEYS FOR OTHER AI APPS</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <input className="bg-input" aria-label="Name for the new key" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} style={{ flex: '1 1 140px', padding: '7px 10px', fontSize: '0.8rem' }} />
        <button className="btn-ghost" disabled={busy || !name.trim()} onClick={create} style={{ padding: '7px 12px', fontSize: '0.75rem' }}>{busy ? <Loader size={12} className="spin" /> : 'Create key'}</button>
      </div>
      {fresh && (
        <div role="status" style={{ border: '1.5px solid var(--leaf)', background: 'var(--good-wash)', padding: 10, display: 'grid', gap: 6 }}>
          <div><b>Your new key for {fresh.name}.</b> Copy it now: CardDesk won't show it again.</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input className="bg-input" readOnly aria-label="New access key" value={fresh.key} onFocus={(e) => e.target.select()} style={{ flex: 1, padding: '7px 10px', fontSize: '0.78rem', fontFamily: 'monospace' }} />
            <button className="btn-primary" onClick={() => { navigator.clipboard?.writeText(fresh.key); setCopied(true); }} style={{ padding: '7px 12px', fontSize: '0.75rem' }}>{copied ? 'Copied' : 'Copy key'}</button>
          </div>
          <div className="ink-dim">In the AI app, connect to <b>{url}</b> and enter this key where it asks for an API key or token (sent as "Authorization: Bearer" or "X-API-Key"). Use the app's secure credential box, not the chat.</div>
          <button className="btn-icon" onClick={() => setFresh(null)} style={{ justifySelf: 'start', fontSize: '0.72rem', textDecoration: 'underline' }}>I've saved it</button>
        </div>
      )}
      {keys === null ? <Loader size={13} className="spin ink-faint" /> : keys.length === 0 ? <div className="ink-faint">No keys yet.</div>
        : keys.map((k) => (
          <div key={k.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--line-soft)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>{k.name} <span className="ink-faint" style={{ fontFamily: 'monospace' }}>{k.prefix}…</span>
              <div className="ink-faint" style={{ fontSize: '0.65rem' }}>created {new Date(k.created_at).toLocaleDateString()} · {k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleString()}` : 'not used yet'}</div></div>
            <button className="btn-ghost" onClick={() => revoke(k)} aria-label={`Revoke key ${k.name}`} style={{ padding: '4px 10px', fontSize: '0.7rem' }}>Revoke</button>
          </div>
        ))}
      {err && <div className="accent-amber" style={{ fontSize: '0.7rem' }}>{err}</div>}
    </div>
  );
}

// eBay listing setup copied from the seller's own listings, plus the two choices that stay theirs.
function ListingSetup({ s, set }) {
  const [state, setState] = useState({ loading: true, templates: null, connected: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    apiFetch('/api/snap-publish').then((r) => r.json()).then((d) => setState({ loading: false, templates: d.templates || null, connected: !!d.connected }))
      .catch(() => setState({ loading: false, templates: null, connected: false }));
  }, []);
  async function learn() {
    setBusy(true); setErr(null);
    const r = await postJson('/api/snap-publish', { action: 'learn' }).catch((e) => ({ ok: false, data: { error: e.message } }));
    if (r.ok) setState((x) => ({ ...x, templates: r.data.templates })); else setErr(r.data.error || `Failed (${r.status})`);
    setBusy(false);
  }
  const t = state.templates;
  const p = t?.policies || {};
  const strip = (n) => (n || '').replace(/\s*\(\d+\)\s*$/, '');
  const row = (k, v) => v ? <div><span className="ink-faint">{k}: </span>{v}</div> : null;
  const tpl = t?.pokemon || t?.mtg;
  return (
    <div style={{ borderTop: '1px solid var(--line)', paddingTop: 12, display: 'grid', gap: 10 }}>
      <h3 className="display-font" style={{ margin: 0, fontSize: '1.1rem' }}>EBAY LISTING SETUP</h3>
      <div className="ink-dim" style={{ fontSize: '0.75rem' }}>New listings copy the setup of your own newest card listings (Yu-Gi-Oh!, One Piece, Lorcana and other games borrow it, with their own game details): category, condition codes, item details, ship-from location, return and payment policies, and Best Offer %.</div>
      {state.loading ? <Loader size={14} className="spin ink-faint" /> : !state.connected ? (
        <div className="accent-amber" style={{ fontSize: '0.8rem' }}>Connect your eBay account in Listings & Prices → Marketplaces first.</div>
      ) : (
        <>
          {t ? (
            <div style={{ fontSize: '0.75rem', display: 'grid', gap: 3, padding: 10, border: '1px solid var(--line)' }}>
              {row('Learned', `${new Date(t.learnedAt).toLocaleString()} from ${[t.pokemon && 'a Pokémon listing', t.mtg && 'a Magic listing'].filter(Boolean).join(' and ')}`)}
              {row('Category', tpl?.categoryId)}
              {row('Condition codes', t.conditions?.source === 'ebay' ? "from eBay's official list" : 'standard codes (eBay list unavailable)')}
              {row('Ships from', [tpl?.location, tpl?.postalCode].filter(Boolean).join(' '))}
              {row(`Under $${s.snapShipCutoff}`, strip(p.envelope?.name) || strip(p.parcel?.name))}
              {row(`$${s.snapShipCutoff} and up`, strip(p.parcel?.name) || strip(p.envelope?.name))}
              {row('Returns', strip(p.returnProfile?.name))}
            </div>
          ) : <div className="accent-amber" style={{ fontSize: '0.8rem' }}>Not learned yet. Publishing needs this once.</div>}
          <button className="btn-ghost" disabled={busy} onClick={learn} style={{ padding: '8px 12px', justifySelf: 'start', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {busy ? <Loader size={13} className="spin" /> : <RefreshCw size={13} />} {t ? 'Re-learn from my listings' : 'Learn from my eBay listings'}
          </button>
          {err && <div className="accent-red" style={{ fontSize: '0.75rem' }}>{err}</div>}
        </>
      )}
      <div style={{ display: 'grid', gap: 4 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, fontSize: '0.8rem', textTransform: 'none', letterSpacing: 0, color: 'var(--ink)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={s.snapAutoCrop !== false} onChange={(e) => set('snapAutoCrop', e.target.checked)} /> Straighten &amp; crop photos automatically
        </label>
        <div className="ink-faint" style={{ fontSize: '0.7rem' }}>Each snap is straightened and cropped so the card fills the photo, with white outside its corners. Uses the corners the AI already found while reading the card (no extra cost on snaps; about a cent for each photo you add later). The card itself is never retouched, the original is kept, and "Undo edit" on any photo puts it back.</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr 1fr', gap: 10, alignItems: 'end' }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', margin: 0, fontSize: '0.8rem', textTransform: 'none', letterSpacing: 0, color: 'var(--ink)' }}>
          <input type="checkbox" style={{ width: 'auto' }} checked={s.snapBestOffer !== false} onChange={(e) => set('snapBestOffer', e.target.checked)} /> Best Offer on new listings
        </label>
        <div><label htmlFor="bo-pct">Accept offers within %</label><input id="bo-pct" className="bg-input" type="number" step="1" min="1" max="50" disabled={s.snapBestOffer === false} value={s.snapBestOfferPct ?? 10} onChange={(e) => set('snapBestOfferPct', e.target.value === '' ? 10 : Number(e.target.value))} /></div>
        <div><label htmlFor="promo-pct">Promoted Listings ad rate %</label><input id="promo-pct" className="bg-input" type="number" step="0.1" min="0" max="20" value={s.snapPromotePct ?? 2} onChange={(e) => set('snapPromotePct', e.target.value === '' ? 0 : Number(e.target.value))} /></div>
        <div className="ink-faint" style={{ gridColumn: '1 / -1', fontSize: '0.7rem' }}>
          Best Offer: offers at {100 - (Number(s.snapBestOfferPct) || 10)}% of the price or more are accepted automatically, lower ones declined (a $10.00 card accepts $9.00 and up). Turn it off per listing in the Repricer.
          {' '}Promotion: each new listing joins your CardDesk Promoted Listings campaign; eBay charges the ad rate only when a promoted listing sells. 0 turns it off. The first time, reconnect eBay (Listings & Prices → Marketplaces) to allow promotions.
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 10 }}>
        <div><label htmlFor="ship-cutoff">Parcel from $</label><input id="ship-cutoff" className="bg-input" type="number" step="1" min="0" value={s.snapShipCutoff} onChange={(e) => set('snapShipCutoff', e.target.value === '' ? 20 : Number(e.target.value))} /></div>
        <div className="ink-faint" style={{ fontSize: '0.7rem', alignSelf: 'end' }}>Cards priced under this use your envelope shipping policy; at or above it, your parcel policy.</div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
        {[['pkg-oz', 'Weight (oz)', 'snapPackageWeightOz', 3], ['pkg-l', 'Length (in)', 'snapPackageLengthIn', 9], ['pkg-w', 'Width (in)', 'snapPackageWidthIn', 6], ['pkg-d', 'Depth (in)', 'snapPackageDepthIn', 1]].map(([id, label, key, d]) => (
          <div key={id}><label htmlFor={id}>{label}</label><input id={id} className="bg-input" type="number" step="0.5" min="0" value={s[key] ?? d} onChange={(e) => set(key, e.target.value === '' ? d : Number(e.target.value))} /></div>
        ))}
        <div className="ink-faint" style={{ gridColumn: '1 / -1', fontSize: '0.7rem' }}>The package each card ships in. eBay needs it to work out calculated shipping. Check the card again after changing it.</div>
      </div>
    </div>
  );
}

// Listings made on eBay before CardDesk: bring them in as live cards (nothing changes on eBay).
function ImportPanel({ onDone, onPhotosChanged }) {
  const [info, setInfo] = useState(null);
  const [fix, setFix] = useState(null);   // full-size photo refresh: { done, total, failed }
  const fixStarted = useRef(false);
  const [run, setRun] = useState(null);   // { done, total, failed: [] }
  const [err, setErr] = useState(null);
  const load = useCallback(async () => {
    const res = await apiFetch('/api/listing-import');
    const data = await res.json().catch(() => ({}));
    if (res.ok) setInfo(data); else setErr(data.error || `Couldn't check eBay listings (${res.status})`);
  }, []);
  useEffect(() => { load(); }, [load]);

  // Cards brought in before the fix have eBay's small preview photos. Swap in full-size ones once,
  // automatically (reads eBay and re-copies; nothing changes on eBay).
  useEffect(() => {
    const ids = info?.needsFullSize || [];
    if (!ids.length || fixStarted.current) return;
    fixStarted.current = true;
    (async () => {
      const failed = [];
      setFix({ done: 0, total: ids.length, failed });
      for (let i = 0; i < ids.length; i += 4) {
        const r = await postJson('/api/listing-import', { action: 'full_size', ids: ids.slice(i, i + 4) }).catch((e) => ({ ok: false, data: { error: e.message } }));
        if (!r.ok) { failed.push({ id: '', error: r.data.error || `stopped (${r.status})` }); break; }
        failed.push(...r.data.results.filter((x) => !x.ok));
        setFix({ done: Math.min(i + 4, ids.length), total: ids.length, failed: [...failed] });
      }
      onPhotosChanged?.();
      await onDone();
      setFix((x) => ({ ...x, finished: true }));
    })();
  }, [info]); // eslint-disable-line react-hooks/exhaustive-deps

  async function start() {
    const ids = info?.pending || [];
    setErr(null);
    const failed = [];
    setRun({ done: 0, total: ids.length, failed });
    for (let i = 0; i < ids.length; i += 4) {
      const r = await postJson('/api/listing-import', { item_ids: ids.slice(i, i + 4) }).catch((e) => ({ ok: false, data: { error: e.message } }));
      if (!r.ok) { setErr(r.data.error || `Import stopped (${r.status})`); break; }
      failed.push(...r.data.results.filter((x) => !x.ok));
      setRun({ done: Math.min(i + 4, ids.length), total: ids.length, failed: [...failed] });
    }
    await onDone();
    await load();
    setRun((x) => (x ? { ...x, finished: true } : x));
  }
  if (!info && !err) return null;
  const busy = run && !run.finished;
  if (info && !info.pending.length && !run && !err && !fix) return null;
  return (
    <div className="bg-card" style={{ padding: 12, display: 'grid', gap: 6, fontSize: '0.8rem' }}>
      {info && info.pending.length > 0 && !busy && (
        <>
          <div><b>{info.pending.length} of your eBay listings</b> {info.pending.length === 1 ? 'was' : 'were'} made before CardDesk. Bring them in to edit their photos, title and description here.</div>
          <div className="ink-faint" style={{ fontSize: '0.72rem' }}>Nothing changes on eBay: CardDesk reads each listing and copies its photos. Takes a minute or two; keep this page open.</div>
          <button className="btn-primary" onClick={start} style={{ padding: '8px 14px', justifySelf: 'start' }}>Bring in {info.pending.length} listing{info.pending.length === 1 ? '' : 's'}</button>
        </>
      )}
      {run && (
        <div role="status">
          {busy ? <><Loader size={12} className="spin" /> Bringing in listings: {run.done} of {run.total}…</> : <span className="accent-green">Brought in {run.done - run.failed.length} listing{run.done - run.failed.length === 1 ? '' : 's'}.</span>}
          <div style={{ height: 6, background: 'var(--well)', borderRadius: 3, marginTop: 6 }}><div style={{ height: 6, width: `${run.total ? (run.done / run.total) * 100 : 100}%`, background: 'var(--leaf)', borderRadius: 3, transition: 'width .3s' }} /></div>
          {run.failed.length > 0 && <div className="accent-amber" style={{ fontSize: '0.72rem', marginTop: 4 }}>{run.failed.length} couldn't be brought in (for example #{run.failed[0].item_id}: {run.failed[0].error}). Tap the button again to retry them.</div>}
        </div>
      )}
      {fix && (
        <div role="status" style={{ fontSize: '0.78rem' }}>
          {!fix.finished
            ? <><Loader size={12} className="spin" /> Getting full-size photos from eBay for listings you brought in: {fix.done} of {fix.total}…</>
            : <span className="accent-green">Full-size photos ready for {fix.done - fix.failed.length} listing{fix.done - fix.failed.length === 1 ? '' : 's'}. Straightened photos were redone from them.</span>}
          {fix.finished && fix.failed.length > 0 && <div className="accent-amber" style={{ fontSize: '0.72rem' }}>{fix.failed.length} couldn't be refreshed ({fix.failed[0].error}). Open this tab again to retry.</div>}
        </div>
      )}
      {err && <div className="accent-red" style={{ fontSize: '0.75rem' }}>{err}</div>}
    </div>
  );
}
