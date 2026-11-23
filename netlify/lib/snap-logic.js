// netlify/lib/snap-logic.js
// Pure Snap-to-List rules (no network): price, title, review flags, and trial scoring.
// Shared by the Netlify functions and the browser, and covered by tests/snap.test.js.

export const SNAP_DEFAULTS = {
  snapModel: 'claude-opus-5-5',
  snapMarkupPct: 0,       // % over market price
  snapMinPrice: 0.99,     // never list below this
  snapEnding: '0.89',     // round up to this ending: '0.89' | '0.98' | '0.99' | '0.49' | 'cents'
  aiMonthlyBudget: 25,    // USD of estimated Claude spend per calendar month; 0 = no limit
  snapShipCutoff: 20,     // list price under this uses the envelope shipping policy, at or over it the parcel one
  snapDescriptionFooter: '', // seller's own note added to every listing description (packaging, shipping...)
  // The package every card ships in. Calculated shipping policies need its weight and size.
  snapPackageWeightOz: 3,
  snapPackageLengthIn: 9,
  snapPackageWidthIn: 6,
  snapPackageDepthIn: 1,
};

export const CONFIDENCE_OK = 0.8;

// Games CardDesk knows. The first five are confirmed against a card catalog with prices;
// "other" card games are priced from eBay listings; sports cards use a different eBay category.
export const GAME_LABELS = { pokemon: 'Pokémon', mtg: 'Magic', yugioh: 'Yu-Gi-Oh!', one_piece: 'One Piece', lorcana: 'Lorcana', other: 'Other card game', sports: 'Sports' };
export const CATALOG_GAMES = ['pokemon', 'mtg', 'yugioh', 'lorcana', 'one_piece'];
export const LISTABLE_GAMES = [...CATALOG_GAMES, 'other'];
const isEnglish = (lang) => /^english$/i.test(lang || 'English');

// A listing's photos in eBay order: the main (identified) photo first, then the extras.
// eBay itself allows 24; 12 keeps the check quick and is plenty for a single card.
export const MAX_LISTING_PHOTOS = 12;
export function listingPhotoPaths(item) {
  const extras = Array.isArray(item?.extra_photo_paths) && item.extra_photo_paths.length
    ? item.extra_photo_paths
    : [item?.back_photo_path]; // cards saved before extra photos existed
  return [...new Set([item?.photo_path, ...extras].filter(Boolean))];
}
const round2 = (n) => Math.round(n * 100) / 100;

// Market price -> list price. At or under the minimum the minimum is used as-is;
// above it the price is rounded UP to the chosen ending (e.g. 2.10 -> 2.89).
export function suggestPrice(market, settings = {}) {
  const s = { ...SNAP_DEFAULTS, ...settings };
  if (!Number.isFinite(market) || market <= 0) return null;
  const min = Number(s.snapMinPrice) || 0;
  const base = market * (1 + (Number(s.snapMarkupPct) || 0) / 100);
  if (base <= min) return round2(min);
  if (s.snapEnding === 'cents') return Math.ceil(base * 100 - 1e-6) / 100;
  const e = parseFloat(s.snapEnding);
  if (!Number.isFinite(e)) return round2(base);
  let p = Math.floor(base) + e;
  if (p < base - 1e-9) p += 1;
  return round2(p);
}

const FINISH_LABEL = { reverse_holo: 'Reverse Holo', holo: 'Holo', foil: 'Foil', normal: '', unknown: '' };

