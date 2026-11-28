// Snap-to-List phase 1: pricing, titles, review flags, catalog matching, the Claude request,
// the fee log and budget guard, and model-trial scoring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { suggestPrice, buildTitle, buildDescription, applyIdentification, scoreTrial, summarizeTrial, titleNumber } from '../netlify/lib/snap-logic.js';
import { splitNumber, pokemonPrice, mtgPrice, lookupPokemon, lookupMtg } from '../netlify/lib/card-catalog.js';
import { costOf, checkBudget, usageRow } from '../netlify/lib/ai-usage.js';
import { readCard, buildRequest } from '../netlify/lib/card-vision.js';
import { identifySnapItem, pickTrialListings, fullSizePhoto, runTrialCase, findDuplicate } from '../netlify/lib/snap-identify.js';
import { fakeDb } from './fake-db.js';

const U = 'u1';
const read = (over = {}) => ({
  is_trading_card: true, game: 'pokemon', card_name: 'Fuecoco', collector_number: '035/193', set_name: null, set_code: null,
  language: 'English', finish: 'reverse_holo', variant: null, rarity: null, game_name: null, art_description: null, flavor_text: null, condition_notes: null, grader: null, grade: null, graded: false, condition_guess: 'unknown',
  possible_misprint: false, misprint_notes: null, confidence: 0.95, notes: null, card_corners: null, printed_name: null, ...over,
});
const catalog = (over = {}) => ({ source: 'tcgdex', id: 'sv02-035', name: 'Fuecoco', setName: 'Paldea Evolved', number: '035/193', imageUrl: 'x', url: 'y', marketPrice: 0.27, priceKey: 'reverse-holofoil', matchLevel: 'exact', ...over });

test('pricing: floor for bulk, rounds up to the chosen ending, markup applies', () => {
  assert.equal(suggestPrice(0.27), 0.99);
  assert.equal(suggestPrice(4.74), 4.89);
  assert.equal(suggestPrice(4.95), 5.89);                 // past .89 rolls to the next dollar
  assert.equal(suggestPrice(2.0, { snapEnding: '0.98' }), 2.98);
  assert.equal(suggestPrice(10, { snapMarkupPct: 10, snapEnding: 'cents' }), 11);
  assert.equal(suggestPrice(0.5, { snapMinPrice: 1.15 }), 1.15);
  assert.equal(suggestPrice(null), null);
});

test('titles: Name Number | Game Set | Key Attribute, pipes only, 70-80 characters of true facts', () => {
  const t = (over) => buildTitle({ condition: 'NM', ...over });
  assert.equal(t({ game: 'pokemon', card_name: 'Noctowl', variant: 'Poke Ball Pattern', catalog_number: '078/131', catalog_set: 'Prismatic Evolutions', finish: 'holo' }),
    'Noctowl 078/131 | Pokemon Prismatic Evolutions | Holo Poke Ball Pattern');                   // stamp is the key attribute, last
  // Played copies: no condition grade in the title.
  const shivan = t({ game: 'mtg', card_name: 'Shivan Dragon', catalog_number: '22', catalog_set: 'Welcome Deck 2017', rarity: 'rare', finish: 'normal', condition: 'LP' });
  assert.equal(shivan, 'Shivan Dragon #22 | Magic The Gathering Welcome Deck 2017 | English Rare');
  assert.doesNotMatch(shivan, /\bLP\b/);
  // Errors: the exact phrase, never a severity, every confirmed error named.
  const lunala = t({ game: 'pokemon', card_name: 'Lunala GX', catalog_number: '141/149', catalog_set: 'Sun & Moon', finish: 'holo', misprint_confirmed: true, misprint_notes: 'minimal texture shift on the art and a crimp at the top' });
  assert.match(lunala, /^Lunala GX 141\/149 \| /);
  assert.match(lunala, /Crimp Error Texture Shift Misprint$|Texture Shift Misprint/);
  assert.match(lunala, /Crimp Error/);
  assert.doesNotMatch(lunala, /minimal|moderate/i);
  // Graded: grader + grade in the title.
  assert.match(t({ game: 'pokemon', card_name: 'Charizard', catalog_number: '4/102', catalog_set: 'Base Set', finish: 'holo', graded: true, extraction: { graded: true, grader: 'psa', grade: '8' } }), /\| [^|]*PSA 8$/);
  // Never an em dash, always within 80, and 70+ whenever there are enough true facts.
  for (const x of [
    { game: 'yugioh', card_name: 'Ash Blossom & Joyous Spring', catalog_number: 'RA01-EN008', catalog_set: '25th Anniversary Rarity Collection', rarity: 'Ultra Rare', variant: '1st Edition' },
    { game: 'one_piece', card_name: 'Monkey.D.Luffy', variant: 'Alternate Art', catalog_number: 'OP05-119', catalog_set: 'Awakening of the New Era', rarity: 'SEC' },
    { game: 'pokemon', card_name: 'Fuecoco', catalog_number: '035/193', catalog_set: 'Paldea Evolved', rarity: 'Common', finish: 'reverse_holo' },
    { game: 'pokemon', card_name: 'X'.repeat(70), catalog_number: '1/2', catalog_set: 'A Very Long Set Name', finish: 'holo' },
  ]) {
    const title = t(x);
    assert.ok(title.length <= 80, title);
    assert.doesNotMatch(title, /[—–]/);
    if (!x.card_name.startsWith('XXX')) assert.ok(title.length >= 70, `${title} (${title.length})`);
  }
  assert.equal(t({ game: 'yugioh', card_name: 'Ash Blossom & Joyous Spring', catalog_number: 'RA01-EN008', catalog_set: '25th Anniversary Rarity Collection', rarity: 'Ultra Rare', variant: '1st Edition' }),
    'Ash Blossom & Joyous Spring RA01-EN008 | Yu-Gi-Oh! | Ultra Rare 1st Edition');            // the set code already names the set
});

