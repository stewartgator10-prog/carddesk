// netlify/functions/listing-import.js
// Bring eBay listings made before CardDesk into the Snap tab (signed-in user). Nothing changes on eBay.
//   GET  /api/listing-import                        -> { active, inCardDesk, pending: [item_id] }
//   POST /api/listing-import { item_ids: [...] }    -> { results: [{ item_id, ok, skipped?, error? }] }  (up to 4 per call)
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, getSellerAccessToken, json } from '../lib/ebay-seller.js';
import { pendingImports, importListings } from '../lib/listing-import.js';

export default async (req) => {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();
  try {
    if (req.method === 'GET') return json(200, await pendingImports({ db, userId }));
    if (req.method !== 'POST') return json(405, { error: 'Use GET or POST.' });
    const body = (await req.json().catch(() => null)) || {};
    const token = await getSellerAccessToken(db, userId);
    return json(200, { results: await importListings({ db, userId, token, itemIds: body.item_ids }) });
  } catch (err) {
    console.error('listing-import', err);
    const status = err.code === 'EBAY_NOT_CONNECTED' || err.code === 'EBAY_RECONNECT' ? 409 : err.status || 502;
    return json(status, { error: err.message, code: err.code || null });
  }
};

export const config = { path: '/api/listing-import' };
