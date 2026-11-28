// netlify/lib/sell-once.js
// "Sell once": when a card sells on one marketplace, every other live listing of it comes down
// (or, with stock left, shows the new quantity), and the card says what happened.
//
// Each sale line is first inserted into marketplace_orders with "on conflict do nothing"; only a
// line that was new is acted on, so running the check twice, or from both sites at once, ends
// things once and records the sale once. A line that stopped partway is finished by the next check
// from that table, whether or not the marketplace still returns it. Ending failures leave the
// listing active with last_error and are retried on every check (retryPendingEnds). Only one check
// per seller runs at a time (takeSaleLock).
//
// decideSale() is pure; handleSales()/runSaleCheck() are the thin runners around it.
import { adapterFor, contextFor, ACCOUNT_MARKETPLACES, MARKETPLACE_LABELS } from './marketplaces/registry.js';
import { isMarketplaceError } from './marketplaces/errors.js';
import { allRows, chunks } from './db-pages.js';
import { crossListedCards } from './sales-run.js';
import crypto from 'node:crypto';

const LIVE = ['active', 'ending'];
const CHANNEL = { whatnot: 'Whatnot', ebay: 'eBay', shopify: 'Shopify', tcgplayer: 'TCGplayer' };

async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
const sellerMessage = (e) => (isMarketplaceError(e) ? e.sellerMessage : 'Something went wrong. We\'ll try again on the next check.');

// ---------- pure decisions ----------
// card: snap_items row; listing: the one that sold; listings: every listing of the card.
export function decideSale({ card, listing, listings, soldQty = 1 }) {
  const before = Number.isFinite(Number(card?.quantity)) ? Number(card.quantity) : 1;
  const qty = Math.max(1, Number(soldQty) || 1);
  const left = Math.max(0, before - qty);
  const soldElsewhereAlready = listing.status === 'ended' && listing.ended_reason === 'sold_elsewhere';
  const doubleSale = before <= 0 || soldElsewhereAlready || before < qty;
  const others = listings.filter((l) => l.id !== listing.id && l.status === 'active');
  const listingLeft = Math.max(0, (listing.quantity ?? before) - qty);
  return {
    left,
    doubleSale,
    listingPatch: left === 0 || listingLeft === 0 ? { status: 'sold', quantity: 0 } : { quantity: listingLeft },
    actions: others.map((l) => (left === 0 ? { kind: 'end', listing: l } : { kind: 'update', listing: l, quantity: left })),
  };
}

export function soldBeforeCrossListed(sale, listings, marketplace) {
  const times = listings.filter((l) => l.marketplace !== marketplace).map((l) => Date.parse(l.listed_at || l.created_at || '')).filter(Number.isFinite);
  const at = Date.parse(sale.at || '');
  return times.length > 0 && Number.isFinite(at) && at < Math.min(...times) - 5 * 60_000;
}

// The card's note, written as a sentence by the app (src/lib/marketplace-text.js).
export function saleNote({ marketplace, sale, decision, ended = [], updated = [], previous = null }) {
  const orders = [...(decision.doubleSale && previous?.orders ? previous.orders : []), { marketplace, url: sale.url || null, orderId: sale.orderId, lineId: sale.lineId ?? null }];
  return {
    marketplace, at: sale.at || new Date().toISOString(), price: sale.price ?? null, quantity: Math.max(1, Number(sale.quantity) || 1),
    quantity_left: decision.left, ended, updated, double_sale: !!decision.doubleSale, orders,
  };
}

// ---------- runner ----------
async function recordLine(db, userId, marketplace, s, now = new Date().toISOString()) {
  const row = {
    claimed_at: now,
    user_id: userId, marketplace, external_order_id: String(s.orderId), external_line_id: String(s.lineId),
    quantity: Math.max(1, Number(s.quantity) || 1), item_price: s.price ?? null, status: s.status || null, ordered_at: s.at || null,
    raw: { externalId: s.externalId ?? null, cardId: s.cardId ?? null, url: s.url ?? null },
  };
  const inserted = await must(db.from('marketplace_orders')
    .upsert(row, { onConflict: 'user_id,marketplace,external_order_id,external_line_id', ignoreDuplicates: true }).select('external_line_id'));
  return { isNew: (inserted || []).length > 0, row };
}

