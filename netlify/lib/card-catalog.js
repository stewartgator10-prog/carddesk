// netlify/lib/card-catalog.js
// Confirms what Claude read against an official card catalog and gets the market price.
//   Pokémon: TCGdex (free, no key; prices are TCGplayer market prices per print style)
//   Magic:   Scryfall (free, no key; prices are TCGplayer market prices)
//   Yu-Gi-Oh!: TCGCSV (free, no key; a daily copy of TCGplayer's prices per rarity and edition),
//              with YGOPRODeck as the fallback when the set code can't be read
//   Lorcana:   Lorcast (free, no key; TCGplayer prices, normal and foil)
//   One Piece: OPTCG API (free, no key; TCGplayer market price per version of a card)
// Every lookup returns null instead of throwing when the card isn't found, so a miss
// sends the card to review rather than failing the whole snap.

import { CATALOG_GAMES } from './snap-logic.js';

const TCGDEX = 'https://api.tcgdex.net/v2/en';
const SCRYFALL = 'https://api.scryfall.com';
const SCRYFALL_HEADERS = { 'User-Agent': 'CardDesk/1.0', Accept: 'application/json' };

export const normName = (s) => String(s || '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// "035/193" -> { local: '35', localRaw: '035', total: '193' }; "TG05/TG30" -> { local: 'tg5', ... }; "216" -> { local: '216' }
export function splitNumber(s) {
  if (!s) return null;
  const [rawLocal, rawTotal] = String(s).replace(/\s+/g, '').split('/');
  const canon = (v) => (v || '').toLowerCase().replace(/^([a-z]*)0*(\d)/, '$1$2');
  if (!rawLocal) return null;
  return { local: canon(rawLocal), localRaw: rawLocal, total: rawTotal ? canon(rawTotal) : null };
}

const sameNumber = (a, b) => {
  const x = splitNumber(a), y = splitNumber(b);
  return !!(x && y && x.local === y.local);
};

async function getJson(url, fetchImpl, headers, { missing = [404] } = {}) {
  const res = await fetchImpl(url, headers ? { headers } : undefined);
  if (missing.includes(res.status)) return null;
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned ${res.status}`);
  return res.json();
}

// ---------- Pokémon (TCGdex) ----------
const TCGP_VARIANT = { reverse_holo: 'reverse-holofoil', holo: 'holofoil', normal: 'normal', foil: 'holofoil' };

export function pokemonPrice(card, finish) {
  const tp = card?.pricing?.tcgplayer;
  if (!tp) return { price: null, key: null };
  const want = TCGP_VARIANT[finish];
  const order = [want, 'normal', 'holofoil', 'reverse-holofoil', '1st-edition-holofoil', '1st-edition-normal'].filter(Boolean);
  for (const key of order) {
    const v = tp[key];
    const p = v?.marketPrice ?? v?.midPrice;
    if (Number.isFinite(p)) return { price: p, key, exact: key === want };
  }
  return { price: null, key: null };
}

export async function lookupPokemon(read, fetchImpl = fetch) {
  const name = read.card_name?.trim();
  if (!name) return null;
  const list = await getJson(`${TCGDEX}/cards?name=${encodeURIComponent(name)}`, fetchImpl) || [];
  const want = normName(name);
  const nameHits = list.filter((c) => normName(c.name) === want);
  const pool = nameHits.length ? nameHits : list.filter((c) => normName(c.name).includes(want) || want.includes(normName(c.name)));
  const num = splitNumber(read.collector_number);
  let candidates = num ? pool.filter((c) => sameNumber(c.localId, read.collector_number)) : [];
  const level = candidates.length ? 'number' : 'name';
  if (!candidates.length) candidates = pool.slice(-1); // name only: newest print, flagged for review
  if (!candidates.length) return null;

  // Several sets share a number: the printed set total (e.g. /193) or set name decides.
  const full = [];
  for (const c of candidates.slice(0, 6)) {
    const card = await getJson(`${TCGDEX}/cards/${encodeURIComponent(c.id)}`, fetchImpl);
    if (card) full.push(card);
  }
  const setName = normName(read.set_name);
  const score = (card) => {
    let s = 0;
    const official = String(card.set?.cardCount?.official ?? '');
    if (num?.total && official && splitNumber(official).local === num.total) s += 2;
    if (setName && normName(card.set?.name).includes(setName.replace(/^sv\s*/, ''))) s += 1;
    return s;
  };
  full.sort((a, b) => score(b) - score(a));
  const card = full[0];
  if (!card) return null;
  const exact = level === 'number' && score(card) >= 2;
  const { price, key } = pokemonPrice(card, read.finish);
  const productId = card.pricing?.tcgplayer?.[key]?.productId;
  return {
    source: 'tcgdex',
    id: card.id,
    name: card.name,
    setName: card.set?.name || null,
    number: `${card.localId}${card.set?.cardCount?.official ? `/${card.set.cardCount.official}` : ''}`,
    rarity: card.rarity || null,
    imageUrl: card.image ? `${card.image}/high.webp` : null,
    url: productId ? `https://www.tcgplayer.com/product/${productId}` : null,
    marketPrice: price,
    priceKey: key,
    matchLevel: exact ? 'exact' : level,
  };
}

