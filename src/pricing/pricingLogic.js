// Pure pricing helpers for the Repricer tab. No React, no network, so they are easy to test.

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'card', 'cards', 'pokemon', 'pokémon', 'mtg', 'tcg', 'ccg',
  'nm', 'lp', 'mp', 'hp', 'mint', 'near', 'holo', 'rare', 'free', 'shipping', 'ship', 'fast', 'lot',
]);

export function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9/.]+/g, ' ')
    .split(' ')
    .map(t => t.replace(/^\.+|\.+$/g, ''))
    .filter(t => t && !STOP_WORDS.has(t));
}

// Grade/condition detection from a listing title. Order matters: most specific first.
const GRADE_PATTERNS = [
  ['PSA 10', /\bpsa\s*10\b/i], ['PSA 9', /\bpsa\s*9\b/i], ['PSA 8', /\bpsa\s*8\b/i],
  ['BGS 9.5', /\bbgs\s*9\.5\b/i], ['BGS 9', /\bbgs\s*9\b/i],
  ['CGC 10', /\bcgc\s*10\b/i], ['CGC 9', /\bcgc\s*9\b/i],
  ['DMG', /\bdamaged\b|\bdmg\b/i], ['HP', /\bheavily played\b|\bhp\b/i],
  ['MP', /\bmoderately played\b|\bmp\b/i], ['LP', /\blightly played\b|\blp\b/i],
  ['NM', /\bnear mint\b|\bnm\b/i],
];

export function detectCondition(title, fallback = null) {
  for (const [label, re] of GRADE_PATTERNS) if (re.test(title || '')) return label;
  return fallback;
}

const isGraded = c => /^(PSA|BGS|CGC)/.test(c || '');

// A record "matches" a listing when every meaningful token of its card name appears in the
// listing title (or in the listing's manual comp key, if the user set one).
// GUESS: token-subset matching is a heuristic. The manual comp key on each row is the escape hatch.
export function nameMatches(listingText, cardName, setName = '') {
  const hay = new Set(tokenize(listingText));
  const need = tokenize(cardName);
  if (need.length === 0) return false;
  if (!need.every(t => hay.has(t))) return false;
  const setTokens = tokenize(setName);
  // Set is optional: only enforce it when the listing text mentions at least one set token.
  if (setTokens.length && setTokens.some(t => hay.has(t))) return setTokens.every(t => hay.has(t));
  return true;
}

