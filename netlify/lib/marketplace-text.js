// netlify/lib/marketplace-text.js
// What a card says about where it is listed and how it sold. Browser-safe (the app imports it).
//   chipsFor(listings)          -> [{ id, marketplace, tone, text, live }]
//   saleSentence(card, listings) -> { tone: 'ok'|'bad'|'info', text, endButtons: [{ listingId, label }], orders } | null
export const LABELS = { ebay: 'eBay', whatnot: 'Whatnot', shopify: 'Shopify', tcgplayer: 'TCGplayer' };
const label = (m) => LABELS[m] || m;
const usd = (n) => `$${Number(n).toFixed(2)}`;
const day = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) : ''; };
const list = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// The newest listing per marketplace for one card, live ones first.
export function currentListings(listings = []) {
  const by = new Map();
  const rank = (l) => (['creating', 'active', 'ending'].includes(l.status) ? 2 : l.status === 'failed' ? 0 : 1);
  for (const l of listings) {
    const cur = by.get(l.marketplace);
    const newer = String(l.updated_at || l.listed_at || l.created_at || '') > String(cur?.updated_at || cur?.listed_at || cur?.created_at || '');
    if (!cur || rank(l) > rank(cur) || (rank(l) === rank(cur) && newer)) by.set(l.marketplace, l);
  }
  const order = ['ebay', 'whatnot', 'shopify', 'tcgplayer'];
  return [...by.values()].sort((a, b) => order.indexOf(a.marketplace) - order.indexOf(b.marketplace));
}

export function chipsFor(listings = []) {
  return currentListings(listings).map((l) => {
    const m = label(l.marketplace);
    const live = ['active', 'ending'].includes(l.status);
    if (live) return { id: l.id, marketplace: l.marketplace, live, tone: l.last_error ? 'warn' : 'live', text: `${m} · ${usd(l.price ?? 0)}${Number(l.quantity) > 1 ? ` · ${l.quantity} left` : ''}`, url: l.url || null };
    if (l.status === 'creating') return { id: l.id, marketplace: l.marketplace, live, tone: 'warn', text: `Listing on ${m}…`, url: null };
    if (l.status === 'sold') return { id: l.id, marketplace: l.marketplace, live, tone: 'sold', text: `Sold on ${m}`, url: l.url || null };
    if (l.status === 'failed') return { id: l.id, marketplace: l.marketplace, live, tone: 'bad', text: `Not listed on ${m}`, url: null };
    if (l.ended_reason === 'disconnected') return { id: l.id, marketplace: l.marketplace, live, tone: 'ended', text: `Left up on ${m}, not watched`, url: l.url || null };
    return { id: l.id, marketplace: l.marketplace, live, tone: 'ended', text: `Ended on ${m}`, url: l.url || null };
  });
}

export function saleSentence(card, listings = []) {
  const n = card?.sale_note;
  if (!n?.marketplace) return null;
  const where = label(n.marketplace);
  const orders = (n.orders || []).filter((o) => o.url);
  if (n.cancelled) {
    if (n.restored) return { tone: 'info', text: `The ${where} order was cancelled, so the card is back in stock.`, endButtons: [], orders };
    const downOn = (n.ended || []).filter((e) => e.ok).map((e) => label(e.marketplace));
    return { tone: 'info', text: `The ${where} order was cancelled.${downOn.length ? ` Relist on ${list(downOn)}?` : ''}`, endButtons: [], orders };
  }
  if (n.double_sale) {
    const both = [...new Set((n.orders || []).map((o) => label(o.marketplace)))];
    const names = both.length > 1 ? list(both) : `${where} twice`;
    return { tone: 'bad', text: `Sold on both ${names}. You only have 1. Cancel one of the orders on that marketplace.`, endButtons: [], orders };
  }
  const failed = (n.ended || []).filter((e) => !e.ok);
  // A failure is cleared once that listing has ended (by the retry or an "End on" button).
  const stillUp = failed.filter((e) => listings.some((l) => l.marketplace === e.marketplace && ['active', 'ending'].includes(l.status)));
  if (stillUp.length) {
    const parts = stillUp.map((e) => `Your ${label(e.marketplace)} listing is still up: ${e.error || 'it could not be ended'}`);
    const endButtons = stillUp.map((e) => {
      const l = listings.find((x) => x.marketplace === e.marketplace && ['active', 'ending'].includes(x.status));
      return { listingId: l.id, label: `End on ${label(e.marketplace)}` };
    });
    const joined = parts.join('. ');
    return { tone: 'bad', text: `Sold on ${where}. ${joined}${/[.!?]$/.test(joined) ? '' : '.'}`, endButtons, orders };
  }
  if (Number(n.quantity_left) > 0) {
    const ok = (n.updated || []).filter((u) => u.ok).map((u) => label(u.marketplace));
    const bad = (n.updated || []).filter((u) => !u.ok);
    return {
      tone: bad.length ? 'bad' : 'ok',
      text: `Sold ${n.quantity || 1} on ${where}. ${n.quantity_left} left${ok.length ? `, updated on ${list(ok)}` : ''}.${bad.map((u) => ` ${label(u.marketplace)} still shows the old number: ${u.error}`).join('')}`,
      endButtons: [], orders,
    };
  }
  const ended = (n.ended || []).filter((e) => e.ok).map((e) => label(e.marketplace));
  const when = n.at ? ` ${day(n.at)}` : '';
  const price = n.price != null ? ` for ${usd(n.price)}` : '';
  return { tone: 'ok', text: `Sold on ${where}${when}${price}.${ended.length ? ` Ended on ${list(ended)} automatically.` : ''}`, endButtons: [], orders };
}
