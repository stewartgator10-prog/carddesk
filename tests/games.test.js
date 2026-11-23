// Yu-Gi-Oh!, One Piece, Lorcana and other card games: catalog matching, review flags, titles, eBay details.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lookupCard, lookupYugioh, lookupLorcana, lookupOnePiece, splitLorcanaName, onePieceId } from '../netlify/lib/card-catalog.js';
import { applyIdentification, buildTitle, CATALOG_GAMES, LISTABLE_GAMES } from '../netlify/lib/snap-logic.js';
import { buildSpecifics, gameSpecific, gameValuesFromAspects, checkSnapItem, learnTemplates } from '../netlify/lib/ebay-listing.js';
import { ebayMedianFor } from '../netlify/lib/market.js';
import { valueCard } from '../netlify/lib/buy-offer.js';
import { identifySnapItem } from '../netlify/lib/snap-identify.js';
import { fakeDb } from './fake-db.js';

const U = 'u1';
const read = (over = {}) => ({ is_trading_card: true, game: 'yugioh', card_name: 'Ash Blossom & Joyous Spring', collector_number: 'RA01-EN008', set_name: null, set_code: 'RA01',
  language: 'English', finish: 'foil', variant: null, rarity: null, game_name: null, graded: false, condition_guess: 'NM', possible_misprint: false, misprint_notes: null, confidence: 0.95, notes: null, ...over });

// A stand-in for the catalog sites: answers by URL, and records what was asked.
function fakeWeb(routes) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    const hit = Object.entries(routes).find(([k]) => String(url).includes(k));
    if (!hit) return new Response('{"error":"not found"}', { status: 404 });
    const [, body] = hit;
    return typeof body === 'number' ? new Response('{}', { status: body }) : new Response(JSON.stringify(body));
  };
  return { fetchImpl, asked };
}
const product = (id, name, number, rarity) => ({ productId: id, name, imageUrl: `https://tcgplayer-cdn.tcgplayer.com/product/${id}_200w.jpg`, url: `https://www.tcgplayer.com/product/${id}`,
  extendedData: [{ name: 'Number', value: number }, { name: 'Rarity', value: rarity }] });

const ygoWeb = () => fakeWeb({
  'tcgcsv.com/tcgplayer/2/groups': { results: [{ groupId: 23233, name: '25th Anniversary Rarity Collection', abbreviation: 'RA01' }, { groupId: 330, name: 'The Legend of Blue Eyes White Dragon', abbreviation: 'LOB' }, { groupId: 9, name: 'Unrelated', abbreviation: 'RA' }] },
  'tcgcsv.com/tcgplayer/2/23233/products': { results: [product(1, 'Ash Blossom & Joyous Spring', 'RA01-EN008', 'Super Rare'), product(2, 'Ash Blossom & Joyous Spring (UR)', 'RA01-EN008', 'Ultra Rare'), product(3, 'Nibiru, the Primal Being', 'RA01-EN015', 'Super Rare')] },
  'tcgcsv.com/tcgplayer/2/23233/prices': { results: [{ productId: 1, subTypeName: '1st Edition', marketPrice: 1.99, midPrice: 3 }, { productId: 2, subTypeName: '1st Edition', marketPrice: 2.33, midPrice: 3 }, { productId: 3, subTypeName: '1st Edition', marketPrice: 0.4 }] },
  'tcgcsv.com/tcgplayer/2/330/products': { results: [product(21792, 'Blue-Eyes White Dragon', 'LOB-001', 'Ultra Rare')] },
  'tcgcsv.com/tcgplayer/2/330/prices': { results: [{ productId: 21792, subTypeName: 'Unlimited', marketPrice: 119.14, midPrice: 119.57 }, { productId: 21792, subTypeName: '1st Edition', marketPrice: null, midPrice: 3799.92 }] },
  'cardinfo.php?name=Dark%20Magician': { data: [{ id: 46986414, name: 'Dark Magician', ygoprodeck_url: 'https://ygoprodeck.com/card/dark-magician', card_sets: [{ set_name: 'Starter Deck: Yugi', set_code: 'SDY-006', set_rarity: 'Ultra Rare', set_price: '0' }], card_prices: [{ tcgplayer_price: '0.33' }] }] },
  'cardinfo.php': 400,
});

