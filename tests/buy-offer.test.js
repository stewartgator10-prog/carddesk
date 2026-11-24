// Buy-offer mode: tiered offer math, valuing cards, reading a page photo, accepting a deal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { offerFor, offerTotals, tiersFrom, OFFER_DEFAULTS } from '../netlify/lib/offer-logic.js';
import { valueCard, identifyOfferPhoto, acceptOffer } from '../netlify/lib/buy-offer.js';
import { readPage, cleanBox } from '../netlify/lib/card-vision.js';
import { checkSnapItem } from '../netlify/lib/ebay-listing.js';
import { fakeDb } from './fake-db.js';

const U = 'u1';
const read = (over = {}) => ({ is_trading_card: true, game: 'pokemon', card_name: 'Fuecoco', collector_number: '035/193', set_name: null, set_code: null, language: 'English', finish: 'reverse_holo', variant: null, rarity: null, game_name: null, art_description: null, flavor_text: null, condition_notes: null, grader: null, grade: null, graded: false, condition_guess: 'unknown', possible_misprint: false, misprint_notes: null, confidence: 0.95, notes: null, ...over });

test('tiered offers: flat bulk, mid %, high %, never more than market, total rounded down', () => {
  assert.equal(offerFor(0.27), 0.05);
  assert.equal(offerFor(0.03), 0.03);       // never offer more than the card is worth
  assert.equal(offerFor(4.74), 2.37);       // 50%
  assert.equal(offerFor(1.99), 0.99);       // 50% of 1.99 = 0.995, rounded down
  assert.equal(offerFor(25), 17.5);         // 70%
  assert.equal(offerFor(null), null);
  const items = [{ market_price: 0.27 }, { market_price: 4.74 }, { market_price: 25 }, { market_price: null }, { market_price: 10, included: false }, { market_price: 2, offer_override: 1.5 }, { market_price: null, market_override: 3 }];
  const t = offerTotals(items, OFFER_DEFAULTS);
  assert.equal(t.cards, 6);
  assert.equal(t.unpriced, 1);
  assert.equal(t.market, 35.01);            // 0.27 + 4.74 + 25 + 2 + 3
  assert.equal(t.offer_before_rounding, 22.92); // 0.05 + 2.37 + 17.5 + 1.5 + 1.5
  assert.equal(t.offer, 22);
  assert.equal(t.pct_of_market, 62.8);
  assert.equal(offerTotals(items, { ...OFFER_DEFAULTS, offerRoundTotal: false }).offer, 22.92);
  assert.equal(tiersFrom({ offerMidPct: 60 }).offerMidPct, 60);
});

test('valuing: TCGplayer for English cards, eBay median for others, slabs and unknowns left for Jackson', async () => {
  const catalog = { source: 'tcgdex', id: 'x', name: 'Fuecoco', setName: 'Paldea Evolved', number: '035/193', marketPrice: 0.27, matchLevel: 'exact' };
  const ebayItem = (t, p) => ({ title: t, price: { value: String(p) }, shippingOptions: [{ shippingCost: { value: '1' } }], buyingOptions: ['FIXED_PRICE'], seller: { username: 'x' } });
  const deps = {
    lookupCard: async () => catalog,
    browseSearch: async ({ q }) => ({ items: q.includes('Japanese') ? [ebayItem('Wartortle 171/165 Japanese', 3), ebayItem('Wartortle 171/165 Japanese AR', 5)] : [] }),
  };
  const en = await valueCard(read(), { deps });
  assert.equal(en.market_price, 0.27);
  assert.equal(en.market_source, 'tcgplayer');
  const jp = await valueCard(read({ card_name: 'Wartortle', collector_number: '171/165', language: 'Japanese', finish: 'holo' }), { deps });
  assert.equal(jp.market_price, 5);         // median of 4.00 and 6.00 totals
  assert.deepEqual(jp.flags, ['ebay_median']);
  const slab = await valueCard(read({ graded: true, language: 'Japanese' }), { deps });
  assert.equal(slab.market_price, null);
  assert.deepEqual(slab.flags.sort(), ['graded', 'no_price']);
  const nameOnly = await valueCard(read(), { deps: { ...deps, lookupCard: async () => ({ ...catalog, matchLevel: 'name', marketPrice: 23 }) } });
  assert.equal(nameOnly.market_price, null); // another printing's price is not used
  assert.ok(nameOnly.flags.includes('name_only_match'));
});

