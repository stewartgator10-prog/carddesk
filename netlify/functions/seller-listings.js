// netlify/functions/seller-listings.js
// GET /api/seller-listings -> the signed-in seller's active eBay listings for the Repricer.
// Runs in demo mode (sample listings) until seller sign-in is wired in netlify/lib/seller-adapter.js.
import { getSellerContext, listActiveListings } from '../lib/seller-adapter.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

export default async (req) => {
  try {
    const ctx = await getSellerContext(req);
    const listings = await listActiveListings(ctx);
    return json({ connected: ctx.connected, demo: !ctx.connected, reason: ctx.reason || null, listings });
  } catch (err) {
    return json({ error: 'Could not load listings', detail: err.message }, 500);
  }
};

export const config = { path: '/api/seller-listings' };