// Titles in the seller's existing style, capped at eBay's 80 characters.
//   Pokémon: "Noctowl (Poke Ball Pattern) 078/131 Prismatic Evolutions Holo"
//   Magic:   "Shivan Dragon (22) Welcome Deck 2017 Foil Magic The Gathering NM"
export function buildTitle(item) {
  const name = item.card_name || item.catalog_name || '';
  const variant = item.variant ? ` (${item.variant})` : '';
  const misprint = item.misprint_confirmed && item.misprint_notes ? `${shortMisprint(item.misprint_notes)} Misprint ` : '';
  const set = item.catalog_set || item.set_name || '';
  const finish = FINISH_LABEL[item.finish] || '';
  // Lorcana prints "53/204"; its catalog only keeps the "53".
  const num = item.game === 'lorcana' ? (item.collector_number || item.catalog_number) : (item.catalog_number || item.collector_number);
  const worn = item.condition && item.condition !== 'NM' ? item.condition : '';
  const join = (parts) => parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  let parts;
  if (item.game === 'mtg') {
    parts = [`${misprint}${name}${variant}`, num ? `(${num})` : '', set, finish || 'Regular', 'Magic The Gathering', item.condition];
  } else if (item.game === 'pokemon' || !item.game) {
    parts = [`${misprint}${name}${variant}`, num, set, finish, worn];
  } else {
    // Other games: "Ash Blossom & Joyous Spring RA01-EN008 25th Anniversary Rarity Collection Ultra Rare Yu-Gi-Oh"
    const game = { yugioh: 'Yu-Gi-Oh', one_piece: 'One Piece', lorcana: 'Lorcana' }[item.game] || item.extraction?.game_name || '';
    const lead = `${misprint}${name}${variant}`;
    const tail = [item.game === 'lorcana' ? finish : '', game, worn];
    // When it runs past eBay's 80 characters, the set name goes first, then the rarity.
    for (const middle of [[num, set, item.rarity], [num, item.rarity], [num]]) {
      parts = [lead, ...middle, ...tail];
      if (join(parts).length <= 80) break;
    }
  }
  const full = join(parts);
  return full.length <= 80 ? full : full.slice(0, 80).replace(/\s+\S*$/, '');
}

function shortMisprint(notes) {
  const n = String(notes).toLowerCase();
  if (n.includes('texture')) return 'Texture Shift';
  if (n.includes('grid')) return 'Print Grid';
  if (n.includes('crimp')) return 'Crimped';
  if (n.includes('miscut') || n.includes('off-center') || n.includes('off center')) return 'Off Center';
  if (n.includes('ink')) return 'Ink Error';
  return 'Possible';
}

export const REVIEW_LABELS = {
  low_confidence: 'AI unsure',
  not_in_catalog: 'Not found in catalog',
  name_only_match: 'Set or number not confirmed',
  name_mismatch: 'Catalog name differs',
  possible_misprint: 'Possible misprint: check',
  already_listed: 'Looks already listed',
  no_price: 'No market price',
  graded: 'Graded slab (not in phase 1)',
  not_a_card: 'Not a trading card',
  other_game: 'No catalog for this game: check the details',
  sports_card: 'Sports card: can\'t be listed from here yet',
  multiple_versions: 'Several versions or editions: check which one',
  ebay_median: 'Priced from eBay listings: check',
  non_english: 'Not English',
  page_photo: 'Needs its own photo for eBay',
};

// Turns Claude's read + the catalog match into the queue row fields and review flags.
// ebayMedian is the middle price of matching eBay listings, used when the catalog has no price for this card.
export function applyIdentification({ read, catalog, settings = {}, duplicateItemId = null, ebayMedian = null }) {
  const reasons = [];
  if (!read.is_trading_card) reasons.push('not_a_card');
  if (read.graded) reasons.push('graded');
  const inCatalog = CATALOG_GAMES.includes(read.game);
  if (read.game === 'sports') reasons.push('sports_card');
  else if (!inCatalog) reasons.push('other_game');
  if (!isEnglish(read.language)) reasons.push('non_english');
  if (!(read.confidence >= CONFIDENCE_OK)) reasons.push('low_confidence');
  if (inCatalog) {
    if (!catalog) reasons.push('not_in_catalog');
    else {
      if (catalog.versions > 1) reasons.push('multiple_versions');
      if (catalog.matchLevel === 'name') reasons.push('name_only_match');
      const a = String(catalog.name || '').toLowerCase(), b = String(read.card_name || '').toLowerCase();
      if (a && b && !a.includes(b) && !b.includes(a)) reasons.push('name_mismatch');
    }
  }
  if (read.possible_misprint) reasons.push('possible_misprint');
  if (duplicateItemId) reasons.push('already_listed');
  // Catalog prices are for English printings, so another language is priced from eBay instead.
  const catalogPrice = isEnglish(read.language) ? catalog?.marketPrice ?? null : null;
  const fromEbay = catalogPrice == null && ebayMedian != null;
  if (fromEbay) reasons.push('ebay_median');
  const market = catalogPrice ?? ebayMedian ?? null;
  const suggested = suggestPrice(market, settings);
  if (suggested == null) reasons.push('no_price');

  const item = {
    extraction: read,
    confidence: read.confidence,
    game: read.game,
    card_name: read.card_name,
    set_name: read.set_name,
    set_code: read.set_code,
    collector_number: read.collector_number,
    finish: read.finish,
    variant: read.variant,
    rarity: catalog?.rarity ?? read.rarity ?? null,
    language: read.language,
    condition: read.condition_guess && read.condition_guess !== 'unknown' ? read.condition_guess : 'NM',
    misprint_flag: !!read.possible_misprint,
    misprint_notes: read.misprint_notes,
    catalog_source: catalog?.source ?? null,
    catalog_id: catalog?.id ?? null,
    catalog_name: catalog?.name ?? null,
    catalog_set: catalog?.setName ?? null,
    catalog_number: catalog?.number ?? null,
    catalog_image_url: catalog?.imageUrl ?? null,
    catalog_url: catalog?.url ?? null,
    match_level: catalog?.matchLevel ?? 'none',
    market_price: market,
    price_source: fromEbay ? 'eBay listings (median)' : market != null ? `TCGplayer market${catalog?.priceKey ? ` (${catalog.priceKey})` : ''}` : null,
    suggested_price: suggested,
    // When only the name matched, the catalog may have picked another printing worth far more or
    // less (Shivan Dragon: $0.16 vs a $23 reprint), so the seller has to set the price.
    price: catalog?.matchLevel === 'name' && !fromEbay ? null : suggested,
    duplicate_item_id: duplicateItemId,
    review_reasons: reasons,
    status: reasons.length ? 'needs_review' : 'ready',
    error: null,
  };
  item.title = buildTitle({ ...item, misprint_confirmed: false });
  return item;
}

