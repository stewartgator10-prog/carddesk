// Sell once: a sale on one marketplace ends (or re-counts) the card's other listings, exactly once.
// eBay and Whatnot are always simulated.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decideSale, handleSales, retryPendingEnds, runSaleCheck, STALE_LINE_MS, takeSaleLock, releaseSaleLock, SALE_LOCK_MS } from '../netlify/lib/sell-once.js';
import { seal } from '../netlify/lib/secret-box.js';
import { resetThrottle } from '../netlify/lib/marketplaces/whatnot-client.js';
import { fakeDb } from './fake-db.js';
import { fakeWhatnot, fixture, ERRORS } from './whatnot-fake.js';

process.env.MARKETPLACE_TOKEN_KEY = crypto.randomBytes(32).toString('base64');
const U = 'u1';
const CARD = 'c0000000-0000-0000-0000-000000000001';
beforeEach(() => resetThrottle());

const ok = (name) => `<${name}Response><Ack>Success</Ack><EndTime>2026-11-28T15:00:00.000Z</EndTime></${name}Response>`;
function trading({ fail = null } = {}) {
  const calls = [];
  const call = async (_tok, name, body) => {
    calls.push({ name, body });
    if (fail) return `<${name}Response><Ack>Failure</Ack><Errors><LongMessage>${fail}</LongMessage><SeverityCode>Error</SeverityCode></Errors></${name}Response>`;
    if (name === 'ReviseInventoryStatus') return `<ReviseInventoryStatusResponse><Ack>Success</Ack></ReviseInventoryStatusResponse>`;
    return ok(name);
  };
  return { call, calls };
}
function whatnotShop() {
  return fakeWhatnot(({ method, path, body }) => {
    if (method === 'POST' && path === '/inventory/set') return { status: 207, body: { results: body.items.map((i) => ({ variant_id: i.variant_id, idempotency_key: i.idempotency_key, status: 'applied', previous_quantity: 1, new_quantity: i.quantity, warnings: [] })) } };
    if (path === '/orders') return { body: fixture('orders-page1.json') };
    if (path === '/orders/123456/items') return { body: fixture('order-items.json', { CARD_ID: CARD }) };
    return null;
  });
}

function world({ quantity = 1, ebay = true, whatnot = true, cardOver = {}, wnOver = {}, ebayOver = {}, dbOpts = {} } = {}) {
  const t = '2026-11-20T00:00:00.000Z';
  return fakeDb({
    snap_items: [{ id: CARD, user_id: U, title: 'Pikachu 025/165', status: ebay ? 'listed' : 'approved', quantity, ebay_item_id: ebay ? '4071' : null, sale_note: null, sold_out_at: null, ...cardOver }],
    inventory: ebay ? [{ id: 'inv1', user_id: U, card_name: 'Pikachu', status: 'In Stock', ebay_item_id: '4071' }] : [],
    marketplace_listings: [
      ...(ebay ? [{ id: 'L-eb', user_id: U, snap_item_id: CARD, inventory_id: 'inv1', marketplace: 'ebay', external_id: '4071', price: 12.5, quantity, status: 'active', listed_at: t, ...ebayOver }] : []),
      ...(whatnot ? [{ id: 'L-wn', user_id: U, snap_item_id: CARD, marketplace: 'whatnot', external_id: '9001', external_variant_id: 'V-1', price: 12.5, quantity, status: 'active', listed_at: t, ...wnOver }] : []),
    ],
    marketplace_orders: [],
    marketplace_accounts: [{ id: 'a1', user_id: U, marketplace: 'whatnot', auth_kind: 'personal_token', access_token_enc: seal('wn_pat_tk_X'), status: 'connected', sales_checked_at: '2026-11-28T14:50:00.000Z', settings: {} }],
    ebay_listings: ebay ? [{ user_id: U, item_id: '4071', status: 'Active', quantity_available: quantity }] : [],
    ebay_accounts: ebay ? [{ id: 'e1', user_id: U, ebay_username: 'jax' }] : [],
  }, null, dbOpts);
}
const deps = (tr, wn) => ({ fetchImpl: wn.fetchImpl, sleep: async () => {}, byMarketplace: { ebay: { token: 'ebay-token', call: tr.call } } });
const wnSale = (over = {}) => ({ orderId: '123456', lineId: '987654', externalId: '9001', cardId: CARD, quantity: 1, price: 14, at: '2026-11-28T14:55:00.000Z', status: 'pending_fulfillment', url: 'https://www.whatnot.com/dashboard/orders/123456', ...over });
const ebaySale = (over = {}) => ({ orderId: '12-345', lineId: 'LI-9', externalId: '4071', quantity: 1, price: 12.5, at: '2026-11-28T14:58:00.000Z', status: 'paid', url: 'https://www.ebay.com/sh/ord/details?orderid=12-345', ...over });