// ---------- Magic (Scryfall) ----------
export function mtgPrice(card, finish) {
  const p = card?.prices || {};
  const pick = finish === 'foil' || finish === 'holo' ? ['usd_foil', 'usd_etched', 'usd'] : ['usd', 'usd_foil', 'usd_etched'];
  for (const k of pick) { const v = parseFloat(p[k]); if (Number.isFinite(v)) return { price: v, key: k }; }
  return { price: null, key: null };
}

function mtgResult(card, read, matchLevel) {
  const { price, key } = mtgPrice(card, read.finish);
  const img = card.image_uris?.normal || card.card_faces?.[0]?.image_uris?.normal || null;
  return {
    source: 'scryfall',
    id: card.id,
    name: card.name,
    setName: card.set_name || null,
    setCode: card.set ? card.set.toUpperCase() : null,
    number: card.collector_number,
    rarity: card.rarity || null,
    imageUrl: img,
    url: card.purchase_uris?.tcgplayer || card.scryfall_uri || null,
    marketPrice: price,
    priceKey: key,
    matchLevel,
  };
}

const mtgNameOk = (card, name) => {
  const want = normName(name);
  return normName(card.name) === want || (card.card_faces || []).some((f) => normName(f.name) === want);
};

export async function lookupMtg(read, fetchImpl = fetch) {
  const name = read.card_name?.trim();
  if (!name) return null;
  const num = splitNumber(read.collector_number);
  const code = (read.set_code || '').trim().toLowerCase();
  if (code && num) {
    const card = await getJson(`${SCRYFALL}/cards/${encodeURIComponent(code)}/${encodeURIComponent(num.localRaw.replace(/^0+(?=\d)/, ''))}`, fetchImpl, SCRYFALL_HEADERS);
    if (card && mtgNameOk(card, name)) return mtgResult(card, read, 'exact');
  }
  const q = `!"${name.replace(/"/g, '')}"`;
  const found = await getJson(`${SCRYFALL}/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released`, fetchImpl, SCRYFALL_HEADERS);
  const prints = found?.data || [];
  if (!prints.length) return null;
  const byCode = code ? prints.filter((c) => c.set === code) : [];
  const byNum = num ? (byCode.length ? byCode : prints).filter((c) => sameNumber(c.collector_number, read.collector_number)) : [];
  if (byNum.length) return mtgResult(byNum[0], read, byCode.length ? 'exact' : 'number');
  if (byCode.length) return mtgResult(byCode[0], read, 'name');
  return mtgResult(prints[0], read, 'name'); // newest print; the seller confirms the set
}