export function median(nums) {
  const s = nums.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Comps for a listing: same card, and same condition bucket (raw vs a specific grade).
// Only comps from the last `maxAgeDays` count, newest first.
export function compsForListing(listing, comps, { maxAgeDays = 90, now = new Date() } = {}) {
  const text = listing.compKey || listing.title;
  const cond = listing.condition || detectCondition(listing.title, 'NM');
  const cutoff = new Date(now.getTime() - maxAgeDays * 86400000);
  return comps
    .filter(c => nameMatches(text, c.cardName, c.set))
    .filter(c => {
      // Graded listings only use comps of the exact same grade. Raw listings use raw comps,
      // preferring the exact condition but accepting NM/LP as close enough when that's all we have.
      if (isGraded(cond) || isGraded(c.condition)) return c.condition === cond;
      return true;
    })
    .filter(c => !c.date || new Date(c.date) >= cutoff)
    .map(c => ({ ...c, price: parseFloat(c.salePrice), exactCondition: c.condition === cond }))
    .filter(c => Number.isFinite(c.price) && c.price > 0)
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}

export function compStats(matched) {
  const exact = matched.filter(c => c.exactCondition);
  const use = exact.length ? exact : matched;
  if (!use.length) return null;
  const prices = use.map(c => c.price);
  return {
    count: use.length,
    median: median(prices),
    low: Math.min(...prices),
    high: Math.max(...prices),
    latest: use[0],
    exactCondition: exact.length > 0,
  };
}

// Cost basis for a listing: first in-stock inventory item whose card name matches.
export function costForListing(listing, inventory) {
  if (listing.costBasis != null && listing.costBasis !== '') return parseFloat(listing.costBasis);
  const text = listing.compKey || listing.title;
  const hit = inventory.find(i => i.status !== 'Sold' && nameMatches(text, i.cardName, i.set));
  return hit ? parseFloat(hit.costBasis) || null : null;
}

export function netAfterFees(price, settings, shippingOut = 0) {
  return price * (1 - settings.ebayFeePct / 100) - settings.ebayFeeFlat - shippingOut;
}

// Lowest price that still clears cost + min profit after eBay fees.
export function floorPrice(cost, settings, shippingOut = 0) {
  if (cost == null || !Number.isFinite(cost)) return null;
  const needNet = cost + (settings.minProfitDollars || 0) + shippingOut + settings.ebayFeeFlat;
  return roundPrice(needNet / (1 - settings.ebayFeePct / 100), 'up');
}

// Round to cents, or to a ".99" style ending when the user asks for charm pricing.
export function roundPrice(p, mode = 'cents') {
  if (!Number.isFinite(p)) return p;
  if (mode === 'up') return Math.ceil(p * 100) / 100;
  if (mode === 'charm') {
    if (p < 1) return Math.max(0.99, Math.round(p * 100) / 100);
    const c = Math.floor(p) + 0.99;
    return +(c - p > 0.5 ? c - 1 : c).toFixed(2);
  }
  return Math.round(p * 100) / 100;
}

// Bulk rules. Each returns the new price for one listing, or null to leave it alone.
export const RULES = {
  matchComps: { label: 'Match comp median', unit: '% over/under', needsComps: true },
  percent: { label: 'Change by %', unit: '%' },
  dollars: { label: 'Change by $', unit: '$' },
  setTo: { label: 'Set all to $', unit: '$' },
};

export function applyRule(listing, rule, amount, ctx) {
  const cur = listing.price;
  const a = parseFloat(amount);
  let next;
  switch (rule) {
    case 'matchComps': {
      if (!ctx.stats) return null;
      next = ctx.stats.median * (1 + (Number.isFinite(a) ? a : 0) / 100);
      break;
    }
    case 'percent': if (!Number.isFinite(a)) return null; next = cur * (1 + a / 100); break;
    case 'dollars': if (!Number.isFinite(a)) return null; next = cur + a; break;
    case 'setTo': if (!Number.isFinite(a)) return null; next = a; break;
    default: return null;
  }
  return roundPrice(next, ctx.rounding || 'cents');
}

// Guardrails for a proposed price. Returns { price, warnings[], blocked }.
// - Never below $0.99 (eBay's practical minimum for fixed price).
// - Optionally clamp to the profit floor.
// - Flag big swings so a typo (e.g. 4.5 instead of 45) is caught before it hits eBay.
export function checkPrice(listing, proposed, ctx) {
  const warnings = [];
  let price = proposed;
  if (!Number.isFinite(price) || price <= 0) return { price, warnings: ['Enter a price above $0'], blocked: true };
  if (price < 0.99) { price = 0.99; warnings.push('Raised to eBay minimum $0.99'); }
  if (ctx.floor != null && price < ctx.floor) {
    if (ctx.enforceFloor) { price = ctx.floor; warnings.push(`Held at profit floor ${money(ctx.floor)}`); }
    else warnings.push(`Below profit floor ${money(ctx.floor)}`);
  }
  const change = (price - listing.price) / listing.price;
  if (Math.abs(change) >= 0.5) warnings.push(`${change > 0 ? '+' : ''}${Math.round(change * 100)}% vs current. Double-check`);
  if (ctx.stats && price > ctx.stats.high * 1.25) warnings.push('Well above highest comp');
  return { price, warnings, blocked: false };
}

export function money(n) {
  return n == null || !Number.isFinite(n) ? '—' : `$${n.toFixed(2)}`;
}