test('decisions: last unit ends the others; stock left re-counts them; selling past zero is a double sale', () => {
  const listing = { id: 'a', status: 'active', quantity: 1 };
  const other = { id: 'b', status: 'active' };
  const one = decideSale({ card: { quantity: 1 }, listing, listings: [listing, other] });
  assert.equal(one.left, 0);
  assert.deepEqual(one.actions.map((a) => a.kind), ['end']);
  assert.deepEqual(one.listingPatch, { status: 'sold', quantity: 0 });
  const three = decideSale({ card: { quantity: 3 }, listing: { ...listing, quantity: 3 }, listings: [listing, other] });
  assert.equal(three.left, 2);
  assert.deepEqual(three.actions.map((a) => [a.kind, a.quantity]), [['update', 2]]);
  assert.equal(three.doubleSale, false);
  assert.equal(decideSale({ card: { quantity: 0 }, listing, listings: [listing] }).doubleSale, true);
  assert.equal(decideSale({ card: { quantity: 0 }, listing: { ...listing, status: 'ended', ended_reason: 'sold_elsewhere' }, listings: [listing] }).doubleSale, true);
});

test('a Whatnot sale of the last card ends the eBay listing, marks the card and stock sold, once', async () => {
  const db = world();
  const tr = trading(); const wn = whatnotShop();
  const r = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) });
  assert.equal(r.newSales, 1); assert.equal(r.ended, 1); assert.deepEqual(r.problems, []);
  assert.deepEqual(tr.calls.map((c) => c.name), ['EndFixedPriceItem']);
  assert.match(tr.calls[0].body, /<ItemID>4071<\/ItemID><EndingReason>NotAvailable<\/EndingReason>/);
  const L = Object.fromEntries(db.tables.marketplace_listings.map((l) => [l.id, l]));
  assert.equal(L['L-wn'].status, 'sold');
  assert.equal(L['L-eb'].status, 'ended'); assert.equal(L['L-eb'].ended_reason, 'sold_elsewhere');
  const c = db.tables.snap_items[0];
  assert.equal(c.quantity, 0); assert.ok(c.sold_out_at);
  assert.equal(c.sale_note.marketplace, 'whatnot'); assert.equal(c.sale_note.price, 14);
  assert.deepEqual(c.sale_note.ended, [{ marketplace: 'ebay', ok: true }]);
  assert.equal(db.tables.inventory[0].status, 'Sold'); assert.equal(db.tables.inventory[0].sale_channel, 'Whatnot');
  assert.equal(db.tables.ebay_listings[0].status, 'Ended');
  // the same check again (or the other site): nothing more happens
  const again = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) });
  assert.equal(again.newSales, 0);
  assert.equal(tr.calls.length, 1);
  assert.equal(db.tables.marketplace_orders.length, 1);
  assert.ok(db.tables.marketplace_orders[0].handled_at);
});

test('an eBay sale of a card live on Whatnot takes it down on Whatnot', async () => {
  const db = world();
  const tr = trading(); const wn = whatnotShop();
  const r = await handleSales({ db, userId: U, marketplace: 'ebay', sales: [ebaySale()], deps: deps(tr, wn) });
  assert.equal(r.ended, 1);
  assert.deepEqual(wn.calls.map((c) => `${c.method} ${c.path}`), ['POST /inventory/set']);
  assert.equal(wn.calls[0].body.items[0].quantity, 0);
  assert.equal(db.tables.marketplace_listings.find((l) => l.id === 'L-wn').status, 'ended');
  assert.equal(db.tables.inventory[0].status, 'In Stock');   // eBay sales are marked sold by the eBay sync itself
  assert.equal(db.tables.snap_items[0].sale_note.marketplace, 'ebay');
});