// ---------- Yu-Gi-Oh! (TCGCSV, then YGOPRODeck) ----------
const YGO = 'https://db.ygoprodeck.com/api/v7';
const TCGCSV = 'https://tcgcsv.com/tcgplayer/2'; // 2 = Yu-Gi-Oh! on TCGplayer
const HEADERS = { 'User-Agent': 'CardDesk/1.0', Accept: 'application/json' };
const price = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : null; };
// "lob-en001" -> "LOB-EN001"; the loose form drops the region letters ("LOB-001") so an older
// print without them still finds its set.
const ygoCode = (s) => String(s || '').toUpperCase().replace(/\s+/g, '');
const ygoLoose = (s) => ygoCode(s).replace(/^([A-Z0-9]+)-[A-Z]*(\d+)$/, '$1-$2');

// TCGCSV refreshes once a day, so set lists and price files are kept for six hours between calls
// (a nightly market refresh would otherwise download the same set file for every listing in it).
const tcgcsvCache = new Map();
async function tcgcsv(path, fetchImpl) {
  const live = fetchImpl === fetch;
  const hit = live && tcgcsvCache.get(path);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.rows;
  const rows = (await getJson(`${TCGCSV}/${path}`, fetchImpl, HEADERS))?.results || [];
  if (live && rows.length) {
    if (tcgcsvCache.size >= 16) tcgcsvCache.delete(tcgcsvCache.keys().next().value);
    tcgcsvCache.set(path, { at: Date.now(), rows });
  }
  return rows;
}
const ygoGroupList = (fetchImpl) => tcgcsv('groups', fetchImpl);
const ext = (product, key) => (product.extendedData || []).find((e) => e.name === key)?.value || null;
const stripParens = (s) => String(s || '').replace(/\s*\([^)]*\)/g, '').trim();

// Finds the exact TCGplayer product for a printed set code such as "RA01-EN008", then the price
// row for its edition. Returns null when the code can't be placed, so the caller can fall back.
async function lookupYugiohTcgplayer(read, fetchImpl) {
  const code = ygoCode(read.collector_number);
  const abbr = /^([A-Z0-9]+)-/.exec(code)?.[1];
  if (!abbr) return null;
  const groups = (await ygoGroupList(fetchImpl)).filter((g) => {
    const a = String(g.abbreviation || '').toUpperCase();
    return a === abbr || a.startsWith(`${abbr}-`);
  }).slice(0, 4);
  if (!groups.length) return null;
  const english = /^english$/i.test(read.language || 'English');
  const found = [];
  for (const g of groups) {
    const products = await tcgcsv(`${g.groupId}/products`, fetchImpl);
    for (const p of products) {
      const n = ygoCode(ext(p, 'Number'));
      if (n === code) found.push({ g, p, exact: true });
      else if (english && n && ygoLoose(n) === ygoLoose(code)) found.push({ g, p, exact: false });
    }
  }
  let hits = found.some((f) => f.exact) ? found.filter((f) => f.exact) : found;
  const sameName = hits.filter((f) => normName(stripParens(f.p.name)) === normName(read.card_name));
  if (sameName.length) hits = sameName;
  if (!hits.length) return null;
  const level = hits[0].exact ? 'exact' : 'number';
  const wantRarity = normName(read.rarity);
  const byRarity = wantRarity ? hits.filter((f) => normName(ext(f.p, 'Rarity')) === wantRarity) : [];
  const chosen = hits.length === 1 ? hits[0] : byRarity.length === 1 ? byRarity[0] : null;
  const shown = chosen || hits[0];
  let marketPrice = null, edition = null, editions = 1;
  if (chosen) {
    const rows = (await tcgcsv(`${chosen.g.groupId}/prices`, fetchImpl)).filter((r) => r.productId === chosen.p.productId);
    editions = rows.length || 1;
    const said = read.variant || '';
    const want = /1st|first/i.test(said) ? /1st/i : /unlimited/i.test(said) ? /unlimited/i : /limited/i.test(said) ? /^limited/i : null;
    // No edition printed on the card means Unlimited.
    const row = (want && rows.find((r) => want.test(r.subTypeName || ''))) || (rows.length === 1 ? rows[0] : rows.find((r) => /unlimited/i.test(r.subTypeName || ''))) || null;
    marketPrice = price(row?.marketPrice) ?? price(row?.midPrice);
    edition = row?.subTypeName || null;
  }
  return {
    source: 'tcgcsv', id: String(shown.p.productId), name: stripParens(shown.p.name),
    setName: shown.g.name || null, number: ygoCode(ext(shown.p, 'Number')), rarity: chosen ? ext(chosen.p, 'Rarity') : null,
    imageUrl: shown.p.imageUrl ? shown.p.imageUrl.replace('_200w', '_400w') : null, url: shown.p.url || null,
    marketPrice, priceKey: chosen ? [ext(chosen.p, 'Rarity'), edition].filter(Boolean).join(', ') : null,
    matchLevel: chosen ? level : 'number',
    // Several rarities share this code, or the card exists in more than one edition.
    versions: Math.max(hits.length, editions),
  };
}

