// netlify/functions/buy-offer.js
// Buy-offer mode (signed-in seller). Offers and their card list are created/edited in the browser
// under row-level security; the AI reading and the accept step run here.
//   POST /api/buy-offer { action: 'identify', offerId, photoPath, kind: 'page' | 'single' }
//        reads the photo (up to 9 cards on a page), values each card, adds them to the offer
//   POST /api/buy-offer { action: 'accept', offerId, finalOffer? }
//        records a purchase for the amount paid (split across the cards by market value) and puts
//        the cards in the Snap to List queue, identified and priced
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, json } from '../lib/ebay-seller.js';
import { identifyOfferPhoto, acceptOffer } from '../lib/buy-offer.js';
import { requireFeature, requireCards } from '../lib/billing.js';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();
  const body = (await req.json().catch(() => null)) || {};
  try {
    { const no = await requireFeature(db, userId, 'buy_offers'); if (no) return no; }
    if (body.action === 'identify') {
      return json(200, await identifyOfferPhoto({ db, userId, offerId: String(body.offerId || ''), photoPath: String(body.photoPath || ''), kind: body.kind }));
    }
    if (body.action === 'accept') {
      return json(200, await acceptOffer({ db, userId, offerId: String(body.offerId || ''), finalOffer: body.finalOffer ?? null }));
    }
    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    console.error('buy-offer', err);
    const status = err.code === 'BUDGET' ? 429 : err.code === 'NO_API_KEY' ? 503 : err.status || 502;
    return json(status, { error: err.message, code: err.code || null });
  }
};

export const config = { path: '/api/buy-offer' };