test('quantity 3: one sale leaves 2 and pushes 2 to eBay instead of ending it', async () => {
  const db = world({ quantity: 3 });
  const tr = trading(); const wn = whatnotShop();
  const r = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) });
  assert.equal(r.ended, 0); assert.equal(r.updated, 1);
  assert.deepEqual(tr.calls.map((c) => c.name), ['ReviseInventoryStatus']);
  assert.match(tr.calls[0].body, /<ItemID>4071<\/ItemID><Quantity>2<\/Quantity>/);
  assert.equal(db.tables.snap_items[0].quantity, 2);
  assert.equal(db.tables.snap_items[0].sold_out_at, null);
  assert.equal(db.tables.marketplace_listings.find((l) => l.id === 'L-wn').status, 'active');
  assert.equal(db.tables.marketplace_listings.find((l) => l.id === 'L-eb').quantity, 2);
  assert.equal(db.tables.ebay_listings[0].quantity_available, 2);
});

test('the last card sold on both marketplaces before we could end one: "sold on both", with both orders', async () => {
  const db = world();
  const tr = trading(); const wn = whatnotShop();
  await handleSales({ db, userId: U, marketplace: 'ebay', sales: [ebaySale()], deps: deps(tr, wn) });
  const r = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) });
  assert.equal(r.doubleSales, 1);
  const note = db.tables.snap_items[0].sale_note;
  assert.equal(note.double_sale, true);
  assert.deepEqual(note.orders.map((o) => o.marketplace), ['ebay', 'whatnot']);
});

test('ending fails: the listing stays up with the reason, and the next check tries again', async () => {
  const db = world();
  const wn = whatnotShop();
  const bad = trading({ fail: 'Internal error to the application.' });
  const r = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(bad, wn) });
  assert.equal(r.ended, 0);
  assert.match(r.problems[0], /^eBay: eBay said: Internal error/);
  const eb = db.tables.marketplace_listings.find((l) => l.id === 'L-eb');
  assert.equal(eb.status, 'active'); assert.match(eb.last_error, /Internal error/);
  assert.deepEqual(db.tables.snap_items[0].sale_note.ended, [{ marketplace: 'ebay', ok: false, error: 'eBay said: Internal error to the application.' }]);
  const good = trading();
  const retry = await retryPendingEnds({ db, userId: U, deps: deps(good, wn) });
  assert.equal(retry.ended, 1);
  assert.equal(db.tables.marketplace_listings.find((l) => l.id === 'L-eb').status, 'ended');
  assert.deepEqual(db.tables.snap_items[0].sale_note.ended, [{ marketplace: 'ebay', ok: true }]);
  assert.equal((await retryPendingEnds({ db, userId: U, deps: deps(good, wn) })).ended, 0);
});

test('a listing eBay already ended counts as ended', async () => {
  const db = world();
  const wn = whatnotShop();
  const tr = trading({ fail: 'The auction has already been closed. (1047)' });
  const r = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) });
  assert.equal(r.ended, 1);
});

test('a cancelled order before anything was ended puts the card back; after, it only adds a note', async () => {
  const db = world({ ebay: false });
  const tr = trading(); const wn = whatnotShop();
  await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) });
  assert.equal(db.tables.snap_items[0].quantity, 0);
  const r = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale({ status: 'cancelled' })], deps: deps(tr, wn) });
  assert.equal(r.cancelled, 1);
  assert.equal(db.tables.snap_items[0].quantity, 1);
  assert.equal(db.tables.snap_items[0].sold_out_at, null);
  assert.equal(db.tables.marketplace_listings[0].status, 'active');

  const db2 = world();
  await handleSales({ db: db2, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) });
  await handleSales({ db: db2, userId: U, marketplace: 'whatnot', sales: [wnSale({ status: 'cancelled' })], deps: deps(tr, wn) });
  assert.equal(db2.tables.snap_items[0].quantity, 0);
  assert.equal(db2.tables.snap_items[0].sale_note.cancelled, true);
  assert.equal(db2.tables.marketplace_listings.find((l) => l.id === 'L-eb').status, 'ended');   // never relisted automatically
});