test('descriptions: prose about the card, condition in plain words, no price, shipping or boilerplate', () => {
  const d = buildDescription({ game: 'yugioh', card_name: "Queen's Knight", catalog_number: 'EEN-EN004', catalog_set: 'Elemental Energy', rarity: 'Rare', finish: 'foil', condition: 'LP',
    misprint_confirmed: true, misprint_notes: 'moderate texture shift across the artwork',
    extraction: { art_description: 'A knight in red and gold armor raises a sword and shield against a burst of white light.', flavor_text: null, condition_notes: 'scratching on the back' } });
  assert.equal(d, "This is Queen's Knight (EEN-EN004) from the Yu-Gi-Oh! Elemental Energy set, a Rare printing. A knight in red and gold armor raises a sword and shield against a burst of white light. "
    + 'This copy shows a Texture Shift Misprint, texture shift across the artwork. Lightly played copy, scratching on the back. Please look closely at the photos to judge the condition for yourself.');
  const sentences = d.split(/(?<=[.!?])\s+/).length;
  assert.ok(sentences >= 4 && sentences <= 6, sentences);
  assert.doesNotMatch(d, /moderate|\$|price|ship|front, back|<li>|:\s*\n/i);
  const slab = buildDescription({ game: 'pokemon', card_name: 'Charizard', catalog_number: '4/102', catalog_set: 'Base Set', finish: 'holo', condition: 'NM', graded: true,
    extraction: { graded: true, grader: 'PSA', grade: '8', flavor_text: 'Spits fire that is hot enough to melt boulders.' } });
  assert.match(slab, /from the Pokemon Base Set, a holo printing\. The flavor text reads: "Spits fire that is hot enough to melt boulders\." Graded PSA 8/);
  assert.doesNotMatch(slab, /Base Set set/);
});

test('identification: clean match is ready; problems go to review with reasons', () => {
  const ok = applyIdentification({ read: read(), catalog: catalog() });
  assert.equal(ok.status, 'ready');
  assert.equal(ok.price, 0.99);
  assert.equal(ok.title, buildTitle(ok));
  assert.match(ok.title, /^Fuecoco 035\/193 \| Pokemon/);
  assert.match(ok.description, /^This is Fuecoco \(035\/193\)/);

  const r = applyIdentification({ read: read({ confidence: 0.5, possible_misprint: true, language: 'Japanese' }), catalog: null, duplicateItemId: '111' });
  assert.equal(r.status, 'needs_review');
  assert.deepEqual(r.review_reasons.sort(), ['already_listed', 'low_confidence', 'no_price', 'non_english', 'not_in_catalog', 'possible_misprint'].sort());
  assert.equal(r.misprint_confirmed, undefined); // only the seller confirms a misprint

  // Name-only match: the catalog may have picked another printing, so no price is pre-filled.
  const nameOnly = applyIdentification({ read: read({ game: 'mtg', card_name: 'Shivan Dragon', collector_number: null }), catalog: catalog({ source: 'scryfall', name: 'Shivan Dragon', marketPrice: 23.1, matchLevel: 'name' }) });
  assert.equal(nameOnly.price, null);
  assert.equal(nameOnly.suggested_price, 23.89);
  assert.ok(nameOnly.review_reasons.includes('name_only_match'));
});

