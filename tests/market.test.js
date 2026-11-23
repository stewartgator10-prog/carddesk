// Automatic comps: competitor matching, search query, refresh orchestration, nightly signature,
// the new Repricer rules, and the title-reading request. eBay, catalogs and Claude are simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { filterCompetitors, summarizeComps, compQuery, numberRegex, refreshMarket } from '../netlify/lib/market.js';
import { signCron, verifyCron } from '../netlify/lib/cron-signature.js';
import { parseTitles } from '../netlify/lib/title-parse.js';
import { applyRule } from '../src/pricing/pricingLogic.js';
import { fakeDb } from './fake-db.js';

const U = 'u1';
const parsed = (over = {}) => ({ is_single_card: true, game: 'pokemon', card_name: 'Fuecoco', collector_number: '035/193', set_name: 'Paldea Evolved', set_code: null, language: 'English', finish: 'reverse_holo', variant: null, graded: false, grader: null, grade: null, condition: 'NM', ...over });
const item = (title, price, ship = 1.25, seller = 'other', options = ['FIXED_PRICE']) => ({ title, price: { value: String(price) }, shippingOptions: [{ shippingCost: { value: String(ship) } }], seller: { username: seller }, buyingOptions: options, itemWebUrl: `https://www.ebay.com/itm/${price}` });

test('only true matches count as competition', () => {
  const items = [
    item('Fuecoco 035/193 Paldea Evolved Reverse Holo Pokemon NM', 0.99),            // match: total 2.24
    item('Fuecoco 35/193 Reverse Holo Paldea Evolved', 0.50, 0),                       // match: no leading zero, free shipping
    item('Fuecoco 035/193 Paldea Evolved Pokemon Common', 0.25),                       // normal, not reverse
    item('Fuecoco 034/193 Paldea Evolved Reverse Holo', 0.30),                         // different number
    item('Fuecoco 035/193 Reverse Holo Japanese', 0.40),                               // Japanese
    item('Fuecoco 035/193 Reverse Holo PSA 10', 25),                                   // graded
    item('Fuecoco 035/193 Reverse Holo Lot x4', 1.00),                                 // lot
    item('Fuecoco 035/193 Reverse Holo', 0.60, 1, 'jacksonseller'),                    // his own
    item('Fuecoco 035/193 Reverse Holo', 0.20, 1, 'other', ['AUCTION']),               // auction
    item('Fuecoco 1035/1193 Reverse Holo', 0.10),                                      // number inside a longer number
  ];
  const out = filterCompetitors(items, parsed(), 'JacksonSeller');
  assert.deepEqual(out.map((x) => x.total), [0.5, 2.24]);
  const s = summarizeComps(out);
  assert.equal(s.comp_low, 0.5);
  assert.equal(s.comp_median, 1.37);
  assert.equal(s.comp_count, 2);
  assert.deepEqual(summarizeComps([]), { comp_low: null, comp_median: null, comp_count: 0, comp_items: [] });
});

test('Japanese and graded cards match only their own kind; queries say so', () => {
  const jp = parsed({ card_name: 'Wartortle', collector_number: '171/165', language: 'Japanese', finish: 'holo' });
  assert.equal(compQuery(jp), 'Wartortle 171/165 Japanese');
  const out = filterCompetitors([item('Wartortle 171/165 AR sv2a Japanese', 3), item('Wartortle 171/165 AR 151 English', 2)], jp, null);
  assert.deepEqual(out.map((x) => x.price), [3]);
  const slab = parsed({ card_name: 'Umbreon VMAX', collector_number: '215/203', graded: true, grader: 'PSA', grade: '10', finish: 'holo' });
  assert.equal(compQuery(slab), 'Umbreon VMAX 215/203 PSA 10');
  assert.deepEqual(filterCompetitors([item('Umbreon VMAX 215/203 PSA 10 Gem Mint', 900), item('Umbreon VMAX 215/203 PSA 9', 500), item('Umbreon VMAX 215/203 NM', 400)], slab).map((x) => x.price), [900]);
  assert.ok(numberRegex('OP07-118').test('Sabo OP07-118 SEC'));
  assert.ok(numberRegex('TG05/TG30').test('Pikachu TG5 Trainer Gallery'));
  assert.ok(!numberRegex('216').test('Spider-Man 2099 2160'));
});