test('nothing changes for a card that is only on eBay, or for a sale from before it went on Whatnot', async () => {
  const db = world({ whatnot: false });
  const tr = trading(); const wn = whatnotShop();
  const r = await handleSales({ db, userId: U, marketplace: 'ebay', sales: [ebaySale()], deps: deps(tr, wn) });
  assert.equal(r.newSales, 0);
  assert.equal(db.tables.marketplace_orders.length, 0);
  assert.equal(db.tables.snap_items[0].sale_note, null);
  assert.equal(db.tables.snap_items[0].quantity, 1);
  const db2 = world({ quantity: 2, wnOver: { listed_at: '2026-11-28T12:00:00.000Z' } });
  const r2 = await handleSales({ db: db2, userId: U, marketplace: 'ebay', sales: [ebaySale({ at: '2026-11-27T10:00:00.000Z' })], deps: deps(tr, wn) });
  assert.equal(r2.newSales, 0);
  assert.equal(db2.tables.snap_items[0].quantity, 2);
  assert.equal(tr.calls.length + wn.calls.length, 0);
});

test('the sale check reads Whatnot, ends eBay within one check, and moves the "last checked" time', async () => {
  const db = world();
  const tr = trading(); const wn = whatnotShop();
  const r = await runSaleCheck({ db, userId: U, deps: deps(tr, wn), includeEbay: false });
  assert.deepEqual(r.checked, ['whatnot']);
  assert.equal(r.newSales, 1); assert.equal(r.ended, 1);
  assert.deepEqual(tr.calls.map((c) => c.name), ['EndFixedPriceItem']);
  assert.notEqual(db.tables.marketplace_accounts[0].sales_checked_at, '2026-11-28T14:50:00.000Z');
  const r2 = await runSaleCheck({ db, userId: U, deps: deps(tr, wn), includeEbay: false });
  assert.equal(r2.newSales, 0);
  assert.equal(tr.calls.length, 1);
});

test('a 401 from Whatnot marks the account "reconnect" without failing the check, and later checks skip it', async () => {
  const db = world();
  const tr = trading();
  const dead = fakeWhatnot(() => ({ status: 401, body: ERRORS['401'] }));
  const r = await runSaleCheck({ db, userId: U, deps: deps(tr, dead), includeEbay: false });
  assert.deepEqual(r.checked, []);
  assert.match(r.problems[0], /stopped accepting your token/);
  assert.equal(db.tables.marketplace_accounts[0].status, 'reconnect');
  const n = dead.calls.length;
  await runSaleCheck({ db, userId: U, deps: deps(tr, dead), includeEbay: false });
  assert.equal(dead.calls.length, n);
});

test('a sale that failed partway is finished by the next check, once, without counting it twice', async () => {
  // The card's stock update fails once with a passing database error, before anything was ended.
  let failNext = true;
  const failOn = ({ table, op }) => (table === 'snap_items' && op === 'update' && failNext ? (failNext = false, 'connection reset') : null);
  const db = world({ dbOpts: { failOn } });
  const tr = trading(); const wn = whatnotShop();
  await assert.rejects(handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) }), /connection reset/);
  const line = db.tables.marketplace_orders[0];
  assert.equal(line.handled_at ?? null, null); assert.equal(line.claimed_at, null);   // released for the next check
  assert.equal(db.tables.snap_items[0].quantity, 1);

  const r = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) });
  assert.equal(r.newSales, 1); assert.equal(r.doubleSales, 0);
  const card = db.tables.snap_items[0];
  assert.equal(card.quantity, 0); assert.ok(card.sold_out_at);
  assert.equal(card.sale_note.double_sale, false);
  assert.deepEqual(card.sale_note.ended, [{ marketplace: 'ebay', ok: true }]);   // ended by the first try, still in the note
  assert.deepEqual(tr.calls.map((c) => c.name), ['EndFixedPriceItem']);           // eBay was not called again
  assert.equal(db.tables.inventory[0].status, 'Sold');
  assert.ok(db.tables.marketplace_orders[0].handled_at);
  const again = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) });
  assert.equal(again.newSales, 0);
});

