// netlify/functions/marketplaces.js
// The seller's marketplaces (eBay plus Whatnot, later Shopify and TCGplayer).
//   GET    /api/marketplaces                                   -> { marketplaces: [{ marketplace, connected, username, status, salesCheckedAt, activeCount, settings }] }
//   POST   { action: 'connect', marketplace: 'whatnot', token } connect with a personal access token (Pro)
//   POST   { action: 'settings', marketplace, shippingProfileId }
//   DELETE { marketplace, endListings: bool }                  disconnect; the token is deleted either way
// No response ever includes a token.
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, json } from '../lib/ebay-seller.js';
import { requireFeature } from '../lib/billing.js';
import { listMarketplaces, connectMarketplace, saveMarketplaceSettings, disconnectMarketplace } from '../lib/marketplaces/service.js';
import { isMarketplaceError, httpStatusFor } from '../lib/marketplaces/errors.js';

export default async (req) => {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();
  try {
    if (req.method === 'GET') return json(200, { marketplaces: await listMarketplaces(db, userId) });
    const body = (await req.json().catch(() => null)) || {};
    if (req.method === 'DELETE') {
      if (!body.marketplace) return json(400, { error: 'Say which marketplace to disconnect.' });
      return json(200, await disconnectMarketplace(db, userId, { marketplace: String(body.marketplace), endListings: body.endListings === true }));
    }
    if (req.method !== 'POST') return json(405, { error: 'Use GET, POST or DELETE.' });
    if (body.action === 'connect') {
      { const no = await requireFeature(db, userId, 'cross_list'); if (no) return no; }
      if (!body.token) return json(400, { error: 'Paste your Whatnot token first.' });
      return json(200, { marketplace: await connectMarketplace(db, userId, { marketplace: String(body.marketplace || ''), token: String(body.token) }) });
    }
    if (body.action === 'settings') return json(200, { marketplace: await saveMarketplaceSettings(db, userId, { marketplace: String(body.marketplace || ''), shippingProfileId: body.shippingProfileId ?? null }) });
    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    if (isMarketplaceError(err)) return json(httpStatusFor(err), { error: err.sellerMessage, code: err.code });
    console.error('marketplaces', err.message);
    return json(500, { error: 'Something went wrong. Try again in a minute.' });
  }
};

export const config = { path: '/api/marketplaces' };
