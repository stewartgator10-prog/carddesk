// netlify/functions/seller-reprice.js
// POST /api/seller-reprice { changes: [{ itemId, sku?, oldPrice, newPrice, reason? }] }
// Revises prices on eBay via Trading API ReviseInventoryStatus (4 items per call).
// In demo mode (eBay account not connected) it validates and pretends, and never contacts eBay.
// A user whose eBay sign-in expired gets an error, never a fake success.
import { getSellerContext, recordPriceChanges } from '../lib/seller-adapter.js';
import { revisePrices } from '../lib/trading-price.js';

const MAX_CHANGES = 200;
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

export function validateChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return 'No changes sent';
  if (changes.length > MAX_CHANGES) return `Too many changes at once (max ${MAX_CHANGES})`;
  const seen = new Set();
  for (const c of changes) {
    if (!c || !c.itemId) return 'Each change needs an itemId';
    const key = `${c.itemId}|${c.sku || ''}`;
    if (seen.has(key)) return `Duplicate change for item ${c.itemId}`;
    seen.add(key);
    const p = Number(c.newPrice);
    if (!Number.isFinite(p) || p < 0.99 || p > 100000) return `Price for ${c.itemId} must be between $0.99 and $100,000`;
  }
  return null;
}

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const changes = (body.changes || []).map(c => ({ ...c, newPrice: Math.round(Number(c.newPrice) * 100) / 100 }));
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
    const results = await revisePrices(ctx.token, changes);
    await recordPriceChanges(ctx, results, changes).catch(err => console.error('price log failed', err));
    return json({ demo: false, results });
  } catch (err) {
    return json({ error: 'Reprice failed', detail: err.message }, 500);
  }
};

export const config = { path: '/api/seller-reprice' };
