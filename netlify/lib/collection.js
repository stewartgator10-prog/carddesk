// netlify/lib/collection.js
// Collection: scan cards in (single, binder page or slab), value them every night, and raise an
// in-app alert when an item reaches its target price or growth %. An alerted item can be sent to
// Snap to List in one step.
import crypto from 'node:crypto';
import { readCard, readPage } from './card-vision.js';
import { lookupCard } from './card-catalog.js';
import { browseSearch } from './ebay-browse.js';
import { compQuery, filterCompetitors, summarizeComps } from './market.js';
import { usageRow, logUsage, checkBudget } from './ai-usage.js';
import { loadSnapSettings, BudgetError } from './snap-identify.js';
import { applyIdentification, buildTitle, buildDescription, suggestPrice, CATALOG_GAMES, CONFIDENCE_OK } from './snap-logic.js';

export const COLLECTION_DEFAULTS = { collectionAlertPct: 25 };
const round2 = (n) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const isEnglish = (lang) => /^english$/i.test(lang || 'English');

// ---------- value ----------
// Raw English cards of the catalog games: TCGplayer market (exact print only). Slabs: the middle
// price of eBay listings for the same grader and grade. Everything else: eBay listings for the raw card.
export async function valueRead(read, { ownSeller = null, deps = {} } = {}) {
  const flags = [];
  let catalog = null, market = null, source = null, key = null;
  if (read.is_trading_card && !read.graded && CATALOG_GAMES.includes(read.game) && isEnglish(read.language)) {
    catalog = await (deps.lookupCard || lookupCard)(read).catch(() => null);
    if (catalog?.versions > 1) flags.push('multiple_versions');
    if (catalog?.matchLevel === 'name') flags.push('name_only_match');
    else if (catalog?.marketPrice != null) { market = catalog.marketPrice; source = 'tcgplayer'; key = catalog.priceKey || null; }
  }
  if (market == null && read.is_trading_card && read.card_name) {
    const graded = !!(read.graded && read.grader && read.grade);
    if (read.graded && !graded) flags.push('grade_unread');
    else {
      try {
        const q = { ...read, graded, grader: graded ? read.grader : null, grade: graded ? read.grade : null };
        const res = await (deps.browseSearch || browseSearch)({ q: compQuery(q), limit: 50, fixedPriceOnly: true });
        const s = summarizeComps(filterCompetitors(res.items, q, ownSeller));
        if (s.comp_median != null) { market = s.comp_median; source = 'ebay_median'; key = graded ? `${read.grader} ${read.grade}` : null; flags.push('ebay_median'); }
      } catch { /* no eBay data: left unpriced */ }
    }
  }
  if (!read.is_trading_card) flags.push('not_a_card');
  if (!(read.confidence >= CONFIDENCE_OK)) flags.push('low_confidence');
  if (market == null) flags.push('no_price');
  return { catalog, market, source, key, flags: [...new Set(flags)] };
}

function itemFields(read, v) {
  const c = v.catalog;
  return {
    extraction: read, game: read.game, card_name: read.card_name, set_name: read.set_name, collector_number: read.collector_number,
    rarity: c?.rarity ?? read.rarity ?? null, finish: read.finish, variant: read.variant, language: read.language,
    condition: read.condition_guess && read.condition_guess !== 'unknown' ? read.condition_guess : 'NM',
    graded: !!read.graded, grader: read.grader || null, grade: read.grade || null,
    catalog_source: c?.source ?? null, catalog_id: c?.id ?? null, catalog_name: c?.name ?? null, catalog_set: c?.setName ?? null,
    catalog_number: c?.number ?? null, catalog_image_url: c?.imageUrl ?? null, catalog_url: c?.url ?? null,
    market_price: v.market, market_source: v.source, market_key: v.key, market_at: new Date().toISOString(), flags: v.flags,
  };
}