async function findListing(db, userId, marketplace, s) {
  if (s.externalId) {
    const hit = await must(db.from('marketplace_listings').select('*').eq('user_id', userId).eq('marketplace', marketplace).eq('external_id', String(s.externalId)).maybeSingle());
    if (hit) return hit;
  }
  if (s.cardId) {   // Whatnot returns our card id as the product's external id
    const rows = await must(db.from('marketplace_listings').select('*').eq('user_id', userId).eq('marketplace', marketplace).eq('snap_item_id', String(s.cardId)));
    return rows.find((l) => LIVE.includes(l.status)) || rows[0] || null;
  }
  return null;
}

async function markReconnect(db, userId, marketplace, err) {
  if (err?.code !== 'reconnect' || !ACCOUNT_MARKETPLACES.includes(marketplace)) return;
  await db.from('marketplace_accounts').update({ status: 'reconnect', last_error: err.sellerMessage, updated_at: new Date().toISOString() })
    .eq('user_id', userId).eq('marketplace', marketplace);
}

// Runs one end/update on another marketplace and records the outcome on that listing.
async function apply(db, userId, action, deps) {
  const l = action.listing;
  const now = new Date().toISOString();
  try {
    const ctx = await contextFor(db, userId, l.marketplace, deps);
    const adapter = adapterFor(l.marketplace);
    if (action.kind === 'end') {
      await adapter.endListing(ctx, l, { reason: 'sold_elsewhere' });
      await must(db.from('marketplace_listings').update({ status: 'ended', ended_reason: 'sold_elsewhere', ended_at: now, last_error: null, quantity: 0, updated_at: now }).eq('id', l.id));
    } else {
      const r = await adapter.updateListing(ctx, l, { quantity: action.quantity });
      await must(db.from('marketplace_listings').update({ quantity: r.quantity ?? action.quantity, last_error: null, synced_at: now, updated_at: now }).eq('id', l.id));
    }
    return { marketplace: l.marketplace, ok: true };
  } catch (e) {
    await markReconnect(db, userId, l.marketplace, e);
    const error = sellerMessage(e);
    await db.from('marketplace_listings').update({ last_error: error, updated_at: now }).eq('id', l.id);
    return { marketplace: l.marketplace, ok: false, error };
  }
}

async function markInventorySold(db, userId, card, listing, marketplace, sale) {
  if (marketplace === 'ebay') return;   // eBay sales go through recompute()/markInventorySold already
  let invId = listing.inventory_id;
  if (!invId && card.ebay_item_id) invId = (await must(db.from('inventory').select('id').eq('user_id', userId).eq('ebay_item_id', card.ebay_item_id)))[0]?.id;
  if (!invId) return;
  await must(db.from('inventory').update({
    status: 'Sold', sold_at: String(sale.at || new Date().toISOString()).slice(0, 10), sale_price: sale.price ?? null,
    sale_channel: CHANNEL[marketplace] || marketplace, updated_at: new Date().toISOString(),
  }).eq('user_id', userId).eq('id', invId).neq('status', 'Sold'));
}

async function handleCancel(db, userId, marketplace, s, existing) {
  await must(db.from('marketplace_orders').update({ status: 'cancelled' }).eq('user_id', userId).eq('marketplace', marketplace)
    .eq('external_order_id', existing.external_order_id).eq('external_line_id', existing.external_line_id));
  if (!existing.handled_at || !existing.snap_item_id) return { restored: false };
  const card = await must(db.from('snap_items').select('*').eq('id', existing.snap_item_id).eq('user_id', userId).maybeSingle());
  if (!card) return { restored: false };
  const note = card.sale_note || {};
  const endedSomething = (note.ended || []).some((e) => e.ok);
  if (endedSomething) {
    // Listings elsewhere are already down: say so and let the seller relist; never relist on our own.
    await must(db.from('snap_items').update({ sale_note: { ...note, cancelled: true } }).eq('id', card.id).eq('user_id', userId));
    return { restored: false };
  }
  const qty = Math.max(1, Number(existing.quantity) || 1);
  await must(db.from('snap_items').update({ quantity: Math.max(0, Number(card.quantity) || 0) + qty, sold_out_at: null, sale_note: { ...note, cancelled: true, restored: true } })
    .eq('id', card.id).eq('user_id', userId));
  // CONFIRM: the spec doesn't say whether Whatnot puts the stock back itself on a cancelled order.
  if (existing.listing_id) {
    await must(db.from('marketplace_listings').update({ status: 'active', sold_at: null, updated_at: new Date().toISOString() })
      .eq('id', existing.listing_id).eq('status', 'sold'));
  }
  return { restored: true };
}

