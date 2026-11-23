// netlify/functions/market-refresh-background.js
// Background job (up to 15 minutes): refresh automatic comps for every seller with eBay connected.
// Only the nightly schedule can start it (signed request, see ../lib/cron-signature.js).
import { getSupabaseAdmin } from '../lib/ebay-seller.js';
import { refreshMarket } from '../lib/market.js';
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
};

export const config = { background: true, path: '/api/market-refresh-run' };
