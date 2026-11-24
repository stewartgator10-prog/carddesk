// netlify/functions/market-refresh-background.js
// Background job (up to 15 minutes): refresh automatic comps for every seller with eBay connected,
// then re-price every collection and raise its alerts (collectors don't need eBay connected).
// Only the nightly schedule can start it (signed request, see ../lib/cron-signature.js).
import { getSupabaseAdmin } from '../lib/ebay-seller.js';
import { refreshMarket } from '../lib/market.js';
import { refreshCollection } from '../lib/collection.js';
import { verifyCron } from '../lib/cron-signature.js';

export default async (req) => {
  if (!verifyCron(req.headers.get('x-cd-ts'), req.headers.get('x-cd-sig'))) { console.warn('market refresh: rejected unsigned call'); return; }
  const db = getSupabaseAdmin();
  const { data: accounts, error } = await db.from('ebay_accounts').select('user_id');
  if (error) { console.error('market refresh', error.message); return; }
  const started = Date.now();
  for (const a of accounts || []) {
    const left = 14 * 60_000 - (Date.now() - started);
    if (left < 60_000) break;
    try {
      const r = await refreshMarket({ db, userId: a.user_id, maxListings: 5000, deadlineMs: left - 30_000 });
      console.info('market refresh', a.user_id, r.processed, 'done,', r.remaining, 'left', r.note || '');
    } catch (err) { console.error('market refresh failed', a.user_id, err.message); }
  }
  // Collections: everyone with cards still held.
  const { data: held } = await db.from('collection_items').select('user_id').eq('status', 'held');
  for (const userId of [...new Set((held || []).map((r) => r.user_id))]) {
    const left = 14 * 60_000 - (Date.now() - started);
    if (left < 45_000) break;
    try {
      const r = await refreshCollection({ db, userId, maxItems: 5000, deadlineMs: left - 30_000 });
      console.info('collection refresh', userId, r.processed, 'priced,', r.alerts, 'new alerts,', r.remaining, 'left');
    } catch (err) { console.error('collection refresh failed', userId, err.message); }
  }
};

export const config = { background: true, path: '/api/market-refresh-run' };
