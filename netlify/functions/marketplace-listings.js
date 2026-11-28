// netlify/functions/marketplace-listings.js
// POST /api/marketplace-listings
//   { action: 'create', marketplace: 'whatnot', snapItemId, price?, quantity? }  list a card (Pro; approved or listed cards)
//   { action: 'update', listingId, price?, quantity? }                          change price or stock (any plan)
//   { action: 'end', listingId }                                                take it down (any plan)
//   { action: 'stock', snapItemId, quantity }                                   the card's stock, pushed to every live listing
// Each change is confirmed by the seller in the app first. Returns the listing row (never raw data or tokens).
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, json } from '../lib/ebay-seller.js';
import { requireFeature } from '../lib/billing.js';
import { loadSnapSettings } from '../lib/snap-identify.js';
import { createCrossListing, updateCrossListing, endCrossListing, setStock } from '../lib/marketplaces/service.js';
import { isMarketplaceError, httpStatusFor } from '../lib/marketplaces/errors.js';

const num = (v) => (v == null || v === '' ? undefined : Number(v));

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();
  try {
    const body = (await req.json().catch(() => null)) || {};
    if (body.action === 'create') {
      { const no = await requireFeature(db, userId, 'cross_list'); if (no) return no; }
      if (!body.snapItemId) return json(400, { error: 'snapItemId is required.' });
      const settings = await loadSnapSettings(db, userId).catch(() => ({}));
      return json(200, { listing: await createCrossListing(db, userId, { marketplace: String(body.marketplace || ''), snapItemId: body.snapItemId, price: num(body.price), quantity: num(body.quantity) }, { settings }) });
    }
    if (body.action === 'update') {
      if (!body.listingId) return json(400, { error: 'listingId is required.' });
      return json(200, { listing: await updateCrossListing(db, userId, { listingId: body.listingId, price: num(body.price), quantity: num(body.quantity) }) });
    }
    if (body.action === 'end') {
      if (!body.listingId) return json(400, { error: 'listingId is required.' });
      return json(200, { listing: await endCrossListing(db, userId, { listingId: body.listingId }) });
    }
    if (body.action === 'stock') {
      if (!body.snapItemId) return json(400, { error: 'snapItemId is required.' });
      return json(200, await setStock(db, userId, { snapItemId: body.snapItemId, quantity: num(body.quantity) }));
    }
    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    if (isMarketplaceError(err)) return json(err.status || httpStatusFor(err), { error: err.sellerMessage, code: err.code });
    console.error('marketplace-listings', err.message);
    return json(500, { error: 'Something went wrong. Try again in a minute.' });
  }
};

export const config = { path: '/api/marketplace-listings' };