export async function lookupYugioh(read, fetchImpl = fetch) {
  const viaTcgplayer = await lookupYugiohTcgplayer(read, fetchImpl).catch((e) => { console.error('tcgcsv', e.message); return null; });
  return viaTcgplayer || lookupYugiohByName(read, fetchImpl);
}

// Fallback: confirms the card exists and which sets it was printed in. Its prices are often missing.
export async function lookupYugiohByName(read, fetchImpl = fetch) {
  const name = read.card_name?.trim();
  if (!name) return null;
  // YGOPRODeck answers 400 when nothing matches.
  const get = (q) => getJson(`${YGO}/cardinfo.php?${q}`, fetchImpl, HEADERS, { missing: [400, 404] });
  let card = (await get(`name=${encodeURIComponent(name)}`))?.data?.[0];
  if (!card) {
    const fuzzy = (await get(`fname=${encodeURIComponent(name)}`))?.data || [];
    card = fuzzy.find((c) => normName(c.name) === normName(name)) || (fuzzy.length === 1 ? fuzzy[0] : null);
  }
  if (!card) return null;
  const sets = card.card_sets || [];
  const code = ygoCode(read.collector_number);
  const english = /^english$/i.test(read.language || 'English');
  let hits = code ? sets.filter((s) => ygoCode(s.set_code) === code) : [];
  let level = hits.length ? 'exact' : 'name';
  if (!hits.length && code && english) {
    hits = sets.filter((s) => ygoLoose(s.set_code) === ygoLoose(code));
    if (hits.length) level = 'number';
  }
  const base = {
    source: 'ygoprodeck', id: String(card.id), name: card.name, imageUrl: null, // their terms don't allow linking their images directly
    url: card.ygoprodeck_url || null,
  };
  if (!hits.length) {
    return { ...base, setName: null, number: null, rarity: null, marketPrice: price(card.card_prices?.[0]?.tcgplayer_price), priceKey: 'lowest print', matchLevel: 'name', versions: sets.length };
  }
  // One set code can be printed in several rarities, each with its own price.
  const wantRarity = normName(read.rarity);
  const byRarity = wantRarity ? hits.filter((s) => normName(s.set_rarity) === wantRarity) : [];
  const chosen = hits.length === 1 ? hits[0] : byRarity.length === 1 ? byRarity[0] : null;
  const edition = /1st|first|limited/i.test(read.variant || '');
  const p = chosen ? price(chosen.set_price) : null;
  return {
    ...base,
    setName: hits[0].set_name || null,
    number: hits[0].set_code,
    rarity: chosen?.set_rarity || null,
    marketPrice: p,
    priceKey: chosen?.set_rarity || null,
    matchLevel: chosen ? level : 'number',
    // More than one rarity under this code, or an edition whose price can differ a lot on a pricier card.
    versions: hits.length > 1 ? hits.length : (edition && p >= 10 ? 2 : 1),
  };
}