test('Yu-Gi-Oh!: the printed set code finds the exact TCGplayer product, by rarity and edition', async () => {
  // One rarity under the code: priced straight away.
  let web = ygoWeb();
  const nib = await lookupYugioh(read({ card_name: 'Nibiru, the Primal Being', collector_number: 'ra01-en015' }), web.fetchImpl);
  assert.deepEqual([nib.source, nib.name, nib.setName, nib.number, nib.rarity, nib.marketPrice, nib.matchLevel, nib.versions],
    ['tcgcsv', 'Nibiru, the Primal Being', '25th Anniversary Rarity Collection', 'RA01-EN015', 'Super Rare', 0.4, 'exact', 1]);
  assert.match(nib.imageUrl, /_400w\.jpg$/);
  assert.ok(!web.asked.some((u) => u.includes('/9/')));                                 // "RA" is a different set from "RA01"

  // Several rarities share RA01-EN008: the rarity Claude read picks one, and it is still flagged as having versions.
  const ur = await lookupYugioh(read({ rarity: 'Ultra Rare' }), ygoWeb().fetchImpl);
  assert.deepEqual([ur.rarity, ur.marketPrice, ur.matchLevel, ur.versions], ['Ultra Rare', 2.33, 'exact', 2]);
  // Rarity not read: no price is guessed.
  const unsure = await lookupYugioh(read(), ygoWeb().fetchImpl);
  assert.deepEqual([unsure.rarity, unsure.marketPrice, unsure.matchLevel, unsure.versions], [null, null, 'number', 2]);

  // Editions: nothing printed means Unlimited; "1st Edition" takes the other row (mid price when there is no market price).
  const unl = await lookupYugioh(read({ card_name: 'Blue-Eyes White Dragon', collector_number: 'LOB-001' }), ygoWeb().fetchImpl);
  assert.deepEqual([unl.marketPrice, unl.priceKey, unl.versions], [119.14, 'Ultra Rare, Unlimited', 2]);
  const first = await lookupYugioh(read({ card_name: 'Blue-Eyes White Dragon', collector_number: 'LOB-001', variant: '1st Edition' }), ygoWeb().fetchImpl);
  assert.deepEqual([first.marketPrice, first.priceKey], [3799.92, 'Ultra Rare, 1st Edition']);
  // An older print read as LOB-EN001 still finds LOB-001, marked as a looser match; a Japanese card does not.
  const loose = await lookupYugioh(read({ card_name: 'Blue-Eyes White Dragon', collector_number: 'LOB-EN001' }), ygoWeb().fetchImpl);
  assert.equal(loose.matchLevel, 'number');
  assert.equal(await lookupYugioh(read({ card_name: 'Blue-Eyes White Dragon', collector_number: 'LOB-JP001', language: 'Japanese' }), ygoWeb().fetchImpl), null);

  // No set code readable: the name alone confirms the card exists, as a name-only match.
  const byName = await lookupYugioh(read({ card_name: 'Dark Magician', collector_number: null }), ygoWeb().fetchImpl);
  assert.deepEqual([byName.source, byName.matchLevel, byName.marketPrice, byName.imageUrl], ['ygoprodeck', 'name', 0.33, null]);
  assert.equal(await lookupYugioh(read({ card_name: 'Not A Card', collector_number: 'ZZ-EN001' }), ygoWeb().fetchImpl), null);
});

const lorcanaCard = (over) => ({ id: 'crd_1', name: 'Elsa', version: 'Snow Queen', collector_number: '53', rarity: 'Uncommon', set: { code: '9', name: 'Fabled' },
  image_uris: { digital: { normal: 'https://cards.lorcast.io/elsa.avif' } }, prices: { usd: 0.15, usd_foil: 0.47 }, purchase_uris: { tcgplayer: 'https://www.tcgplayer.com/product/649997' }, ...over });

