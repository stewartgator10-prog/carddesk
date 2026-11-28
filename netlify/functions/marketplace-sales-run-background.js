// netlify/functions/marketplace-sales-run-background.js
// Background job started every 5 minutes by marketplace-sales-cron (signed, see ../lib/cron-signature.js).
// Runs the sale check for each seller who needs it, oldest check first, and stops starting new
// sellers after 12 minutes so the next run picks up the rest. Runs can overlap (one starts every
// 5 minutes); each seller's check holds a lease (takeSaleLock), so a seller is never checked twice at once.
import { getSupabaseAdmin } from '../lib/ebay-seller.js';
import { verifyCron } from '../lib/cron-signature.js';
import { sellersToCheck } from '../lib/sales-run.js';
import { runSaleCheck } from '../lib/sell-once.js';

export default async (req) => {
  if (!verifyCron(req.headers.get('x-cd-ts'), req.headers.get('x-cd-sig'), Date.now(), 10 * 60_000, 'sales-check')) { console.warn('sales check: rejected unsigned call'); return; }
  const db = getSupabaseAdmin();
  const started = Date.now();
  let sellers;
  try { sellers = await sellersToCheck(db); } catch (err) { console.error('sales check', err.message); return; }
  for (const s of sellers) {
    if (Date.now() - started > 12 * 60_000) break;
    try {
      const r = await runSaleCheck({ db, userId: s.userId, includeEbay: s.crossListed });
      if (r.busy) { console.info('sales check', s.userId, 'skipped: another check is running'); continue; }
      if (r.newSales || r.problems.length) console.info('sales check', s.userId, r.newSales, 'new sales,', r.ended, 'ended,', r.problems.length, 'problems');
    } catch (err) { console.error('sales check failed', s.userId, err.message); }
  }
};

export const config = { background: true, path: '/api/marketplace-sales-run' };
