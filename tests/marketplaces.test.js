// The marketplace layer: every adapter meets the contract, the endpoints' work never leaks a token,
// plan gating, connect/disconnect, listing on Whatnot end to end, and the signed 5-minute job.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ADAPTERS, CONTRACT } from '../netlify/lib/marketplaces/registry.js';
import { MarketplaceError, httpStatusFor } from '../netlify/lib/marketplaces/errors.js';
import {
  listMarketplaces, connectMarketplace, disconnectMarketplace, createCrossListing, updateCrossListing, endCrossListing, setStock, checkSalesNow, saveMarketplaceSettings,
  readyGames, STALE_CLAIM_MS,
} from '../netlify/lib/marketplaces/service.js';
import { resetThrottle } from '../netlify/lib/marketplaces/whatnot-client.js';
import { open } from '../netlify/lib/secret-box.js';
import { signCron, verifyCron } from '../netlify/lib/cron-signature.js';
import { sellersToCheck, crossListedCards } from '../netlify/lib/sales-run.js';
import { requireFeature } from '../netlify/lib/billing.js';
import { FEATURE_PLAN, hasFeature } from '../netlify/lib/plans.js';
import { fakeDb } from './fake-db.js';
import { fakeWhatnot, fixture, ERRORS } from './whatnot-fake.js';

const U = 'u1';
const TOKEN = 'wn_pat_tk_LEAKCHECK_9f8e7d6c5b4a';
const CARD = 'c0000000-0000-0000-0000-0000000000aa';
process.env.MARKETPLACE_TOKEN_KEY = crypto.randomBytes(32).toString('base64');
delete process.env.WHATNOT_CATEGORY_IDS;

let realFetch;
beforeEach(() => { resetThrottle(); realFetch = globalThis.fetch; globalThis.fetch = async (u) => { throw new Error(`global fetch called: ${u}`); }; });
afterEach(() => { globalThis.fetch = realFetch; delete process.env.BILLING_ENABLED; });

