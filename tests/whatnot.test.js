// Whatnot adapter and client. Whatnot is always simulated (tests/whatnot-fake.js); its response
// shapes are guesses from the saved OpenAPI spec until checked against a live shop.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { whatnot, categoryIdFor, categoryFor, productAttributes, CONDITION_LABELS, productBody, inlineDimensionProfile } from '../netlify/lib/marketplaces/whatnot.js';
import { TCG_CATEGORIES, TCG_ATTRIBUTES, TAXONOMY_VERSION } from '../netlify/lib/marketplaces/whatnot-taxonomy.js';
import { errorFor } from '../netlify/lib/marketplaces/whatnot-client.js';
import { httpStatusFor } from '../netlify/lib/marketplaces/errors.js';
import fs from 'node:fs';
import { whatnotClient, whatnotMessage, resetThrottle } from '../netlify/lib/marketplaces/whatnot-client.js';
import { seal } from '../netlify/lib/secret-box.js';
import { LISTABLE_GAMES } from '../netlify/lib/snap-logic.js';
import { fakeDb } from './fake-db.js';
import { fakeWhatnot, fixture, ERRORS } from './whatnot-fake.js';

const U = 'u1';
const TOKEN = 'wn_pat_tk_TESTSECRET123';
const CARD_ID = '11111111-2222-3333-4444-555555555555';
process.env.MARKETPLACE_TOKEN_KEY = crypto.randomBytes(32).toString('base64');
delete process.env.WHATNOT_CATEGORY_IDS;   // the categories come from Whatnot's taxonomy

// A clock that only moves when the code sleeps, so pacing is tested without waiting.
function clock() {
  let t = 1_700_000_000_000; const waits = [];
  return { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; }, waits, at: () => t };
}
const card = (over = {}) => ({ id: CARD_ID, user_id: U, title: 'Pikachu 025/165 151 Pokemon NM', game: 'pokemon', condition: 'LP', card_name: 'Pikachu',
  catalog_set: '151', catalog_number: '025/165', price: 12.5, quantity: 1, status: 'approved', photo_path: `${U}/b/1.jpg`, extra_photo_paths: [`${U}/b/2.jpg`], ...over });
const account = () => ({ id: 'a1', user_id: U, marketplace: 'whatnot', auth_kind: 'personal_token', access_token_enc: seal(TOKEN), status: 'connected', settings: { shipping_profile_id: '501' } });

function shop({ existing = null, onCreate } = {}) {
  return fakeWhatnot(({ method, path, body }) => {
    if (method === 'GET' && path === '/products') return { body: { data: existing ? [existing] : [], next_cursor: null } };
    if (method === 'POST' && path === '/products') { onCreate?.(body); return { status: 201, body: fixture('product-created.json', { CARD_ID, CATEGORY_ID: body.category.id }) }; }
    if (method === 'GET' && /\/products\/[^/]+\/variants$/.test(path)) return { body: fixture('variants.json') };
    if (method === 'GET' && /^\/products\/[^/]+$/.test(path)) return existing ? { body: existing } : { status: 404, body: ERRORS['404'] };
    if (method === 'PATCH' && /\/variants$/.test(path)) return { status: 207, body: { variants: [{ id: body.variants[0].id }], errors: null } };
    if (method === 'POST' && path === '/inventory/set') return { status: 207, body: { results: body.items.map((i) => ({ variant_id: i.variant_id, idempotency_key: i.idempotency_key, status: 'applied', previous_quantity: 0, new_quantity: i.quantity, warnings: [] })) } };
    if (method === 'POST' && path.startsWith('/merchandising/products/')) return { body: { product_id: path.split('/').pop(), transaction_type: 'buy_it_now', reserved_for_live: false, sudden_death: null } };
    if (method === 'DELETE') return { status: 204 };
    return null;
  });
}
const ctxWith = (fetchImpl, c = clock()) => ({ db: fakeDb({}, null, { signedUrls: true }), userId: U, account: account(), fetchImpl, sleep: c.sleep, now: c.now });

beforeEach(() => resetThrottle());

