// netlify/lib/card-catalog.js
// Confirms what Claude read against an official card catalog and gets the market price.
//   Pokémon: TCGdex (free, no key; prices are TCGplayer market prices per print style)
//   Magic:   Scryfall (free, no key; prices are TCGplayer market prices)
// Every lookup returns null instead of throwing when the card isn't found, so a miss
// sends the card to review rather than failing the whole snap.

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

async function getJson(url, fetchImpl, headers) {
  const res = await fetchImpl(url, headers ? { headers } : undefined);
  if (res.status === 404) return null;
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

export async function lookupCard(read, fetchImpl = fetch) {
  if (read.game === 'pokemon') return lookupPokemon(read, fetchImpl);
  if (read.game === 'mtg') return lookupMtg(read, fetchImpl);
  return null; // other games: photo-only in phase 1
}
