// netlify/functions/ebay-sync-orders.js
// POST /api/ebay-sync-orders   body: { days?: number }
// Pulls the signed-in seller's eBay orders (Fulfillment API) and money
// movements (Finances API), stores them in Supabase, auto-marks matching
// inventory as sold, and recomputes per-line P&L.

import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, getSellerAccessToken } from '../lib/ebay-seller.js';
import { normalizeOrder, normalizeTransaction, computeLinePnl, matchLinesToInventory } from '../lib/pnl.js';

const FULFILLMENT = 'https://api.ebay.com/sell/fulfillment/v1/order';
const FINANCES = 'https://apiz.ebay.com/sell/finances/v1/transaction';
const FIRST_SYNC_DAYS = 90;   // how far back the very first sync looks
const OVERLAP_HOURS = 72;     // re-read this much before the last sync to catch late fees/refunds

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

async function ebayGetAll(token, baseUrl, params, listKey, pageSize) {
  const out = [];
  for (let offset = 0; offset < 20000; offset += pageSize) {
    const qs = new URLSearchParams({ ...params, limit: String(pageSize), offset: String(offset) });
    const res = await fetch(`${baseUrl}?${qs}`, {
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

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();

  try {
    const body = await req.json().catch(() => ({}));
    const account = await must(db.from('ebay_accounts').select('orders_synced_at').eq('user_id', userId).maybeSingle());
    if (!account) return json({ error: 'Connect your eBay seller account first.' }, 409);

    const now = new Date();
    let from;
    if (body.days) from = new Date(now - Math.min(Number(body.days), 730) * 864e5);
    else if (account.orders_synced_at) from = new Date(new Date(account.orders_synced_at) - OVERLAP_HOURS * 36e5);
    else from = new Date(now - FIRST_SYNC_DAYS * 864e5);
    const fromIso = from.toISOString(), toIso = now.toISOString();

    const token = await getSellerAccessToken(db, userId);

    // lastmodifieddate (not creationdate) so refunds/cancels on older orders come through.
    const rawOrders = await ebayGetAll(token, FULFILLMENT,
      { filter: `lastmodifieddate:[${fromIso}..]` }, 'orders', 200);
    const rawTxns = await ebayGetAll(token, FINANCES,
      { filter: `transactionDate:[${fromIso}..${toIso}]` }, 'transactions', 1000);

    // ---- store raw-ish data ----
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

    // ---- recompute for every order touched by this sync ----
    const touched = [...new Set([...orders.map((o) => o.order_id), ...txns.map((t) => t.order_id).filter(Boolean)])];
    const result = await recompute(db, userId, touched);

    await must(db.from('ebay_accounts').update({ orders_synced_at: toIso }).eq('user_id', userId));
    return json({ from: fromIso, to: toIso, orders: orders.length, lines: lines.length, transactions: txns.length, ...result });
  } catch (err) {
    console.error('ebay-sync-orders', err);
    if (err.code === 'EBAY_NOT_CONNECTED' || err.code === 'EBAY_RECONNECT') return json({ error: err.message, code: err.code }, 409);
    const status = err.status === 401 || err.status === 403 ? 401 : 500;
    return json({ error: err.message, detail: err.detail?.slice?.(0, 500) }, status);
  }
};

export async function recompute(db, userId, orderIds) {
  if (!orderIds.length) return { autoMarkedSold: 0, suggested: 0 };
  const allLines = [], allOrders = [], allTxns = [];
  for (const c of chunk(orderIds, 100)) {
    allOrders.push(...await must(db.from('ebay_orders').select('*').eq('user_id', userId).in('order_id', c)));
    allLines.push(...await must(db.from('ebay_order_lines').select('*').eq('user_id', userId).in('order_id', c)));
    allTxns.push(...await must(db.from('ebay_transactions').select('*').eq('user_id', userId).in('order_id', c)));
  }
  const inventory = await must(db.from('inventory')
    .select('id, card_name, status, cost_basis, ebay_item_id, sku, ebay_order_line_id').eq('user_id', userId));
  const settingsRow = await must(db.from('settings').select('data').eq('user_id', userId).maybeSingle());
  const settings = settingsRow?.data || {};

  // ---- match unmatched, non-cancelled lines to inventory ----
  const orderById = new Map(allOrders.map((o) => [o.order_id, o]));
  const candidates = allLines.filter((l) => l.match_status === 'unmatched' && orderById.get(l.order_id)?.cancel_state !== 'CANCELED');
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
  for (const l of allLines) {
    if (l.inventory_id && ['auto', 'confirmed'].includes(l.match_status)) {
      const inv = invById.get(l.inventory_id);
      if (inv?.cost_basis != null) costByLine.set(l.line_item_id, Number(inv.cost_basis));
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
      updated_at: new Date().toISOString(),
    };
  });
  for (const c of chunk(updates, 200)) await must(db.from('ebay_order_lines').upsert(c, { onConflict: 'user_id,line_item_id' }));
  return { autoMarkedSold, suggested };
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

export const config = { path: '/api/ebay-sync-orders' };
