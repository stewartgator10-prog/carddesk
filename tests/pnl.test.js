import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeOrder, normalizeTransaction, computeLinePnl, summarizePnl, matchLinesToInventory } from '../netlify/lib/pnl.js';

const U = 'user-1';
const order = {
  orderId: '12-345', creationDate: '2026-11-01T10:00:00Z', orderPaymentStatus: 'PAID',
  pricingSummary: { priceSubtotal: { value: '60.00' }, deliveryCost: { value: '5.00' }, total: { value: '65.00' } },
  totalMarketplaceFee: { value: '8.92' },
  buyer: { username: 'b1' },
  lineItems: [
    { lineItemId: 'L1', legacyItemId: '111', sku: 'CHZ-1', title: 'Charizard VMAX 020/189 Darkness Ablaze', quantity: 1, lineItemCost: { value: '40.00' }, deliveryCost: { shippingCost: { value: '5.00' } } },
    { lineItemId: 'L2', legacyItemId: '222', title: 'Umbreon V Alt Art Evolving Skies 189/203', quantity: 1, lineItemCost: { value: '20.00' }, deliveryCost: { shippingCost: { value: '0' } } },
  ],
};

test('normalizeOrder maps money fields', () => {
  const { order: o, lines } = normalizeOrder(order, U);
  assert.equal(o.order_total, 65);
  assert.equal(o.marketplace_fee_reported, 8.92);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].shipping_charged, 5);
});

test('computeLinePnl uses actual fees, spreads label/ad/refund, and applies cost', () => {
  const { order: o, lines } = normalizeOrder(order, U);
  const txns = [
    normalizeTransaction({ transactionId: 'T1', transactionType: 'SALE', bookingEntry: 'CREDIT', orderId: '12-345', amount: { value: '56.08' }, totalFeeAmount: { value: '8.92' },
      orderLineItems: [
        { lineItemId: 'L1', marketplaceFees: [{ feeType: 'FINAL_VALUE_FEE', amount: { value: '5.96' } }, { feeType: 'FINAL_VALUE_FEE_FIXED_PER_ORDER', amount: { value: '0.30' } }] },
        { lineItemId: 'L2', marketplaceFees: [{ feeType: 'FINAL_VALUE_FEE', amount: { value: '2.66' } }] },
      ] }, U),
    normalizeTransaction({ transactionId: 'T2', transactionType: 'SHIPPING_LABEL', bookingEntry: 'DEBIT', orderId: '12-345', amount: { value: '4.50' } }, U),
    normalizeTransaction({ transactionId: 'T3', transactionType: 'NON_SALE_CHARGE', feeType: 'AD_FEE', bookingEntry: 'DEBIT', references: [{ referenceId: '12-345', referenceType: 'ORDER_ID' }], amount: { value: '1.30' } }, U),
    normalizeTransaction({ transactionId: 'T4', transactionType: 'NON_SALE_CHARGE', feeType: 'SUBSCRIPTION_FEE', bookingEntry: 'DEBIT', amount: { value: '4.95' } }, U),
  ];
  const rows = computeLinePnl({ orders: [o], lines, txns, costByLine: new Map([['L1', 20]]) });
  const r1 = rows.find((r) => r.line_item_id === 'L1');
  const r2 = rows.find((r) => r.line_item_id === 'L2');
  assert.equal(r1.fee_source, 'actual');
  assert.equal(r1.fees, 6.26);
  // L1 is 45/65 of the order
  assert.equal(r1.shipping_label, -3.12);
  assert.equal(r1.ad_fees, -0.9);
  assert.equal(r1.net_payout, 34.72);
  assert.equal(r1.profit, 14.72);
  assert.equal(r2.profit, null); // no cost known
  const s = summarizePnl(rows, txns);
  assert.equal(s.orders, 1);
  assert.equal(s.missing_cost, 1);
  assert.equal(s.overhead, -4.95);
  assert.equal(s.net_payout, round(r1.net_payout + r2.net_payout));
});

test('falls back to order-reported fee, then to estimate', () => {
  const { order: o, lines } = normalizeOrder(order, U);
  let rows = computeLinePnl({ orders: [o], lines, txns: [] });
  assert.equal(rows[0].fee_source, 'order');
  assert.equal(rows[0].fees, round(8.92 * 45 / 65));
  rows = computeLinePnl({ orders: [{ ...o, marketplace_fee_reported: null }], lines, txns: [], settings: { ebayFeePct: 10, ebayFeeFlat: 0 } });
  assert.equal(rows[0].fee_source, 'estimated');
  assert.equal(rows[0].fees, 4.5);
});

test('refund reduces net, cancellation zeroes it', () => {
  const { order: o, lines } = normalizeOrder(order, U);
  const refund = normalizeTransaction({ transactionId: 'R1', transactionType: 'REFUND', bookingEntry: 'DEBIT', orderId: '12-345', amount: { value: '65.00' } }, U);
  const rows = computeLinePnl({ orders: [o], lines, txns: [refund] });
  assert.equal(rows[0].refunds, -45);
  const c = computeLinePnl({ orders: [{ ...o, cancel_state: 'CANCELED' }], lines, txns: [] });
  assert.equal(c[0].net_payout, 0);
  assert.equal(summarizePnl(c).orders, 0);
});

test('matching: item id and sku auto, title only suggested, sold rows skipped', () => {
  const { lines } = normalizeOrder(order, U);
  const inv = [
    { id: 'a', card_name: 'Charizard VMAX', status: 'In Stock', sku: 'CHZ-1' },
    { id: 'b', card_name: 'Umbreon V Alt Art Evolving Skies', status: 'In Stock' },
    { id: 'c', card_name: 'Umbreon V Alt Art Evolving Skies', status: 'Sold' },
  ];
  const m = matchLinesToInventory(lines, inv);
  assert.deepEqual(m.map((x) => [x.line_item_id, x.inventory_id, x.method, x.auto]), [
    ['L1', 'a', 'sku', true],
    ['L2', 'b', 'title', false],
  ]);
  // item id wins over sku
  const m2 = matchLinesToInventory(lines, [{ id: 'z', card_name: 'x', status: 'In Stock', ebay_item_id: '111' }, ...inv]);
  assert.equal(m2[0].inventory_id, 'z');
  assert.equal(m2[0].method, 'item_id');
  // a line already linked is not matched again
  const m3 = matchLinesToInventory(lines, [{ ...inv[0], ebay_order_line_id: 'L1', status: 'Sold' }, inv[1]]);
  assert.deepEqual(m3.map((x) => x.line_item_id), ['L2']);
});

function round(n) { return Math.round(n * 100) / 100; }
