import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nameMatches, detectCondition, compsForListing, compStats, floorPrice, netAfterFees,
  applyRule, checkPrice, roundPrice, costForListing,
} from '../src/pricing/pricingLogic.js';
import { buildReviseXml, parseReviseResponse, chunk, revisePrices } from '../netlify/lib/trading-price.js';
import { validateChanges } from '../netlify/functions/seller-reprice.js';

const settings = { ebayFeePct: 13.25, ebayFeeFlat: 0.30, minProfitDollars: 5, defaultShipping: 1 };
const now = new Date('2026-11-22');

test('name matching ignores filler words and accents', () => {
  assert.ok(nameMatches('Charizard VMAX 020/189 Darkness Ablaze Pokémon NM', 'Charizard VMAX'));
  assert.ok(!nameMatches('Charizard V 019/189 Darkness Ablaze', 'Charizard VMAX'));
  assert.ok(nameMatches('Ragavan, Nimble Pilferer MH2', 'ragavan nimble pilferer'));
});

test('set only enforced when listing mentions it', () => {
  assert.ok(nameMatches('Charizard VMAX Darkness Ablaze', 'Charizard VMAX', 'Darkness Ablaze'));
  assert.ok(nameMatches('Charizard VMAX 020/189', 'Charizard VMAX', 'Darkness Ablaze'));
});

test('condition detection prefers grades', () => {
  assert.equal(detectCondition('Umbreon VMAX PSA 10 Evolving Skies'), 'PSA 10');
  assert.equal(detectCondition('Card BGS 9.5'), 'BGS 9.5');
  assert.equal(detectCondition('Pikachu lightly played'), 'LP');
  assert.equal(detectCondition('Pikachu', 'NM'), 'NM');
});

const comps = [
  { cardName: 'Charizard VMAX', set: 'Darkness Ablaze', condition: 'NM', salePrice: '40', date: '2026-11-01' },
  { cardName: 'Charizard VMAX', set: 'Darkness Ablaze', condition: 'NM', salePrice: '44', date: '2026-11-10' },
  { cardName: 'Charizard VMAX', set: 'Darkness Ablaze', condition: 'NM', salePrice: '48', date: '2026-11-15' },
  { cardName: 'Charizard VMAX', set: 'Darkness Ablaze', condition: 'PSA 10', salePrice: '300', date: '2026-11-15' },
  { cardName: 'Charizard VMAX', set: '', condition: 'NM', salePrice: '10', date: '2025-01-01' }, // too old
];

test('comps filter by grade bucket and age', () => {
  const raw = compStats(compsForListing({ title: 'Charizard VMAX 020/189 Darkness Ablaze NM' }, comps, { now }));
  assert.equal(raw.count, 3); assert.equal(raw.median, 44); assert.equal(raw.latest.salePrice, '48');
  const graded = compStats(compsForListing({ title: 'Charizard VMAX PSA 10 Darkness Ablaze', condition: 'PSA 10' }, comps, { now }));
  assert.equal(graded.count, 1); assert.equal(graded.median, 300);
});

test('manual comp key overrides title', () => {
  const m = compsForListing({ title: 'Zard vmx DA', compKey: 'Charizard VMAX' }, comps, { now });
  assert.equal(m.length, 3);
});

test('floor price clears cost + profit after fees', () => {
  const f = floorPrice(20, settings, 1);
  const net = netAfterFees(f, settings, 1);
  assert.ok(net >= 25 - 0.01, `net ${net}`);
  assert.ok(netAfterFees(f - 0.05, settings, 1) < 25);
  assert.equal(floorPrice(null, settings), null);
});

test('rounding', () => {
  assert.equal(roundPrice(44.123), 44.12);
  assert.equal(roundPrice(44.2, 'charm'), 43.99);
  assert.equal(roundPrice(44.7, 'charm'), 44.99);
  assert.equal(roundPrice(0.4, 'charm'), 0.99);
});