test('Lorcana: set and number, then name and number; foil price for foils; cheapest print when only the name matches', async () => {
  assert.deepEqual(splitLorcanaName('Elsa - Snow Queen'), { name: 'Elsa', version: 'Snow Queen' });
  const web = fakeWeb({
    '/cards/9/53': lorcanaCard(),
    '/cards/search': { results: [lorcanaCard(), lorcanaCard({ id: 'crd_2', version: 'Spirit of Winter', collector_number: '42', set: { code: '1', name: 'The First Chapter' }, prices: { usd: 5 } }),
      lorcanaCard({ id: 'crd_3', version: 'Spirit of Winter', collector_number: '207', rarity: 'Enchanted', set: { code: '1', name: 'The First Chapter' }, prices: { usd_foil: 946.27 } })] },
  });
  const exact = await lookupLorcana(read({ game: 'lorcana', card_name: 'Elsa - Snow Queen', collector_number: '53/204', set_code: '9', finish: 'normal' }), web.fetchImpl);
  assert.deepEqual([exact.name, exact.setName, exact.number, exact.marketPrice, exact.priceKey, exact.matchLevel], ['Elsa - Snow Queen', 'Fabled', '53', 0.15, 'usd', 'exact']);
  const foil = await lookupLorcana(read({ game: 'lorcana', card_name: 'Elsa - Snow Queen', collector_number: '53/204', set_code: null }), web.fetchImpl);
  assert.deepEqual([foil.marketPrice, foil.priceKey, foil.matchLevel], [0.47, 'usd_foil', 'exact']);
  const nameOnly = await lookupLorcana(read({ game: 'lorcana', card_name: 'Elsa - Spirit of Winter', collector_number: null, set_code: null, finish: 'normal' }), web.fetchImpl);
  assert.deepEqual([nameOnly.matchLevel, nameOnly.marketPrice, nameOnly.versions], ['name', 5, 2]);   // not the $946 Enchanted
  assert.equal(await lookupLorcana(read({ game: 'lorcana', card_name: 'Nobody - At All', collector_number: '1/204', set_code: null }), web.fetchImpl), null);
});

const op = (name, imageId, market, set = 'OP-05', setName = 'Awakening of the New Era') => ({ card_name: name, set_name: setName, set_id: set, rarity: 'SEC', card_set_id: 'OP05-119', card_image_id: imageId, market_price: market, card_image: `https://optcgapi.com/${imageId}.jpg` });

