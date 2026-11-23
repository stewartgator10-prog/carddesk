// netlify/lib/mcp-tools.js
// The CardDesk tools an AI agent (the Claude app, via the MCP connector) can call.
// Every tool acts as the signed-in seller and reuses the same rules as the app's screens:
// the eBay check before publishing, the "this exact listing passed" signature, the monthly
// AI budget, server-side price limits. Handlers are plain functions so they can be tested.
import { buildTitle, suggestPrice, REVIEW_LABELS } from './snap-logic.js';
import { checkSnapItem, publishSnapItem } from './ebay-listing.js';
import { summarizePnl } from './pnl.js';
import { monthStart, MODEL_LABELS } from './ai-usage.js';

export const MAX_CHECK_PER_CALL = 6;     // each check uploads photos + calls eBay; keeps a call well under the time limit
export const MAX_PUBLISH_PER_CALL = 10;
const CONDITIONS = ['NM', 'LP', 'MP', 'HP', 'DMG'];
const FINISHES = ['normal', 'holo', 'reverse_holo', 'foil', 'unknown'];
const LISTING_FIELDS = ['title', 'price', 'condition', 'finish', 'card_name', 'catalog_set', 'catalog_number', 'misprint_confirmed'];

const round2 = (n) => Math.round(n * 100) / 100;
async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
const toolError = (message) => Object.assign(new Error(message), { toolError: true });

export function cardView(it) {
  return {
    id: it.id,
    status: it.status,
    title: it.title,
    card: { name: it.card_name, set: it.catalog_set || it.set_name, number: it.catalog_number || it.collector_number, finish: it.finish, condition: it.condition, language: it.language, game: it.game },
    price: it.price != null ? Number(it.price) : null,
    market_price: it.market_price != null ? Number(it.market_price) : null,
    suggested_price: it.suggested_price != null ? Number(it.suggested_price) : null,
    cost: it.cost_basis != null ? Number(it.cost_basis) : null,
    ai_confidence: it.confidence != null ? Number(it.confidence) : null,
    flags: (it.review_reasons || []).map((r) => REVIEW_LABELS[r] || r),
    possible_misprint: it.misprint_flag ? (it.misprint_notes || 'yes') : null,
    misprint_confirmed: !!it.misprint_confirmed,
    has_back_photo: !!it.back_photo_path,
    ebay_check: it.publish_state ? {
      state: it.publish_state, passed: it.publish_check?.ok ?? null, errors: it.publish_check?.errors || [],
      warnings: it.publish_check?.warnings || [], listing_fee: it.publish_check?.fees?.total ?? null, error: it.publish_error || null,
    } : null,
    ebay_url: it.ebay_url || null,
    error: it.error || null,
  };
}

async function ownCards(db, userId, ids) {
  if (!Array.isArray(ids) || !ids.length) throw toolError('Give at least one card id (from list_cards).');
  const rows = await must(db.from('snap_items').select('*').eq('user_id', userId).in('id', ids));
  const found = new Set(rows.map((r) => r.id));
  return { rows, missing: ids.filter((id) => !found.has(id)) };
}

async function patchCard(db, userId, card, patch) {
  if (['checked', 'check_failed'].includes(card.publish_state) && LISTING_FIELDS.some((k) => k in patch && patch[k] !== card[k])) {
    Object.assign(patch, { publish_state: null, publish_check: null }); // the old check no longer describes this listing
  }
  await must(db.from('snap_items').update(patch).eq('user_id', userId).eq('id', card.id));
  return { ...card, ...patch };
}

// ---------- read ----------
export async function queueSummary({ db, userId, origin }) {
  const rows = await must(db.from('snap_items').select('status, publish_state, publish_check').eq('user_id', userId));
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const approved = rows.filter((r) => r.status === 'approved');
  const usage = await must(db.from('api_usage').select('cost_usd').eq('user_id', userId).gte('created_at', monthStart()));
  const settingsRow = await must(db.from('settings').select('data').eq('user_id', userId).maybeSingle());
  const acct = await must(db.from('ebay_accounts').select('listing_templates').eq('user_id', userId).maybeSingle());
  return {
    cards_by_status: counts,
    approved_ready_to_publish: approved.filter((r) => r.publish_state === 'checked' && r.publish_check?.ok).length,
    approved_needing_check: approved.filter((r) => r.publish_state !== 'checked').length,
    ai_spend_this_month_usd: round2(usage.reduce((s, r) => s + Number(r.cost_usd || 0), 0)),
    ai_monthly_budget_usd: Number(settingsRow?.data?.aiMonthlyBudget ?? 25),
    ebay_connected: !!acct,
    ebay_listing_setup_learned: !!acct?.listing_templates,
    snap_photos_url: `${origin}/?tab=snap`,
    note: 'Photos are taken in the CardDesk Snap tab on a phone (snap_photos_url); cards appear here once identified.',
  };
}

