// netlify/functions/ebay-sync-orders.js
// POST /api/ebay-sync-orders   body: { days?: number }
// Pulls the signed-in seller's eBay orders (Fulfillment API) and money
// movements (Finances API), stores them in Supabase, auto-marks matching
// inventory as sold, and recomputes per-line P&L (netlify/lib/ebay-orders.js).
// Then any eBay sale of a card that is also on another marketplace ends it there (sell once).

import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, getSellerAccessToken } from '../lib/ebay-seller.js';
import { requireFeature } from '../lib/billing.js';
import { syncEbayOrders, ebaySaleLines } from '../lib/ebay-orders.js';
import { handleSales } from '../lib/sell-once.js';

export { recompute, markInventorySold, releaseInventory } from '../lib/ebay-orders.js';

const FIRST_SYNC_DAYS = 90;   // how far back the very first sync looks
const OVERLAP_HOURS = 72;     // re-read this much before the last sync to catch late fees/refunds

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

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
    { const no = await requireFeature(db, userId, 'profit'); if (no) return no; }
    const body = (await req.json().catch(() => null)) || {};
    const days = body.days == null || body.days === '' ? null : Number(body.days);
    if (days !== null && !(days > 0)) return json({ error: 'days must be a positive number of days to look back (max 730).' }, 400);
    const account = await must(db.from('ebay_accounts').select('orders_synced_at').eq('user_id', userId).maybeSingle());
    if (!account) return json({ error: 'Connect your eBay seller account first.' }, 409);

    const now = new Date();
    let from;
    if (days) from = new Date(now - Math.min(days, 730) * 864e5);
    else if (account.orders_synced_at) from = new Date(new Date(account.orders_synced_at) - OVERLAP_HOURS * 36e5);
    else from = new Date(now - FIRST_SYNC_DAYS * 864e5);
    const fromIso = from.toISOString(), toIso = now.toISOString();

    const token = await getSellerAccessToken(db, userId);
    const { orders, lines, txns, result } = await syncEbayOrders({ db, userId, token, fromIso, toIso });
    await must(db.from('ebay_accounts').update({ orders_synced_at: toIso }).eq('user_id', userId));

    // Sell once: a card that sold here comes down from Whatnot (and the others). Never fails the sync.
    let sellOnce = null;
    try { sellOnce = await handleSales({ db, userId, marketplace: 'ebay', sales: ebaySaleLines(orders, lines) }); }
    catch (e) { console.error('ebay-sync-orders sell-once', e.message); }

    return json({ from: fromIso, to: toIso, orders: orders.length, lines: lines.length, transactions: txns.length, ...result,
      ...(sellOnce ? { endedElsewhere: sellOnce.ended, problems: sellOnce.problems } : {}) });
  } catch (err) {
    console.error('ebay-sync-orders', err);
    if (err.code === 'EBAY_NOT_CONNECTED' || err.code === 'EBAY_RECONNECT') return json({ error: err.message, code: err.code }, 409);
    const status = err.status === 401 || err.status === 403 ? 401 : 500;
    return json({ error: err.message, detail: err.detail?.slice?.(0, 500) }, status);
  }
};

export const config = { path: '/api/ebay-sync-orders' };