function shop() {
  return fakeWhatnot(({ method, path, body }) => {
    if (path === '/users/me') return { body: fixture('users-me.json') };
    if (path === '/orders' && method === 'GET') return { body: { data: [], next_cursor: null } };
    if (path === '/shipping/dimension_profiles') return { body: fixture('dimension-profiles.json') };
    if (method === 'GET' && path === '/products') return { body: { data: [], next_cursor: null } };
    if (method === 'POST' && path === '/products') return { status: 201, body: fixture('product-created.json', { CARD_ID: body.external_id, CATEGORY_ID: body.category.id }) };
    if (method === 'GET' && /\/variants$/.test(path)) return { body: fixture('variants.json') };
    if (method === 'GET' && /^\/products\/[^/]+$/.test(path)) return { body: fixture('product-created.json', { CARD_ID: CARD, CATEGORY_ID: '2' }) };
    if (method === 'PATCH') return { status: 207, body: { variants: [{ id: 'V-1' }], errors: null } };
    if (path === '/inventory/set') return { status: 207, body: { results: body.items.map((i) => ({ variant_id: i.variant_id, idempotency_key: i.idempotency_key, status: 'applied', previous_quantity: 1, new_quantity: i.quantity, warnings: [] })) } };
    if (path.startsWith('/merchandising/')) return { body: { product_id: '9001', transaction_type: 'buy_it_now', reserved_for_live: false, sudden_death: null } };
    if (method === 'DELETE') return { status: 204 };
    return null;
  });
}
// The one-live-listing-per-card index from the migration (creating / active / ending).
const ONE_LIVE = { marketplace_listings: [{ cols: ['snap_item_id', 'marketplace'], where: (r) => ['creating', 'active', 'ending'].includes(r.status) }] };
const world = (over = {}, opts = {}) => fakeDb({
  snap_items: [{ id: CARD, user_id: U, title: 'Pikachu 025/165 151', game: 'pokemon', condition: 'NM', status: 'listed', price: 12.5, quantity: 1,
    ebay_item_id: '4071', ebay_url: 'https://www.ebay.com/itm/4071', photo_path: `${U}/b/1.jpg`, listed_at: '2026-11-01T00:00:00.000Z' }],
  inventory: [{ id: 'inv1', user_id: U, card_name: 'Pikachu', status: 'In Stock', ebay_item_id: '4071' }],
  ebay_accounts: [{ id: 'e1', user_id: U, ebay_username: 'jax' }],
  ebay_listings: [{ user_id: U, item_id: '4071', status: 'Active', quantity_available: 1 }],
  marketplace_listings: [], marketplace_accounts: [], marketplace_orders: [], subscriptions: [], ...over,
}, null, { signedUrls: true, unique: ONE_LIVE, ...opts });
// eBay's order API with no new orders.
const ebayOrders = async (url) => { assert.match(String(url), /^https:\/\/api\.ebay\.com\/sell\/fulfillment\//); return new Response(JSON.stringify({ orders: [], total: 0 }), { status: 200 }); };
const trading = () => { const calls = []; return { calls, call: async (_t, name) => { calls.push(name); return `<${name}Response><Ack>Success</Ack></${name}Response>`; } }; };

test('every adapter implements the marketplace contract', () => {
  for (const [id, a] of Object.entries(ADAPTERS)) {
    assert.equal(a.id, id);
    assert.ok(a.label && Array.isArray(a.authKinds));
    for (const fn of CONTRACT) assert.equal(typeof a[fn], 'function', `${id}.${fn}`);
  }
  assert.equal(httpStatusFor(new MarketplaceError('rate_limited', 'x')), 429);
  assert.equal(httpStatusFor(new Error('x')), 500);
});

test('Whatnot is a Pro feature; on the founder site everything is on', async () => {
  assert.equal(FEATURE_PLAN.cross_list, 'pro');
  assert.equal(hasFeature('basic', 'cross_list'), false);
  assert.equal(hasFeature('pro', 'cross_list'), true);
  const db = world();
  assert.equal(await requireFeature(db, U, 'cross_list'), null);   // billing off (jaxspic)
  process.env.BILLING_ENABLED = 'true';
  const no = await requireFeature(db, U, 'cross_list');
  assert.equal(no.status, 402);
  const body = await no.json();
  assert.equal(body.code, 'UPGRADE');
  assert.match(body.error, /Listing on more marketplaces is part of the Pro plan/);
});

test('the full flow never puts the token, or its sealed form, in a response or a log line', async () => {
  const db = world();
  const wn = shop(); const tr = trading();
  const deps = { fetchImpl: wn.fetchImpl, sleep: async () => {}, byMarketplace: { ebay: { token: 'ebay-tok', call: tr.call, fetchImpl: ebayOrders } } };
  const logs = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.map(String).join(' '));
  const out = [];
  try {
    out.push(await connectMarketplace(db, U, { marketplace: 'whatnot', token: TOKEN }, deps));
    out.push(await listMarketplaces(db, U));
    out.push(await saveMarketplaceSettings(db, U, { marketplace: 'whatnot', shippingProfileId: '502' }));
    const listing = await createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: CARD, price: 13 }, deps);
    out.push(listing);
    out.push(await updateCrossListing(db, U, { listingId: listing.id, price: 14 }, deps));
    out.push(await setStock(db, U, { snapItemId: CARD, quantity: 2 }, deps));
    db.tables.marketplace_accounts[0].sales_checked_at = '2026-01-01T00:00:00.000Z';
    out.push(await checkSalesNow(db, U, deps));
    out.push(await endCrossListing(db, U, { listingId: listing.id }, deps));
    for (const bad of ['wn_pat_tk_', 'nope']) out.push(await connectMarketplace(db, U, { marketplace: 'whatnot', token: bad }, deps).catch((e) => ({ error: e.sellerMessage })));
    out.push(await disconnectMarketplace(db, U, { marketplace: 'whatnot', endListings: true }, deps));
  } finally { Object.assign(console, orig); }
  const sealedEver = [];
  const text = JSON.stringify(out) + logs.join('\n');
  assert.ok(!text.includes(TOKEN), 'token leaked');
  assert.ok(!text.includes('LEAKCHECK'), 'token leaked');
  assert.ok(!/v1\.[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/.test(text), 'sealed token leaked');
  assert.equal(sealedEver.length, 0);
  // Whatnot only ever saw it in the Authorization header.
  assert.ok(wn.calls.every((c) => !JSON.stringify([c.path, c.query, c.body]).includes(TOKEN)));
});