const listings = [
  { user_id: U, item_id: '1', title: 'Reverse Holo Fuecoco 035/193 Common Paldea Evolved Pokemon TCG', price: 1.89, status: 'Active' },
  { user_id: U, item_id: '2', title: 'Vintage Base Set Pokemon Sticker Sheet (2001)', price: 5, status: 'Active' },
  { user_id: U, item_id: '3', title: 'Wartortle 171/165 AR- Scarlet and Violet 151 sv2a - Japanese - NM- US Seller', price: 4.89, status: 'Active' },
];
function marketDb(extra = {}) {
  return fakeDb({ ebay_listings: listings.map((l) => ({ ...l })), listing_market: [], ebay_accounts: [{ user_id: U, ebay_username: 'jacksonseller' }], settings: [], api_usage: [], ...extra });
}

test('refresh: reads titles once in one AI call, prices English cards from the catalog, finds competition, logs the fee', async () => {
  const db = marketDb();
  const calls = { parse: 0, catalog: [], search: [] };
  const deps = {
    parseTitles: async ({ titles }) => {
      calls.parse += 1;
      assert.equal(titles.length, 3);
      return { usage: { input_tokens: 1500, output_tokens: 600 }, latencyMs: 2000, requestId: 'r1', reads: new Map([
        [0, parsed()],
        [1, parsed({ is_single_card: false, card_name: 'Sticker Sheet', collector_number: null })],
        [2, parsed({ card_name: 'Wartortle', collector_number: '171/165', language: 'Japanese', finish: 'holo' })],
      ]) };
    },
    lookupCard: async (p) => { calls.catalog.push(p.card_name); return { source: 'tcgdex', id: 'sv02-035', name: 'Fuecoco', setName: 'Paldea Evolved', number: '035/193', marketPrice: 0.27, priceKey: 'reverse-holofoil', matchLevel: 'exact' }; },
    browseSearch: async ({ q }) => { calls.search.push(q); return { items: q.startsWith('Fuecoco') ? [item('Fuecoco 035/193 Reverse Holo', 0.99), item('Fuecoco 035/193 Reverse Holo', 0.5, 1, 'jacksonseller')] : [item('Wartortle 171/165 Japanese', 3.5)] }; },
  };
  const r = await refreshMarket({ db, userId: U, deps });
  assert.equal(calls.parse, 1);
  assert.deepEqual(calls.catalog, ['Fuecoco']);                       // Japanese card: no English catalog price
  assert.deepEqual(calls.search, ['Fuecoco 035/193', 'Wartortle 171/165 Japanese']); // sticker sheet: not searched
  assert.equal(r.processed, 3);
  assert.equal(r.remaining, 0);
  const row = (id) => db.tables.listing_market.find((x) => x.item_id === id);
  assert.equal(row('1').market_price, 0.27);
  assert.equal(row('1').comp_low, 2.24);                               // his own $0.50 listing excluded
  assert.equal(row('3').market_price, undefined);
  assert.equal(row('3').comp_low, 4.75);
  assert.equal(row('2').error, 'Not a single card');
  assert.equal(db.tables.api_usage[0].purpose, 'title_parse');
  assert.equal(db.tables.api_usage[0].model, 'claude-haiku-5-5');

  // Second run: nothing is due, so no AI call and no searches.
  calls.parse = 0; calls.search = [];
  const again = await refreshMarket({ db, userId: U, deps });
  assert.equal(again.processed, 0);
  assert.equal(calls.parse, 0);
  // A renamed listing is read again.
  db.tables.ebay_listings[0].title = 'Fuecoco 035/193 Paldea Evolved Reverse Holo NM';
  deps.parseTitles = async ({ titles }) => { calls.parse += 1; assert.equal(titles.length, 1); return { usage: { input_tokens: 500, output_tokens: 200 }, reads: new Map([[0, parsed()]]) }; };
  assert.equal((await refreshMarket({ db, userId: U, deps })).processed, 1);
  assert.equal(calls.parse, 1);
});

