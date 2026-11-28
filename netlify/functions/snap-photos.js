// netlify/functions/snap-photos.js
// POST /api/snap-photos  (signed-in user) — a listing's photos.
//   { action: 'autocrop', id, path }          the AI finds the card's corners, then straighten + crop (about a cent)
//   { action: 'crop', id, path, corners }     straighten + crop with corners placed by hand
//   { action: 'undo', id, path }              put the original photo back
//   { action: 'order', id, paths }            new order (first = main photo); photos left out are removed
//   { action: 'update_ebay', id }             a live listing: send its changed photos, title and description to eBay
// Returns { item }.
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, getSellerAccessToken, json } from '../lib/ebay-seller.js';
import { loadSnapSettings } from '../lib/snap-identify.js';
import { applyCrop, undoEdit, setPhotoOrder, autoCrop, pushChangesToEbay } from '../lib/snap-photos.js';
import { requireFeature } from '../lib/billing.js';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();
  const body = (await req.json().catch(() => null)) || {};
  if (!body.id || typeof body.id !== 'string') return json(400, { error: 'id is required.' });

  try {
    const { data: item, error } = await db.from('snap_items').select('*').eq('id', body.id).eq('user_id', userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!item) return json(404, { error: 'Card not found.' });
    if (item.status === 'discarded') return json(409, { error: 'This card was discarded.' });
    const path = typeof body.path === 'string' ? body.path : null;
    switch (body.action) {
      case 'autocrop': return json(200, { item: await autoCrop({ db, userId, item, path, settings: await loadSnapSettings(db, userId) }) });
      case 'crop': return json(200, { item: await applyCrop({ db, userId, item, path, corners: body.corners, by: 'manual' }) });
      case 'undo': return json(200, { item: await undoEdit({ db, userId, item, path }) });
      case 'order': return json(200, { item: await setPhotoOrder({ db, userId, item, paths: body.paths }) });
      case 'update_ebay': { const no = await requireFeature(db, userId, 'live_edit'); if (no) return no; }
        return json(200, { item: await pushChangesToEbay({ db, userId, token: await getSellerAccessToken(db, userId), item }) });
      default: return json(400, { error: 'Unknown action.' });
    }
  } catch (err) {
    console.error('snap-photos', err);
    const status = err.code === 'EBAY_NOT_CONNECTED' || err.code === 'EBAY_RECONNECT' ? 409 : err.code === 'NO_API_KEY' ? 503 : err.status || 502;
    return json(status, { error: err.message, code: err.code || null });
  }
};

export const config = { path: '/api/snap-photos' };
