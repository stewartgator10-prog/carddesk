// netlify/functions/costs.js
// Cost capture for the signed-in seller.
//   GET  /api/costs                     -> progress summary + purchases
//   POST /api/costs { action, ... }     -> one of:
//     import_listings                                   one inventory card per copy of each active listing
//     set_costs        { items: [{ inventoryId, cost }] }   typed costs
//     estimate         { pct, inventoryIds? }              fill missing costs at pct% of price (marked estimated)
//     save_purchase    { purchase: { id?, total_paid, purchased_at?, source?, split_method?, notes? }, inventoryIds }
//     delete_purchase  { id }
//     sale_cost        { lineItemId, cost, estimated? }    cost for a past eBay sale
//     estimate_sales   { pct }                             estimate every past sale still without a cost
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, json } from '../lib/ebay-seller.js';
import { requireFeature } from '../lib/billing.js';
import {
  importListings, setCosts, estimateMissing, savePurchase, deletePurchase, setSaleCost, estimateSales,
} from '../lib/costs.js';

async function summary(db, userId) {
  const [inv, lines, purchases] = await Promise.all([
    db.from('inventory').select('status, cost_basis, cost_source, ebay_item_id, ebay_order_line_id').eq('user_id', userId),
    db.from('ebay_order_lines').select('match_status, cost_basis, cost_estimated, ebay_orders(cancel_state)').eq('user_id', userId),
    db.from('purchases').select('*').eq('user_id', userId).order('purchased_at', { ascending: false }),
  ]);
  for (const r of [inv, lines, purchases]) if (r.error) throw new Error(r.error.message);
  const stock = inv.data.filter((r) => r.status === 'In Stock');
  const sales = lines.data.filter((l) => l.ebay_orders?.cancel_state !== 'CANCELED' && l.match_status !== 'ignored');
  return {
    inStock: { cards: stock.length, withCost: stock.filter((r) => r.cost_basis != null).length, estimated: stock.filter((r) => r.cost_source === 'estimated').length },
    sales: { lines: sales.length, withCost: sales.filter((l) => l.cost_basis != null).length, estimated: sales.filter((l) => l.cost_estimated).length },
    purchases: purchases.data,
  };
}

export default async (req) => {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();

  try {
    { const no = await requireFeature(db, userId, 'profit'); if (no) return no; }
    if (req.method === 'GET') return json(200, await summary(db, userId));
    if (req.method !== 'POST') return json(405, { error: 'Use GET or POST.' });

    const body = (await req.json().catch(() => null)) || {};
    let result;
    switch (body.action) {
      case 'import_listings': result = await importListings(db, userId); break;
      case 'set_costs':
        if (!Array.isArray(body.items) || !body.items.length || body.items.length > 500) return json(400, { error: 'items must be a list of 1 to 500 { inventoryId, cost }.' });
        result = await setCosts(db, userId, body.items); break;
      case 'estimate':
        result = await estimateMissing(db, userId, { pct: body.pct, inventoryIds: Array.isArray(body.inventoryIds) ? body.inventoryIds : null }); break;
      case 'save_purchase':
        result = await savePurchase(db, userId, { purchase: body.purchase || {}, inventoryIds: Array.isArray(body.inventoryIds) ? body.inventoryIds : [] }); break;
      case 'delete_purchase':
        if (!body.id) return json(400, { error: 'id is required.' });
        result = await deletePurchase(db, userId, String(body.id)); break;
      case 'sale_cost':
        if (!body.lineItemId) return json(400, { error: 'lineItemId is required.' });
        result = await setSaleCost(db, userId, { lineItemId: String(body.lineItemId), cost: body.cost, estimated: body.estimated === true }); break;
      case 'estimate_sales': result = await estimateSales(db, userId, { pct: body.pct }); break;
      default: return json(400, { error: 'Unknown action.' });
    }
    return json(200, { result, summary: await summary(db, userId) });
  } catch (err) {
    console.error('costs', err);
    return json(err.status || 500, { error: err.message });
  }
};

export const config = { path: '/api/costs' };
