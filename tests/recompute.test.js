import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recompute } from '../netlify/functions/ebay-sync-orders.js';
import { normalizeOrder, normalizeTransaction } from '../netlify/lib/pnl.js';
import { fakeDb } from './fake-db.js';

const U = 'u1';

test('recompute auto-marks item-id match sold, suggests title match, stores P&L', async () => {
  const { order, lines } = normalizeOrder({
    orderId: 'O1', creationDate: '2026-11-10T12:00:00Z', totalMarketplaceFee: { value: '6.00' },
    pricingSummary: { priceSubtotal: { value: '50' }, deliveryCost: { value: '0' }, total: { value: '50' } },
    lineItems: [
      { lineItemId: 'A', legacyItemId: '999', title: 'Lugia V Alt Art Silver Tempest', quantity: 1, lineItemCost: { value: '30' } },
      { lineItemId: 'B', title: 'Moonbreon Umbreon VMAX Evolving Skies 215', quantity: 1, lineItemCost: { value: '20' } },
    ],
  }, U);
  const db = fakeDb({
    ebay_orders: [order],
    ebay_order_lines: lines.map((l) => ({ ...l, match_status: 'unmatched' })),
    ebay_transactions: [normalizeTransaction({ transactionId: 'S', transactionType: 'SALE', bookingEntry: 'CREDIT', orderId: 'O1', amount: { value: '44' },
      orderLineItems: [{ lineItemId: 'A', marketplaceFees: [{ feeType: 'FINAL_VALUE_FEE', amount: { value: '4.00' } }] }] }, U)],
    inventory: [
      { id: 'i1', user_id: U, card_name: 'Lugia V', status: 'In Stock', cost_basis: 12, ebay_item_id: '999' },
      { id: 'i2', user_id: U, card_name: 'Umbreon VMAX Evolving Skies', status: 'In Stock', cost_basis: 8 },
    ],
    settings: [],
  });
  const r = await recompute(db, U, ['O1']);
  assert.deepEqual(r, { autoMarkedSold: 1, suggested: 1, restocked: 0 });
  const inv = db.tables.inventory;
  assert.equal(inv[0].status, 'Sold');
  assert.equal(inv[0].ebay_order_line_id, 'A');
  assert.equal(inv[0].sold_at, '2026-11-10');
  assert.equal(inv[1].status, 'In Stock');
  const [a, b] = db.tables.ebay_order_lines;
  assert.equal(a.match_status, 'auto');
  assert.equal(a.fee_source, 'actual');
  assert.equal(a.profit, 14); // 30 - 4 - 12
  assert.equal(b.match_status, 'suggested');
  assert.equal(b.inventory_id, 'i2');
  assert.equal(b.profit, null); // not counted until confirmed
  assert.equal(b.fee_source, 'order');

  // Running again doesn't double-mark anything.
  const r2 = await recompute(db, U, ['O1']);
  assert.deepEqual(r2, { autoMarkedSold: 0, suggested: 0, restocked: 0 });
});

test('a cancelled order puts its auto-matched card back in stock and can be re-matched later', async () => {
  const { order, lines } = normalizeOrder({
    orderId: 'O2', creationDate: '2026-11-12T12:00:00Z',
    pricingSummary: { priceSubtotal: { value: '40' }, deliveryCost: { value: '0' }, total: { value: '40' } },
    lineItems: [{ lineItemId: 'C', legacyItemId: '777', title: 'Charizard VMAX', quantity: 1, lineItemCost: { value: '40' } }],
  }, U);
  const db = fakeDb({
    ebay_orders: [order],
    ebay_order_lines: lines.map((l) => ({ ...l, match_status: 'unmatched' })),
    ebay_transactions: [],
    inventory: [{ id: 'i9', user_id: U, card_name: 'Charizard VMAX', status: 'In Stock', cost_basis: 10, ebay_item_id: '777' }],
    settings: [],
  });
  assert.equal((await recompute(db, U, ['O2'])).autoMarkedSold, 1);
  assert.equal(db.tables.inventory[0].status, 'Sold');

  db.tables.ebay_orders[0].cancel_state = 'CANCELED'; // buyer cancels; next sync sees it
  const r = await recompute(db, U, ['O2']);
  assert.equal(r.restocked, 1);
  assert.equal(db.tables.inventory[0].status, 'In Stock');
  assert.equal(db.tables.inventory[0].ebay_order_line_id, null);
  assert.equal(db.tables.ebay_order_lines[0].inventory_id, null);
  assert.equal(db.tables.ebay_order_lines[0].net_payout, 0);
  assert.equal((await recompute(db, U, ['O2'])).autoMarkedSold, 0); // cancelled lines are never re-matched
});