export async function listCards({ db, userId }, { status = 'open', limit = 25, flagged_only = false } = {}) {
  let q = db.from('snap_items').select('*').eq('user_id', userId);
  if (status === 'open') q = q.in('status', ['uploaded', 'identifying', 'ready', 'needs_review', 'failed', 'approved']);
  else q = q.eq('status', status);
  let rows = await must(q.order('created_at', { ascending: false }).limit(Math.min(Math.max(Number(limit) || 25, 1), 100)));
  if (flagged_only) rows = rows.filter((r) => (r.review_reasons || []).length || r.misprint_flag);
  return { count: rows.length, cards: rows.map(cardView) };
}

export async function profitReport({ db, userId }, { days = 30 } = {}) {
  const since = new Date(Date.now() - Math.min(Math.max(Number(days) || 30, 1), 3650) * 864e5).toISOString();
  const lines = await must(db.from('ebay_order_lines').select('*').eq('user_id', userId).gte('sold_at', since));
  const orders = await must(db.from('ebay_orders').select('order_id, cancel_state').eq('user_id', userId));
  const overhead = await must(db.from('ebay_transactions').select('transaction_type, amount, order_id, transaction_date').eq('user_id', userId).is('order_id', null).gte('transaction_date', since));
  const cancelled = new Set(orders.filter((o) => o.cancel_state === 'CANCELED').map((o) => o.order_id));
  const counted = (l) => ['auto', 'confirmed'].includes(l.match_status);
  const rows = lines.map((l) => ({
    ...l, gross: Number(l.gross) || 0, fees: Number(l.fees) || 0, shipping_label: Number(l.shipping_label) || 0, ad_fees: Number(l.ad_fees) || 0,
    refunds: Number(l.refunds) || 0, other: Number(l.other) || 0, net_payout: Number(l.net_payout) || 0,
    cost_basis: counted(l) && l.cost_basis != null ? Number(l.cost_basis) : null, profit: counted(l) && l.profit != null ? Number(l.profit) : null,
    cancelled: cancelled.has(l.order_id),
  }));
  const s = summarizePnl(rows, overhead.map((t) => ({ ...t, amount: Number(t.amount) })));
  const withProfit = rows.filter((r) => r.profit != null && !r.cancelled).sort((a, b) => b.profit - a.profit);
  const brief = (r) => ({ title: r.title, sold: String(r.sold_at || '').slice(0, 10), sold_for: r.gross, net: r.net_payout, cost: r.cost_basis, profit: r.profit, cost_estimated: !!r.cost_estimated });
  return {
    period_days: Number(days) || 30,
    orders: s.orders, gross_sales: s.gross, ebay_fees: s.fees, shipping_labels: s.shipping_label, ad_fees: s.ad_fees, refunds: s.refunds,
    net_payout: s.net_payout, cost_of_cards: s.cost, profit_on_sales: s.profit, store_costs: s.overhead, profit_after_store_costs: s.profit_after_overhead,
    sales_missing_cost: s.missing_cost, sales_with_estimated_cost: rows.filter((r) => r.cost_estimated && r.profit != null).length,
    best_sales: withProfit.slice(0, 5).map(brief),
    worst_sales: withProfit.slice(-5).reverse().map(brief),
    note: s.missing_cost ? 'Profit only counts sales whose card cost is known; the rest are listed in sales_missing_cost. Costs can be added on the Costs tab.' : undefined,
  };
}

