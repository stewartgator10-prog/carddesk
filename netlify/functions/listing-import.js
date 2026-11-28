// netlify/functions/listing-import.js
// Bring eBay listings made before CardDesk into the Snap tab (signed-in user). Nothing changes on eBay.
//   GET  /api/listing-import                        -> { active, inCardDesk, pending: [item_id] }
//   POST /api/listing-import { item_ids: [...] }    -> { results: [{ item_id, ok, skipped?, error? }] }  (up to 4 per call)
//   POST /api/listing-import { action: 'full_size', ids: [...] }  re-copy imported photos at full size (up to 4 cards per call)
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, getSellerAccessToken, json } from '../lib/ebay-seller.js';
import { pendingImports, importListings, refreshFullSizeMany } from '../lib/listing-import.js';
import { requireFeature, requireCards } from '../lib/billing.js';

export default async (req) => {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();
  try {
    { const no = await requireFeature(db, userId, 'import'); if (no) return no; }
    if (req.method === 'GET') return json(200, await pendingImports({ db, userId }));
    if (req.method !== 'POST') return json(405, { error: 'Use GET or POST.' });
    const body = (await req.json().catch(() => null)) || {};
    const token = await getSellerAccessToken(db, userId);
    if (body.action === 'full_size') return json(200, { results: await refreshFullSizeMany({ db, userId, token, snapIds: body.ids }) });
    return json(200, { results: await importListings({ db, userId, token, itemIds: body.item_ids }) });
  } catch (err) {
    console.error('listing-import', err);
    const status = err.code === 'EBAY_NOT_CONNECTED' || err.code === 'EBAY_RECONNECT' ? 409 : err.status || 502;
    return json(status, { error: err.message, code: err.code || null });
  }
};

export const config = { path: '/api/listing-import' };