// A line claimed this long ago and still not handled is from a check that failed or was cut off
// by the time limit; the next check takes it over.
export const STALE_LINE_MS = 15 * 60_000;

// Takes a recorded but unfinished line for this run. Only one run can win: the update matches the
// claim it read, so a parallel run that got there first leaves nothing to update.
async function claimLine(db, userId, marketplace, existing, now) {
  const claimedAt = existing.claimed_at ? Date.parse(existing.claimed_at) : 0;
  if (existing.claimed_at && Date.now() - claimedAt < STALE_LINE_MS) return false;   // another check is on it
  let q = db.from('marketplace_orders').update({ claimed_at: now }).eq('user_id', userId).eq('marketplace', marketplace)
    .eq('external_order_id', existing.external_order_id).eq('external_line_id', existing.external_line_id).is('handled_at', null);
  q = existing.claimed_at ? q.eq('claimed_at', existing.claimed_at) : q.is('claimed_at', null);
  return (await must(q.select('external_line_id'))).length > 0;
}

// Every listing of the cards that are (or were) on a marketplace other than eBay, paged past the
// 1,000-row cap: the few non-eBay rows first, then only those cards' eBay rows.
async function crossListedRows(db, userId) {
  const others = await allRows(() => db.from('marketplace_listings').select('id, snap_item_id, marketplace, external_id').eq('user_id', userId).neq('marketplace', 'ebay').order('id'));
  const ids = [...new Set(others.filter((l) => l.snap_item_id).map((l) => l.snap_item_id))];
  const ebay = [];
  for (const part of chunks(ids)) ebay.push(...await allRows(() => db.from('marketplace_listings').select('id, snap_item_id, marketplace, external_id').eq('user_id', userId).eq('marketplace', 'ebay').in('snap_item_id', part).order('id')));
  return { others, ebay };
}

// A line we recorded earlier, rebuilt as a sale line, so it is finished even when the marketplace no
// longer returns it (an older order, or one past the look-back).
export function lineFromRow(r) {
  return {
    orderId: r.external_order_id, lineId: r.external_line_id, quantity: r.quantity, price: r.item_price ?? null, status: r.status || null,
    at: r.ordered_at || null, externalId: r.raw?.externalId ?? null, cardId: r.raw?.cardId ?? null, url: r.raw?.url ?? null,
  };
}

// Acts on sale lines from one marketplace, then on any line recorded earlier and not finished
// (whatever the marketplace returned this time). Returns counts and the problems the seller should see.
export async function handleSales({ db, userId, marketplace, sales, deps = {} }) {
  const out = { newSales: 0, ended: 0, updated: 0, doubleSales: 0, cancelled: 0, problems: [] };
  let todo = sales || [];
  if (marketplace === 'ebay' && todo.length) {
    // Only eBay listings of cards that are (or were) also on another marketplace matter here, so a
    // seller who never cross-lists does no extra work and nothing changes for them.
    const { ebay } = await crossListedRows(db, userId);
    const items = new Set(ebay.map((l) => String(l.external_id)));
    todo = todo.filter((x) => items.has(String(x.externalId)));
  }
  const key = (x) => `${x.orderId}|${x.lineId}`;
  const seen = new Set(todo.filter((x) => x?.orderId && x?.lineId).map(key));
  const unfinished = await must(db.from('marketplace_orders').select('*').eq('user_id', userId).eq('marketplace', marketplace).is('handled_at', null));
  const leftover = unfinished.filter((r) => r.status !== 'cancelled').map(lineFromRow).filter((x) => !seen.has(key(x)));
  for (const s of [...todo, ...leftover]) {
    if (!s?.orderId || !s?.lineId) continue;
    const r = await handleOne({ db, userId, marketplace, s, deps });
    for (const k of ['newSales', 'ended', 'updated', 'doubleSales', 'cancelled']) out[k] += r[k] || 0;
    out.problems.push(...(r.problems || []));
  }
  return out;
}