// ---------- Lorcana (Lorcast) ----------
const LORCAST = 'https://api.lorcast.com/v0';
// The card shows a name and a version line ("Elsa" / "Snow Queen"); Claude joins them with " - ".
export const splitLorcanaName = (s) => {
  const [name, ...rest] = String(s || '').split(/\s+[-–—]\s+/);
  return { name: name.trim(), version: rest.join(' - ').trim() || null };
};

function lorcanaResult(card, read, matchLevel, versions = 1) {
  const foil = read.finish === 'foil' || read.finish === 'holo';
  const keys = foil ? ['usd_foil', 'usd'] : ['usd', 'usd_foil'];
  const key = keys.find((k) => price(card.prices?.[k]) != null) || null;
  return {
    source: 'lorcast', id: card.id, name: `${card.name}${card.version ? ` - ${card.version}` : ''}`,
    setName: card.set?.name || null, setCode: card.set?.code || null, number: String(card.collector_number),
    rarity: card.rarity || null, imageUrl: card.image_uris?.digital?.normal || null,
    url: card.purchase_uris?.tcgplayer || null,
    marketPrice: key ? price(card.prices[key]) : null, priceKey: key, matchLevel, versions,
  };
}

export async function lookupLorcana(read, fetchImpl = fetch) {
  const { name, version } = splitLorcanaName(read.card_name);
  if (!name) return null;
  const sameCard = (c) => normName(c.name) === normName(name) && (!version || normName(c.version) === normName(version));
  const num = splitNumber(read.collector_number);
  const code = String(read.set_code || '').trim();
  if (code && num) {
    const card = await getJson(`${LORCAST}/cards/${encodeURIComponent(code)}/${encodeURIComponent(num.localRaw.replace(/^0+(?=\d)/, ''))}`, fetchImpl, HEADERS);
    if (card?.id && sameCard(card)) return lorcanaResult(card, read, 'exact');
  }
  const found = await getJson(`${LORCAST}/cards/search?q=${encodeURIComponent(`name:"${name.replace(/"/g, '')}"`)}&unique=prints`, fetchImpl, HEADERS);
  const prints = (found?.results || []).filter(sameCard);
  if (!prints.length) return null;
  const byNum = num ? prints.filter((c) => sameNumber(c.collector_number, read.collector_number)) : [];
  if (byNum.length) return lorcanaResult(byNum[0], read, byNum.length === 1 ? 'exact' : 'number', byNum.length);
  // Only the name matched: show the cheapest printing, so a rare version's price is never assumed.
  const cheapest = prints.map((c) => lorcanaResult(c, read, 'name', prints.length)).sort((a, b) => (a.marketPrice ?? Infinity) - (b.marketPrice ?? Infinity))[0];
  return cheapest;
}

// ---------- One Piece (OPTCG API) ----------
const OPTCG = 'https://optcgapi.com/api';
// "op01-001" -> "OP01-001". Booster sets, starter decks (ST) and promos (P-) live on different paths.
export const onePieceId = (s) => {
  const m = /^([A-Z]{1,4}\d{0,2})-?(\d{3})$/.exec(String(s || '').toUpperCase().replace(/\s+/g, ''));
  return m ? `${m[1]}-${m[2]}` : null;
};
const opBaseName = (s) => String(s || '').replace(/\s*\([^)]*\)/g, '').trim();
const OP_VARIANT = [
  [/parallel|alternate art|alt\.? art/i, /alternate art|parallel/i], [/manga/i, /manga/i], [/\bsp\b|special/i, /\(sp\)/i],
  [/reprint/i, /reprint/i], [/wanted/i, /wanted poster/i], [/treasure/i, /treasure/i], [/full art/i, /full art/i],
  [/pre-?release/i, /pre-?release/i], [/winner/i, /winner/i], [/judge/i, /judge/i], [/gold/i, /gold/i],
];

