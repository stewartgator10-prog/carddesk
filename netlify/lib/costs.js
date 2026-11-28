// netlify/lib/costs.js
// Cost capture: what each card cost, so every sale can show real profit.
//  - importListings: one inventory card per copy of each active eBay listing (tied by item number)
//  - setCosts / estimateMissing: typed or estimated costs
//  - savePurchase / deletePurchase: one order's total (cards + shipping + tax) split across its cards
//  - setSaleCost / estimateSales: costs for sales that happened before inventory existed
// After any change, P&L is recomputed for the sales those cards are linked to.
import crypto from 'node:crypto';
import { recompute } from './ebay-orders.js';
import { splitCost, estimateCost, validCost } from './cost-split.js';

const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

async function must(p) {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

// Pure math lives in cost-split.js so the browser can use it too.
export { splitCost, estimateCost, validCost };

// ---------- recompute P&L for sales linked to these inventory cards ----------
async function recomputeFor(db, userId, inventoryIds) {
  if (!inventoryIds.length) return;
  const rows = await must(db.from('inventory').select('id, ebay_order_line_id').eq('user_id', userId).in('id', inventoryIds));
  const lineIds = rows.map((r) => r.ebay_order_line_id).filter(Boolean);
  if (!lineIds.length) return;
  const lines = await must(db.from('ebay_order_lines').select('order_id').eq('user_id', userId).in('line_item_id', lineIds));
  const orders = [...new Set(lines.map((l) => l.order_id))];
  if (orders.length) await recompute(db, userId, orders);
}

// ---------- current listings -> inventory ----------
export async function importListings(db, userId) {
  const listings = await must(db.from('ebay_listings').select('item_id, title, sku, price, quantity_available')
    .eq('user_id', userId).eq('status', 'Active'));
  const inv = await must(db.from('inventory').select('id, ebay_item_id, status').eq('user_id', userId).eq('status', 'In Stock'));
  const have = new Map();
  for (const r of inv) if (r.ebay_item_id) have.set(String(r.ebay_item_id), (have.get(String(r.ebay_item_id)) || 0) + 1);
  const rows = [];
  for (const l of listings) {
    const want = Math.max(1, Number(l.quantity_available) || 1);
    const missing = want - (have.get(String(l.item_id)) || 0);
    for (let i = 0; i < missing; i++) {
      rows.push({
        id: crypto.randomUUID(), user_id: userId, card_name: l.title || `eBay item ${l.item_id}`,
        status: 'In Stock', ebay_item_id: String(l.item_id), sku: l.sku || null,
        current_fmv: num(l.price), sale_channel: null,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 500) await must(db.from('inventory').insert(rows.slice(i, i + 500)));
  return { created: rows.length, listings: listings.length };
}

// ---------- typed and estimated costs ----------
export async function setCosts(db, userId, items) {
  const bad = items.find((it) => !it?.inventoryId || !validCost(it.cost));
  if (bad) throw Object.assign(new Error('Each item needs an inventoryId and a cost of 0 or more.'), { status: 400 });
  const ids = items.map((it) => it.inventoryId);
  const before = await must(db.from('inventory').select('id, purchase_id').eq('user_id', userId).in('id', ids));
  if (before.length !== new Set(ids).size) throw Object.assign(new Error('Some cards were not found.'), { status: 404 });
  for (const it of items) {
    await must(db.from('inventory').update({ cost_basis: round2(Number(it.cost)), cost_source: 'entered', purchase_id: null, updated_at: new Date().toISOString() })
      .eq('user_id', userId).eq('id', it.inventoryId));
  }
  // A card typed by hand leaves its purchase; the rest of that purchase is re-split.
  const touched = [...new Set(before.map((r) => r.purchase_id).filter(Boolean))];
  for (const pid of touched) await resplitPurchase(db, userId, pid);
  await recomputeFor(db, userId, ids);
  return { updated: items.length };
}

export async function estimateMissing(db, userId, { pct, inventoryIds = null }) {
  if (!(Number(pct) > 0 && Number(pct) <= 100)) throw Object.assign(new Error('pct must be between 0 and 100.'), { status: 400 });
  let q = db.from('inventory').select('id, current_fmv, sale_price, cost_basis').eq('user_id', userId).is('cost_basis', null);
  if (inventoryIds) q = q.in('id', inventoryIds);
  const rows = await must(q);
  let n = 0;
  for (const r of rows) {
    const cost = estimateCost(r.sale_price ?? r.current_fmv, pct);
    if (cost == null) continue;
    await must(db.from('inventory').update({ cost_basis: cost, cost_source: 'estimated', updated_at: new Date().toISOString() }).eq('user_id', userId).eq('id', r.id));
    n++;
  }
  await recomputeFor(db, userId, rows.map((r) => r.id));
  return { estimated: n, skipped: rows.length - n };
}

// ---------- purchases ----------
export async function resplitPurchase(db, userId, purchaseId) {
  const p = await must(db.from('purchases').select('*').eq('user_id', userId).eq('id', purchaseId).maybeSingle());
  if (!p) return { cards: 0 };
  const cards = await must(db.from('inventory').select('id, current_fmv, sale_price').eq('user_id', userId).eq('purchase_id', purchaseId));
  const split = splitCost(p.total_paid, cards.map((c) => ({ id: c.id, weight: c.current_fmv ?? c.sale_price })), p.split_method);
  for (const [id, cost] of split) {
    await must(db.from('inventory').update({ cost_basis: cost, cost_source: 'purchase', updated_at: new Date().toISOString() }).eq('user_id', userId).eq('id', id));
  }
  return { cards: cards.length, split };
}

export async function savePurchase(db, userId, { purchase, inventoryIds = [] }) {
  const total = Number(purchase?.total_paid);
  if (!validCost(total)) throw Object.assign(new Error('total_paid must be 0 or more.'), { status: 400 });
  const method = purchase.split_method === 'even' ? 'even' : 'market';
  const id = purchase.id || crypto.randomUUID();
  if (purchase.id) {
    const existing = await must(db.from('purchases').select('id').eq('user_id', userId).eq('id', id).maybeSingle());
    if (!existing) throw Object.assign(new Error('Purchase not found.'), { status: 404 });
  }
  const row = {
    id, user_id: userId, total_paid: round2(total), split_method: method,
    purchased_at: purchase.purchased_at || new Date().toISOString().slice(0, 10),
    source: purchase.source || null, notes: purchase.notes || null,
  };
  await must(db.from('purchases').upsert(row, { onConflict: 'id' }));

  let previous = [];
  if (inventoryIds.length) {
    const cards = await must(db.from('inventory').select('id, purchase_id').eq('user_id', userId).in('id', inventoryIds));
    if (cards.length !== new Set(inventoryIds).size) throw Object.assign(new Error('Some cards were not found.'), { status: 404 });
    previous = [...new Set(cards.map((c) => c.purchase_id).filter((p) => p && p !== id))];
    for (const c of cards) await must(db.from('inventory').update({ purchase_id: id }).eq('user_id', userId).eq('id', c.id));
  }
  const out = await resplitPurchase(db, userId, id);
  for (const pid of previous) await resplitPurchase(db, userId, pid); // cards moved out of another purchase
  const affected = await must(db.from('inventory').select('id').eq('user_id', userId).eq('purchase_id', id));
  await recomputeFor(db, userId, affected.map((r) => r.id));
  return { purchase: row, cards: out.cards };
}

export async function deletePurchase(db, userId, purchaseId) {
  const cards = await must(db.from('inventory').select('id').eq('user_id', userId).eq('purchase_id', purchaseId));
  for (const c of cards) {
    await must(db.from('inventory').update({ purchase_id: null, cost_basis: null, cost_source: null }).eq('user_id', userId).eq('id', c.id));
  }
  await must(db.from('purchases').delete().eq('user_id', userId).eq('id', purchaseId));
  await recomputeFor(db, userId, cards.map((c) => c.id));
  return { cleared: cards.length };
}

// ---------- past sales ----------
// Saves the cost as a sold inventory card linked to the sale, so the existing P&L
// (and next year's tax records) work the same as for cards bought after today.
export async function setSaleCost(db, userId, { lineItemId, cost, estimated = false }) {
  if (!validCost(cost)) throw Object.assign(new Error('cost must be 0 or more.'), { status: 400 });
  const line = await must(db.from('ebay_order_lines').select('*').eq('user_id', userId).eq('line_item_id', lineItemId).maybeSingle());
  if (!line) throw Object.assign(new Error('Sale not found.'), { status: 404 });
  const source = estimated ? 'estimated' : 'entered';
  if (line.inventory_id && ['auto', 'confirmed'].includes(line.match_status)) {
    await must(db.from('inventory').update({ cost_basis: round2(Number(cost)), cost_source: source, purchase_id: null }).eq('user_id', userId).eq('id', line.inventory_id));
  } else {
    const order = await must(db.from('ebay_orders').select('created_at_ebay').eq('user_id', userId).eq('order_id', line.order_id).maybeSingle());
    const id = crypto.randomUUID();
    await must(db.from('inventory').insert({
      id, user_id: userId, card_name: line.title || `eBay sale ${lineItemId}`, status: 'Sold',
      sold_at: (order?.created_at_ebay || new Date().toISOString()).slice(0, 10),
      sale_price: round2(Number(line.item_price || 0) + Number(line.shipping_charged || 0)), sale_channel: 'eBay',
      ebay_item_id: line.legacy_item_id || null, sku: line.sku || null, ebay_order_line_id: lineItemId,
      cost_basis: round2(Number(cost)), cost_source: source,
    }));
    await must(db.from('ebay_order_lines').update({ inventory_id: id, match_status: 'confirmed', match_method: 'manual', match_confidence: null })
      .eq('user_id', userId).eq('line_item_id', lineItemId));
  }
  await recompute(db, userId, [line.order_id]);
  return { lineItemId, cost: round2(Number(cost)), estimated };
}

export async function estimateSales(db, userId, { pct }) {
  if (!(Number(pct) > 0 && Number(pct) <= 100)) throw Object.assign(new Error('pct must be between 0 and 100.'), { status: 400 });
  const lines = await must(db.from('ebay_order_lines').select('line_item_id, gross, item_price, shipping_charged, match_status, order_id').eq('user_id', userId).eq('match_status', 'unmatched'));
  const orders = await must(db.from('ebay_orders').select('order_id, cancel_state').eq('user_id', userId));
  const cancelled = new Set(orders.filter((o) => o.cancel_state === 'CANCELED').map((o) => o.order_id));
  let n = 0;
  for (const l of lines) {
    if (cancelled.has(l.order_id)) continue;
    const cost = estimateCost(l.gross ?? Number(l.item_price || 0) + Number(l.shipping_charged || 0), pct);
    if (cost == null) continue;
    await setSaleCost(db, userId, { lineItemId: l.line_item_id, cost, estimated: true });
    n++;
  }
  return { estimated: n };
}