async function handleOne({ db, userId, marketplace, s, deps }) {
  const nowIso = new Date().toISOString();
  const existing = await must(db.from('marketplace_orders').select('*').eq('user_id', userId).eq('marketplace', marketplace)
    .eq('external_order_id', String(s.orderId)).eq('external_line_id', String(s.lineId)).maybeSingle());
  let retry = false;
  let cancelled = 0;
  if (existing) {
    if (s.status === 'cancelled' && existing.status !== 'cancelled') { await handleCancel(db, userId, marketplace, s, existing); cancelled = 1; }
    if (existing.handled_at || existing.status === 'cancelled' || s.status === 'cancelled') return { cancelled };
    // Recorded by an earlier check that stopped partway: finish it now.
    if (!(await claimLine(db, userId, marketplace, existing, nowIso))) return {};
    retry = true;
  } else {
    const { isNew } = await recordLine(db, userId, marketplace, s, nowIso);
    if (!isNew) return {};   // the other site (or a parallel run) got it first
  }
  const done = (patch = {}) => must(db.from('marketplace_orders').update({ handled_at: new Date().toISOString(), ...patch }).eq('user_id', userId).eq('marketplace', marketplace)
    .eq('external_order_id', String(s.orderId)).eq('external_line_id', String(s.lineId)));
  try {
    return await handleLine({ db, userId, marketplace, s, deps, done, retry, nowIso });
  } catch (e) {
    // Let the next check take the line over straight away instead of waiting for the claim to expire.
    await db.from('marketplace_orders').update({ claimed_at: null }).eq('user_id', userId).eq('marketplace', marketplace)
      .eq('external_order_id', String(s.orderId)).eq('external_line_id', String(s.lineId)).is('handled_at', null);
    throw e;
  }
}

const sameLine = (marketplace, s) => (o) => o.marketplace === marketplace && String(o.orderId) === String(s.orderId) && String(o.lineId ?? s.lineId) === String(s.lineId);
const loadCard = (db, userId, id) => must(db.from('snap_items').select('*').eq('id', id).eq('user_id', userId).maybeSingle());
const loadListings = (db, userId, cardId) => must(db.from('marketplace_listings').select('*').eq('user_id', userId).eq('snap_item_id', cardId));

// Merges this sale's end/stock results into the card's note (as it is now: another sale of the
// same card may have written its own since), keeping entries for other marketplaces.
async function finishNote(db, userId, cardId, marketplace, s, { ended, updated }) {
  const card = await loadCard(db, userId, cardId);
  const note = card?.sale_note;
  if (!note || !(note.orders || []).some(sameLine(marketplace, s))) return;
  const merge = (old = [], mine = []) => [...old.filter((e) => !mine.some((m) => m.marketplace === e.marketplace)), ...mine];
  await must(db.from('snap_items').update({ sale_note: { ...note, ended: merge(note.ended, ended), updated: merge(note.updated, updated) } }).eq('id', cardId).eq('user_id', userId));
}

