// Collection: scan in, value, alerts, nightly refresh, send to Snap to List.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { valueRead, checkAlert, nextAlertState, growthBase, scanCollectionPhoto, refreshCollection, recheckAlerts, repriceItem, sendToSnap } from '../netlify/lib/collection.js';
import { fakeDb } from './fake-db.js';

const U = 'u1';
const read = (over = {}) => ({ is_trading_card: true, game: 'pokemon', card_name: 'Charizard ex', collector_number: '199/165', set_name: null, set_code: null,
  language: 'English', finish: 'holo', variant: null, rarity: null, game_name: null, art_description: null, flavor_text: null, condition_notes: null,
  graded: false, grader: null, grade: null, condition_guess: 'NM', possible_misprint: false, misprint_notes: null, confidence: 0.95, notes: null, ...over });
const catalog = (over = {}) => ({ source: 'tcgdex', id: 'sv3pt5-199', name: 'Charizard ex', setName: '151', number: '199/165', rarity: 'Special Illustration Rare',
  imageUrl: 'https://img/c.webp', url: 'https://tcgplayer/x', marketPrice: 120, priceKey: 'holofoil', matchLevel: 'exact', versions: 1, ...over });
const listing = (title, price, seller = 'someone') => ({ title, price: { value: String(price) }, shippingOptions: [{ shippingCost: { value: '5' } }], buyingOptions: ['FIXED_PRICE'], seller: { username: seller } });

test('valuing: catalog for raw English cards, eBay listings for the same grade on slabs, eBay for the rest', async () => {
  const deps = {
    lookupCard: async () => catalog(),
    browseSearch: async ({ q }) => ({ q, items: [listing('Charizard ex 199/165 PSA 10 151', 400), listing('Charizard ex 199/165 PSA 10 SIR', 450), listing('Charizard ex 199/165 PSA 9', 200),
      listing('Charizard ex 199/165 151 SIR', 115), listing('Charizard ex 199/165 151 SIR', 125)] }),
  };
  const raw = await valueRead(read(), { deps });
  assert.deepEqual([raw.market, raw.source, raw.flags], [120, 'tcgplayer', []]);
  const slab = await valueRead(read({ graded: true, grader: 'PSA', grade: '10' }), { deps });
  assert.deepEqual([slab.market, slab.source, slab.key], [430, 'ebay_median', 'PSA 10']);                // 405 and 455 with shipping; the PSA 9 and raw copies don't count
  const unread = await valueRead(read({ graded: true, grader: null, grade: null }), { deps });
  assert.deepEqual([unread.market, unread.flags.sort()], [null, ['grade_unread', 'no_price']]);
  const japanese = await valueRead(read({ language: 'Japanese' }), { deps: { ...deps, browseSearch: async () => ({ items: [listing('Charizard ex 199/165 Japanese', 20)] }) } });
  assert.deepEqual([japanese.market, japanese.source], [25, 'ebay_median']);
});

test('alerts: target price first, then growth from cost, else from value when added; dismissals stick', () => {
  const base = { status: 'held', alert_state: 'none', value_at_add: 100, market_price: 126 };
  assert.deepEqual(growthBase({ cost: 80, value_at_add: 100 }), { base: 80, from: 'cost' });
  assert.deepEqual(growthBase({ cost: null, value_at_add: 100 }), { base: 100, from: 'added' });
  assert.match(checkAlert(base, { collectionAlertPct: 25 }), /^Up 26% from \$100\.00 when added; now \$126\.00\.$/);
  assert.equal(checkAlert({ ...base, market_price: 124 }, { collectionAlertPct: 25 }), null);
  assert.match(checkAlert({ ...base, cost: 50, market_price: 70 }, { collectionAlertPct: 25 }), /Up 40% from what you paid \(\$50\.00\)/);
  assert.match(checkAlert({ ...base, market_price: 90, target_price: 90 }, {}), /Reached your target of \$90\.00/);
  assert.equal(checkAlert({ ...base, target_pct: 50 }, { collectionAlertPct: 25 }), null);               // the item's own % overrides the default
  assert.equal(checkAlert({ ...base, status: 'listing' }, {}), null);
  assert.equal(checkAlert({ ...base, market_price: 500 }, { collectionAlertPct: 0 }), null);             // 0 = no default alert

  const on = nextAlertState(base, { collectionAlertPct: 25 });
  assert.equal(on.alert_state, 'active');
  assert.equal(nextAlertState({ ...base, alert_state: 'dismissed' }, { collectionAlertPct: 25 }), null);  // stays dismissed while still true
  assert.deepEqual(nextAlertState({ ...base, alert_state: 'dismissed', market_price: 101 }, { collectionAlertPct: 25 }), { alert_state: 'none', alert_reason: null, alert_at: null });
});

const scanDb = () => fakeDb({ settings: [{ user_id: U, data: { collectionAlertPct: 25 } }], api_usage: [], ebay_accounts: [], collection_items: [], collection_prices: [], snap_items: [] },
  null, { files: { [`${U}/collection/p.jpg`]: 'jpeg', 'other/x.jpg': 'jpeg' } });