test('connect: a good token finds the seller and a card-sized shipping profile; the token only goes in the header', async () => {
  const { fetchImpl, calls } = fakeWhatnot(({ path }) => (
    path === '/users/me' ? { body: fixture('users-me.json') }
      : path === '/orders' ? { body: { data: [], next_cursor: null } }
        : path === '/shipping/dimension_profiles' ? { body: fixture('dimension-profiles.json') } : null));
  const c = clock();
  const r = await whatnot.connect(null, U, { token: ` ${TOKEN} ` }, { fetchImpl, sleep: c.sleep, now: c.now });
  assert.equal(r.username, 'jaxcards');
  assert.equal(r.externalUserId, '7781');
  assert.equal(r.authKind, 'personal_token');
  assert.equal(r.settings.shipping_profile_id, '501');
  assert.deepEqual(calls.map((x) => x.path), ['/users/me', '/orders', '/shipping/dimension_profiles']);
  assert.ok(calls.every((x) => x.auth === `Bearer ${TOKEN}`));
  assert.ok(calls.every((x) => !JSON.stringify(x.query).includes(TOKEN)));
});

test('connect: a bad prefix, a refused token and a token without order access each get their own message', async () => {
  const none = fakeWhatnot(() => { throw new Error('must not be called'); });
  await assert.rejects(whatnot.connect(null, U, { token: 'abc123' }, { fetchImpl: none.fetchImpl }), /doesn't look like a Whatnot token\. It starts with wn_pat_tk_/);
  assert.equal(none.calls.length, 0);
  const refused = fakeWhatnot(() => ({ status: 401, body: ERRORS['401'] }));
  await assert.rejects(whatnot.connect(null, U, { token: TOKEN }, { fetchImpl: refused.fetchImpl }), /Whatnot didn't accept that token\. Check you copied all of it/);
  const noOrders = fakeWhatnot(({ path }) => (path === '/users/me' ? { body: fixture('users-me.json') } : { status: 403, body: ERRORS['403'] }));
  await assert.rejects(whatnot.connect(null, U, { token: TOKEN }, { fetchImpl: noOrders.fetchImpl }),
    (e) => e.code === 'missing_scope' && /can't read your orders\. Make a new one with read:orders ticked/.test(e.message) && !e.message.includes(TOKEN));
});

test('create: product with title, description, condition, category, photos and sku, then price, quantity and Buy It Now in the shop', async () => {
  let created;
  const { fetchImpl, calls } = shop({ onCreate: (b) => { created = b; } });
  const r = await whatnot.createListing(ctxWith(fetchImpl), card(), { price: 12.5, quantity: 2 });
  assert.deepEqual(calls.map((x) => `${x.method} ${x.path}`), [
    'GET /products', 'POST /products', 'GET /products/9001/variants', 'PATCH /products/9001/variants', 'POST /inventory/set', 'POST /merchandising/products/9001']);
  assert.equal(created.title, 'Pikachu 025/165 151 Pokemon NM');
  assert.equal(created.external_id, CARD_ID);
  assert.deepEqual(created.category, { id: '2' });   // Pokémon Cards
  assert.match(created.description, /^Condition: Lightly Played/);
  assert.deepEqual(created.attributes, [
    { id: '84', value: 'Light Played' }, { id: '936', value: '151' }, { id: '937', value: 'English' }, { id: '893', value: 'Card' }, { id: '197', value: '025/165' }]);
  assert.equal(created.hazardous_material, 'not_hazardous');
  assert.deepEqual(created.dimension_profile, { id: '501' });
  assert.equal(created.media.length, 2);
  assert.match(created.media[0].url, /^https:\/\/storage\.example\/sign\/u1\/b\/1\.jpg/);
  const patch = calls[3].body.variants[0];
  assert.deepEqual(patch.price, { amount: '12.50', currency: 'USD' });
  assert.equal(patch.sku, 'SNAP-1111111122');
  assert.equal(calls[4].body.items[0].quantity, 2);
  assert.ok(calls[4].body.items[0].idempotency_key);
  assert.deepEqual(calls[5].body, { transaction_type: 'buy_it_now', reserve_for_live: false });
  assert.deepEqual(r, { externalId: '9001', variantId: 'V-1', listingId: null, url: 'https://www.whatnot.com/product/9001', price: 12.5, quantity: 2 });
  // Every body matches the spec's request schema (no extra fields: they are additionalProperties: false).
  const spec = JSON.parse(fs.readFileSync(new URL('../docs/marketplaces/whatnot-api/openapi.json', import.meta.url), 'utf8')).components.schemas;
  const allowed = (name) => Object.keys(spec[name].properties);
  assert.deepEqual(Object.keys(created).filter((k) => !allowed('CreateProductRequest').includes(k)), []);
  for (const k of spec.CreateProductRequest.required) assert.ok(k in created, k);
  assert.deepEqual(Object.keys(patch).filter((k) => !allowed('ProductVariantPatch').includes(k)), []);
  assert.deepEqual(Object.keys(calls[4].body.items[0]).filter((k) => !allowed('SetInventoryItem').includes(k)), []);
  assert.deepEqual(Object.keys(calls[5].body).filter((k) => !allowed('MerchandiseProductRequest').includes(k)), []);
  assert.match(created.category.id, /^[1-9][0-9]{0,18}$/);
});

test('create: eBay picture links are used when the card has them; no shipping profile sends a card-sized package', () => {
  const b = productBody(card({ ebay_picture_urls: ['https://i.ebayimg.com/a.jpg'] }), { photoUrls: ['https://i.ebayimg.com/a.jpg'], categoryId: '2', account: { settings: {} }, settings: { snapPackageWeightOz: 2 } });
  assert.deepEqual(b.dimension_profile, inlineDimensionProfile({ snapPackageWeightOz: 2 }));
  assert.deepEqual(b.dimension_profile.weight, { value: 2, unit: 'ounce' });
  assert.equal(b.hazardous_material, 'not_hazardous');
});

test('create: a retry after a lost response adopts the product with our card id instead of making a second one', async () => {
  const existing = fixture('product-created.json', { CARD_ID, CATEGORY_ID: '2' });
  const { fetchImpl, calls } = shop({ existing, onCreate: () => { throw new Error('must not create twice'); } });
  const r = await whatnot.createListing(ctxWith(fetchImpl), card(), { price: 12.5 });
  assert.equal(r.externalId, '9001');
  assert.ok(!calls.some((x) => x.method === 'POST' && x.path === '/products'));
});

test('create: Whatnot\'s own reason comes back, and a failure after the product exists says which product', async () => {
  const bad = fakeWhatnot(({ method, path }) => (method === 'GET' && path === '/products' ? { body: { data: [], next_cursor: null } } : { status: 422, body: ERRORS['422'] }));
  await assert.rejects(whatnot.createListing(ctxWith(bad.fetchImpl), card(), { price: 12.5 }),
    (e) => e.code === 'rejected' && e.message === 'Whatnot said: category.id: String should match pattern \'^[1-9][0-9]{0,18}$\'' && e.status == null);
  const half = shop();
  const orig = half.fetchImpl;
  const failing = async (url, init) => (String(url).includes('/merchandising/') ? new Response(JSON.stringify(ERRORS['422-not-ready']), { status: 422 }) : orig(url, init));
  await assert.rejects(whatnot.createListing(ctxWith(failing), card(), { price: 12.5 }), (e) => e.partial?.externalId === '9001' && /description: A description is required to publish/.test(e.message));
});

test('create: a sports card and a bad price are refused before anything is sent', async () => {
  const none = fakeWhatnot(() => { throw new Error('must not be called'); });
  await assert.rejects(whatnot.createListing(ctxWith(none.fetchImpl), card({ game: 'sports' }), { price: 5 }), (e) => e.code === 'rejected' && /Sports cards can't be listed on Whatnot/.test(e.message));
  await assert.rejects(whatnot.createListing(ctxWith(none.fetchImpl), card(), { price: 0.5 }), /at least \$1\.00/);
  assert.equal(none.calls.length, 0);
});

test('categories: each game has its Whatnot category; other games match by name; sports has none; the site setting still overrides', () => {
  assert.equal(TAXONOMY_VERSION, '1.2.3');
  const id = (game, name) => categoryIdFor(game, {}, name);
  assert.deepEqual(['pokemon', 'mtg', 'yugioh', 'one_piece', 'lorcana'].map((g) => id(g)), ['2', '9', '8', '567', '2013']);
  for (const g of LISTABLE_GAMES) assert.ok(id(g), g);
  for (const [name, want] of [['Dragon Ball Super Card Game', '12'], ['Digimon Card Game', '94'], ['Flesh and Blood', '154'], ['Flesh & Blood TCG', '154'],
    ['Weiss Schwarz', '93'], ['Weiß Schwarz', '93'], ['UniVersus', '92'], ['Union Arena', '1471'], ['Gundam Card Game', '2014'], ['Sorcery: Contested Realm', '1405'],
    ['Sorcery TCG', '1405'], ['MetaZoo', '58'], ['Naruto Kayou', '311'], ['Riftbound: League of Legends TCG', '2015'], ['Grand Archive', '138'], ['', '138'], [null, '138']]) {
    assert.equal(id('other', name), want, String(name));
  }
  assert.equal(id('sports'), null);
  assert.equal(categoryFor({ game: 'sports' }), null);
  assert.equal(categoryIdFor('pokemon', { WHATNOT_CATEGORY_IDS: '{"pokemon":"777"}' }), '777');
  assert.equal(categoryIdFor('other', { WHATNOT_CATEGORY_IDS: '{"other":"888"}' }, 'Digimon'), '94');   // a matched game wins over the fallback
  assert.equal(categoryIdFor('other', { WHATNOT_CATEGORY_IDS: '{"other":"888"}' }, 'Grand Archive'), '888');
  assert.equal(categoryIdFor('pokemon', { WHATNOT_CATEGORY_IDS: 'not json' }), '2');
  assert.deepEqual(Object.keys(CONDITION_LABELS), ['NM', 'LP', 'MP', 'HP', 'DMG']);
});

test('card details: only values each detail takes, only the details the category lists', () => {
  const at = (c, over = {}) => Object.fromEntries(productAttributes(c, categoryFor(c, {})).map((a) => [TCG_ATTRIBUTES[a.id].key, a.value]));
  // Pokémon: condition, set and number as free text; language and rarity only from Whatnot's lists.
  assert.deepEqual(at(card({ condition: 'MP', language: 'Japanese', rarity: 'special illustration rare' })), {
    'tcg.condition': 'Moderately Played', 'tcg.pokemon.set': '151', 'tcg.pokemon.language': 'Japanese', 'tcg.pokemon.product_type': 'Card',
    'tcg.pokemon.rarity': 'Special Illustration Rare', 'single.card_number': '025/165' });
  assert.equal(at(card({ rarity: 'Rare Holo Galaxy', language: 'Klingon' }))['tcg.pokemon.rarity'], undefined);   // not in the list: left out
  assert.equal(at(card({ language: 'Klingon' }))['tcg.pokemon.language'], undefined);
  // Magic: English / Non-English, "Single Card".
  const mtg = at(card({ game: 'mtg', language: 'German', catalog_set: 'Bloomburrow', catalog_number: '123' }));
  assert.equal(mtg['tcg.mtg.language'], 'Non-English'); assert.equal(mtg['tcg.mtg.product_type'], 'Single Card'); assert.equal(mtg['tcg.mtg.card_set'], 'Bloomburrow');
  // A graded slab: condition "Graded", the grader in Whatnot's words, grade and cert.
  const slab = at(card({ extraction: { graded: true, grader: 'BGS', grade: '9.5', cert_number: '0012345' } }));
  assert.equal(slab['tcg.condition'], 'Graded'); assert.equal(slab.graded, 'true'); assert.equal(slab['graded.service'], 'BECKETT');
  assert.equal(slab['graded.grade'], '9.5'); assert.equal(slab['graded.cert_number'], '0012345');
  const ygo = at(card({ game: 'yugioh', rarity: 'ultra rare', catalog_set: null, set_name: 'Legend of Blue Eyes', catalog_number: 'LOB-EN001', extraction: { graded: true, grader: 'PSA', grade: '10' } }));
  assert.equal(ygo['tcg.yugioh.grading_service'], 'Professional Sports Authenticator (PSA)');
  assert.equal(ygo['tcg.yugioh.rarity'], 'Ultra Rare'); assert.equal(ygo['tcg.yugioh.card_number'], 'LOB-EN001'); assert.equal(ygo['tcg.yugioh.product_type'], 'Singles');
  // A grade a fixed list doesn't have is left out (Digimon's grade is a list).
  assert.equal(at(card({ game: 'other', extraction: { game_name: 'Digimon', graded: true, grade: 'Gem Mint' } }))['tcg.digimon.grade'], undefined);
  // Flesh & Blood only takes condition; the "other cards" category takes no set or number.
  assert.deepEqual(Object.keys(at(card({ game: 'other', extraction: { game_name: 'Flesh and Blood' } }))), ['tcg.condition']);
  assert.deepEqual(Object.keys(at(card({ game: 'other', extraction: { game_name: 'Grand Archive' } }))), ['tcg.condition']);
  // Ungraded cards never send the graded details.
  assert.equal(at(card())['graded'], undefined);
  // Every value sent is valid for its attribute.
  for (const c of TCG_CATEGORIES) {
    for (const a of productAttributes(card({ extraction: { graded: true, grader: 'CGC', grade: '9' }, rarity: 'Rare', language: 'English' }), { id: c.id, attrs: c.attrs })) {
      const def = TCG_ATTRIBUTES[a.id];
      assert.ok(Object.values(c.attrs).includes(Number(a.id)), `${c.label} ${a.id}`);
      if (def.type === 'ENUM') assert.ok(def.values.includes(a.value), `${c.label} ${def.key}=${a.value}`);
      if (def.type === 'BOOLEAN') assert.ok(['true', 'false'].includes(a.value));
    }
  }
});

test('the generated taxonomy table matches Whatnot\'s file', () => {
  const tax = JSON.parse(fs.readFileSync(new URL('../docs/marketplaces/whatnot-api/taxonomy.json', import.meta.url), 'utf8'));
  const cats = new Map(tax.categories.map((c) => [c.id, c]));
  const attrs = new Map(tax.attributes.map((a) => [a.id, a]));
  for (const c of TCG_CATEGORIES) {
    assert.equal(cats.get(c.id)?.label, c.label);
    for (const id of Object.values(c.attrs)) assert.ok(cats.get(c.id).attributes.some((x) => x.id === id), `${c.label} lists ${id}`);
  }
  for (const [id, a] of Object.entries(TCG_ATTRIBUTES)) {
    assert.equal(attrs.get(Number(id)).type, a.type);
    if (a.type === 'ENUM') assert.deepEqual(a.values, attrs.get(Number(id)).values);
  }
  assert.equal(attrs.get(84).key, 'tcg.condition');
});

test('change price and quantity; end sets quantity 0 and removes an unsold product; already gone is fine', async () => {
  const { fetchImpl, calls } = shop();
  const listing = { external_id: '9001', external_variant_id: 'V-1', price: 12.5, quantity: 1 };
  assert.deepEqual(await whatnot.updateListing(ctxWith(fetchImpl), listing, { price: 11 }), { price: 11, quantity: 1 });
  assert.deepEqual(calls.at(-1).body, { variants: [{ id: 'V-1', price: { amount: '11.00', currency: 'USD' } }] });
  assert.deepEqual(await whatnot.updateListing(ctxWith(fetchImpl), listing, { quantity: 3 }), { price: 12.5, quantity: 3 });
  calls.length = 0;
  assert.deepEqual(await whatnot.endListing(ctxWith(fetchImpl), listing, { reason: 'seller' }), { ok: true });
  assert.deepEqual(calls.map((x) => `${x.method} ${x.path}`), ['POST /inventory/set', 'DELETE /products/9001']);
  assert.equal(calls[0].body.items[0].quantity, 0);
  calls.length = 0;
  await whatnot.endListing(ctxWith(fetchImpl), listing, { reason: 'sold_elsewhere' });
  assert.deepEqual(calls.map((x) => x.method), ['POST']);   // sold elsewhere: keep the product, quantity 0
  const gone = fakeWhatnot(() => ({ status: 404, body: ERRORS['404'] }));
  assert.deepEqual(await whatnot.endListing(ctxWith(gone.fetchImpl), listing, { reason: 'sold_elsewhere' }), { ok: true, gone: true });
});

test('a 401 is "reconnect", a 403 "missing permission", a 500 "unavailable"; none carries the token', async () => {
  for (const [status, code] of [[401, 'reconnect'], [403, 'missing_scope'], [409, 'rejected'], [500, 'unavailable']]) {
    const f = fakeWhatnot(() => ({ status, body: ERRORS[String(status)] || {} }));
    await assert.rejects(whatnot.updateListing(ctxWith(f.fetchImpl), { external_id: 'P', external_variant_id: 'V' }, { price: 5 }),
      (e) => e.code === code && !e.message.includes(TOKEN) && !JSON.stringify(e).includes(TOKEN) && e.status == null && e.detail.whatnotStatus === status);
  }
  // Our endpoints answer with our own status for the code, never Whatnot's.
  assert.equal(httpStatusFor(errorFor(401)), 409); assert.equal(httpStatusFor(errorFor(403)), 409);
  assert.equal(httpStatusFor(errorFor(400)), 422); assert.equal(httpStatusFor(errorFor(418)), 422); assert.equal(httpStatusFor(errorFor(503)), 502);
  assert.equal(errorFor(400).message, 'Whatnot turned that down. Check the card\'s details and try again.');
  assert.doesNotMatch(errorFor(418).message, /418/);
});

test('429: waits Retry-After and tries again, up to twice, then "Whatnot is busy"', async () => {
  let n = 0;
  const f = fakeWhatnot(() => (++n <= 2 ? { status: 429, body: ERRORS['429'], headers: { 'Retry-After': '3' } } : { body: fixture('users-me.json') }));
  const c = clock();
  const me = await whatnotClient({ token: TOKEN, fetchImpl: f.fetchImpl, sleep: c.sleep, now: c.now }).get('/users/me');
  assert.equal(me.username, 'jaxcards');
  assert.deepEqual(c.waits.filter((w) => w >= 1000), [3000, 3000]);
  const always = fakeWhatnot(() => ({ status: 429, headers: { 'Retry-After': '60' } }));
  const c2 = clock();
  await assert.rejects(whatnotClient({ token: TOKEN, key: 'k2', fetchImpl: always.fetchImpl, sleep: c2.sleep, now: c2.now }).get('/users/me'),
    (e) => e.code === 'rate_limited' && e.message === 'Whatnot is busy, try again in a minute.');
  assert.equal(always.calls.length, 3);
  assert.ok(c2.waits.every((w) => w <= 10_000));   // Retry-After is capped at 10 s
});

test('bulk listing 50 cards stays under 10 requests a second for the seller', async () => {
  const c = clock();
  const starts = [];
  const { fetchImpl } = shop();
  const timed = async (url, init) => { starts.push(c.now()); return fetchImpl(url, init); };
  const ctx = ctxWith(timed, c);
  for (let i = 0; i < 50; i++) await whatnot.createListing(ctx, card({ id: `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000` }), { price: 3 });
  assert.equal(starts.length, 300);
  for (let i = 0; i + 10 < starts.length; i++) assert.ok(starts[i + 10] - starts[i] >= 1000, `11 requests inside one second at ${i}`);
});

test('sales: pages orders newest first, stops past the look-back, reads items of recent orders only', async () => {
  const { fetchImpl, calls } = fakeWhatnot(({ path, query }) => {
    if (path === '/orders') return { body: query.cursor === 'c2' ? fixture('orders-page2.json') : fixture('orders-page1.json') };
    if (path === '/orders/123456/items') return { body: fixture('order-items.json', { CARD_ID }) };
    return null;
  });
  const sales = await whatnot.fetchSales(ctxWith(fetchImpl), { since: '2026-11-28T14:50:00.000Z' });
  assert.deepEqual(sales, [{ orderId: '123456', lineId: '987654', externalId: '9001', cardId: CARD_ID, variantId: 'V-1', quantity: 1, price: 14, currency: 'USD',
    at: '2026-11-28T14:55:00.000Z', status: 'pending_fulfillment', url: 'https://www.whatnot.com/dashboard/orders/123456' }]);
  assert.deepEqual(calls.map((x) => x.path), ['/orders', '/orders', '/orders/123456/items']);
  assert.equal(calls[1].query.cursor, 'c2');
});

test('Whatnot error bodies become one readable line', () => {
  assert.equal(whatnotMessage(ERRORS['422']), 'category.id: String should match pattern \'^[1-9][0-9]{0,18}$\'');
  assert.equal(whatnotMessage({ errors: [{ field: 'media', message: 'An image is required' }] }), 'media: An image is required');
  assert.equal(whatnotMessage('<html>Bad gateway</html>'), '');
  assert.equal(whatnotMessage({ detail: 'nope' }), 'nope');
  assert.equal(whatnotMessage({ message: 'busy' }), 'busy');
  assert.equal(whatnotMessage(null), '');
});