test('a line another check is working on is left alone until its claim expires (a run cut off by the time limit)', async () => {
  const db = world();
  const tr = trading(); const wn = whatnotShop();
  const recent = new Date().toISOString();
  db.tables.marketplace_orders.push({ user_id: U, marketplace: 'whatnot', external_order_id: '123456', external_line_id: '987654', quantity: 1, claimed_at: recent, handled_at: null });
  assert.equal((await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) })).newSales, 0);
  assert.equal(tr.calls.length, 0);
  db.tables.marketplace_orders[0].claimed_at = new Date(Date.now() - STALE_LINE_MS - 1000).toISOString();
  const r = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) });
  assert.equal(r.newSales, 1); assert.equal(r.ended, 1);
  assert.equal(db.tables.marketplace_listings.find((l) => l.id === 'L-eb').status, 'ended');
});

test('a stock push that failed is tried again on the next check', async () => {
  const db = world({ quantity: 3 });
  const wn = whatnotShop();
  const r = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale({ quantity: 2 })], deps: deps(trading({ fail: 'Internal error to the application.' }), wn) });
  assert.equal(r.updated, 0);
  const eb = () => db.tables.marketplace_listings.find((l) => l.id === 'L-eb');
  assert.equal(eb().quantity, 3); assert.match(eb().last_error, /Internal error/);
  assert.equal(db.tables.snap_items[0].quantity, 1);
  const good = trading();
  const retry = await retryPendingEnds({ db, userId: U, deps: deps(good, wn) });
  assert.equal(retry.updated, 1); assert.equal(retry.ended, 0);
  assert.match(good.calls[0].body, /<ItemID>4071<\/ItemID><Quantity>1<\/Quantity>/);
  assert.equal(eb().quantity, 1); assert.equal(eb().last_error, null); assert.equal(eb().status, 'active');
  assert.deepEqual(db.tables.snap_items[0].sale_note.updated, [{ marketplace: 'ebay', ok: true }]);
  assert.equal((await retryPendingEnds({ db, userId: U, deps: deps(good, wn) })).updated, 0);
});

test('an eBay sale of a cross-listed card is found even when the seller has more than 1,000 eBay listings', async () => {
  const db = world();
  // 1,500 other eBay listings ahead of this card's rows.
  db.tables.marketplace_listings.unshift(...Array.from({ length: 1500 }, (_, i) => ({ id: `x${i}`, user_id: U, snap_item_id: `other-${i}`, marketplace: 'ebay', external_id: String(50000 + i), status: 'active' })));
  const tr = trading(); const wn = whatnotShop();
  const r = await handleSales({ db, userId: U, marketplace: 'ebay', sales: [ebaySale()], deps: deps(tr, wn) });
  assert.equal(r.newSales, 1); assert.equal(r.ended, 1);
  assert.equal(db.tables.marketplace_listings.find((l) => l.id === 'L-wn').status, 'ended');
});

test('a line that stopped partway is finished from our own record, even when Whatnot no longer returns it', async () => {
  // The note update (after eBay was ended) fails once: the stock is already taken, the line is open.
  let n = 0;
  const failOn = ({ table, op }) => (table === 'snap_items' && op === 'update' && ++n === 2 ? 'connection reset' : null);
  const db = world({ dbOpts: { failOn } });
  const tr = trading(); const wn = whatnotShop();
  await assert.rejects(handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) }), /connection reset/);
  assert.equal(db.tables.snap_items[0].quantity, 0);
  assert.equal(db.tables.marketplace_orders[0].handled_at ?? null, null);
  // The next check gets nothing back from Whatnot for that order (it is past the look-back).
  const r = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [], deps: deps(tr, wn) });
  assert.equal(r.newSales, 0);                                   // already counted in the stock
  assert.ok(db.tables.marketplace_orders[0].handled_at);
  const card = db.tables.snap_items[0];
  assert.equal(card.quantity, 0); assert.equal(card.sale_note.double_sale, false);
  assert.deepEqual(card.sale_note.ended, [{ marketplace: 'ebay', ok: true }]);
  assert.deepEqual(tr.calls.map((c) => c.name), ['EndFixedPriceItem']);   // eBay ended once
  assert.equal(db.tables.inventory[0].status, 'Sold');
  assert.equal(db.tables.marketplace_listings.find((l) => l.id === 'L-wn').status, 'sold');
});