const offerDb = () => fakeDb({
  buy_offers: [{ id: 'o1', user_id: U, name: 'Show binder', status: 'draft' }],
  buy_offer_items: [], settings: [], api_usage: [], ebay_accounts: [{ user_id: U, ebay_username: 'me' }], purchases: [], snap_items: [],
}, null, { files: { [`${U}/offers/page.jpg`]: 'jpeg', 'someone/else.jpg': 'jpeg' } });

test('a page photo adds every card to the offer, valued; the AI call is logged', async () => {
  const db = offerDb();
  const deps = {
    readPage: async () => ({ usage: { input_tokens: 3000, output_tokens: 1200 }, latencyMs: 9000, cards: [
      { ...read(), position: 1, box: { x: 0, y: 0, w: 0.33, h: 0.33 } },
      { ...read({ card_name: 'Briar', collector_number: '100/131', confidence: 0.4 }), position: 2, box: { x: 0.33, y: 0, w: 0.33, h: 0.33 } },
    ] }),
    lookupCard: async (r) => ({ source: 'tcgdex', name: r.card_name, marketPrice: r.card_name === 'Briar' ? 0.22 : 4.74, matchLevel: 'exact' }),
    browseSearch: async () => ({ items: [] }),
  };
  const r = await identifyOfferPhoto({ db, userId: U, offerId: 'o1', photoPath: `${U}/offers/page.jpg`, kind: 'page', deps });
  assert.equal(r.cards_found, 2);
  const items = db.tables.buy_offer_items;
  assert.deepEqual(items.map((i) => [i.position, i.card_name, i.market_price]), [[1, 'Fuecoco', 4.74], [2, 'Briar', 0.22]]);
  assert.deepEqual(items[1].flags, ['low_confidence']);
  assert.deepEqual(items[0].box, { x: 0, y: 0, w: 0.33, h: 0.33 });
  assert.equal(db.tables.api_usage[0].purpose, 'buy_offer');
  // A second photo continues the numbering.
  await identifyOfferPhoto({ db, userId: U, offerId: 'o1', photoPath: `${U}/offers/page.jpg`, kind: 'single', deps: { ...deps, readCard: async () => ({ usage: {}, read: read({ card_name: 'Lugia V' }) }) } });
  assert.equal(db.tables.buy_offer_items[2].position, 3);
  assert.equal(db.tables.buy_offer_items[2].box, null);
  await assert.rejects(identifyOfferPhoto({ db, userId: U, offerId: 'o1', photoPath: 'someone/else.jpg', kind: 'page', deps }), /does not belong to you/);
  await assert.rejects(identifyOfferPhoto({ db, userId: U, offerId: 'nope', photoPath: `${U}/offers/page.jpg`, kind: 'page', deps }), /not found/);
});