// ---------- model trial scoring against the seller's own listing titles ----------
const STOP = new Set(['the', 'of', 'a', 'and', 'pokemon', 'tcg', 'card', 'holo', 'reverse', 'regular', 'rare', 'common', 'uncommon', 'nm', 'lp', 'mp', 'hp', 'magic', 'gathering', 'sv', 'ex']);
const tokens = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, '')
  .split(/[^a-z0-9]+/).filter((t) => t && !STOP.has(t));

export function titleNumber(title) {
  const m = String(title || '').match(/\b([A-Za-z]{0,4}\d{1,4})\s*\/\s*([A-Za-z]{0,4}\d{1,4})\b/);
  return m ? `${m[1]}/${m[2]}` : null;
}

const localOf = (s) => String(s || '').split('/')[0].toLowerCase().replace(/^([a-z]*)0*(\d)/, '$1$2');

export function scoreTrial({ title, read, catalog }) {
  const t = new Set(tokens(title));
  const nameTok = tokens(read?.card_name);
  const name_ok = nameTok.length > 0 && nameTok.every((x) => t.has(x));
  const tn = titleNumber(title);
  const number_ok = tn ? !!read?.collector_number && localOf(read.collector_number) === localOf(tn) : null;
  const setTok = tokens(catalog?.setName || read?.set_name);
  const set_ok = setTok.length ? setTok.filter((x) => t.has(x)).length / setTok.length >= 0.6 : null;
  const catTok = tokens(catalog?.name);
  const catalog_ok = !!catalog && catTok.length > 0 && catTok.every((x) => t.has(x))
    && (tn ? localOf(catalog.number) === localOf(tn) : true);
  return { name_ok, number_ok, set_ok, catalog_ok, correct: name_ok && number_ok !== false };
}

export function summarizeTrial(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.model)) by.set(r.model, []);
    by.get(r.model).push(r);
  }
  const pct = (xs, k) => { const s = xs.filter((x) => x[k] != null); return s.length ? s.filter((x) => x[k]).length / s.length : null; };
  return [...by.entries()].map(([model, xs]) => {
    const ok = xs.filter((x) => !x.error);
    const cost = xs.reduce((s, x) => s + (Number(x.cost_usd) || 0), 0);
    const lat = ok.map((x) => x.latency_ms).filter(Number.isFinite).sort((a, b) => a - b);
    return {
      model,
      cards: xs.length,
      errors: xs.length - ok.length,
      correct: pct(ok, 'correct'),
      name: pct(ok, 'name_ok'),
      number: pct(ok, 'number_ok'),
      set: pct(ok, 'set_ok'),
      catalog: pct(ok, 'catalog_ok'),
      totalCost: Math.round(cost * 1e4) / 1e4,
      costPerCard: xs.length ? cost / xs.length : null,
      medianLatencyMs: lat.length ? lat[Math.floor(lat.length / 2)] : null,
    };
  }).sort((a, b) => a.model.localeCompare(b.model));
}