// One sale line, after this run has claimed it. The card's stock is taken first, in one update that
// only applies if the stock is still what we read: two sales of one card handled at the same time
// (a Whatnot check and an eBay sync) can't both see the last unit, so the second is the double sale
// and its note lists both orders. `retry`: an earlier check recorded this line and stopped partway.
async function handleLine({ db, userId, marketplace, s, deps, done, retry, nowIso }) {
  const out = { newSales: 0, ended: 0, updated: 0, doubleSales: 0, problems: [] };
  if (s.status === 'cancelled') { await done(); return out; }
  const listing0 = await findListing(db, userId, marketplace, s);
  if (!listing0?.snap_item_id) { await done({ listing_id: listing0?.id || null }); return out; }   // not one of our cards
  let listings = await loadListings(db, userId, listing0.snap_item_id);
  // An eBay sale of a card that was never on another marketplace is left to the eBay sync as before.
  if (marketplace === 'ebay' && !listings.some((l) => l.marketplace !== 'ebay')) { await done({ listing_id: listing0.id, snap_item_id: listing0.snap_item_id }); return out; }
  let card = await loadCard(db, userId, listing0.snap_item_id);
  if (!card) { await done({ listing_id: listing0.id }); return out; }
  // A sale from before the card went up on another marketplace was already counted in its stock.
  if (soldBeforeCrossListed(s, listings, marketplace)) { await done({ listing_id: listing0.id, snap_item_id: card.id }); return out; }

  // 1. Take the sale off the card's stock (unless an earlier try already did: its note has this order).
  let decision = null;
  for (let attempt = 0; ; attempt++) {
    if ((card.sale_note?.orders || []).some(sameLine(marketplace, s))) break;
    const listing = listings.find((l) => l.id === listing0.id) || listing0;
    decision = decideSale({ card, listing, listings, soldQty: s.quantity });
    const note = saleNote({ marketplace, sale: s, decision, previous: card.sale_note });
    const won = await must(db.from('snap_items').update({ quantity: decision.left, sold_out_at: decision.left === 0 ? (card.sold_out_at || nowIso) : null, sale_note: note })
      .eq('id', card.id).eq('user_id', userId).eq('quantity', card.quantity).select('id'));
    if (won.length) { card = { ...card, quantity: decision.left, sale_note: note }; break; }
    if (attempt >= 4) throw new Error('The card kept changing while we recorded the sale. We\'ll try again on the next check.');
    decision = null;
    card = await loadCard(db, userId, card.id);
    listings = await loadListings(db, userId, card.id);
    if (!card) { await done({ listing_id: listing0.id }); return out; }
  }
  const left = decision ? decision.left : Math.max(0, Number(card.quantity) || 0);
  if (decision) { out.newSales++; if (decision.doubleSale) out.doubleSales++; }

  // 2. The listing that sold, then every other live listing: end it (none left) or show the new count.
  const sold = listings.find((l) => l.id === listing0.id) || listing0;
  const patch = decision ? decision.listingPatch : left === 0 ? { status: 'sold', quantity: 0 } : null;
  if (patch && !(sold.status === 'sold' && patch.status === 'sold')) {
    await must(db.from('marketplace_listings').update({ ...patch, ...(patch.status === 'sold' ? { sold_at: s.at || nowIso } : {}), updated_at: nowIso }).eq('id', sold.id));
  }
  const others = listings.filter((l) => l.id !== sold.id && l.status === 'active');
  const actions = others.filter((l) => left === 0 || Number(l.quantity) !== left).map((l) => (left === 0 ? { kind: 'end', listing: l } : { kind: 'update', listing: l, quantity: left }));
  // Listings an earlier try already ended for this sale still belong in the note.
  const ended = retry && left === 0 ? listings.filter((l) => l.id !== sold.id && l.status === 'ended' && l.ended_reason === 'sold_elsewhere').map((l) => ({ marketplace: l.marketplace, ok: true })) : [];
  const updated = [];
  for (const a of actions) {
    const r = await apply(db, userId, a, deps);
    (a.kind === 'end' ? ended : updated).push(r);
    if (r.ok) out[a.kind === 'end' ? 'ended' : 'updated']++;
    else out.problems.push(`${MARKETPLACE_LABELS[r.marketplace]}: ${r.error}`);
  }
  // 3. The note says what happened, then the stock row is marked sold.
  await finishNote(db, userId, card.id, marketplace, s, { ended, updated });
  if (left === 0) await markInventorySold(db, userId, card, sold, marketplace, s);
  await done({ listing_id: sold.id, snap_item_id: card.id });
  return out;
}

// Ends and stock changes that failed earlier, tried again: a listing still up for a card that has
// sold out is ended; a listing still showing old stock after a sale gets the card's count.
export async function retryPendingEnds({ db, userId, deps = {} }) {
  const out = { ended: 0, updated: 0, problems: [] };
  const pending = await must(db.from('marketplace_listings').select('*').eq('user_id', userId).eq('status', 'active').not('last_error', 'is', null));
  for (const l of pending) {
    if (!l.snap_item_id) continue;
    const card = await must(db.from('snap_items').select('id, quantity, sold_out_at, sale_note').eq('id', l.snap_item_id).eq('user_id', userId).maybeSingle());
    if (!card) continue;
    const left = Number(card.quantity);
    if (left > 0 && !card.sold_out_at) {
      if (!Number.isFinite(left) || Number(l.quantity) === left) continue;
      const r = await apply(db, userId, { kind: 'update', listing: l, quantity: left }, deps);
      const note = card.sale_note;
      if (note?.updated) {
        const updated = [...note.updated.filter((e) => e.marketplace !== l.marketplace), r];
        await must(db.from('snap_items').update({ sale_note: { ...note, updated } }).eq('id', card.id).eq('user_id', userId));
      }
      if (r.ok) out.updated++; else out.problems.push(`${MARKETPLACE_LABELS[l.marketplace]}: ${r.error}`);
      continue;
    }
    if (left > 0 || !card.sold_out_at) continue;
    const r = await apply(db, userId, { kind: 'end', listing: l }, deps);
    const note = card.sale_note || {};
    const ended = [...(note.ended || []).filter((e) => e.marketplace !== l.marketplace), r];
    await must(db.from('snap_items').update({ sale_note: { ...note, ended } }).eq('id', card.id).eq('user_id', userId));
    if (r.ok) out.ended++; else out.problems.push(`${MARKETPLACE_LABELS[l.marketplace]}: ${r.error}`);
  }
  return out;
}