test('catalog helpers: numbers and prices', () => {
  assert.deepEqual(splitNumber('035/193'), { local: '35', localRaw: '035', total: '193' });
  assert.equal(splitNumber('TG05/TG30').local, 'tg5');
  const card = { pricing: { tcgplayer: { normal: { marketPrice: 0.21 }, 'reverse-holofoil': { marketPrice: 0.27 } } } };
  assert.equal(pokemonPrice(card, 'reverse_holo').price, 0.27);
  assert.equal(pokemonPrice(card, 'holo').price, 0.21); // no holo print: falls back
  assert.equal(mtgPrice({ prices: { usd: '0.16', usd_foil: '1.20' } }, 'foil').price, 1.2);
});

test('Pokémon lookup picks the print whose set total matches the printed number', async () => {
  const fake = async (url) => {
    const u = String(url);
    const body = u.includes('/cards?name=')
      ? [{ id: 'sv04-035', localId: '035', name: 'Fuecoco' }, { id: 'sv02-035', localId: '035', name: 'Fuecoco' }, { id: 'sv02-034', localId: '034', name: 'Fuecoco' }]
      : u.endsWith('sv02-035') ? { id: 'sv02-035', localId: '035', name: 'Fuecoco', set: { name: 'Paldea Evolved', cardCount: { official: 193 } }, pricing: { tcgplayer: { 'reverse-holofoil': { marketPrice: 0.27, productId: 9 } } } }
        : { id: 'sv04-035', localId: '035', name: 'Fuecoco', set: { name: 'Paradox Rift', cardCount: { official: 182 } }, pricing: {} };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const c = await lookupPokemon(read(), fake);
  assert.equal(c.id, 'sv02-035');
  assert.equal(c.matchLevel, 'exact');
  assert.equal(c.marketPrice, 0.27);
  assert.equal(c.url, 'https://www.tcgplayer.com/product/9');
});

test('Magic lookup uses set code + number directly, and falls back to name search', async () => {
  const card = { id: 'a', name: 'Shivan Dragon', set: 'w17', set_name: 'Welcome Deck 2017', collector_number: '22', prices: { usd: '0.16' } };
  const direct = await lookupMtg(read({ game: 'mtg', card_name: 'Shivan Dragon', collector_number: '22', set_code: 'W17', finish: 'normal' }),
    async (u) => new Response(JSON.stringify(String(u).includes('/cards/w17/22') ? card : { data: [] })));
  assert.equal(direct.matchLevel, 'exact');
  assert.equal(direct.marketPrice, 0.16);
  const missing = await lookupMtg(read({ game: 'mtg', card_name: 'Nope', collector_number: null }), async () => new Response('{}', { status: 404 }));
  assert.equal(missing, null);
});

test('fee tracker: cost from published per-token prices; budget blocks new calls', async () => {
  assert.equal(costOf('claude-opus-5-5', { input_tokens: 2500, output_tokens: 600 }), 0.022);
  assert.equal(costOf('claude-haiku-5-5', { input_tokens: 2500, output_tokens: 600 }), 0.00055);
  assert.equal(costOf('some-other-model', { input_tokens: 1 }), null);
  const now = new Date('2026-11-23T12:00:00Z');
  const db = fakeDb({ api_usage: [
    { user_id: U, cost_usd: 20, created_at: '2026-11-02T00:00:00Z' },
    { user_id: U, cost_usd: 6, created_at: '2026-11-20T00:00:00Z' },
    { user_id: U, cost_usd: 99, created_at: '2026-10-30T00:00:00Z' }, // last month doesn't count
  ] });
  const b = await checkBudget(db, U, { aiMonthlyBudget: 25 }, now);
  assert.deepEqual(b, { spent: 26, budget: 25, ok: false });
  assert.equal((await checkBudget(db, U, { aiMonthlyBudget: 0 }, now)).ok, true); // 0 = no limit
  assert.equal(usageRow({ userId: U, model: 'claude-haiku-5-5', purpose: 'snap_identify', usage: { input_tokens: 1000, output_tokens: 100 } }).cost_usd, 0.00015);
});

// A stand-in for api.anthropic.com: records what the SDK sends and answers like the real API.
async function withFakeAnthropic(answer, fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json', 'request-id': 'req_test123' });
      res.end(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: seen.at(-1).body.model, stop_reason: answer.stop_reason || 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify(answer.read) }],
        usage: { input_tokens: 2400, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const client = new Anthropic({ apiKey: 'test-key', baseURL: `http://127.0.0.1:${server.address().port}`, maxRetries: 0 });
  try { return await fn(client, seen); } finally { server.close(); }
}

test('Claude request: photo + schema + low effort, Opus gets the refusal fallback; answer is parsed and costed', async () => {
  const image = { base64: Buffer.from('jpegbytes').toString('base64'), mediaType: 'image/jpeg' };
  await withFakeAnthropic({ read: read() }, async (client, seen) => {
    const r = await readCard({ model: 'claude-opus-5-5', image, anthropic: client });
    assert.equal(r.read.card_name, 'Fuecoco');
    assert.equal(r.requestId, 'req_test123');
    assert.equal(r.usage.input_tokens, 2400);
    const sent = seen[0];
    assert.equal(sent.body.model, 'claude-opus-5-5');
    assert.equal(sent.body.output_config.effort, 'low');
    assert.equal(sent.body.output_config.format.type, 'json_schema');
    assert.ok(sent.body.output_config.format.schema.properties.collector_number);
    assert.equal(sent.body.fallbacks, 'default');
    assert.match(sent.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(sent.body.messages[0].content[0].source.media_type, 'image/jpeg');
    assert.equal(sent.headers.authorization, 'Bearer test-key'); // SDK 1.x sends the key as a bearer token

    await readCard({ model: 'claude-haiku-5-5', image, anthropic: client });
    assert.equal(seen[1].body.fallbacks, undefined); // no server-side fallback for Haiku
  });
  await withFakeAnthropic({ read: read(), stop_reason: 'refusal' }, async (client) => {
    await assert.rejects(readCard({ model: 'claude-haiku-5-5', image, anthropic: client }), (e) => e.usage?.input_tokens === 2400);
  });
  assert.deepEqual(buildRequest('claude-haiku-5-5', image).betas, ['structured-outputs-2025-12-15']);
});

test('identifying a snapped card: reads, matches, prices, flags duplicates, logs the fee', async () => {
  const db = fakeDb({
    settings: [{ user_id: U, data: { snapModel: 'claude-haiku-5-5' } }],
    api_usage: [],
    snap_items: [{ id: 's1', user_id: U, status: 'uploaded', photo_path: `${U}/b/1.jpg` }],
    ebay_listings: [{ user_id: U, status: 'Active', item_id: '999', title: 'Reverse Holo Fuecoco 035/193 Common Paldea Evolved Pokemon TCG' }],
  }, null, { files: { [`${U}/b/1.jpg`]: 'jpegbytes' } });
  let gotImage = null;
  const deps = {
    readCard: async ({ model, image }) => { gotImage = image; return { read: read(), usage: { input_tokens: 2000, output_tokens: 400 }, latencyMs: 1200, requestId: 'req_1', model }; },
    lookupCard: async () => catalog(),
  };
  const out = await identifySnapItem({ db, userId: U, item: db.tables.snap_items[0], deps });
  assert.equal(gotImage.base64, Buffer.from('jpegbytes').toString('base64'));
  const row = db.tables.snap_items[0];
  assert.equal(row.status, 'needs_review');           // already listed
  assert.deepEqual(row.review_reasons, ['already_listed']);
  assert.equal(row.duplicate_item_id, '999');
  assert.equal(row.model, 'claude-haiku-5-5');
  assert.equal(row.price, 0.99);
  const fee = db.tables.api_usage[0];
  assert.equal(fee.purpose, 'snap_identify');
  assert.equal(fee.snap_item_id, 's1');
  assert.equal(fee.cost_usd, 0.0004);
  assert.equal(out.cost, 0.0004);
});

test('a failed read marks the card failed and still logs what the call cost', async () => {
  const db = fakeDb({ settings: [], api_usage: [], snap_items: [{ id: 's2', user_id: U, status: 'uploaded', photo_path: 'p' }] }, null, { files: { p: 'x' } });
  const deps = { readCard: async () => { throw Object.assign(new Error('Claude declined to read this photo.'), { usage: { input_tokens: 2000, output_tokens: 10 } }); } };
  await assert.rejects(identifySnapItem({ db, userId: U, item: db.tables.snap_items[0], deps }), /declined/);
  assert.equal(db.tables.snap_items[0].status, 'failed');
  assert.equal(db.tables.api_usage[0].ok, false);
  assert.ok(db.tables.api_usage[0].cost_usd > 0);
});

test('over budget: no Claude call is made', async () => {
  const db = fakeDb({ settings: [{ user_id: U, data: { aiMonthlyBudget: 1 } }], api_usage: [{ user_id: U, cost_usd: 1.5, created_at: new Date().toISOString() }], snap_items: [{ id: 's3', user_id: U, photo_path: 'p' }] }, null, { files: { p: 'x' } });
  let called = false;
  await assert.rejects(identifySnapItem({ db, userId: U, item: db.tables.snap_items[0], deps: { readCard: async () => { called = true; } } }), (e) => e.code === 'BUDGET');
  assert.equal(called, false);
});

test('duplicate check needs the same number when one was read', async () => {
  const db = fakeDb({ ebay_listings: [{ user_id: U, status: 'Active', item_id: '1', title: 'Fuecoco 034/193 Paldea Evolved' }] });
  assert.equal(await findDuplicate(db, U, read()), null);
});

test('trial: sample, full-size photos, scoring against the seller\'s titles, summary', async () => {
  const listings = [
    ...Array.from({ length: 30 }, (_, i) => ({ item_id: `p${String(i).padStart(2, '0')}`, title: `Card${i} ${i + 1}/100 Set Holo`, image_url: 'https://i.ebayimg.com/images/g/a/s-l140.jpg', price: 1 })),
    ...Array.from({ length: 12 }, (_, i) => ({ item_id: `m${i}`, title: `Spell${i} Magic The Gathering TCG NM`, image_url: 'u', price: 1 })),
    { item_id: 'x', title: 'Charizard PSA 10 Base Set', image_url: 'u' },
    { item_id: 'y', title: 'Dr. Seuss Book', image_url: 'u' },
  ];
  const s = pickTrialListings(listings, 30);
  assert.equal(s.length, 30);
  assert.equal(s.filter((l) => l.item_id.startsWith('m')).length, 10);
  assert.ok(!s.some((l) => ['x', 'y'].includes(l.item_id)));
  assert.equal(fullSizePhoto('https://i.ebayimg.com/images/g/8z4A/s-l140.jpg'), 'https://i.ebayimg.com/images/g/8z4A/s-l1600.jpg');

  const title = 'Noctowl (Poke Ball Pattern) 078/131 Sv: Prismatic Evolutions Holo';
  assert.equal(titleNumber(title), '078/131');
  assert.deepEqual(scoreTrial({ title, read: read({ card_name: 'Noctowl', collector_number: '78/131' }), catalog: catalog({ name: 'Noctowl', setName: 'Prismatic Evolutions', number: '078/131' }) }),
    { name_ok: true, number_ok: true, set_ok: true, catalog_ok: true, correct: true });
  assert.equal(scoreTrial({ title, read: read({ card_name: 'Noctowl', collector_number: '079/131' }), catalog: null }).correct, false);
  assert.equal(scoreTrial({ title: 'Shivan Dragon Welcome Deck 2017 Regular Rare Magic The Gathering TCG LP', read: read({ card_name: 'Shivan Dragon', collector_number: '22' }), catalog: null }).number_ok, null);

  const db = fakeDb({ settings: [], api_usage: [], model_trial_results: [] });
  const row = await runTrialCase({ db, userId: U, trialId: 't1', model: 'claude-haiku-5-5', listing: { item_id: '5', title, price: 1.89, image_url: 'https://i.ebayimg.com/images/g/z/s-l140.jpg' }, deps: {
    fetchImage: async (u) => { assert.match(u, /s-l1600/); return { base64: 'eA==', mediaType: 'image/jpeg' }; },
    readCard: async () => ({ read: read({ card_name: 'Noctowl', collector_number: '078/131' }), usage: { input_tokens: 2000, output_tokens: 400 }, latencyMs: 900 }),
    lookupCard: async () => catalog({ name: 'Noctowl', setName: 'Prismatic Evolutions', number: '078/131', marketPrice: 0.13 }),
  } });
  assert.equal(row.correct, true);
  assert.equal(db.tables.model_trial_results.length, 1);
  assert.equal(db.tables.api_usage[0].purpose, 'model_trial');

  const sum = summarizeTrial([
    { model: 'a', correct: true, name_ok: true, number_ok: true, cost_usd: 0.02, latency_ms: 4000 },
    { model: 'a', correct: false, name_ok: true, number_ok: false, cost_usd: 0.02, latency_ms: 6000 },
    { model: 'a', error: 'x', cost_usd: 0 },
  ]);
  assert.equal(sum[0].correct, 0.5);
  assert.equal(sum[0].errors, 1);
  assert.equal(sum[0].totalCost, 0.04);
});
