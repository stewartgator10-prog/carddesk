// netlify/functions/marketplace-sales.js
// POST /api/marketplace-sales -> { checked, newSales, ended, problems }
// "Check for sales now": the same sale check the schedule runs every 5 minutes, for the signed-in
// seller only, at most once every 30 seconds. Works on every plan (so nothing sells twice).
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, json } from '../lib/ebay-seller.js';
import { checkSalesNow } from '../lib/marketplaces/service.js';
import { isMarketplaceError, httpStatusFor } from '../lib/marketplaces/errors.js';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  try {
    return json(200, await checkSalesNow(getSupabaseAdmin(), auth.user.id));
  } catch (err) {
    if (isMarketplaceError(err)) return json(err.status || httpStatusFor(err), { error: err.sellerMessage, code: err.code });
    console.error('marketplace-sales', err.message);
    return json(500, { error: 'Something went wrong. Try again in a minute.' });
  }
};

export const config = { path: '/api/marketplace-sales' };