test('One Piece: the card number lists every version; the plain one is the default and special versions need a clear match', async () => {
  assert.equal(onePieceId('op05-119'), 'OP05-119');
  assert.equal(onePieceId('P-001'), 'P-001');
  assert.equal(onePieceId('035/193'), null);
  const web = fakeWeb({
    '/sets/card/OP05-119/': [op('Monkey.D.Luffy (119)', 'OP05-119', 20), op('Monkey.D.Luffy (119) (Alternate Art)', 'OP05-119_p1', 155.28), op('Monkey.D.Luffy (119) (Alternate Art) (Manga)', 'OP05-119_p2', 3915.86),
      op('Monkey.D.Luffy (OP05-119) (Alternate Art)', 'OP05-119_p4', 217.32, 'PRB-01', 'Premium Booster'), op('Monkey.D.Luffy (OP05-119) (Manga)', 'OP05-119_r2', 4250, 'PRB-01', 'Premium Booster')],
    '/sets/card/ST01-001/': 404,
    '/decks/card/ST01-001/': [{ ...op('Monkey.D.Luffy (001)', 'ST01-001', 30.81, 'ST-01', 'Starter Deck 1'), card_set_id: 'ST01-001', rarity: 'L' }],
  });
  const one = (over) => lookupOnePiece(read({ game: 'one_piece', card_name: 'Monkey.D.Luffy', collector_number: 'OP05-119', ...over }), web.fetchImpl);
  const plain = await one({});
  assert.deepEqual([plain.name, plain.marketPrice, plain.matchLevel, plain.versions, plain.number], ['Monkey.D.Luffy', 20, 'number', 5, 'OP05-119']);
  const alt = await one({ variant: 'Alternate Art' });
  assert.deepEqual([alt.name, alt.marketPrice, alt.id], ['Monkey.D.Luffy (Alternate Art)', 155.28, 'OP05-119_p1']);       // same set, and not the manga one
  const manga = await one({ variant: 'Manga' });
  assert.equal(manga.marketPrice, 3915.86);
  const odd = await one({ variant: 'Some unknown stamp' });
  assert.equal(odd.marketPrice, null);                                                                                    // can't tell which: no price guessed
  const deck = await lookupOnePiece(read({ game: 'one_piece', card_name: 'Monkey.D.Luffy', collector_number: 'ST01-001' }), web.fetchImpl);
  assert.deepEqual([deck.marketPrice, deck.matchLevel, deck.versions], [30.81, 'exact', 1]);                              // starter decks live on another path
  assert.ok(web.asked.some((u) => u.includes('/decks/card/ST01-001/')));
  assert.equal(await lookupOnePiece(read({ game: 'one_piece', collector_number: 'OP99-999' }), web.fetchImpl), null);
});

test('only the five catalog games are looked up; every card game but sports can be listed', async () => {
  assert.deepEqual([...CATALOG_GAMES].sort(), ['lorcana', 'mtg', 'one_piece', 'pokemon', 'yugioh']);
  assert.deepEqual(LISTABLE_GAMES.filter((g) => !CATALOG_GAMES.includes(g)), ['other']);
  let called = false;
  assert.equal(await lookupCard(read({ game: 'other' }), async () => { called = true; return new Response('{}'); }), null);
  assert.equal(called, false);
});

const ygoCatalog = (over = {}) => ({ source: 'tcgcsv', id: '2', name: 'Ash Blossom & Joyous Spring', setName: '25th Anniversary Rarity Collection', number: 'RA01-EN008', rarity: 'Ultra Rare',
  imageUrl: 'https://img/2.jpg', url: 'https://www.tcgplayer.com/product/2', marketPrice: 2.33, priceKey: 'Ultra Rare, 1st Edition', matchLevel: 'exact', versions: 1, ...over });