export async function lookupOnePiece(read, fetchImpl = fetch) {
  const id = onePieceId(read.collector_number);
  if (!id) return null;
  const order = id.startsWith('ST') ? ['decks', 'sets', 'promos'] : id.startsWith('P-') ? ['promos', 'sets', 'decks'] : ['sets', 'promos', 'decks'];
  let list = [];
  for (const kind of order) {
    const got = await getJson(`${OPTCG}/${kind}/card/${encodeURIComponent(id)}/`, fetchImpl, HEADERS);
    if (Array.isArray(got) && got.length) { list = got; break; }
  }
  if (!list.length) return null;
  // The same card number comes in plain, alternate art, manga, SP... versions worth very different amounts.
  const plain = list.find((c) => c.card_image_id === c.card_set_id) || list[0];
  let chosen = plain;
  const variant = String(read.variant || '').trim();
  if (variant) {
    const wanted = OP_VARIANT.filter(([said]) => said.test(variant)).map(([, named]) => named);
    let fits = wanted.length ? list.filter((c) => c !== plain && wanted.every((re) => re.test(c.card_name))) : [];
    const narrow = (keep) => { const next = fits.filter(keep); if (fits.length > 1 && next.length) fits = next; };
    narrow((c) => c.set_id === plain.set_id);                                        // the set the plain card came from
    const unsaid = OP_VARIANT.filter(([said]) => !said.test(variant)).map(([, named]) => named);
    narrow((c) => !unsaid.some((re) => re.test(c.card_name)));                        // not also a manga, SP... version
    chosen = fits.length === 1 ? fits[0] : null;
  }
  const shown = chosen || plain;
  return {
    source: 'optcg', id: shown.card_image_id || shown.card_set_id,
    name: `${opBaseName(shown.card_name)}${chosen && chosen !== plain ? ` ${(shown.card_name.match(/\((?!\d+\)|[A-Z]+\d*-\d+\))[^)]*\)/g) || []).join(' ')}` : ''}`.trim(),
    setName: shown.set_name || null, number: shown.card_set_id, rarity: shown.rarity || null,
    imageUrl: shown.card_image || null, url: null,
    marketPrice: chosen ? price(chosen.market_price) : null, priceKey: chosen === plain ? 'standard version' : (chosen ? 'special version' : null),
    matchLevel: chosen ? (list.length === 1 ? 'exact' : 'number') : 'number',
    versions: list.length,
  };
}

// One lookup per game in CATALOG_GAMES. Anything else is priced from eBay listings and sent to review.
const LOOKUPS = { pokemon: lookupPokemon, mtg: lookupMtg, yugioh: lookupYugioh, lorcana: lookupLorcana, one_piece: lookupOnePiece };
export { CATALOG_GAMES };

export async function lookupCard(read, fetchImpl = fetch) {
  const fn = LOOKUPS[read.game];
  return fn ? fn(read, fetchImpl) : null;
}

// The AI sometimes files newer Magic cards (crossover sets such as Spider-Man or Final Fantasy) under
// "other". If the printed set code and number are a real Magic card with the same name, it is Magic.
// Returns { read, catalog } with read.game corrected.
export async function resolveCatalog(read, { lookup = lookupCard, fetchImpl = fetch } = {}) {
  let catalog = await lookup(read, fetchImpl).catch((e) => { console.error('catalog lookup', e.message); return null; });
  if (!catalog && read?.game === 'other' && read.set_code && read.collector_number && read.card_name) {
    const asMtg = { ...read, game: 'mtg' };
    const hit = await lookupMtg(asMtg, fetchImpl).catch(() => null);
    if (hit && hit.matchLevel === 'exact') return { read: { ...asMtg, game_name: null }, catalog: hit };
  }
  return { read, catalog };
}