test('connect stores only the sealed token; a refused token stores nothing; disconnect deletes it', async () => {
  const db = world();
  const wn = shop();
  const deps = { fetchImpl: wn.fetchImpl, sleep: async () => {} };
  const m = await connectMarketplace(db, U, { marketplace: 'whatnot', token: TOKEN }, deps);
  assert.equal(m.username, 'jaxcards'); assert.equal(m.connected, true);
  const row = db.tables.marketplace_accounts[0];
  assert.notEqual(row.access_token_enc, TOKEN);
  assert.equal(open(row.access_token_enc), TOKEN);
  assert.equal(row.settings.shipping_profile_id, '501');
  assert.ok(!Object.values(row).some((v) => v === TOKEN));
  const db2 = world();
  const refused = fakeWhatnot(() => ({ status: 401, body: ERRORS['401'] }));
  await assert.rejects(connectMarketplace(db2, U, { marketplace: 'whatnot', token: TOKEN }, { fetchImpl: refused.fetchImpl, sleep: async () => {} }), /didn't accept that token/);
  assert.equal(db2.tables.marketplace_accounts.length, 0);
  const keyless = connectMarketplace(world(), U, { marketplace: 'whatnot', token: TOKEN }, { ...deps, env: {} });
  await assert.rejects(keyless, (e) => e.code === 'not_set_up' && /isn't set up on this site yet/.test(e.message));
  const r = await disconnectMarketplace(db, U, { marketplace: 'whatnot' }, deps);
  assert.equal(db.tables.marketplace_accounts.length, 0);
  assert.equal(r.marketplaces.find((x) => x.marketplace === 'whatnot').connected, false);
});

test('list on Whatnot: card must be approved or on eBay; one live Whatnot listing per card; its eBay listing is tracked too', async () => {
  const db = world();
  const wn = shop();
  const deps = { fetchImpl: wn.fetchImpl, sleep: async () => {} };
  await connectMarketplace(db, U, { marketplace: 'whatnot', token: TOKEN }, deps);
  const l = await createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: CARD, price: 13 }, deps);
  assert.equal(l.status, 'active'); assert.equal(l.external_id, '9001'); assert.equal(Number(l.price), 13); assert.equal(l.inventory_id, 'inv1');
  assert.equal(l.raw, undefined);
  const eb = db.tables.marketplace_listings.find((x) => x.marketplace === 'ebay');
  assert.equal(eb.external_id, '4071'); assert.equal(eb.status, 'active');
  await assert.rejects(createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: CARD, price: 13 }, deps), /already on Whatnot/);
  db.tables.snap_items.push({ id: 'draft', user_id: U, status: 'ready', title: 'x', price: 3 });
  await assert.rejects(createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: 'draft', price: 3 }, deps), /Approve the card first/);
  await assert.rejects(createCrossListing(db, 'someone-else', { marketplace: 'whatnot', snapItemId: CARD, price: 3 }, deps), /Card not found/);
});

test('a failed Whatnot listing is kept with the reason, and the retry adopts the product it made', async () => {
  const db = world();
  const ok = shop();
  const deps = { fetchImpl: ok.fetchImpl, sleep: async () => {} };
  await connectMarketplace(db, U, { marketplace: 'whatnot', token: TOKEN }, deps);
  const failing = async (url, init) => (String(url).includes('/merchandising/') ? new Response(JSON.stringify({ detail: 'needs an image' }), { status: 422 }) : ok.fetchImpl(url, init));
  await assert.rejects(createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: CARD, price: 13 }, { ...deps, fetchImpl: failing }), /needs an image/);
  const failed = db.tables.marketplace_listings.filter((x) => x.marketplace === 'whatnot');
  assert.equal(failed.length, 1); assert.equal(failed[0].status, 'failed'); assert.equal(failed[0].external_id, '9001');
  assert.equal(failed[0].last_error, 'Whatnot said: needs an image');
  ok.calls.length = 0;
  const l = await createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: CARD, price: 13 }, deps);
  assert.equal(l.status, 'active');
  assert.ok(!ok.calls.some((c) => c.method === 'POST' && c.path === '/products'), 'made a second product');
  assert.equal(db.tables.marketplace_listings.filter((x) => x.marketplace === 'whatnot').length, 1);
});