test('review: a confirmed Yu-Gi-Oh! card is ready; versions, other games, other languages and sports are held with the reason', () => {
  const ok = applyIdentification({ read: read({ variant: '1st Edition' }), catalog: ygoCatalog() });
  assert.deepEqual([ok.status, ok.review_reasons, ok.market_price, ok.price, ok.rarity, ok.game], ['ready', [], 2.33, 2.89, 'Ultra Rare', 'yugioh']);
  assert.equal(ok.title, 'Ash Blossom & Joyous Spring (1st Edition) RA01-EN008 Ultra Rare Yu-Gi-Oh');             // set name dropped to fit 80 characters
  assert.ok(ok.title.length <= 80);

  const versions = applyIdentification({ read: read(), catalog: ygoCatalog({ versions: 7, marketPrice: null, rarity: null, matchLevel: 'number' }), ebayMedian: 4.2 });
  assert.deepEqual(versions.review_reasons.sort(), ['ebay_median', 'multiple_versions']);
  assert.deepEqual([versions.market_price, versions.price_source, versions.price, versions.status], [4.2, 'eBay listings (median)', 4.89, 'needs_review']);

  const digimon = applyIdentification({ read: read({ game: 'other', game_name: 'Digimon Card Game', card_name: 'Agumon', collector_number: 'BT1-010' }), catalog: null, ebayMedian: 1.5 });
  assert.deepEqual(digimon.review_reasons.sort(), ['ebay_median', 'other_game']);                                    // no "not in catalog": there is no catalog for it
  assert.equal(digimon.price, 1.89);
  assert.equal(digimon.title, 'Agumon BT1-010 Digimon Card Game');

  // A Japanese card: the catalog price is for the English print, so eBay's price is used instead.
  const jp = applyIdentification({ read: read({ language: 'Japanese' }), catalog: ygoCatalog(), ebayMedian: 9 });
  assert.equal(jp.market_price, 9);
  assert.ok(jp.review_reasons.includes('non_english') && jp.review_reasons.includes('ebay_median'));

  const sports = applyIdentification({ read: read({ game: 'sports', card_name: 'Some Player' }), catalog: null });
  assert.ok(sports.review_reasons.includes('sports_card') && !sports.review_reasons.includes('other_game'));

  assert.equal(buildTitle({ game: 'one_piece', card_name: 'Monkey.D.Luffy', variant: 'Alternate Art', catalog_number: 'OP05-119', catalog_set: 'Awakening of the New Era', rarity: 'SEC', condition: 'NM' }),
    'Monkey.D.Luffy (Alternate Art) OP05-119 Awakening of the New Era SEC One Piece');
  assert.equal(buildTitle({ game: 'lorcana', card_name: 'Elsa - Snow Queen', catalog_number: '53', collector_number: '53/204', catalog_set: 'Fabled', rarity: 'Uncommon', finish: 'foil', condition: 'NM' }),
    'Elsa - Snow Queen 53/204 Fabled Uncommon Foil Lorcana');
  assert.equal(buildTitle({ game: 'pokemon', card_name: 'Fuecoco', catalog_number: '035/193', catalog_set: 'Paldea Evolved', finish: 'reverse_holo', condition: 'NM' }), 'Fuecoco 035/193 Paldea Evolved Reverse Holo'); // unchanged
});

const ebayItem = (title, price) => ({ title, price: { value: String(price) }, shippingOptions: [{ shippingCost: { value: '1' } }], buyingOptions: ['FIXED_PRICE'], seller: { username: 'someone' } });

test('a card with no catalog price is priced from matching eBay listings, in Snap to List and in buy offers', async () => {
  const browseSearch = async ({ q }) => ({ items: [ebayItem('Agumon BT1-010 Digimon', 1), ebayItem('Agumon BT1-010 Digimon Card Game NM', 2), ebayItem('Agumon BT1-010 PSA 10', 80), ebayItem('Gabumon BT1-029', 9),
    { ...ebayItem('Agumon BT1-010 mine', 0.5), seller: { username: 'me' } }], q });
  const digimon = read({ game: 'other', game_name: 'Digimon Card Game', card_name: 'Agumon', collector_number: 'BT1-010', finish: 'normal' });
  assert.equal(await ebayMedianFor(digimon, { ownSeller: 'me', deps: { browseSearch } }), 2.5);     // 2.00 and 3.00 with shipping; the slab, the other card and my own listing don't count

  const db = fakeDb({ settings: [], api_usage: [], ebay_listings: [], ebay_accounts: [{ user_id: U, ebay_username: 'me' }],
    snap_items: [{ id: 's1', user_id: U, status: 'uploaded', photo_path: `${U}/b/1.jpg` }] }, null, { files: { [`${U}/b/1.jpg`]: 'jpeg' } });
  const deps = { readCard: async ({ model }) => ({ read: digimon, usage: { input_tokens: 2000, output_tokens: 400 }, latencyMs: 900, requestId: 'r', model }), lookupCard: async () => null, browseSearch };
  await identifySnapItem({ db, userId: U, item: db.tables.snap_items[0], deps });
  const row = db.tables.snap_items[0];
  assert.deepEqual([row.game, row.market_price, row.price, row.status], ['other', 2.5, 2.89, 'needs_review']);
  assert.deepEqual(row.review_reasons.sort(), ['ebay_median', 'other_game']);

  // Buy offers: a Yu-Gi-Oh! card uses its catalog price; several versions are flagged for a look.
  const v = await valueCard(read({ rarity: 'Ultra Rare' }), { deps: { lookupCard: async () => ygoCatalog({ versions: 7 }), browseSearch } });
  assert.deepEqual([v.market_price, v.market_source, v.flags], [2.33, 'tcgplayer', ['multiple_versions']]);
});

