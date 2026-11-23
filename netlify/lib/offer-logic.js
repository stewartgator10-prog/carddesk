// netlify/lib/offer-logic.js
// Buy-offer math, shared by the server and the browser (no Node-only imports).

export const OFFER_DEFAULTS = {
  offerBulkUnder: 1,       // cards with market under this are bulk...
  offerBulkFlat: 0.05,     // ...offered at this flat price each
  offerMidPct: 50,         // market from bulk cutoff up to offerHighFrom: this % of market
  offerHighFrom: 20,       // market at or above this...
  offerHighPct: 70,        // ...this % of market
  offerRoundTotal: true,   // round the total down to whole dollars
};

const round2 = (n) => Math.round(n * 100) / 100;
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

export const tiersFrom = (settings = {}) => Object.fromEntries(Object.keys(OFFER_DEFAULTS).map((k) => [k, settings[k] ?? OFFER_DEFAULTS[k]]));

// Offer for one card from its market value. Cents are rounded down (offers never round up).
export function offerFor(market, tiers = OFFER_DEFAULTS) {
  const m = num(market);
  if (m == null || !Number.isFinite(m) || m < 0) return null;
  const t = { ...OFFER_DEFAULTS, ...tiers };
  if (m < Number(t.offerBulkUnder)) return Math.min(round2(Number(t.offerBulkFlat)), m);
  const pct = m >= Number(t.offerHighFrom) ? Number(t.offerHighPct) : Number(t.offerMidPct);
  return Math.floor(m * pct + 1e-6) / 100;
}

export const marketOf = (it) => num(it.market_override) ?? num(it.market_price);
export const offerOf = (it, tiers) => num(it.offer_override) ?? offerFor(marketOf(it), tiers);

export function offerTotals(items, tiers = OFFER_DEFAULTS) {
  const t = { ...OFFER_DEFAULTS, ...tiers };
  const inc = items.filter((it) => it.included !== false);
  const priced = inc.filter((it) => offerOf(it, t) != null);
  const market = round2(priced.reduce((s, it) => s + (marketOf(it) || 0), 0));
  const rawOffer = round2(priced.reduce((s, it) => s + offerOf(it, t), 0));
  const offer = t.offerRoundTotal ? Math.floor(rawOffer + 1e-6) : rawOffer;
  return {
    cards: inc.length,
    unpriced: inc.length - priced.length,
    market,
    offer_before_rounding: rawOffer,
    offer,
    pct_of_market: market > 0 ? Math.round((offer / market) * 1000) / 10 : null,
  };
}

export const OFFER_FLAG_LABELS = {
  low_confidence: 'AI unsure',
  no_price: 'No market price',
  not_a_card: 'Not a single card',
  graded: 'Graded slab',
  ebay_median: 'Priced from eBay listings',
  name_only_match: 'Set or number not confirmed',
  multiple_versions: 'Several versions or editions: check which one',
};