test('a downgraded seller can still change and end listings and check sales (no plan check in those paths)', async () => {
  process.env.BILLING_ENABLED = 'true';
  const db = world();
  const wn = shop(); const tr = trading();
  const deps = { fetchImpl: wn.fetchImpl, sleep: async () => {}, byMarketplace: { ebay: { token: 't', call: tr.call, fetchImpl: ebayOrders } } };
  await connectMarketplace(db, U, { marketplace: 'whatnot', token: TOKEN }, deps);
  const l = await createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: CARD, price: 13 }, deps);
  assert.equal((await updateCrossListing(db, U, { listingId: l.id, quantity: 2 }, deps)).quantity, 2);
  db.tables.marketplace_accounts[0].sales_checked_at = '2026-01-01T00:00:00.000Z';
  const s = await checkSalesNow(db, U, deps);
  assert.deepEqual(s.checked, ['whatnot', 'ebay']);   // a card on two marketplaces: eBay is read too
  await assert.rejects(checkSalesNow(db, U, deps), (e) => e.code === 'rate_limited' && e.status === 429);
  assert.equal((await endCrossListing(db, U, { listingId: l.id }, deps)).status, 'ended');
  assert.equal((await disconnectMarketplace(db, U, { marketplace: 'whatnot' }, deps)).left, 0);
});

test('stock change goes to every live listing; disconnect can end them or leave them up', async () => {
  const db = world();
  const wn = shop(); const tr = trading();
  const deps = { fetchImpl: wn.fetchImpl, sleep: async () => {}, byMarketplace: { ebay: { token: 't', call: tr.call } } };
  await connectMarketplace(db, U, { marketplace: 'whatnot', token: TOKEN }, deps);
  await createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: CARD, price: 13 }, deps);
  const r = await setStock(db, U, { snapItemId: CARD, quantity: 3 }, deps);
  assert.deepEqual(r.results.map((x) => [x.marketplace, x.ok, x.quantity]).sort(), [['ebay', true, 3], ['whatnot', true, 3]]);
  assert.ok(tr.calls.includes('ReviseInventoryStatus'));
  assert.equal(db.tables.snap_items[0].quantity, 3);
  await assert.rejects(setStock(db, U, { snapItemId: CARD, quantity: 0 }, deps), /from 1 to 999/);
  const left = await disconnectMarketplace(db, U, { marketplace: 'whatnot', endListings: false }, deps);
  assert.equal(left.left, 1);
  const wl = db.tables.marketplace_listings.find((x) => x.marketplace === 'whatnot');
  assert.equal(wl.status, 'ended'); assert.equal(wl.ended_reason, 'disconnected'); assert.match(wl.last_error, /no longer watch it/);
  assert.equal(db.tables.marketplace_accounts.length, 0);
});

test('the 5-minute job: signed per purpose, and it visits Whatnot sellers and cross-listed sellers, oldest first', async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  const { ts, sig } = signCron(1_000_000, 'sales-check');
  assert.equal(verifyCron(ts, sig, 1_000_000, 600_000, 'sales-check'), true);
  assert.equal(verifyCron(ts, sig, 1_000_000), false);   // not valid for the market refresh
  const m = signCron(1_000_000);
  assert.equal(verifyCron(m.ts, m.sig, 1_000_000), true);   // market-refresh signatures still work
  assert.equal(verifyCron(m.ts, m.sig, 1_000_000, 600_000, 'sales-check'), false);
  const db = fakeDb({
    marketplace_accounts: [
      { user_id: 'b', status: 'connected', sales_checked_at: '2026-11-28T10:00:00Z' },
      { user_id: 'a', status: 'connected', sales_checked_at: '2026-11-28T09:00:00Z' },
      { user_id: 'r', status: 'reconnect', sales_checked_at: '2026-11-28T08:00:00Z' },
    ],
    marketplace_listings: [
      { user_id: 'c', snap_item_id: 's1', marketplace: 'ebay', status: 'active' }, { user_id: 'c', snap_item_id: 's1', marketplace: 'whatnot', status: 'active' },
      { user_id: 'd', snap_item_id: 's2', marketplace: 'ebay', status: 'active' },
    ],
  });
  assert.deepEqual((await sellersToCheck(db)).map((s) => [s.userId, s.crossListed]), [['c', true], ['a', false], ['b', false]]);
});