test('scanning a binder page adds every card, priced, with a first price-history point; the AI fee is logged', async () => {
  const db = scanDb();
  const deps = {
    readPage: async () => ({ usage: { input_tokens: 3000, output_tokens: 900 }, latencyMs: 8000, cards: [
      { ...read(), position: 1, box: { x: 0, y: 0, w: 0.33, h: 0.33 } },
      { ...read({ card_name: 'Pidgey', collector_number: '016/165', confidence: 0.5 }), position: 2, box: { x: 0.33, y: 0, w: 0.33, h: 0.33 } },
    ] }),
    lookupCard: async (r) => catalog(r.card_name === 'Pidgey' ? { name: 'Pidgey', number: '016/165', marketPrice: 0.12, rarity: 'Common' } : {}),
    browseSearch: async () => ({ items: [] }),
  };
  const r = await scanCollectionPhoto({ db, userId: U, photoPath: `${U}/collection/p.jpg`, kind: 'page', deps });
  assert.equal(r.cards_found, 2);
  const items = db.tables.collection_items;
  assert.deepEqual(items.map((i) => [i.card_name, i.market_price, i.value_at_add, i.source, i.status, i.alert_state]),
    [['Charizard ex', 120, 120, 'page', 'held', 'none'], ['Pidgey', 0.12, 0.12, 'page', 'held', 'none']]);
  assert.deepEqual(items[0].photo_crop, { x: 0, y: 0, w: 0.33, h: 0.33 });
  assert.deepEqual(items[1].flags, ['low_confidence']);
  assert.equal(db.tables.collection_prices.length, 2);
  assert.equal(db.tables.api_usage[0].purpose, 'collection_scan');
  await assert.rejects(scanCollectionPhoto({ db, userId: U, photoPath: 'other/x.jpg', kind: 'page', deps }), /does not belong to you/);
});

test('nightly refresh re-prices held cards, keeps a missed price, keeps manual values, and raises alerts', async () => {
  const old = new Date(Date.now() - 2 * 86400e3).toISOString();
  const db = fakeDb({ settings: [{ user_id: U, data: { collectionAlertPct: 25 } }], ebay_accounts: [], collection_prices: [], collection_items: [
    { id: 'a', user_id: U, status: 'held', alert_state: 'none', game: 'pokemon', card_name: 'Charizard ex', collector_number: '199/165', language: 'English', extraction: read(), market_price: 100, value_at_add: 100, market_source: 'tcgplayer', market_at: old },
    { id: 'b', user_id: U, status: 'held', alert_state: 'none', game: 'pokemon', card_name: 'Gone', collector_number: '1/1', language: 'English', extraction: read({ card_name: 'Gone' }), market_price: 5, value_at_add: 5, market_source: 'tcgplayer', market_at: old },
    { id: 'c', user_id: U, status: 'held', alert_state: 'none', game: 'pokemon', card_name: 'Mine', market_price: 40, value_at_add: 10, market_source: 'manual', market_at: old },
    { id: 'd', user_id: U, status: 'listing', alert_state: 'none', game: 'pokemon', card_name: 'Listed', market_price: 1, market_at: old },
    { id: 'e', user_id: U, status: 'held', alert_state: 'none', game: 'pokemon', card_name: 'Fresh', market_price: 1, market_at: new Date().toISOString() },
  ] });
  const r = await refreshCollection({ db, userId: U, deps: { lookupCard: async (x) => (x.card_name === 'Gone' ? null : catalog({ marketPrice: 130 })), browseSearch: async () => ({ items: [] }) } });
  const byId = Object.fromEntries(db.tables.collection_items.map((i) => [i.id, i]));
  assert.deepEqual([r.processed, r.alerts], [3, 2]);
  assert.deepEqual([byId.a.market_price, byId.a.alert_state], [130, 'active']);   // up 30%
  assert.equal(byId.b.market_price, 5);                                          // lookup missed: yesterday's value kept
  assert.deepEqual([byId.c.market_price, byId.c.alert_state], [40, 'active']);   // manual value kept, and it is 4x what it was added at
  assert.equal(db.tables.collection_prices.length, 3);
  // Raising the default to 50% clears the alert on the 30% card but not the 300% one.
  db.tables.settings[0].data.collectionAlertPct = 50;
  const re = await recheckAlerts({ db, userId: U });
  assert.deepEqual([re.active, byId.a.alert_state, byId.c.alert_state], [1, 'none', 'active']);
});

test('re-pricing after a correction, and sending a card to Snap to List with its cost', async () => {
  const db = fakeDb({ settings: [], ebay_accounts: [], collection_prices: [], snap_items: [], collection_items: [
    { id: 'a', user_id: U, status: 'held', alert_state: 'active', alert_reason: 'Up', game: 'pokemon', card_name: 'Charizard ex', collector_number: '199/165', language: 'English', finish: 'holo',
      condition: 'NM', extraction: read(), market_price: 130, market_source: 'tcgplayer', value_at_add: 100, cost: 60, catalog_source: 'tcgdex', catalog_name: 'Charizard ex', catalog_set: '151',
      catalog_number: '199/165', rarity: 'Special Illustration Rare', photo_path: `${U}/collection/p.jpg`, photo_crop: { x: 0, y: 0, w: 0.3, h: 0.3 }, flags: [] },
  ] });
  const fixed = await repriceItem({ db, userId: U, id: 'a', deps: { lookupCard: async () => catalog({ marketPrice: 140 }), browseSearch: async () => ({ items: [] }) } });
  assert.equal(fixed.item.market_price, 140);
  const r = await sendToSnap({ db, userId: U, id: 'a' });
  const snap = db.tables.snap_items[0];
  assert.equal(snap.id, r.snap_item_id);
  assert.deepEqual([snap.card_name, snap.cost_basis, snap.market_price, snap.batch_id], ['Charizard ex', 60, 140, 'collection']);
  assert.ok(snap.price > 0);
  assert.ok(snap.review_reasons.includes('page_photo'));                         // binder-page card needs its own photo first
  assert.match(snap.title, /^Charizard ex 199\/165 \| Pokemon/);
  const item = db.tables.collection_items[0];
  assert.deepEqual([item.status, item.alert_state, item.snap_item_id], ['listing', 'none', snap.id]);
  await assert.rejects(sendToSnap({ db, userId: U, id: 'a' }), /already being listed/);
});
