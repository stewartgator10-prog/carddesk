// netlify/functions/snap-publish.js
// Snap to List phase 2: put approved cards on eBay.
//   GET  /api/snap-publish                  -> { templates }  the learned listing setup (or null)
//   POST /api/snap-publish { action: 'learn' }              read the seller's own listings once to copy their setup
//   POST /api/snap-publish { action: 'check', id }          upload photos + eBay's free verify call (nothing goes live)
//   POST /api/snap-publish { action: 'publish', id }        list it; only if that exact listing passed the check
// One card per request keeps each call well inside the function time limit; the browser loops.
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, getSellerAccessToken, json } from '../lib/ebay-seller.js';
import { learnTemplates, checkSnapItem, publishSnapItem } from '../lib/ebay-listing.js';
import { loadSnapSettings } from '../lib/snap-identify.js';
import { planFor } from '../lib/billing.js';
import { hasFeature } from '../lib/plans.js';

export default async (req) => {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();

  try {
    if (req.method === 'GET') {
      const { data } = await db.from('ebay_accounts').select('listing_templates').eq('user_id', userId).maybeSingle();
      return json(200, { connected: !!data, templates: data?.listing_templates || null });
    }
    if (req.method !== 'POST') return json(405, { error: 'Use GET or POST.' });
    const body = (await req.json().catch(() => null)) || {};
    const token = await getSellerAccessToken(db, userId);

    if (body.action === 'learn') return json(200, { templates: await learnTemplates({ db, userId, token }) });

    if (!['check', 'publish'].includes(body.action)) return json(400, { error: 'Unknown action.' });
    if (!body.id) return json(400, { error: 'id is required.' });
    const { data: item, error } = await db.from('snap_items').select('*').eq('id', String(body.id)).eq('user_id', userId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!item) return json(404, { error: 'Card not found.' });
    let settings = await loadSnapSettings(db, userId);
    // Best Offer and promotion on new listings are part of Pro and up (Tyche Cards only).
    if (!hasFeature(await planFor(db, userId), 'automation')) settings = { ...settings, snapBestOffer: false, snapPromotePct: 0 };

    if (body.action === 'check') return json(200, { item: await checkSnapItem({ db, userId, token, item, settings }) });
    return json(200, { result: await publishSnapItem({ db, userId, token, item, settings }) });
  } catch (err) {
    console.error('snap-publish', err);
    const status = err.code === 'EBAY_NOT_CONNECTED' || err.code === 'EBAY_RECONNECT' ? 409 : err.status || 502;
    return json(status, { error: err.message, code: err.code || null });
  }
};

export const config = { path: '/api/snap-publish' };