test('refresh: over the AI budget, titles are not read and the reason is recorded', async () => {
  const db = marketDb({ settings: [{ user_id: U, data: { aiMonthlyBudget: 1 } }], api_usage: [{ user_id: U, cost_usd: 2, created_at: new Date().toISOString() }] });
  let called = false;
  const r = await refreshMarket({ db, userId: U, deps: { parseTitles: async () => { called = true; } , browseSearch: async () => ({ items: [] }) } });
  assert.equal(called, false);
  assert.match(r.note, /budget reached/);
  assert.match(db.tables.listing_market[0].error, /budget reached/);
});

test('refresh stops at its time limit and reports what is left', async () => {
  const db = marketDb();
  const deps = {
    parseTitles: async ({ titles }) => ({ usage: {}, reads: new Map(titles.map((t) => [t.i, parsed()])) }),
    lookupCard: async () => null,
    browseSearch: async () => { await new Promise((r) => setTimeout(r, 30)); return { items: [] }; },
  };
  const r = await refreshMarket({ db, userId: U, deps, deadlineMs: 40 });
  assert.ok(r.processed >= 1 && r.processed < 3);
  assert.equal(r.remaining, 3 - r.processed);
});

test('nightly job: only a fresh, correctly signed call is accepted', () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';
  const { ts, sig } = signCron(1_000_000);
  assert.equal(verifyCron(ts, sig, 1_000_000 + 60_000), true);
  assert.equal(verifyCron(ts, sig, 1_000_000 + 11 * 60_000), false);     // too old
  assert.equal(verifyCron(ts, sig.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), 1_000_000), false);
  assert.equal(verifyCron(String(1_000_001), sig, 1_000_000), false);
  assert.equal(verifyCron(null, null), false);
});

test('Repricer rules: match market, undercut eBay low (accounting for buyer shipping)', () => {
  const l = { price: 3, market: { price: 4.74 }, comp: { low: 2.24 } };
  assert.equal(applyRule(l, 'matchMarket', '10', {}), 5.21);
  assert.equal(applyRule(l, 'undercut', '0.05', { buyerShipping: 0 }), 2.19);
  assert.equal(applyRule(l, 'undercut', '0.05', { buyerShipping: 1.25 }), 0.94);
  assert.equal(applyRule({ price: 3 }, 'matchMarket', '0', {}), null);
  assert.equal(applyRule({ price: 3, comp: { low: null } }, 'undercut', '0', {}), null);
});

test('title reading: one Haiku call, schema-checked, low effort', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      seen.push(JSON.parse(b));
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_t' });
      res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ items: [{ i: 0, ...parsed() }, { i: 7, ...parsed() }] }) }], usage: { input_tokens: 900, output_tokens: 300 } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const anthropic = new Anthropic({ apiKey: 'k', baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });
    const r = await parseTitles({ titles: [{ i: 0, title: 'Reverse Holo Fuecoco 035/193' }], anthropic });
    assert.equal(seen[0].model, 'claude-haiku-5-5');
    assert.equal(seen[0].output_config.effort, 'low');
    assert.equal(seen[0].output_config.format.type, 'json_schema');
    assert.match(seen[0].messages[0].content, /0\. Reverse Holo Fuecoco 035\/193/);
    assert.equal(r.reads.size, 1);           // the answer for a title that wasn't asked about is ignored
    assert.equal(r.reads.get(0).card_name, 'Fuecoco');
    assert.equal(r.requestId, 'req_t');
  } finally { server.close(); }
});
