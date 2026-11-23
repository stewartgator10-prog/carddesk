// netlify/functions/market.js
// Automatic comps for the signed-in seller's active listings.
//   GET  /api/market                                   -> { rows, summary }
//   POST /api/market { action: 'refresh', itemIds?, force? }
//        refreshes up to 15 listings that are due (new, renamed or older than 20 h), then returns
//        { processed, remaining, ... }; the browser calls again until remaining is 0.
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, json } from '../lib/ebay-seller.js';
import { refreshMarket } from '../lib/market.js';

export default async (req) => {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();
  try {
    if (req.method === 'GET') {
      const { data, error } = await db.from('listing_market').select('*').eq('user_id', userId);
      if (error) throw new Error(error.message);
      const rows = data || [];
      const last = rows.map((r) => r.comp_at).filter(Boolean).sort().pop() || null;
      return json(200, { rows, summary: { listings: rows.length, with_market: rows.filter((r) => r.market_price != null).length, with_competition: rows.filter((r) => r.comp_count > 0).length, last_refresh: last } });
    }
    if (req.method !== 'POST') return json(405, { error: 'Use GET or POST.' });
    const body = (await req.json().catch(() => null)) || {};
    if (body.action !== 'refresh') return json(400, { error: 'Unknown action.' });
    const itemIds = Array.isArray(body.itemIds) ? body.itemIds.slice(0, 100) : null;
    return json(200, await refreshMarket({ db, userId, itemIds, force: body.force === true, maxListings: 15, deadlineMs: 25_000 }));
  } catch (err) {
    console.error('market', err);
    return json(500, { error: err.message });
  }
};

export const config = { path: '/api/market' };