// ---------- alerts ----------
// Growth is measured from what was paid, or from the value on the day it was scanned when no cost
// was entered. An item's own target price or % overrides the collection default.
export function growthBase(item) {
  const cost = Number(item.cost);
  if (item.cost != null && cost > 0) return { base: cost, from: 'cost' };
  const added = Number(item.value_at_add);
  return item.value_at_add != null && added > 0 ? { base: added, from: 'added' } : { base: null, from: null };
}

export function checkAlert(item, settings = {}) {
  const price = Number(item.market_price);
  if (item.market_price == null || !(price > 0) || item.status !== 'held') return null;
  const money = (n) => `$${Number(n).toFixed(2)}`;
  if (item.target_price != null && Number(item.target_price) > 0 && price >= Number(item.target_price)) {
    return `Reached your target of ${money(item.target_price)} (now ${money(price)}).`;
  }
  const pct = item.target_pct != null ? Number(item.target_pct) : Number(settings.collectionAlertPct ?? COLLECTION_DEFAULTS.collectionAlertPct);
  const { base, from } = growthBase(item);
  if (pct > 0 && base) {
    const up = ((price - base) / base) * 100;
    if (up >= pct) return `Up ${Math.round(up)}% from ${from === 'cost' ? `what you paid (${money(base)})` : `${money(base)} when added`}; now ${money(price)}.`;
  }
  return null;
}

// New alert -> active. Still true -> unchanged (so a dismissal sticks). No longer true -> cleared.
export function nextAlertState(item, settings) {
  const reason = checkAlert(item, settings);
  if (reason && item.alert_state === 'none') return { alert_state: 'active', alert_reason: reason, alert_at: new Date().toISOString() };
  if (reason && item.alert_state === 'active' && reason !== item.alert_reason) return { alert_reason: reason };
  if (!reason && item.alert_state !== 'none') return { alert_state: 'none', alert_reason: null, alert_at: null };
  return null;
}

async function loadSettings(db, userId) {
  const row = await must(db.from('settings').select('data').eq('user_id', userId).maybeSingle());
  return { ...COLLECTION_DEFAULTS, ...(row?.data || {}) };
}

async function recordPrice(db, item, price, source) {
  if (price == null) return;
  await db.from('collection_prices').upsert([{ item_id: item.id, user_id: item.user_id, day: today(), price, source }], { onConflict: 'item_id,day' });
}

// ---------- scan ----------
export async function scanCollectionPhoto({ db, userId, photoPath, kind, deps = {} }) {
  if (!['page', 'single'].includes(kind)) throw fail('kind must be page or single', 400);
  if (!String(photoPath || '').startsWith(`${userId}/`)) throw fail('That photo does not belong to you.', 403);
  const settings = await loadSnapSettings(db, userId);
  const budget = await checkBudget(db, userId, settings);
  if (!budget.ok) throw new BudgetError(budget);
  const { data: blob, error } = await db.storage.from('snap-photos').download(photoPath);
  if (error || !blob) throw fail(`Couldn't open the photo: ${error?.message || 'missing'}`, 502);
  const image = { base64: Buffer.from(await blob.arrayBuffer()).toString('base64'), mediaType: blob.type || 'image/jpeg' };
  const model = settings.snapModel;
  let r;
  try {
    r = kind === 'page'
      ? await (deps.readPage || readPage)({ model, image })
      : await (deps.readCard || readCard)({ model, image }).then((x) => ({ ...x, cards: [{ ...x.read, position: 1, box: null }] }));
  } catch (err) {
    if (err.usage) await logUsage(db, usageRow({ userId, model, purpose: 'collection_scan', usage: err.usage, latencyMs: err.latencyMs, requestId: err.requestId, ok: false, error: err.message }));
    throw err;
  }
  const fee = usageRow({ userId, model, purpose: 'collection_scan', usage: r.usage, latencyMs: r.latencyMs, requestId: r.requestId });
  await logUsage(db, fee);
  const acct = await must(db.from('ebay_accounts').select('ebay_username').eq('user_id', userId).maybeSingle());
  const all = await loadSettings(db, userId);
  const rows = [];
  for (const card of r.cards) {
    const { position, box, ...read } = card;
    const v = await valueRead(read, { ownSeller: acct?.ebay_username, deps });
    const row = {
      id: crypto.randomUUID(), user_id: userId, photo_path: photoPath, photo_crop: kind === 'page' ? box : null, source: kind,
      ...itemFields(read, v), value_at_add: v.market, status: 'held', alert_state: 'none',
    };
    Object.assign(row, nextAlertState(row, all) || {});
    rows.push(row);
  }
  if (rows.length) {
    await must(db.from('collection_items').insert(rows));
    for (const row of rows) await recordPrice(db, row, row.market_price, row.market_source);
  }
  return { items: rows, cost: fee.cost_usd, cards_found: rows.length };
}