test('accepting: purchase for the amount paid, split by value; cards land in the Snap queue with their cost', async () => {
  const db = offerDb();
  db.tables.buy_offer_items.push(
    { id: 'a', offer_id: 'o1', user_id: U, photo_path: `${U}/p.jpg`, source: 'page', position: 1, box: { x: 0, y: 0, w: 0.3, h: 0.3 }, game: 'pokemon', card_name: 'Fuecoco', collector_number: '035/193', finish: 'reverse_holo', condition: 'NM', language: 'English', confidence: 0.95, extraction: read(), catalog_source: 'tcgdex', catalog_name: 'Fuecoco', catalog_set: 'Paldea Evolved', catalog_number: '035/193', market_price: 30, market_source: 'tcgplayer', flags: [], included: true },
    { id: 'b', offer_id: 'o1', user_id: U, photo_path: `${U}/s.jpg`, source: 'single', position: 2, box: null, game: 'pokemon', card_name: 'Wartortle', collector_number: '171/165', finish: 'holo', condition: 'NM', language: 'Japanese', confidence: 0.9, extraction: read({ card_name: 'Wartortle', language: 'Japanese' }), market_price: 10, market_source: 'ebay_median', flags: ['ebay_median'], included: true },
    { id: 'c', offer_id: 'o1', user_id: U, photo_path: `${U}/s.jpg`, source: 'single', position: 3, card_name: 'Left out', market_price: 100, flags: [], included: false },
  );
  const r = await acceptOffer({ db, userId: U, offerId: 'o1', finalOffer: 25 });
  assert.equal(r.cards, 2);
  assert.equal(r.totals.offer, 26);                       // 70% of 30 = 21, 50% of 10 = 5
  const p = db.tables.purchases[0];
  assert.equal(p.total_paid, 25);
  assert.equal(p.source, 'Buy offer: Show binder');
  const snaps = db.tables.snap_items;
  assert.equal(snaps.length, 2);
  const fue = snaps.find((s) => s.card_name === 'Fuecoco');
  const war = snaps.find((s) => s.card_name === 'Wartortle');
  assert.equal(fue.cost_basis + war.cost_basis, 25);       // split exactly
  assert.equal(fue.cost_basis, 18.75);                     // 30/40 of 25
  assert.equal(fue.purchase_id, p.id);
  assert.deepEqual(fue.photo_crop, { x: 0, y: 0, w: 0.3, h: 0.3 });
  assert.ok(fue.review_reasons.includes('page_photo'));
  assert.equal(fue.status, 'needs_review');
  assert.equal(war.photo_crop, null);
  assert.equal(war.market_price, 10);                      // eBay median carried into the listing price
  assert.ok(war.price > 0);
  assert.equal(db.tables.buy_offers[0].status, 'accepted');
  assert.equal(db.tables.buy_offer_items.find((i) => i.id === 'a').snap_item_id, fue.id);
  await assert.rejects(acceptOffer({ db, userId: U, offerId: 'o1' }), /already accepted/);
});

test('a card with only a binder-page photo cannot be checked for eBay', async () => {
  await assert.rejects(checkSnapItem({ db: fakeDb({}), userId: U, token: 't', settings: {}, item: { id: 's', status: 'approved', game: 'pokemon', price: 5, title: 'x', photo_crop: { x: 0, y: 0, w: 0.3, h: 0.3 } } }), /binder-page photo/);
});

test('page reading: up to 9 cards in reading order, boxes kept inside the photo', async () => {
  const cards = Array.from({ length: 11 }, (_, i) => ({ ...read({ card_name: `Card ${i}` }), position: 11 - i, box: { x: -0.1, y: 0.5, w: 2, h: 0.2 } }));
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      const body = JSON.parse(b);
      assert.match(body.system, /binder page/);
      assert.ok(body.output_config.format.schema.properties.cards);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null, content: [{ type: 'text', text: JSON.stringify({ cards }) }], usage: { input_tokens: 3000, output_tokens: 900 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const anthropic = new Anthropic({ apiKey: 'k', baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });
    const r = await readPage({ model: 'claude-opus-5-5', image: { base64: 'eA==', mediaType: 'image/jpeg' }, anthropic });
    assert.equal(r.cards.length, 9);
    assert.deepEqual(r.cards.map((c) => c.position), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
    assert.deepEqual(r.cards[0].box, { x: 0, y: 0.5, w: 1, h: 0.2 });
  } finally { server.close(); }
  assert.deepEqual(cleanBox({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }), { x: 0.9, y: 0.9, w: 0.09999999999999998, h: 0.09999999999999998 });
});