export async function feeReport({ db, userId }) {
  const rows = await must(db.from('api_usage').select('model, purpose, cost_usd, ok').eq('user_id', userId).gte('created_at', monthStart()));
  const by = (k) => Object.values(rows.reduce((m, r) => { const key = r[k]; m[key] = m[key] || { [k]: k === 'model' ? (MODEL_LABELS[key] || key) : key, calls: 0, cost_usd: 0 }; m[key].calls += 1; m[key].cost_usd = round2(m[key].cost_usd + Number(r.cost_usd || 0)); return m; }, {}));
  return { month_to_date_usd: round2(rows.reduce((s, r) => s + Number(r.cost_usd || 0), 0)), calls: rows.length, failed_calls: rows.filter((r) => !r.ok).length, by_model: by('model'), by_use: by('purpose'), note: 'Estimated from Anthropic list prices; the Anthropic invoice is final.' };
}

// ---------- edit ----------
export async function updateCards({ db, userId }, { updates }) {
  if (!Array.isArray(updates) || !updates.length || updates.length > 100) throw toolError('updates must be a list of 1 to 100 changes.');
  const { rows, missing } = await ownCards(db, userId, updates.map((u) => u.id));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const results = [];
  for (const u of updates) {
    const card = byId.get(u.id);
    if (!card) { results.push({ id: u.id, ok: false, error: 'not found' }); continue; }
    if (['listed', 'discarded'].includes(card.status)) { results.push({ id: u.id, ok: false, error: `card is ${card.status}` }); continue; }
    const patch = {};
    if (u.price !== undefined) {
      const p = round2(Number(u.price));
      if (!(p >= 0.99 && p <= 100000)) { results.push({ id: u.id, ok: false, error: 'price must be between $0.99 and $100,000' }); continue; }
      patch.price = p;
    }
    if (u.condition !== undefined) { if (!CONDITIONS.includes(u.condition)) { results.push({ id: u.id, ok: false, error: `condition must be one of ${CONDITIONS.join(', ')}` }); continue; } patch.condition = u.condition; }
    if (u.finish !== undefined) { if (!FINISHES.includes(u.finish)) { results.push({ id: u.id, ok: false, error: `finish must be one of ${FINISHES.join(', ')}` }); continue; } patch.finish = u.finish; }
    if (u.card_name !== undefined) patch.card_name = String(u.card_name).slice(0, 120);
    if (u.set !== undefined) patch.catalog_set = String(u.set).slice(0, 120);
    if (u.number !== undefined) patch.catalog_number = String(u.number).slice(0, 30);
    if (u.misprint_confirmed !== undefined) patch.misprint_confirmed = !!u.misprint_confirmed;
    if (u.cost !== undefined) {
      if (u.cost === null) Object.assign(patch, { cost_basis: null, cost_source: null, purchase_id: null });
      else { const c = Number(u.cost); if (!(c >= 0 && c <= 1_000_000)) { results.push({ id: u.id, ok: false, error: 'cost must be 0 or more' }); continue; } Object.assign(patch, { cost_basis: round2(c), cost_source: 'entered', purchase_id: null }); }
    }
    if (u.title !== undefined) patch.title = String(u.title).slice(0, 80);
    else if (u.rebuild_title || ['card_name', 'catalog_set', 'catalog_number', 'finish', 'condition', 'misprint_confirmed'].some((k) => k in patch)) patch.title = buildTitle({ ...card, ...patch });
    const after = await patchCard(db, userId, card, patch);
    results.push({ id: u.id, ok: true, card: cardView(after) });
  }
  return { updated: results.filter((r) => r.ok).length, results, missing };
}

export async function repriceCards({ db, userId, settings }, { ids, markup_pct }) {
  const pct = Number(markup_pct);
  if (!Number.isFinite(pct) || pct < -90 || pct > 1000) throw toolError('markup_pct must be a number between -90 and 1000.');
  const { rows, missing } = await ownCards(db, userId, ids);
  const results = [];
  for (const card of rows) {
    if (['listed', 'discarded'].includes(card.status)) { results.push({ id: card.id, ok: false, error: `card is ${card.status}` }); continue; }
    if (card.market_price == null) { results.push({ id: card.id, ok: false, error: 'no market price for this card' }); continue; }
    const price = suggestPrice(Number(card.market_price), { ...settings, snapMarkupPct: pct });
    const after = await patchCard(db, userId, card, { price });
    results.push({ id: card.id, ok: true, title: card.title, market: Number(card.market_price), old_price: card.price != null ? Number(card.price) : null, new_price: after.price });
  }
  return { repriced: results.filter((r) => r.ok).length, rule: `market ${pct >= 0 ? '+' : ''}${pct}%, then your minimum and price ending`, results, missing };
}