const tpl = { categoryId: '183454', itemSpecifics: [{ name: 'Game', values: ['Pokémon TCG'] }, { name: 'Manufacturer', values: ['The Pokémon Company'] }, { name: 'Character', values: ['Briar'] },
  { name: 'Card Name', values: ['Briar'] }, { name: 'Finish', values: ['Reverse Holo'] }, { name: 'Graded', values: ['No'] }] };
const spec = (list, name) => list.find((s) => s.name === name)?.values[0];

test('eBay details: another game borrows the Pokémon listing setup but gets its own Game, maker and rarity', () => {
  const ebayNames = gameValuesFromAspects({ aspects: [{ localizedAspectName: 'Card Name', aspectValues: [] }, { localizedAspectName: 'Game', aspectValues: [
    { localizedValue: 'Pokémon TCG' }, { localizedValue: 'Magic: The Gathering' }, { localizedValue: 'Yu-Gi-Oh! TCG' }, { localizedValue: 'One Piece TCG' }, { localizedValue: 'Disney Lorcana' }, { localizedValue: 'Digimon' }] }] });
  const templates = { pokemon: tpl, gameValues: ebayNames };
  const ygo = { game: 'yugioh', card_name: 'Ash Blossom & Joyous Spring', catalog_set: '25th Anniversary Rarity Collection', catalog_number: 'RA01-EN008', rarity: 'Ultra Rare', language: 'English', finish: 'foil' };
  const s = buildSpecifics(ygo, tpl, { tplGame: 'pokemon', templates });
  assert.deepEqual([spec(s, 'Game'), spec(s, 'Manufacturer'), spec(s, 'Rarity'), spec(s, 'Card Number'), spec(s, 'Graded'), spec(s, 'Character')],
    ['Yu-Gi-Oh! TCG', 'Konami', 'Ultra Rare', 'RA01-EN008', 'No', undefined]);
  assert.equal(gameSpecific({ game: 'one_piece' }, templates), 'One Piece TCG');                       // eBay's wording when it was learned
  assert.equal(gameSpecific({ game: 'one_piece' }, {}), 'One Piece Card Game');                        // our wording otherwise
  assert.equal(gameSpecific({ game: 'other', extraction: { game_name: 'Digimon Card Game' } }, templates), 'Digimon');
  assert.equal(gameSpecific({ game: 'other', extraction: { game_name: 'Weiss Schwarz' } }, templates), 'Weiss Schwarz');
  assert.equal(gameSpecific({ game: 'other', extraction: {} }, templates), null);
  // A Pokémon card on the Pokémon setup is unchanged.
  const p = buildSpecifics({ game: 'pokemon', card_name: 'Briar', finish: 'reverse_holo', rarity: 'Rare' }, tpl, { tplGame: 'pokemon', templates });
  assert.deepEqual([spec(p, 'Game'), spec(p, 'Manufacturer'), spec(p, 'Character'), spec(p, 'Rarity')], ['Pokémon TCG', 'The Pokémon Company', 'Briar', undefined]);
});