test('a line recorded before a crash, with nothing done yet, is finished from our record alone', async () => {
  const db = world();
  const tr = trading(); const wn = whatnotShop();
  db.tables.marketplace_orders.push({ user_id: U, marketplace: 'whatnot', external_order_id: '123456', external_line_id: '987654', quantity: 1, item_price: 14, status: 'pending_fulfillment',
    ordered_at: '2026-11-28T14:55:00.000Z', claimed_at: new Date(Date.now() - STALE_LINE_MS - 1000).toISOString(), handled_at: null, raw: { externalId: '9001', cardId: CARD, url: null } });
  const r = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [], deps: deps(tr, wn) });
  assert.equal(r.newSales, 1); assert.equal(r.ended, 1);
  assert.equal(db.tables.snap_items[0].quantity, 0);
  assert.equal(db.tables.snap_items[0].sale_note.price, 14);
});

test('two sales of the last card handled at the same time: one takes the stock, the other is "sold on both" with both orders', async () => {
  const db = world();
  const tr = trading(); const wn = whatnotShop();
  await Promise.all([
    handleSales({ db, userId: U, marketplace: 'ebay', sales: [ebaySale()], deps: deps(tr, wn) }),
    handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) }),
  ]);
  const card = db.tables.snap_items[0];
  assert.equal(card.quantity, 0);
  assert.equal(card.sale_note.double_sale, true);
  assert.deepEqual(card.sale_note.orders.map((o) => o.marketplace).sort(), ['ebay', 'whatnot']);
  assert.ok(db.tables.marketplace_orders.every((o) => o.handled_at));
});

test('one sale check per seller at a time: a second run waits its turn; a lease that ran out is taken over', async () => {
  const db = world();
  const tr = trading(); const wn = whatnotShop();
  const held = await takeSaleLock(db, U);
  assert.ok(held);
  assert.equal(await takeSaleLock(db, U), null);
  const busy = await runSaleCheck({ db, userId: U, deps: deps(tr, wn), includeEbay: false });
  assert.equal(busy.busy, true); assert.equal(wn.calls.length, 0);
  await releaseSaleLock(db, U, held);
  const r = await runSaleCheck({ db, userId: U, deps: deps(tr, wn), includeEbay: false });
  assert.ok(!r.busy); assert.equal(r.newSales, 1);
  assert.ok(Date.parse(db.tables.marketplace_sale_locks[0].locked_until) <= Date.now());   // given back
  // A check cut off by the time limit never gives it back; the next one takes over once it runs out.
  const stuck = await takeSaleLock(db, U);
  assert.ok(stuck);
  assert.equal(await takeSaleLock(db, U, { now: Date.now() + SALE_LOCK_MS - 60_000 }), null);
  assert.ok(await takeSaleLock(db, U, { now: Date.now() + SALE_LOCK_MS + 1000 }));
  // Two runs started together: only one does the work.
  const db2 = world();
  const wn2 = whatnotShop(); const tr2 = trading();
  const both = await Promise.all([runSaleCheck({ db: db2, userId: U, deps: deps(tr2, wn2), includeEbay: false }), runSaleCheck({ db: db2, userId: U, deps: deps(tr2, wn2), includeEbay: false })]);
  assert.equal(both.filter((x) => x.busy).length, 1);
  assert.equal(tr2.calls.length, 1);
});

test('the stock changed between reading the card and taking the sale off it: the sale is re-read, not lost', async () => {
  // Another sale (an eBay sync running at the same moment) takes the last card just before our update.
  let db; let raced = false;
  const failOn = ({ table, op }) => {
    if (table === 'snap_items' && op === 'update' && !raced) {
      raced = true;
      Object.assign(db.tables.snap_items[0], { quantity: 0, sold_out_at: '2026-11-28T14:58:00.000Z',
        sale_note: { marketplace: 'ebay', quantity_left: 0, ended: [], updated: [], double_sale: false, orders: [{ marketplace: 'ebay', orderId: '12-345', lineId: 'LI-9', url: null }] } });
    }
    return null;
  };
  db = world({ dbOpts: { failOn } });
  const tr = trading(); const wn = whatnotShop();
  const r = await handleSales({ db, userId: U, marketplace: 'whatnot', sales: [wnSale()], deps: deps(tr, wn) });
  assert.equal(r.doubleSales, 1);
  const note = db.tables.snap_items[0].sale_note;
  assert.equal(note.double_sale, true);
  assert.deepEqual(note.orders.map((o) => o.marketplace), ['ebay', 'whatnot']);
  assert.equal(db.tables.snap_items[0].quantity, 0);
});