export async function approveCards({ db, userId }, { ids, acknowledge_flags = false }) {
  const { rows, missing } = await ownCards(db, userId, ids);
  const results = [];
  for (const card of rows) {
    if (!['ready', 'needs_review'].includes(card.status)) { results.push({ id: card.id, ok: false, error: `card is ${card.status}` }); continue; }
    if (!(Number(card.price) >= 0.99) || !card.title) { results.push({ id: card.id, ok: false, error: 'needs a title and a price of at least $0.99 first' }); continue; }
    const flags = (card.review_reasons || []).map((r) => REVIEW_LABELS[r] || r);
    if (flags.length && !acknowledge_flags) { results.push({ id: card.id, ok: false, error: `flagged for review (${flags.join('; ')}). Show the user and approve again with acknowledge_flags=true only if they agree.` }); continue; }
    await patchCard(db, userId, card, { status: 'approved' });
    results.push({ id: card.id, ok: true, title: card.title, price: Number(card.price) });
  }
  return { approved: results.filter((r) => r.ok).length, results, missing };
}

export async function discardCards({ db, userId }, { ids }) {
  const { rows, missing } = await ownCards(db, userId, ids);
  const results = [];
  for (const card of rows) {
    if (card.status === 'listed') { results.push({ id: card.id, ok: false, error: 'already listed on eBay; end the listing on eBay instead' }); continue; }
    await patchCard(db, userId, card, { status: 'discarded' });
    results.push({ id: card.id, ok: true });
  }
  return { discarded: results.filter((r) => r.ok).length, results, missing };
}

// ---------- eBay ----------
export async function checkCards({ db, userId, getToken, settings, deps = {} }, { ids }) {
  if (!Array.isArray(ids) || !ids.length) throw toolError('Give the ids of approved cards to check.');
  if (ids.length > MAX_CHECK_PER_CALL) throw toolError(`Check at most ${MAX_CHECK_PER_CALL} cards per call; call again for the rest.`);
  const { rows, missing } = await ownCards(db, userId, ids);
  const token = await getToken();
  const results = [];
  for (const card of rows) {
    try {
      const after = await (deps.checkSnapItem || checkSnapItem)({ db, userId, token, item: card, settings, ...(deps.call ? { call: deps.call } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
      results.push({ id: card.id, title: card.title, passed: !!after.publish_check?.ok, errors: after.publish_check?.errors || [], warnings: after.publish_check?.warnings || [], listing_fee: after.publish_check?.fees?.total ?? null });
    } catch (err) {
      results.push({ id: card.id, title: card.title, passed: false, errors: [err.message] });
    }
  }
  return { checked: results.length, passed: results.filter((r) => r.passed).length, results, missing, note: 'Nothing was listed. Cards that passed can be published with publish_cards after the user confirms.' };
}

export async function publishCards({ db, userId, getToken, settings, deps = {} }, { ids, user_confirmed }) {
  if (user_confirmed !== true) throw toolError('Publishing puts live listings on eBay. First show the user each card\'s title and price, ask for a clear yes, then call again with user_confirmed=true.');
  if (!Array.isArray(ids) || !ids.length) throw toolError('Give the ids of checked cards to publish.');
  if (ids.length > MAX_PUBLISH_PER_CALL) throw toolError(`Publish at most ${MAX_PUBLISH_PER_CALL} cards per call.`);
  const { rows, missing } = await ownCards(db, userId, ids);
  const token = await getToken();
  const results = [];
  for (const card of rows) {
    try {
      const r = await (deps.publishSnapItem || publishSnapItem)({ db, userId, token, item: card, settings, ...(deps.call ? { call: deps.call } : {}) });
      results.push({ id: card.id, title: card.title, price: Number(card.price), listed: true, ebay_url: r.url });
    } catch (err) {
      results.push({ id: card.id, title: card.title, listed: false, error: err.message });
    }
  }
  return { published: results.filter((r) => r.listed).length, results, missing };
}
