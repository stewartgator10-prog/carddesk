// Cost capture: purchase splits, listing import, typed/estimated costs, past-sale costs, and P&L.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  splitCost, estimateCost, importListings, setCosts, estimateMissing, savePurchase, deletePurchase, setSaleCost, estimateSales,
} from '../netlify/lib/costs.js';
import { matchLinesToInventory } from '../netlify/lib/pnl.js';
import { fakeDb } from './fake-db.js';

const U = 'u1';
const sum = (m) => Math.round([...m.values()].reduce((a, b) => a + b, 0) * 100) / 100;

test('split by market value adds up to the exact total, to the cent', () => {
  const m = splitCost(20, [{ id: 'a', weight: 40 }, { id: 'b', weight: 0.25 }, { id: 'c', weight: 9.75 }]);
  assert.equal(sum(m), 20);
  assert.equal(m.get('a'), 16);       // 40/50 of $20
  assert.equal(m.get('b'), 0.1);
  assert.equal(m.get('c'), 3.9);
  const even = splitCost(10, [{ id: 'a' }, { id: 'b' }, { id: 'c' }], 'even');
  assert.deepEqual([...even.values()], [3.34, 3.33, 3.33]);   // leftover cent goes to one card, total stays $10.00
  assert.equal(sum(splitCost(7.77, Array.from({ length: 13 }, (_, i) => ({ id: i, weight: i + 1 })))), 7.77);
  const unknown = splitCost(9, [{ id: 'a', weight: 4 }, { id: 'b', weight: null }, { id: 'c', weight: 2 }]);
  assert.equal(unknown.get('b'), 3);  // unknown value counts as the average (3)
  assert.equal(sum(splitCost(0, [{ id: 'a', weight: 1 }])), 0);
  assert.equal(estimateCost(4.89, 25), 1.22);
  assert.equal(estimateCost(null, 25), null);
});

const listings = [
  { user_id: U, status: 'Active', item_id: '100', title: 'Fuecoco 035/193 Paldea Evolved Reverse Holo', price: 1.89, quantity_available: 1 },
  { user_id: U, status: 'Active', item_id: '200', title: 'Briar 100/131 Prismatic Evolutions Reverse Holo', price: 1.19, quantity_available: 3 },
  { user_id: U, status: 'Ended', item_id: '300', title: 'Old', price: 5, quantity_available: 0 },
];

test('importing listings makes one inventory card per copy, once', async () => {
  const db = fakeDb({ ebay_listings: listings.map((l) => ({ ...l })), inventory: [] });
  assert.deepEqual(await importListings(db, U), { created: 4, listings: 2 });
  assert.equal(db.tables.inventory.filter((r) => r.ebay_item_id === '200').length, 3);
  assert.equal(db.tables.inventory[0].current_fmv, 1.89);
  assert.equal(db.tables.inventory[0].status, 'In Stock');
  assert.deepEqual(await importListings(db, U), { created: 0, listings: 2 }); // running again adds nothing
});

function stockDb() {
  return fakeDb({
    inventory: [
      { id: 'i1', user_id: U, status: 'In Stock', current_fmv: 40, cost_basis: null },
      { id: 'i2', user_id: U, status: 'In Stock', current_fmv: 10, cost_basis: null },
      { id: 'i3', user_id: U, status: 'In Stock', current_fmv: 2, cost_basis: null },
    ],
    purchases: [], ebay_order_lines: [], ebay_orders: [], ebay_transactions: [], settings: [],
  });
}

test('a purchase splits its total by value; moving a card re-splits both purchases', async () => {
  const db = stockDb();
  const { purchase } = await savePurchase(db, U, { purchase: { total_paid: 25, source: 'eBay: seller1' }, inventoryIds: ['i1', 'i2'] });
  const inv = (id) => db.tables.inventory.find((r) => r.id === id);
  assert.equal(inv('i1').cost_basis, 20);
  assert.equal(inv('i2').cost_basis, 5);
  assert.equal(inv('i1').cost_source, 'purchase');

  await savePurchase(db, U, { purchase: { total_paid: 3 }, inventoryIds: ['i2', 'i3'] }); // i2 moves to a new purchase
  assert.equal(inv('i1').cost_basis, 25);   // first purchase now only i1
  assert.equal(inv('i2').cost_basis + inv('i3').cost_basis, 3);

  await setCosts(db, U, [{ inventoryId: 'i1', cost: 18 }]); // typed by hand: leaves its purchase
  assert.equal(inv('i1').cost_source, 'entered');
  assert.equal(inv('i1').purchase_id, null);

  await deletePurchase(db, U, inv('i3').purchase_id);
  assert.equal(inv('i3').cost_basis, null);
  assert.equal(db.tables.purchases.length, 1);
  assert.ok(db.tables.purchases.find((p) => p.id === purchase.id));
  await assert.rejects(setCosts(db, U, [{ inventoryId: 'i1', cost: -1 }]), /0 or more/);
  await assert.rejects(savePurchase(db, U, { purchase: { total_paid: 5 }, inventoryIds: ['nope'] }), /not found/);
});