const verifyOk = '<VerifyAddFixedPriceItemResponse><Ack>Success</Ack><Fees><Fee><Name>ListingFee</Name><Fee currencyID="USD">0.0</Fee></Fee></Fees></VerifyAddFixedPriceItemResponse>';
const uploadOk = async () => new Response('<UploadSiteHostedPicturesResponse><Ack>Success</Ack><SiteHostedPictureDetails><FullURL>https://i.ebayimg.com/p.jpg</FullURL></SiteHostedPictureDetails></UploadSiteHostedPicturesResponse>');
const listable = (over = {}) => ({ id: '0f8fad5b-d9cb-469f-a165-70867728950e', user_id: U, status: 'approved', game: 'yugioh', card_name: 'Ash Blossom & Joyous Spring', catalog_set: '25th Anniversary Rarity Collection',
  catalog_number: 'RA01-EN008', rarity: 'Ultra Rare', finish: 'foil', condition: 'NM', language: 'English', price: 2.89, title: 'Ash Blossom & Joyous Spring RA01-EN008 Ultra Rare Yu-Gi-Oh', photo_path: 'u1/b/front.jpg', ...over });
const checkDb = (item) => fakeDb({ snap_items: [item], inventory: [], ebay_listings: [], settings: [],
  ebay_accounts: [{ id: 'acct', user_id: U, listing_templates: { pokemon: tpl, policies: {}, conditions: null, gameValues: ['Pokémon TCG', 'Yu-Gi-Oh! TCG'] } }] }, null, { files: { 'u1/b/front.jpg': 'front' } });

test('the eBay check accepts Yu-Gi-Oh! and other card games, and explains what it still refuses', async () => {
  const db = checkDb(listable());
  let xml = '';
  await checkSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: {}, fetchImpl: uploadOk, call: async (_t, _n, body) => { xml = body; return verifyOk; } });
  assert.equal(db.tables.snap_items[0].publish_state, 'checked');
  assert.match(xml, /<Name>Game<\/Name><Value>Yu-Gi-Oh! TCG<\/Value>/);
  assert.match(xml, /<Name>Manufacturer<\/Name><Value>Konami<\/Value>/);
  assert.doesNotMatch(xml, /Pokémon/);
  assert.match(xml, /<CategoryID>183454<\/CategoryID>/);

  const run = (item) => { const d = checkDb(item); return checkSnapItem({ db: d, userId: U, token: 't', item: d.tables.snap_items[0], settings: {}, fetchImpl: uploadOk, call: async () => verifyOk }); };
  await assert.rejects(run(listable({ game: 'sports' })), /Sports cards use a different eBay category/);
  await assert.rejects(run(listable({ game: 'other', extraction: {} })), /needs the game's name/);
  const other = await run(listable({ game: 'other', extraction: { game_name: 'Digimon Card Game' } }));
  assert.equal(other.publish_state, 'checked');
});

test('learning the listing setup also stores eBay\'s names for each game', async () => {
  const db = fakeDb({ ebay_accounts: [{ id: 'acct', user_id: U }],
    ebay_listings: [{ user_id: U, item_id: '2', title: 'Briar 100/131 Prismatic Evolutions Reverse Holo', status: 'Active', listing_type: 'FixedPriceItem', start_time: '2026-11-10', raw: {} }] });
  const item = '<GetItemResponse><Ack>Success</Ack><Item><ItemID>2</ItemID><StartPrice currencyID="USD">1.89</StartPrice><PrimaryCategory><CategoryID>183454</CategoryID></PrimaryCategory></Item></GetItemResponse>';
  const fetchImpl = async (url, init) => {
    if (String(url).includes('get_item_aspects_for_category')) {
      assert.equal(init.headers.Authorization, 'Bearer app-token');
      return new Response(JSON.stringify({ aspects: [{ localizedAspectName: 'Game', aspectValues: [{ localizedValue: 'Yu-Gi-Oh! TCG' }, { localizedValue: 'Disney Lorcana' }] }] }));
    }
    return new Response('{}');
  };
  const t = await learnTemplates({ db, userId: U, token: 'user-token', call: async () => item, fetchImpl, appToken: async () => 'app-token' });
  assert.deepEqual(t.gameValues, ['Yu-Gi-Oh! TCG', 'Disney Lorcana']);
  assert.deepEqual(db.tables.ebay_accounts[0].listing_templates.gameValues, ['Yu-Gi-Oh! TCG', 'Disney Lorcana']);
});