test('a sold-out card can\'t be listed on Whatnot, whatever quantity the request sends', async () => {
  const wn = shop();
  const deps = { fetchImpl: wn.fetchImpl, sleep: async () => {} };
  for (const over of [{ quantity: 0 }, { quantity: 1, sold_out_at: '2026-11-28T15:00:00.000Z' }]) {
    const db = world();
    await connectMarketplace(db, U, { marketplace: 'whatnot', token: TOKEN }, deps);
    Object.assign(db.tables.snap_items[0], over);
    wn.calls.length = 0;
    await assert.rejects(createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: CARD, price: 13, quantity: 1 }, deps), (e) => e.status === 409 && /sold out/.test(e.message));
    assert.equal(wn.calls.length, 0);
    assert.equal(db.tables.marketplace_listings.filter((x) => x.marketplace === 'whatnot').length, 0);
  }
});

test('two creates of the same card at once: the card is claimed first, so only one Whatnot product is made', async () => {
  const db = world();
  const wn = shop();
  const deps = { fetchImpl: wn.fetchImpl, sleep: async () => {} };
  await connectMarketplace(db, U, { marketplace: 'whatnot', token: TOKEN }, deps);
  wn.calls.length = 0;
  const [a, b] = await Promise.allSettled([
    createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: CARD, price: 13 }, deps),
    createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: CARD, price: 13 }, deps),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ['fulfilled', 'rejected']);
  const lost = [a, b].find((x) => x.status === 'rejected').reason;
  assert.equal(lost.status, 409); assert.match(lost.message, /already being listed on Whatnot|already on Whatnot/);
  assert.equal(wn.calls.filter((c) => c.method === 'POST' && c.path === '/products').length, 1);
  const rows = db.tables.marketplace_listings.filter((x) => x.marketplace === 'whatnot');
  assert.deepEqual(rows.map((r) => [r.status, r.external_id]), [['active', '9001']]);
});

test('a claim left by a create that was cut off expires, and the next create goes ahead', async () => {
  const db = world();
  const wn = shop();
  const deps = { fetchImpl: wn.fetchImpl, sleep: async () => {} };
  await connectMarketplace(db, U, { marketplace: 'whatnot', token: TOKEN }, deps);
  const fresh = new Date().toISOString();
  db.tables.marketplace_listings.push({ id: 'claim', user_id: U, snap_item_id: CARD, marketplace: 'whatnot', status: 'creating', updated_at: fresh });
  await assert.rejects(createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: CARD, price: 13 }, deps), (e) => e.status === 409 && /already being listed/.test(e.message));
  db.tables.marketplace_listings.find((x) => x.id === 'claim').updated_at = new Date(Date.now() - STALE_CLAIM_MS - 1000).toISOString();
  const l = await createCrossListing(db, U, { marketplace: 'whatnot', snapItemId: CARD, price: 13 }, deps);
  assert.equal(l.status, 'active');
  assert.deepEqual(db.tables.marketplace_listings.filter((x) => x.marketplace === 'whatnot').map((x) => x.status), ['active']);
});

test('Whatnot listing is offered for every card game Whatnot has a category for (not sports)', async () => {
  assert.deepEqual(readyGames('whatnot', {}), ['pokemon', 'mtg', 'yugioh', 'lorcana', 'one_piece', 'other']);
  assert.ok(!readyGames('whatnot', {}).includes('sports'));
  const db = world();
  const wn = (await listMarketplaces(db, U)).find((m) => m.marketplace === 'whatnot');
  assert.equal(wn.categoryReady, true); assert.ok(wn.readyGames.includes('pokemon'));
});

test('listing reads page past Supabase\'s 1,000-row cap: a cross-listed card past row 1,000 is still found', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => ({ id: `e${i}`, user_id: 'big', snap_item_id: `s${i}`, marketplace: 'ebay', external_id: String(9000 + i), status: 'active' }));
  const db = fakeDb({
    marketplace_accounts: [{ user_id: 'big', status: 'connected', sales_checked_at: '2026-11-28T10:00:00Z' }],
    marketplace_listings: [...many, { id: 'w1', user_id: 'big', snap_item_id: 's2400', marketplace: 'whatnot', status: 'active' }],
  });
  assert.equal((await db.from('marketplace_listings').select('*')).data.length, 1000);   // the cap is real in the fake too
  assert.deepEqual((await sellersToCheck(db)).map((s) => [s.userId, s.crossListed]), [['big', true]]);
  assert.deepEqual(await crossListedCards(db, 'big'), [{ userId: 'big', snapItemId: 's2400' }]);
  assert.equal((await listMarketplaces(fakeDb({ ...db.tables, ebay_accounts: [] }), 'big')).find((m) => m.marketplace === 'ebay').activeCount, 2500);
});
