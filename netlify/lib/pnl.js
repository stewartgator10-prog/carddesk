// netlify/lib/pnl.js
// Pure logic for turning eBay Fulfillment orders + Finances transactions into
// per-line profit, and for matching sold lines back to inventory.
// No I/O here so it can be unit tested (see test/pnl.test.js).

const num = (v) => {
  const n = parseFloat(v?.value ?? v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;

// ---------- Orders (Sell Fulfillment API: GET /sell/fulfillment/v1/order) ----------

export function normalizeOrder(o, userId) {
  const lines = (o.lineItems || []).map((li) => ({
    user_id: userId,
    line_item_id: li.lineItemId,
    order_id: o.orderId,
    legacy_item_id: li.legacyItemId || null,
    sku: li.sku || null,
    title: li.title || '',
    quantity: li.quantity || 1,
    item_price: num(li.lineItemCost),            // total for this line (price * qty), before tax
    shipping_charged: num(li.deliveryCost?.shippingCost),
    fulfillment_status: li.lineItemFulfillmentStatus || null,
  }));
  return {
    order: {
      user_id: userId,
      order_id: o.orderId,
      created_at_ebay: o.creationDate,
      buyer_username: o.buyer?.username || null,
      payment_status: o.orderPaymentStatus || null,
      fulfillment_status: o.orderFulfillmentStatus || null,
      cancel_state: o.cancelStatus?.cancelState || null,
      subtotal: num(o.pricingSummary?.priceSubtotal),
      shipping_charged: num(o.pricingSummary?.deliveryCost),
      order_total: num(o.pricingSummary?.total),
      // Fee eBay reports on the order itself. Used as a fallback when the
      // Finances transaction hasn't posted yet.
      marketplace_fee_reported: o.totalMarketplaceFee ? num(o.totalMarketplaceFee) : null,
      raw: o,
    },
    lines,
  };
}

// ---------- Transactions (Sell Finances API: GET /sell/finances/v1/transaction) ----------

function refOrderId(t) {
  if (t.orderId) return t.orderId;
  const ref = (t.references || []).find((r) => r.referenceType === 'ORDER_ID');
  return ref ? ref.referenceId : null;
}

export function normalizeTransaction(t, userId) {
  // Signed from the seller's point of view: CREDIT = money in, DEBIT = money out.
  const sign = t.bookingEntry === 'DEBIT' ? -1 : 1;
  const lineFees = (t.orderLineItems || []).map((li) => ({
    line_item_id: li.lineItemId,
    fees: (li.marketplaceFees || []).map((f) => ({ type: f.feeType, amount: num(f.amount) })),
  }));
  return {
    user_id: userId,
    transaction_id: t.transactionId,
    transaction_type: t.transactionType,
    transaction_status: t.transactionStatus || null,
    transaction_date: t.transactionDate,
    order_id: refOrderId(t),
    fee_type: t.feeType || null,
    amount: round2(sign * num(t.amount)),
    total_fee_amount: num(t.totalFeeAmount),
    line_fees: lineFees,
    memo: t.transactionMemo || null,
    raw: t,
  };
}

// ---------- P&L ----------

/**
 * Compute profit for each order line.
 * @param orders   rows shaped like normalizeOrder().order
 * @param lines    rows shaped like normalizeOrder().lines[n]
 * @param txns     rows shaped like normalizeTransaction()
 * @param costByLine  Map line_item_id -> cost basis (from matched inventory), may be missing
 * @param settings { ebayFeePct, ebayFeeFlat } used only when no real fee is known
 */
export function computeLinePnl({ orders, lines, txns, costByLine = new Map(), settings = {} }) {
  const orderById = new Map(orders.map((o) => [o.order_id, o]));
  const linesByOrder = new Map();
  for (const l of lines) {
    if (!linesByOrder.has(l.order_id)) linesByOrder.set(l.order_id, []);
    linesByOrder.get(l.order_id).push(l);
  }

  // Real per-line marketplace fees from SALE transactions.
  const saleFeeByLine = new Map();
  // Order-level money movements to spread across lines.
  const perOrder = new Map(); // order_id -> { label, ads, refunds, other }
  const bucket = (id) => {
    if (!perOrder.has(id)) perOrder.set(id, { label: 0, ads: 0, refunds: 0, other: 0 });
    return perOrder.get(id);
  };

  for (const t of txns) {
    if (t.transaction_type === 'SALE') {
      for (const lf of t.line_fees || []) {
        const total = lf.fees.reduce((s, f) => s + f.amount, 0);
        saleFeeByLine.set(lf.line_item_id, (saleFeeByLine.get(lf.line_item_id) || 0) + total);
      }
      continue;
    }
    if (!t.order_id) continue; // not tied to an order (e.g. store subscription) -> shown separately
    const b = bucket(t.order_id);
    if (t.transaction_type === 'SHIPPING_LABEL') b.label += t.amount;           // negative
    else if (t.transaction_type === 'REFUND') b.refunds += t.amount;           // negative
    else if (t.transaction_type === 'NON_SALE_CHARGE' && /AD_FEE/i.test(t.fee_type || '')) b.ads += t.amount;
    else if (['NON_SALE_CHARGE', 'DISPUTE', 'ADJUSTMENT', 'CREDIT'].includes(t.transaction_type)) b.other += t.amount;
  }

  const results = [];
  for (const l of lines) {
    const order = orderById.get(l.order_id);
    const siblings = linesByOrder.get(l.order_id) || [l];
    const orderGross = siblings.reduce((s, x) => s + x.item_price + x.shipping_charged, 0);
    const gross = l.item_price + l.shipping_charged;
    const share = orderGross > 0 ? gross / orderGross : 1 / siblings.length;

    let fees, feeSource;
    if (saleFeeByLine.has(l.line_item_id)) {
      fees = saleFeeByLine.get(l.line_item_id); feeSource = 'actual';
    } else if (order?.marketplace_fee_reported != null) {
      fees = order.marketplace_fee_reported * share; feeSource = 'order';
    } else {
      const pct = settings.ebayFeePct ?? 13.25;
      const flat = settings.ebayFeeFlat ?? 0.30;
      fees = gross * (pct / 100) + flat * share; feeSource = 'estimated';
    }

    const b = perOrder.get(l.order_id) || { label: 0, ads: 0, refunds: 0, other: 0 };
    const label = b.label * share, ads = b.ads * share, refunds = b.refunds * share, other = b.other * share;
    const cancelled = order?.cancel_state === 'CANCELED';
    const cost = costByLine.has(l.line_item_id) ? costByLine.get(l.line_item_id) : null;

    const net = cancelled ? 0 : gross - fees + label + ads + refunds + other;
    results.push({
      line_item_id: l.line_item_id,
      order_id: l.order_id,
      title: l.title,
      sold_at: order?.created_at_ebay || null,
      quantity: l.quantity,
      gross: round2(gross),
      fees: round2(fees),
      fee_source: feeSource,
      shipping_label: round2(label),
      ad_fees: round2(ads),
      refunds: round2(refunds),
      other: round2(other),
      net_payout: round2(net),
      cost_basis: cost,
      profit: cost == null ? null : round2(net - cost),
      cancelled,
    });
  }
  return results;
}

export function summarizePnl(rows, unattributedTxns = []) {
  const s = { orders: new Set(), gross: 0, fees: 0, shipping_label: 0, ad_fees: 0, refunds: 0, other: 0, net_payout: 0, cost: 0, profit: 0, missing_cost: 0, estimated_fees: 0 };
  for (const r of rows) {
    if (r.cancelled) continue;
    s.orders.add(r.order_id);
    for (const k of ['gross', 'fees', 'shipping_label', 'ad_fees', 'refunds', 'other', 'net_payout']) s[k] += r[k];
    if (r.cost_basis == null) s.missing_cost++; else { s.cost += r.cost_basis; s.profit += r.profit; }
    if (r.fee_source !== 'actual') s.estimated_fees++;
  }
  // Store-level costs not tied to an order (subscription, non-order ad fees, etc.)
  const overhead = unattributedTxns
    .filter((t) => !t.order_id && t.transaction_type === 'NON_SALE_CHARGE')
    .reduce((sum, t) => sum + t.amount, 0);
  const out = { ...s, orders: s.orders.size, overhead: round2(overhead) };
  for (const k of ['gross', 'fees', 'shipping_label', 'ad_fees', 'refunds', 'other', 'net_payout', 'cost', 'profit']) out[k] = round2(out[k]);
  out.profit_after_overhead = round2(out.profit + out.overhead);
  return out;
}

// ---------- Inventory matching ----------

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

function titleScore(a, b) {
  const ta = new Set(norm(a).split(' ').filter((w) => w.length > 1));
  const tb = new Set(norm(b).split(' ').filter((w) => w.length > 1));
  if (!ta.size || !tb.size) return 0;
  let hit = 0;
  for (const w of ta) if (tb.has(w)) hit++;
  return hit / Math.min(ta.size, tb.size);
}

/**
 * Decide which inventory row each sold line belongs to.
 * Order of trust: eBay item id -> SKU -> title similarity.
 * Only id/SKU matches are applied automatically; title matches are returned
 * as suggestions for the user to confirm.
 * @returns [{ line_item_id, inventory_id, method: 'item_id'|'sku'|'title', confidence, auto }]
 */
export function matchLinesToInventory(lines, inventory) {
  const available = inventory.filter((i) => i.status !== 'Sold' && !i.ebay_order_line_id);
  const used = new Set();
  const already = new Set(inventory.filter((i) => i.ebay_order_line_id).map((i) => i.ebay_order_line_id));
  const out = [];

  for (const l of lines) {
    if (already.has(l.line_item_id)) continue;
    // A card added to inventory after the sale can't be the card that sold (e.g. the remaining
    // copies of a multi-quantity listing imported later), so only older cards are candidates.
    const soldAt = l.sold_at_hint ? Date.parse(l.sold_at_hint) : NaN;
    const free = available.filter((i) => !used.has(i.id)
      && !(Number.isFinite(soldAt) && i.created_at && Date.parse(i.created_at) > soldAt + 60_000));
    let m = null;
    if (l.legacy_item_id) {
      const hit = free.find((i) => i.ebay_item_id && String(i.ebay_item_id) === String(l.legacy_item_id));
      if (hit) m = { inv: hit, method: 'item_id', confidence: 1 };
    }
    if (!m && l.sku) {
      const hit = free.find((i) => i.sku && i.sku === l.sku);
      if (hit) m = { inv: hit, method: 'sku', confidence: 1 };
    }
    if (!m) {
      let best = null, bestScore = 0;
      for (const i of free) {
        const sc = titleScore(i.card_name || i.cardName, l.title);
        if (sc > bestScore) { best = i; bestScore = sc; }
      }
      if (best && bestScore >= 0.6) m = { inv: best, method: 'title', confidence: round2(bestScore) };
    }
    if (m) {
      used.add(m.inv.id);
      out.push({ line_item_id: l.line_item_id, inventory_id: m.inv.id, method: m.method, confidence: m.confidence, auto: m.method !== 'title' });
    }
  }
  return out;
}
