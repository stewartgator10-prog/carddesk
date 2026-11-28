// Haiku first, Opus for the hard cards; Magic cards filed under "other" are found anyway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.js';
import { readCardRouted, escalationReason, autoRoutes, identifySnapItem, runTrialCase } from '../netlify/lib/snap-identify.js';
import { resolveCatalog } from '../netlify/lib/card-catalog.js';
import { SNAP_DEFAULTS } from '../netlify/lib/snap-logic.js';

const U = 'u1';
const read = (over = {}) => ({ is_trading_card: true, game: 'pokemon', card_name: 'Fuecoco', printed_name: null, collector_number: '035/193', set_code: null, set_name: null,
  language: 'English', finish: 'normal', variant: null, rarity: null, game_name: null, graded: false, confidence: 0.95, card_corners: null, ...over });
const usage = { input_tokens: 5500, output_tokens: 400 };

test('escalation: only the hard cards go to Opus', () => {
  assert.equal(escalationReason(read(), { id: 'x' }), null);
  assert.equal(escalationReason(read({ confidence: 0.6 }), { id: 'x' }), 'low_confidence');
  assert.equal(escalationReason(read({ language: 'Japanese' }), { id: 'x' }), 'not_english');
  assert.equal(escalationReason(read(), null), 'no_catalog_match');
  assert.equal(escalationReason(read({ game: 'other' }), null), 'other_game');
  assert.equal(escalationReason(read({ is_trading_card: false }), null), 'not_a_card');
  assert.equal(autoRoutes(SNAP_DEFAULTS), true);
  assert.equal(autoRoutes({ ...SNAP_DEFAULTS, snapAutoRoute: false }), false);
  assert.equal(autoRoutes({ ...SNAP_DEFAULTS, snapModel: 'claude-haiku-5-5' }), false, 'Haiku chosen outright: nothing to route to');
});

test('routing: an easy card is read once by Haiku; a hard one is read again by Opus and both calls are logged', async () => {
  const db = fakeDb({ api_usage: [] });
  const calls = [];
  const deps = (haikuRead, opusRead) => ({
    readCard: async ({ model }) => { calls.push(model); return { read: model === 'claude-haiku-5-5' ? haikuRead : opusRead, usage, latencyMs: 1000 }; },
    lookupCard: async (r) => (r.game === 'pokemon' && r.language === 'English' ? { id: 'sv02-035', name: 'Fuecoco' } : null),
  });
  const easy = await readCardRouted({ db, userId: U, settings: SNAP_DEFAULTS, image: {}, purpose: 'snap_identify', deps: deps(read(), read()) });
  assert.deepEqual([easy.model, easy.route, calls], ['claude-haiku-5-5', null, ['claude-haiku-5-5']]);
  assert.ok(easy.cost < 0.005, String(easy.cost));

  calls.length = 0;
  const jp = await readCardRouted({ db, userId: U, settings: SNAP_DEFAULTS, image: {}, purpose: 'snap_identify',
    deps: deps(read({ language: 'Japanese', card_name: 'エレキブルex' }), read({ language: 'Japanese', card_name: 'Electivire ex', printed_name: 'エレキブルex' })) });
  assert.deepEqual(calls, ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.equal(jp.model, 'claude-opus-5-5');
  assert.equal(jp.read.card_name, 'Electivire ex');
  assert.deepEqual(jp.route, { first: 'claude-haiku-5-5', escalated: 'not_english' });
  assert.equal(db.tables.api_usage.length, 3, 'every call logged');
  assert.equal(jp.usage.input_tokens, 11000);

  // Opus failing never loses the card: the Haiku read is kept.
  const kept = await readCardRouted({ db, userId: U, settings: SNAP_DEFAULTS, image: {}, purpose: 'snap_identify',
    deps: { readCard: async ({ model }) => { if (model === 'claude-opus-5-5') throw new Error('overloaded'); return { read: read({ confidence: 0.5 }), usage }; }, lookupCard: async () => ({ id: 'x' }) } });
  assert.equal(kept.model, 'claude-haiku-5-5'); assert.equal(kept.route.failed, 'overloaded');

  // Routing off: the chosen model alone.
  calls.length = 0;
  await readCardRouted({ db, userId: U, settings: { ...SNAP_DEFAULTS, snapAutoRoute: false }, image: {}, purpose: 'x', deps: deps(read(), read()) });
  assert.deepEqual(calls, ['claude-opus-5-5']);
});

test('Magic cards filed under "other": the printed set code and number find them, only when the name matches', async () => {
  const card = { id: 'c1', name: 'Airship Crash', set: 'fin', set_name: 'Final Fantasy', collector_number: '171', rarity: 'common', prices: { usd: '0.10' }, image_uris: { normal: 'x' }, scryfall_uri: 'y', finishes: ['nonfoil'] };
  const seen = [];
  const fetchImpl = async (url) => { seen.push(String(url)); return String(url).includes('/cards/fin/171') ? new Response(JSON.stringify(card), { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('{}', { status: 404 }); };
  const r = await resolveCatalog(read({ game: 'other', game_name: 'Magic', card_name: 'Airship Crash', set_code: 'FIN', collector_number: '0171', finish: 'normal' }), { fetchImpl });
  assert.equal(r.read.game, 'mtg'); assert.equal(r.catalog.name, 'Airship Crash'); assert.equal(r.read.game_name, null);
  assert.ok(seen.some((u) => u.includes('/cards/fin/171')));
  const wrong = await resolveCatalog(read({ game: 'other', card_name: 'Something Else', set_code: 'FIN', collector_number: '0171' }), { fetchImpl });
  assert.equal(wrong.read.game, 'other'); assert.equal(wrong.catalog, null);
  const noCode = await resolveCatalog(read({ game: 'other', card_name: 'Airship Crash', set_code: null }), { fetchImpl: async () => { throw new Error('should not be called'); } });
  assert.equal(noCode.catalog, null);
});

test('snaps record the routing; the trial has an "auto" arm', async () => {
  const db = fakeDb({ settings: [], api_usage: [], ebay_listings: [], snap_items: [{ id: 's1', user_id: U, photo_path: 'u1/b/s1.jpg', status: 'uploaded' }] }, {}, { files: { 'u1/b/s1.jpg': Buffer.from('x') } });
  const deps = { readCard: async ({ model }) => ({ read: model === 'claude-haiku-5-5' ? read({ confidence: 0.5 }) : read(), usage }), lookupCard: async () => ({ source: 'tcgdex', id: 'x', name: 'Fuecoco', number: '035/193', marketPrice: 0.3 }), autoCropOnSnap: async () => null };
  const out = await identifySnapItem({ db, userId: U, item: db.tables.snap_items[0], deps });
  assert.equal(out.item.model, 'claude-opus-5-5');
  assert.deepEqual(out.item.extraction.route, { first: 'claude-haiku-5-5', escalated: 'low_confidence' });

  const row = await runTrialCase({ db, userId: U, trialId: 't1', model: 'auto', listing: { item_id: '9', title: 'Fuecoco 035/193 Paldea Evolved', image_url: 'https://i.ebayimg.com/x/s-l140.jpg' },
    deps: { ...deps, fetchImage: async () => ({ base64: '', mediaType: 'image/jpeg' }), readCard: async () => ({ read: read(), usage }) } });
  assert.equal(row.model, 'auto'); assert.equal(row.correct, true);
  assert.ok(row.cost_usd < 0.005, 'easy card: Haiku only');
});