// Re-reads the price after the collector corrected the card's details.
export async function repriceItem({ db, userId, id, deps = {} }) {
  const item = await must(db.from('collection_items').select('*').eq('user_id', userId).eq('id', id).maybeSingle());
  if (!item) throw fail('Item not found.', 404);
  const read = { ...(item.extraction || {}), is_trading_card: true, game: item.game, card_name: item.card_name, set_name: item.set_name,
    collector_number: item.collector_number, rarity: item.rarity, finish: item.finish, variant: item.variant, language: item.language,
    graded: item.graded, grader: item.grader, grade: item.grade, confidence: 1 };
  const acct = await must(db.from('ebay_accounts').select('ebay_username').eq('user_id', userId).maybeSingle());
  const v = await valueRead(read, { ownSeller: acct?.ebay_username, deps });
  const patch = { ...itemFields(read, v), extraction: item.extraction };
  if (item.value_at_add == null && v.market != null) patch.value_at_add = v.market;
  Object.assign(patch, nextAlertState({ ...item, ...patch }, await loadSettings(db, userId)) || {});
  await must(db.from('collection_items').update(patch).eq('user_id', userId).eq('id', id));
  await recordPrice(db, { ...item, ...patch }, patch.market_price, patch.market_source);
  return { item: { ...item, ...patch } };
}

// ---------- nightly ----------
const STALE_MS = 20 * 3600e3;
export async function refreshCollection({ db, userId, force = false, maxItems = 200, deadlineMs = 25_000, deps = {} }) {
  const started = Date.now();
  const settings = await loadSettings(db, userId);
  const items = await must(db.from('collection_items').select('*').eq('user_id', userId).eq('status', 'held'));
  const due = items.filter((i) => force || !i.market_at || Date.now() - Date.parse(i.market_at) > STALE_MS)
    .sort((a, b) => String(a.market_at || '').localeCompare(String(b.market_at || '')));
  const acct = await must(db.from('ebay_accounts').select('ebay_username').eq('user_id', userId).maybeSingle());
  let processed = 0, alerts = 0;
  for (const item of due.slice(0, maxItems)) {
    if (Date.now() - started > deadlineMs) break;
    let patch;
    if (item.market_source === 'manual') patch = { market_at: new Date().toISOString() };     // the collector's own value is kept
    else {
      const read = { ...(item.extraction || {}), is_trading_card: true, game: item.game, card_name: item.card_name, set_name: item.set_name,
        collector_number: item.collector_number, rarity: item.rarity, finish: item.finish, variant: item.variant, language: item.language,
        graded: item.graded, grader: item.grader, grade: item.grade, confidence: 1 };
      const v = await valueRead(read, { ownSeller: acct?.ebay_username, deps }).catch(() => null);
      patch = { market_at: new Date().toISOString() };
      // A missed lookup keeps yesterday's value instead of wiping it.
      if (v?.market != null) Object.assign(patch, { market_price: v.market, market_source: v.source, market_key: v.key });
    }
    const after = { ...item, ...patch };
    const alert = nextAlertState(after, settings);
    if (alert?.alert_state === 'active') alerts += 1;
    await must(db.from('collection_items').update({ ...patch, ...(alert || {}) }).eq('user_id', userId).eq('id', item.id));
    await recordPrice(db, after, after.market_price, after.market_source);
    processed += 1;
  }
  return { processed, remaining: Math.max(0, due.length - processed), alerts };
}

