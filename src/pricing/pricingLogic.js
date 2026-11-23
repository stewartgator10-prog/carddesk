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

// Grade/condition detection from a listing title or an eBay condition string.
// Any slab grade from the big four graders (PSA 7, BGS 9.5, CGC 9.5, SGC 10...) wins over raw words.
const GRADE_RE = /\b(psa|bgs|cgc|sgc)\s*-?\s*(10|[1-9](?:\.5)?)\b/i;
const RAW_PATTERNS = [
  ['DMG', /\bdamaged\b|\bdmg\b/i], ['HP', /\bheavily played\b|\bhp\b/i],
  ['MP', /\bmoderately played\b|\bmp\b/i], ['LP', /\blightly played\b|\blp\b/i],
  ['NM', /\bnear mint\b|\bnm\b/i],
];

export function detectCondition(title, fallback = null) {
  const g = String(title || '').match(GRADE_RE);
  if (g) return `${g[1].toUpperCase()} ${g[2]}`;
  for (const [label, re] of RAW_PATTERNS) if (re.test(title || '')) return label;
  return fallback;
}

// eBay's Browse API reports graded cards as just "Graded"; the grade itself is in the title.
export function conditionFromEbay(condition, title) {
  return detectCondition(condition) || detectCondition(title) || 'NM';
}

// Price from one pasted sale-list line ("Charizard 020/189 $45", "Lugia V alt art - 120").
// A $ amount wins; otherwise the last plain number that isn't a card number (020/189) or a grade.
export function extractAskPrice(line) {
  const s = String(line || '');
  const dollar = s.match(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?/);
  if (dollar) return { price: parseFloat(dollar[1].replace(/,/g, '') + (dollar[2] || '')), token: dollar[0] };
  const masked = s
    .replace(/\b\d+\s*\/\s*\d+\b/g, m => ' '.repeat(m.length))
    .replace(new RegExp(GRADE_RE.source, 'gi'), m => ' '.repeat(m.length));
  const nums = [...masked.matchAll(/(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?(?!\w|[.,]\d)/g)];
  if (!nums.length) return null;
  const last = nums[nums.length - 1];
  return { price: parseFloat(last[1].replace(/,/g, '') + (last[2] || '')), token: last[0], index: last.index };
}

const isGraded = c => /^(PSA|BGS|CGC|SGC)/.test(c || '');

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
  // Prefer an inventory item explicitly tied to this eBay listing, then fall back to name matching.
  const byId = inventory.find(i => i.ebayItemId && String(i.ebayItemId) === String(listing.itemId));
  const toCost = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }; // a $0 cost (a pull, a gift) is still a cost
  if (byId && byId.costBasis !== '' && byId.costBasis != null) return toCost(byId.costBasis);
  const text = listing.compKey || listing.title;
  const hit = inventory.find(i => i.status !== 'Sold' && nameMatches(text, i.cardName, i.set));
  return hit ? toCost(hit.costBasis) : null;
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
  matchMarket: { label: 'Match TCGplayer market', unit: '% over/under' },
  undercut: { label: 'Undercut eBay low by $', unit: '$ below' },
  matchComps: { label: 'Match sold comp median', unit: '% over/under', needsComps: true },
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
    case 'matchMarket': {
      if (!(listing.market?.price > 0)) return null;
      next = listing.market.price * (1 + (Number.isFinite(a) ? a : 0) / 100);
      break;
    }
    case 'undercut': {
      // Competitor prices are totals (price + their shipping). Subtracting what this seller charges
      // buyers for shipping compares like with like; with 0 the result never undercuts on total.
      if (!(listing.comp?.low > 0)) return null;
      next = listing.comp.low - (Number.isFinite(a) ? a : 0) - (Number(ctx.buyerShipping) || 0);
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