test('estimates fill only missing costs and are marked estimated', async () => {
  const db = stockDb();
  db.tables.inventory[0].cost_basis = 12; db.tables.inventory[0].cost_source = 'entered';
  assert.deepEqual(await estimateMissing(db, U, { pct: 25 }), { estimated: 2, skipped: 0 });
  assert.equal(db.tables.inventory[0].cost_basis, 12);
  assert.equal(db.tables.inventory[1].cost_basis, 2.5);
  assert.equal(db.tables.inventory[1].cost_source, 'estimated');
  await assert.rejects(estimateMissing(db, U, { pct: 0 }), /between/);
});

function salesDb() {
  const order = (id, cancel = null) => ({ user_id: U, order_id: id, created_at_ebay: '2026-10-01T12:00:00Z', cancel_state: cancel, marketplace_fee_reported: null });
  const line = (id, order_id, price) => ({ user_id: U, line_item_id: id, order_id, legacy_item_id: `9${id}`, title: `Card ${id}`, quantity: 1, item_price: price, shipping_charged: 0, match_status: 'unmatched' });
  return fakeDb({
    ebay_orders: [order('O1'), order('O2'), order('O3', 'CANCELED')],
    ebay_order_lines: [line('A', 'O1', 10), line('B', 'O2', 4), line('C', 'O3', 8)],
    ebay_transactions: [{ user_id: U, transaction_id: 'T', transaction_type: 'SALE', order_id: 'O1', line_fees: [{ line_item_id: 'A', fees: [{ type: 'FVF', amount: 1.5 }] }] }],
    inventory: [], purchases: [], settings: [],
  });
}

test('a past sale\'s cost becomes a sold inventory card linked to the sale, and profit appears', async () => {
  const db = salesDb();
  await setSaleCost(db, U, { lineItemId: 'A', cost: 3 });
  const inv = db.tables.inventory[0];
  assert.equal(inv.status, 'Sold');
  assert.equal(inv.ebay_order_line_id, 'A');
  assert.equal(inv.sale_price, 10);
  assert.equal(inv.sold_at, '2026-10-01');
  const a = db.tables.ebay_order_lines.find((l) => l.line_item_id === 'A');
  assert.equal(a.match_status, 'confirmed');
  assert.equal(a.cost_basis, 3);
  assert.equal(a.profit, 5.5);              // 10 - 1.50 fee - 3 cost
  assert.equal(a.cost_estimated, false);

  await setSaleCost(db, U, { lineItemId: 'A', cost: 4 }); // changing it updates the same card
  assert.equal(db.tables.inventory.length, 1);
  assert.equal(db.tables.ebay_order_lines.find((l) => l.line_item_id === 'A').profit, 4.5);

  assert.deepEqual(await estimateSales(db, U, { pct: 25 }), { estimated: 1 }); // B only; C was cancelled
  const b = db.tables.ebay_order_lines.find((l) => l.line_item_id === 'B');
  assert.equal(b.cost_basis, 1);
  assert.equal(b.cost_estimated, true);
  assert.equal(db.tables.ebay_order_lines.find((l) => l.line_item_id === 'C').match_status, 'unmatched');
});

test('cards added to inventory after a sale are never auto-matched to it', () => {
  const lines = [{ line_item_id: 'L', legacy_item_id: '200', sold_at_hint: '2026-10-01T12:00:00Z' }];
  const older = [{ id: 'x', ebay_item_id: '200', status: 'In Stock', created_at: '2026-09-01T00:00:00Z' }];
  const newer = [{ id: 'y', ebay_item_id: '200', status: 'In Stock', created_at: '2026-11-23T00:00:00Z' }];
  assert.equal(matchLinesToInventory(lines, newer).length, 0);
  assert.equal(matchLinesToInventory(lines, older)[0].inventory_id, 'x');
  assert.equal(matchLinesToInventory([{ ...lines[0], sold_at_hint: null }], newer).length, 1); // no date: old behaviour
});