// Re-checks alerts only (after the collector changes a target or the default %), without new prices.
export async function recheckAlerts({ db, userId }) {
  const settings = await loadSettings(db, userId);
  const items = await must(db.from('collection_items').select('*').eq('user_id', userId).eq('status', 'held'));
  let active = 0;
  for (const item of items) {
    const alert = nextAlertState(item, settings);
    if (alert) await must(db.from('collection_items').update(alert).eq('user_id', userId).eq('id', item.id));
    if ((alert?.alert_state ?? item.alert_state) === 'active') active += 1;
  }
  return { active };
}

// ---------- list it ----------
// Puts the card in the Snap to List queue, identified and priced, with its cost; the collection
// item is marked as listing. Binder-page cards still need their own photo before eBay.
export async function sendToSnap({ db, userId, id }) {
  const item = await must(db.from('collection_items').select('*').eq('user_id', userId).eq('id', id).maybeSingle());
  if (!item) throw fail('Item not found.', 404);
  if (item.status !== 'held') throw fail('This card is already being listed.');
  const settings = await loadSnapSettings(db, userId);
  const read = { ...(item.extraction || {}), card_name: item.card_name, set_name: item.set_name, collector_number: item.collector_number,
    rarity: item.rarity, finish: item.finish, variant: item.variant, language: item.language, condition_guess: item.condition,
    graded: item.graded, grader: item.grader, grade: item.grade, game: item.game, confidence: item.extraction?.confidence ?? 1, is_trading_card: true };
  const catalog = item.catalog_source ? { source: item.catalog_source, id: item.catalog_id, name: item.catalog_name, setName: item.catalog_set,
    number: item.catalog_number, imageUrl: item.catalog_image_url, url: item.catalog_url, rarity: item.rarity, marketPrice: item.market_price,
    matchLevel: (item.flags || []).includes('name_only_match') ? 'name' : 'exact', versions: (item.flags || []).includes('multiple_versions') ? 2 : 1 } : null;
  const snap = applyIdentification({ read, catalog, settings, ebayMedian: !catalog && item.market_price != null ? Number(item.market_price) : null });
  if (item.graded) snap.review_reasons = [...new Set([...snap.review_reasons, 'graded'])];
  if (item.photo_crop) snap.review_reasons = [...snap.review_reasons, 'page_photo'];
  if (snap.price == null && item.market_price != null) Object.assign(snap, { price: suggestPrice(Number(item.market_price), settings), market_price: Number(item.market_price) });
  snap.status = snap.review_reasons.length ? 'needs_review' : 'ready';
  snap.title = buildTitle({ ...snap, misprint_confirmed: false });
  snap.description = buildDescription({ ...snap, misprint_confirmed: false });
  const snapId = crypto.randomUUID();
  await must(db.from('snap_items').insert({
    ...snap, id: snapId, user_id: userId, batch_id: 'collection', photo_path: item.photo_path, photo_crop: item.photo_crop,
    model: settings.snapModel, identified_at: new Date().toISOString(),
    cost_basis: item.cost ?? null, cost_source: item.cost != null ? 'entered' : null,
  }));
  await must(db.from('collection_items').update({ status: 'listing', snap_item_id: snapId, alert_state: 'none', alert_reason: null, alert_at: null }).eq('user_id', userId).eq('id', id));
  return { snap_item_id: snapId, status: snap.status };
}
