// netlify/functions/seller-reprice.js
// POST /api/seller-reprice { changes: [{ itemId, sku?, oldPrice, newPrice, reason? }], confirmLargeChanges? }
// Revises prices on eBay via Trading API ReviseInventoryStatus (4 items per call).
// In demo mode (eBay account not connected) it validates and pretends, and never contacts eBay.
// A user whose eBay sign-in expired gets an error, never a fake success.
//
// Guardrails enforced here, not just in the browser, so a script or AI agent calling the
// API directly gets the same protection as the Repricer screen:
//  - every item must be one of this user's Active fixed-price listings (auctions can't be repriced)
//  - a change of 50% or more against the synced price is refused unless confirmLargeChanges is true
import { getSellerContext, recordPriceChanges } from '../lib/seller-adapter.js';
import { revisePrices, setBestOffer } from '../lib/trading-price.js';

const MAX_CHANGES = 200;
export const LARGE_CHANGE = 0.5;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

export function validateChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return 'No changes sent';
  if (changes.length > MAX_CHANGES) return `Too many changes at once (max ${MAX_CHANGES})`;
  const seen = new Set();
  for (const c of changes) {
    if (!c || typeof c !== 'object' || !c.itemId) return 'Each change needs an itemId';
    const key = `${c.itemId}|${c.sku || ''}`;
    if (seen.has(key)) return `Duplicate change for item ${c.itemId}`;
    seen.add(key);
    const p = Number(c.newPrice);
    if (!Number.isFinite(p) || p < 0.99 || p > 100000) return `Price for ${c.itemId} must be between $0.99 and $100,000`;
  }
  return null;
}

// Checks the changes against the user's synced listings. Returns an error string or null.
export function checkAgainstListings(changes, listings, { confirmLargeChanges = false } = {}) {
  const byId = new Map(listings.map(l => [String(l.item_id), l]));
  const large = [];
  for (const c of changes) {
    const l = byId.get(String(c.itemId));
    if (!l || l.status !== 'Active') return `Item ${c.itemId} isn't one of your active eBay listings. Sync your listings and try again.`;
    if (l.listing_type && l.listing_type !== 'FixedPriceItem') return `Item ${c.itemId} is an auction; only Buy It Now prices can be changed.`;
    const cur = Number(l.price);
    if (cur > 0 && Math.abs(Number(c.newPrice) - cur) / cur >= LARGE_CHANGE) large.push(`${c.itemId} ($${cur.toFixed(2)} → $${Number(c.newPrice).toFixed(2)})`);
  }
  if (large.length && !confirmLargeChanges) {
    return `These changes are 50% or more from the current price: ${large.join(', ')}. Send confirmLargeChanges: true if they are intended.`;
  }
  return null;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (body && body.action === 'best_offer') return bestOfferAction(req, body);
  if (!body || typeof body !== 'object' || !Array.isArray(body.changes)) return json({ error: 'Body must be { changes: [...] }' }, 400);
  const changes = body.changes.map(c => (c && typeof c === 'object'
    ? { ...c, itemId: c.itemId != null ? String(c.itemId) : c.itemId, newPrice: Math.round(Number(c.newPrice) * 100) / 100 }
    : c));
  const problem = validateChanges(changes);
  if (problem) return json({ error: problem }, 400);

  try {
    const ctx = await getSellerContext(req, { withToken: true });
    if (ctx.response) return ctx.response;
    if (ctx.reason === 'ebay_reconnect') return json({ error: ctx.error || 'Reconnect your eBay account.' }, 409);
    if (!ctx.connected) {
      const results = changes.map(c => ({ itemId: c.itemId, ok: true, price: c.newPrice, error: null, warnings: [] }));
      return json({ demo: true, results });
    }
    const { data: listings, error } = await ctx.admin.from('ebay_listings')
      .select('item_id, price, status, listing_type')
      .eq('user_id', ctx.userId).in('item_id', changes.map(c => c.itemId));
    if (error) throw new Error(error.message);
    const refused = checkAgainstListings(changes, listings || [], { confirmLargeChanges: body.confirmLargeChanges === true });
    if (refused) return json({ error: refused }, 400);

    const results = await revisePrices(ctx.token, changes);
    await recordPriceChanges(ctx, results, changes).catch(err => console.error('price log failed', err));
    return json({ demo: false, results });
  } catch (err) {
    return json({ error: 'Reprice failed', detail: err.message }, 500);
  }
};

// POST { action: 'best_offer', itemId, enabled } turns Best Offer on (auto-accept at 90% of the price
// and up, auto-decline below, or the seller's own %) or off for one of the seller's live Buy It Now listings.
async function bestOfferAction(req, body) {
  const itemId = body.itemId != null ? String(body.itemId) : '';
  if (!itemId || typeof body.enabled !== 'boolean') return json({ error: 'Send { action: "best_offer", itemId, enabled: true | false }' }, 400);
  try {
    const ctx = await getSellerContext(req, { withToken: true });
    if (ctx.response) return ctx.response;
    if (ctx.reason === 'ebay_reconnect') return json({ error: ctx.error || 'Reconnect your eBay account.' }, 409);
    if (!ctx.connected) return json({ demo: true, result: { itemId, enabled: body.enabled } });
    const { data: l, error } = await ctx.admin.from('ebay_listings').select('item_id, price, status, listing_type')
      .eq('user_id', ctx.userId).eq('item_id', itemId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!l || l.status !== 'Active') return json({ error: `Item ${itemId} isn't one of your active eBay listings. Sync your listings and try again.` }, 400);
    if (l.listing_type && l.listing_type !== 'FixedPriceItem') return json({ error: 'Best Offer is only for Buy It Now listings.' }, 400);
    const { data: s } = await ctx.admin.from('settings').select('data').eq('user_id', ctx.userId).maybeSingle();
    const pct = Number(s?.data?.snapBestOfferPct ?? 10);
    const result = await setBestOffer(ctx.token, { itemId, enabled: body.enabled, price: Number(l.price), pct });
    await ctx.admin.from('ebay_listings').update({ best_offer: body.enabled }).eq('user_id', ctx.userId).eq('item_id', itemId);
    return json({ demo: false, result });
  } catch (err) {
    return json({ error: `eBay didn't change Best Offer: ${err.message}` }, 502);
  }
}

export const config = { path: '/api/seller-reprice' };
