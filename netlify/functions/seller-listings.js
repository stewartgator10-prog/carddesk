// netlify/functions/seller-listings.js
// GET /api/seller-listings -> the signed-in seller's active eBay listings for the Repricer.
// Returns sample listings (demo mode) when the user hasn't connected their eBay account yet.
import { getSellerContext, listActiveListings } from '../lib/seller-adapter.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

export default async (req) => {
  try {
    const ctx = await getSellerContext(req);
    if (ctx.response) return ctx.response;
    const listings = await listActiveListings(ctx);
    return json({ connected: ctx.connected, demo: !ctx.connected, reason: ctx.reason || null, listings });
  } catch (err) {
    return json({ error: 'Could not load listings', detail: err.message }, 500);
  }
};

export const config = { path: '/api/seller-listings' };
