// netlify/lib/ebay-orders.js
// Pulls a seller's eBay orders (Fulfillment API) and, optionally, money movements (Finances API),
// stores them, auto-marks matching inventory as sold and recomputes per-line P&L.
// Used by POST /api/ebay-sync-orders (the seller's button) and by the scheduled sale check for
// sellers with a card on two marketplaces. `fetchImpl` is injectable so tests never reach eBay.
import { normalizeOrder, normalizeTransaction, computeLinePnl, matchLinesToInventory } from './pnl.js';

const FULFILLMENT = 'https://api.ebay.com/sell/fulfillment/v1/order';
const FINANCES = 'https://apiz.ebay.com/sell/finances/v1/transaction';

export async function ebayGetAll(token, baseUrl, params, listKey, pageSize, fetchImpl = fetch) {
  const out = [];
  for (let offset = 0; offset < 20000; offset += pageSize) {
    const qs = new URLSearchParams({ ...params, limit: String(pageSize), offset: String(offset) });
    const res = await fetchImpl(`${baseUrl}?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US', Accept: 'application/json' },
    });
    if (!res.ok) {
      const detail = await res.text();
      const err = new Error(`eBay ${new URL(baseUrl).pathname} failed: ${res.status}`);
      err.status = res.status; err.detail = detail;
      throw err;
    }
    const data = await res.json();
    const page = data[listKey] || [];
    out.push(...page);
    if (page.length < pageSize || out.length >= (data.total ?? Infinity)) break;
  }
  return out;
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function must(p) {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
}

// Reads and stores orders changed since `fromIso`. withFinances=false (the scheduled sale check)
// skips the Finances API; the seller's own sync fills fees in later.
export async function syncEbayOrders({ db, userId, token, fromIso, toIso = new Date().toISOString(), withFinances = true, fetchImpl = fetch }) {
  // lastmodifieddate (not creationdate) so refunds/cancels on older orders come through.
  const rawOrders = await ebayGetAll(token, FULFILLMENT, { filter: `lastmodifieddate:[${fromIso}..]` }, 'orders', 200, fetchImpl);
  const rawTxns = withFinances
    ? await ebayGetAll(token, FINANCES, { filter: `transactionDate:[${fromIso}..${toIso}]` }, 'transactions', 1000, fetchImpl)
    : [];

  const orders = [], lines = [];
  for (const o of rawOrders) {
    const n = normalizeOrder(o, userId);
    orders.push({ ...n.order, updated_at: toIso });
    lines.push(...n.lines.map((l) => ({ ...l, updated_at: toIso })));
  }
  const txns = rawTxns.map((t) => ({ ...normalizeTransaction(t, userId), updated_at: toIso }));

  for (const c of chunk(orders, 200)) await must(db.from('ebay_orders').upsert(c, { onConflict: 'user_id,order_id' }));
  // Only order-derived columns are sent, so existing match/P&L columns are kept.
  for (const c of chunk(lines, 200)) await must(db.from('ebay_order_lines').upsert(c, { onConflict: 'user_id,line_item_id' }));
  for (const c of chunk(txns, 200)) await must(db.from('ebay_transactions').upsert(c, { onConflict: 'user_id,transaction_id,transaction_type' }));

  const touched = [...new Set([...orders.map((o) => o.order_id), ...txns.map((t) => t.order_id).filter(Boolean)])];
  const result = await recompute(db, userId, touched);
  return { orders, lines, txns, result };
}

// eBay order lines as marketplace sale lines (see netlify/lib/sell-once.js).
export function ebaySaleLines(orders, lines) {
  const byId = new Map(orders.map((o) => [o.order_id, o]));
  return lines.filter((l) => l.legacy_item_id).map((l) => {
    const o = byId.get(l.order_id) || {};
    const qty = Number(l.quantity) || 1;
    return {
      orderId: String(l.order_id), lineId: String(l.line_item_id), externalId: String(l.legacy_item_id), quantity: qty,
      price: l.item_price != null ? Math.round((Number(l.item_price) / qty) * 100) / 100 : null, currency: 'USD',
      at: o.created_at_ebay || null, status: o.cancel_state === 'CANCELED' ? 'cancelled' : 'paid',
      url: `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(l.order_id)}`,
    };
  });
}

export async function recompute(db, userId, orderIds) {
  if (!orderIds.length) return { autoMarkedSold: 0, suggested: 0, restocked: 0 };
  const allLines = [], allOrders = [], allTxns = [];
  for (const c of chunk(orderIds, 100)) {
    allOrders.push(...await must(db.from('ebay_orders').select('*').eq('user_id', userId).in('order_id', c)));
    allLines.push(...await must(db.from('ebay_order_lines').select('*').eq('user_id', userId).in('order_id', c)));
    allTxns.push(...await must(db.from('ebay_transactions').select('*').eq('user_id', userId).in('order_id', c)));
  }
  const inventory = await must(db.from('inventory')
    .select('id, card_name, status, cost_basis, cost_source, ebay_item_id, sku, ebay_order_line_id, created_at').eq('user_id', userId));
  const settingsRow = await must(db.from('settings').select('data').eq('user_id', userId).maybeSingle());
  const settings = settingsRow?.data || {};

  const orderById = new Map(allOrders.map((o) => [o.order_id, o]));

  // ---- cancelled after we marked the card sold: put it back in stock ----
  let restocked = 0;
  for (const l of allLines) {
    if (l.inventory_id && ['auto', 'confirmed'].includes(l.match_status) && orderById.get(l.order_id)?.cancel_state === 'CANCELED') {
      await releaseInventory(db, userId, l.inventory_id, l.line_item_id);
      const inv = inventory.find((i) => i.id === l.inventory_id);
      if (inv) Object.assign(inv, { status: 'In Stock', ebay_order_line_id: null });
      Object.assign(l, { inventory_id: null, match_status: 'unmatched', match_method: null, match_confidence: null });
      restocked++;
    }
  }

  // ---- match unmatched, non-cancelled lines to inventory ----
  const candidates = allLines
    .filter((l) => l.match_status === 'unmatched' && orderById.get(l.order_id)?.cancel_state !== 'CANCELED')
    .map((l) => ({ ...l, sold_at_hint: orderById.get(l.order_id)?.created_at_ebay || null }));
  const matches = matchLinesToInventory(candidates, inventory);
  let autoMarkedSold = 0, suggested = 0;
  for (const m of matches) {
    const line = allLines.find((l) => l.line_item_id === m.line_item_id);
    line.inventory_id = m.inventory_id;
    line.match_method = m.method;
    line.match_confidence = m.confidence;
    line.match_status = m.auto ? 'auto' : 'suggested';
    if (m.auto) {
      await markInventorySold(db, userId, m.inventory_id, line, orderById.get(line.order_id));
      autoMarkedSold++;
    } else suggested++;
  }

  // ---- P&L ----
  const invById = new Map(inventory.map((i) => [i.id, i]));
  const costByLine = new Map();
  const estimatedLines = new Set();
  for (const l of allLines) {
    if (l.inventory_id && ['auto', 'confirmed'].includes(l.match_status)) {
      const inv = invById.get(l.inventory_id);
      if (inv?.cost_basis != null) costByLine.set(l.line_item_id, Number(inv.cost_basis));
      if (inv?.cost_basis != null && inv.cost_source === 'estimated') estimatedLines.add(l.line_item_id);
    }
  }
  const pnl = computeLinePnl({ orders: allOrders, lines: allLines, txns: allTxns, costByLine, settings });
  const updates = pnl.map((r) => {
    const l = allLines.find((x) => x.line_item_id === r.line_item_id);
    return {
      user_id: userId, line_item_id: r.line_item_id, order_id: r.order_id,
      inventory_id: l.inventory_id, match_method: l.match_method, match_status: l.match_status, match_confidence: l.match_confidence,
      gross: r.gross, fees: r.fees, fee_source: r.fee_source, shipping_label: r.shipping_label, ad_fees: r.ad_fees,
      refunds: r.refunds, other: r.other, net_payout: r.net_payout, cost_basis: r.cost_basis, profit: r.profit, sold_at: r.sold_at,
      cost_estimated: estimatedLines.has(r.line_item_id),
      updated_at: new Date().toISOString(),
    };
  });
  for (const c of chunk(updates, 200)) await must(db.from('ebay_order_lines').upsert(c, { onConflict: 'user_id,line_item_id' }));
  return { autoMarkedSold, suggested, restocked };
}

export async function markInventorySold(db, userId, inventoryId, line, order) {
  await must(db.from('inventory').update({
    status: 'Sold',
    sold_at: (order?.created_at_ebay || new Date().toISOString()).slice(0, 10),
    sale_price: Number(line.item_price) + Number(line.shipping_charged || 0),
    sale_channel: 'eBay',
    ebay_order_line_id: line.line_item_id,
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId).eq('id', inventoryId));
}

// Undo markInventorySold, but only if the card is still linked to this sale.
export async function releaseInventory(db, userId, inventoryId, lineItemId) {
  await must(db.from('inventory').update({
    status: 'In Stock', sold_at: null, sale_price: null, sale_channel: null, ebay_order_line_id: null,
    updated_at: new Date().toISOString(),
  }).eq('user_id', userId).eq('id', inventoryId).eq('ebay_order_line_id', lineItemId));
}