// Cards live on two or more marketplaces at once.
export async function crossListedCount(db, userId) {
  return (await crossListedCards(db, userId)).length;
}

// One sale check per seller at a time. Scheduled runs start every 5 minutes and can run longer, and
// "Check for sales now" can start one too, so each check holds a lease on the seller first. The
// lease runs out on its own (SALE_LOCK_MS, the longest a background function runs), so a check that
// was cut off never blocks the next one for long.
export const SALE_LOCK_MS = 15 * 60_000;

export async function takeSaleLock(db, userId, { holder = crypto.randomUUID(), now = Date.now(), leaseMs = SALE_LOCK_MS } = {}) {
  const until = new Date(now + leaseMs).toISOString();
  const row = { user_id: userId, holder, locked_until: until, updated_at: new Date(now).toISOString() };
  const made = await must(db.from('marketplace_sale_locks').upsert(row, { onConflict: 'user_id', ignoreDuplicates: true }).select('user_id'));
  if (made.length) return holder;
  // Someone holds (or held) it: take it over only once their lease has run out.
  const taken = await must(db.from('marketplace_sale_locks').update({ holder, locked_until: until, updated_at: row.updated_at })
    .eq('user_id', userId).lt('locked_until', new Date(now).toISOString()).select('user_id'));
  return taken.length ? holder : null;
}

export async function releaseSaleLock(db, userId, holder) {
  const at = new Date(Date.now() - 1000).toISOString();   // already run out: free for the next check
  await db.from('marketplace_sale_locks').update({ locked_until: at, updated_at: new Date().toISOString() }).eq('user_id', userId).eq('holder', holder);
}

// The whole sale check for one seller: Whatnot orders, eBay orders when a card is on two
// marketplaces, then retries of earlier failed ends. Runs on every plan. Returns { busy: true }
// without doing anything when another check for this seller is still running.
export async function runSaleCheck({ db, userId, deps = {}, includeEbay = null }) {
  const holder = await takeSaleLock(db, userId);
  if (!holder) return { busy: true, checked: [], newSales: 0, ended: 0, updated: 0, doubleSales: 0, problems: [] };
  try { return await saleCheck({ db, userId, deps, includeEbay }); } finally { await releaseSaleLock(db, userId, holder).catch(() => {}); }
}

async function saleCheck({ db, userId, deps, includeEbay }) {
  const startedAt = new Date().toISOString();
  const res = { checked: [], newSales: 0, ended: 0, updated: 0, doubleSales: 0, problems: [] };
  const add = (r) => { for (const k of ['newSales', 'ended', 'updated', 'doubleSales']) res[k] += r[k] || 0; res.problems.push(...(r.problems || [])); };
  const accounts = await must(db.from('marketplace_accounts').select('*').eq('user_id', userId));
  for (const acct of accounts) {
    if (acct.status !== 'connected') { res.problems.push(`${MARKETPLACE_LABELS[acct.marketplace]}: ${acct.last_error || 'reconnect to see sales'}`); continue; }
    try {
      const ctx = await contextFor(db, userId, acct.marketplace, { ...deps, accounts: { ...(deps.accounts || {}), [acct.marketplace]: acct } });
      const sales = await adapterFor(acct.marketplace).fetchSales(ctx, { since: acct.sales_checked_at });
      add(await handleSales({ db, userId, marketplace: acct.marketplace, sales, deps }));
      await must(db.from('marketplace_accounts').update({ sales_checked_at: startedAt, last_error: null, updated_at: startedAt }).eq('id', acct.id));
      res.checked.push(acct.marketplace);
    } catch (e) {
      await markReconnect(db, userId, acct.marketplace, e);
      if (!isMarketplaceError(e) || e.code !== 'reconnect') await db.from('marketplace_accounts').update({ last_error: sellerMessage(e), updated_at: startedAt }).eq('id', acct.id);
      res.problems.push(`${MARKETPLACE_LABELS[acct.marketplace]}: ${sellerMessage(e)}`);
    }
  }
  const wantEbay = includeEbay ?? (await crossListedCount(db, userId)) > 0;
  if (wantEbay) {
    try {
      const ctx = await contextFor(db, userId, 'ebay', deps);
      const sales = await adapterFor('ebay').fetchSales(ctx, {});
      add(await handleSales({ db, userId, marketplace: 'ebay', sales, deps }));
      res.checked.push('ebay');
    } catch (e) { res.problems.push(`eBay: ${sellerMessage(e)}`); }
  }
  add(await retryPendingEnds({ db, userId, deps }));
  return res;
}
