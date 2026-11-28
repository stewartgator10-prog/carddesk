// netlify/lib/sell-once.js
// "Sell once": when a card sells on one marketplace, every other live listing of it comes down
// (or, with stock left, shows the new quantity), and the card says what happened.
//
// Each sale line is first inserted into marketplace_orders with "on conflict do nothing"; only a
// line that was new is acted on, so running the check twice, or from both sites at once, ends
// things once and records the sale once. Ending failures leave the listing active with last_error
// and are retried on every check (retryPendingEnds).
//
// decideSale() is pure; handleSales()/runSaleCheck() are the thin runners around it.
import { adapterFor, contextFor, ACCOUNT_MARKETPLACES, MARKETPLACE_LABELS } from './marketplaces/registry.js';
import { isMarketplaceError } from './marketplaces/errors.js';

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
  const orders = [...(decision.doubleSale && previous?.orders ? previous.orders : []), { marketplace, url: sale.url || null, orderId: sale.orderId }];
  return {
    marketplace, at: sale.at || new Date().toISOString(), price: sale.price ?? null, quantity: Math.max(1, Number(sale.quantity) || 1),
    quantity_left: decision.left, ended, updated, double_sale: !!decision.doubleSale, orders,
  };
}

// ---------- runner ----------
async function recordLine(db, userId, marketplace, s) {
  const row = {
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
  // CONFIRM (9): whether Whatnot puts the stock back itself on a cancelled order.
  if (existing.listing_id) {
    await must(db.from('marketplace_listings').update({ status: 'active', sold_at: null, updated_at: new Date().toISOString() })
      .eq('id', existing.listing_id).eq('status', 'sold'));
  }
  return { restored: true };
}

// Acts on sale lines from one marketplace. Returns counts and the problems the seller should see.
export async function handleSales({ db, userId, marketplace, sales, deps = {} }) {
  const out = { newSales: 0, ended: 0, updated: 0, doubleSales: 0, cancelled: 0, problems: [] };
  let todo = sales || [];
  if (marketplace === 'ebay' && todo.length) {
    // Only eBay listings of cards that are (or were) also on another marketplace matter here, so a
    // seller who never cross-lists does no extra work and nothing changes for them.
    const mine = await must(db.from('marketplace_listings').select('snap_item_id, marketplace, external_id').eq('user_id', userId));
    const cross = new Set(mine.filter((l) => l.marketplace !== 'ebay' && l.snap_item_id).map((l) => l.snap_item_id));
    const items = new Set(mine.filter((l) => l.marketplace === 'ebay' && cross.has(l.snap_item_id)).map((l) => String(l.external_id)));
    todo = todo.filter((x) => items.has(String(x.externalId)));
  }
  for (const s of todo) {
    if (!s?.orderId || !s?.lineId) continue;
    const existing = await must(db.from('marketplace_orders').select('*').eq('user_id', userId).eq('marketplace', marketplace)
      .eq('external_order_id', String(s.orderId)).eq('external_line_id', String(s.lineId)).maybeSingle());
    if (existing) {
      if (s.status === 'cancelled' && existing.status !== 'cancelled') { await handleCancel(db, userId, marketplace, s, existing); out.cancelled++; }
      continue;
    }
    const { isNew } = await recordLine(db, userId, marketplace, s);
    if (!isNew) continue;   // the other site (or a parallel run) got it first
    const nowIso = new Date().toISOString();
    const done = (patch = {}) => db.from('marketplace_orders').update({ handled_at: nowIso, ...patch }).eq('user_id', userId).eq('marketplace', marketplace)
      .eq('external_order_id', String(s.orderId)).eq('external_line_id', String(s.lineId));
    if (s.status === 'cancelled') { await done(); continue; }

    const listing = await findListing(db, userId, marketplace, s);
    if (!listing?.snap_item_id) { await done({ listing_id: listing?.id || null }); continue; }   // not one of our cards
    const listings = await must(db.from('marketplace_listings').select('*').eq('user_id', userId).eq('snap_item_id', listing.snap_item_id));
    // An eBay sale of a card that was never on another marketplace is left to the eBay sync as before.
    if (marketplace === 'ebay' && !listings.some((l) => l.marketplace !== 'ebay')) { await done({ listing_id: listing.id, snap_item_id: listing.snap_item_id }); continue; }
    const card = await must(db.from('snap_items').select('*').eq('id', listing.snap_item_id).eq('user_id', userId).maybeSingle());
    if (!card) { await done({ listing_id: listing.id }); continue; }
    // A sale from before the card went up on another marketplace was already counted in its stock.
    if (soldBeforeCrossListed(s, listings, marketplace)) { await done({ listing_id: listing.id, snap_item_id: card.id }); continue; }

    out.newSales++;
    const decision = decideSale({ card, listing, listings, soldQty: s.quantity });
    await must(db.from('marketplace_listings').update({ ...decision.listingPatch, ...(decision.listingPatch.status === 'sold' ? { sold_at: s.at || nowIso } : {}), updated_at: nowIso }).eq('id', listing.id));
    const ended = [], updated = [];
    for (const a of decision.actions) {
      const r = await apply(db, userId, a, deps);
      (a.kind === 'end' ? ended : updated).push(r);
      if (r.ok) out[a.kind === 'end' ? 'ended' : 'updated']++;
      else out.problems.push(`${MARKETPLACE_LABELS[r.marketplace]}: ${r.error}`);
    }
    if (decision.doubleSale) out.doubleSales++;
    const note = saleNote({ marketplace, sale: s, decision, ended, updated, previous: card.sale_note });
    await must(db.from('snap_items').update({ quantity: decision.left, sold_out_at: decision.left === 0 ? (card.sold_out_at || nowIso) : null, sale_note: note })
      .eq('id', card.id).eq('user_id', userId));
    if (decision.left === 0) await markInventorySold(db, userId, card, listing, marketplace, s);
    await done({ listing_id: listing.id, snap_item_id: card.id });
  }
  return out;
}

// Ends that failed earlier, tried again: listings still active for a card that has sold out.
export async function retryPendingEnds({ db, userId, deps = {} }) {
  const out = { ended: 0, problems: [] };
  const pending = await must(db.from('marketplace_listings').select('*').eq('user_id', userId).eq('status', 'active').not('last_error', 'is', null));
  for (const l of pending) {
    if (!l.snap_item_id) continue;
    const card = await must(db.from('snap_items').select('id, quantity, sold_out_at, sale_note').eq('id', l.snap_item_id).eq('user_id', userId).maybeSingle());
    if (!card || Number(card.quantity) > 0 || !card.sold_out_at) continue;
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
  const rows = await must(db.from('marketplace_listings').select('snap_item_id, marketplace, status').eq('user_id', userId).in('status', LIVE));
  const by = new Map();
  for (const r of rows) if (r.snap_item_id) by.set(r.snap_item_id, new Set([...(by.get(r.snap_item_id) || []), r.marketplace]));
  return [...by.values()].filter((s) => s.size > 1).length;
}

// The whole sale check for one seller: Whatnot orders, eBay orders when a card is on two
// marketplaces, then retries of earlier failed ends. Runs on every plan.
export async function runSaleCheck({ db, userId, deps = {}, includeEbay = null }) {
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