test('bulk rules', () => {
  const l = { price: 50 };
  assert.equal(applyRule(l, 'percent', '-10', {}), 45);
  assert.equal(applyRule(l, 'dollars', '2.5', {}), 52.5);
  assert.equal(applyRule(l, 'setTo', '9.99', {}), 9.99);
  assert.equal(applyRule(l, 'matchComps', '5', { stats: { median: 40 } }), 42);
  assert.equal(applyRule(l, 'matchComps', '0', { stats: null }), null);
  assert.equal(applyRule(l, 'percent', '', {}), null);
});

test('guardrails: floor, minimum, big swings', () => {
  const l = { price: 50 };
  assert.equal(checkPrice(l, 10, { floor: 30, enforceFloor: true }).price, 30);
  assert.ok(checkPrice(l, 10, { floor: 30, enforceFloor: false }).warnings.some(w => w.includes('floor')));
  assert.equal(checkPrice(l, 0.5, {}).price, 0.99);
  assert.ok(checkPrice(l, 5, {}).warnings.some(w => w.includes('-90%')));
  assert.ok(checkPrice(l, NaN, {}).blocked);
});

test('cost from inventory, ignoring sold items', () => {
  const inv = [
    { cardName: 'Charizard VMAX', costBasis: '15', status: 'Sold' },
    { cardName: 'Charizard VMAX', costBasis: '22', status: 'In Stock' },
  ];
  assert.equal(costForListing({ title: 'Charizard VMAX Darkness Ablaze' }, inv), 22);
  assert.equal(costForListing({ title: 'x', costBasis: 7 }, inv), 7);
});

test('trading XML is escaped and chunked by 4', () => {
  const xml = buildReviseXml([{ itemId: '123', sku: 'A&B', newPrice: 9.5 }]);
  assert.match(xml, /<ItemID>123<\/ItemID><SKU>A&amp;B<\/SKU><StartPrice>9.50<\/StartPrice>/);
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6, 7, 8, 9]).map(c => c.length), [4, 4, 1]);
});

test('parse partial failure', () => {
  const xml = `<ReviseInventoryStatusResponse><Ack>PartialFailure</Ack>
    <Errors><ShortMessage>Bad</ShortMessage><LongMessage>Item 2 has ended.</LongMessage><SeverityCode>Error</SeverityCode></Errors>
    <InventoryStatus><ItemID>1</ItemID><StartPrice>10.0</StartPrice></InventoryStatus></ReviseInventoryStatusResponse>`;
  const r = parseReviseResponse(xml, [{ itemId: '1', newPrice: 10 }, { itemId: '2', newPrice: 20 }]);
  assert.deepEqual(r.map(x => x.ok), [true, false]);
  assert.equal(r[1].error, 'Item 2 has ended.');
});

test('revisePrices batches calls and isolates a failed batch', async () => {
  const calls = [];
  const fake = async (_t, _n, body) => {
    calls.push(body);
    if (calls.length === 2) throw new Error('boom');
    const ids = [...body.matchAll(/<ItemID>(.*?)<\/ItemID>/g)].map(m => m[1]);
    return `<R><Ack>Success</Ack>${ids.map(i => `<InventoryStatus><ItemID>${i}</ItemID><StartPrice>1</StartPrice></InventoryStatus>`).join('')}</R>`;
  };
  const changes = Array.from({ length: 6 }, (_, i) => ({ itemId: String(i), newPrice: 5 }));
  const res = await revisePrices('tok', changes, fake);
  assert.equal(calls.length, 2);
  assert.deepEqual(res.map(r => r.ok), [true, true, true, true, false, false]);
});

test('server validation', () => {
  assert.equal(validateChanges([{ itemId: '1', newPrice: 5 }]), null);
  assert.match(validateChanges([]), /No changes/);
  assert.match(validateChanges([{ itemId: '1', newPrice: 0.5 }]), /between/);
  assert.match(validateChanges([{ itemId: '1', newPrice: 5 }, { itemId: '1', newPrice: 6 }]), /Duplicate/);
});

test('cost prefers inventory linked by eBay item id', () => {
  const inv = [
    { cardName: 'Charizard VMAX', costBasis: '22', status: 'In Stock' },
    { cardName: 'Something else', costBasis: '30', status: 'In Stock', ebayItemId: '555' },
  ];
  assert.equal(costForListing({ itemId: '555', title: 'Charizard VMAX' }, inv), 30);
});
