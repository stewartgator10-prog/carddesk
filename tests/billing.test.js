// Tyche Cards plans: limits, feature gates, Stripe checkout and the webhook. Off on the founder site.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.js';
import { PLANS, hasFeature, effectivePlan, cardLimit, priceLookupKey } from '../netlify/lib/plans.js';
import { requireFeature, requireCards, usageFor, checkoutUrl, portalUrl, handleStripeEvent, rowFromSubscription, formEncode, planFor } from '../netlify/lib/billing.js';

const U = 'u1';
const thisMonth = new Date().toISOString();
afterEach(() => { delete process.env.BILLING_ENABLED; delete process.env.STRIPE_SECRET_KEY; });
const on = () => { process.env.BILLING_ENABLED = 'true'; process.env.STRIPE_SECRET_KEY = 'rk_test_x'; };
const body = async (r) => JSON.parse(await r.text());

test('plans: prices, limits, which plan unlocks what, lapsed subscriptions fall back to Free', () => {
  assert.deepEqual(['free', 'basic', 'pro', 'elite'].map((p) => [PLANS[p].month, PLANS[p].year, cardLimit(p)]), [[0, 0, 25], [19, 190, 300], [39, 390, 1000], [79, 790, 3000]]);
  assert.equal(hasFeature('free', 'repricer'), false); assert.equal(hasFeature('pro', 'repricer'), true);
  assert.equal(hasFeature('pro', 'connector'), false); assert.equal(hasFeature('elite', 'connector'), true);
  assert.equal(hasFeature('basic', 'live_edit'), true); assert.equal(hasFeature('free', 'live_edit'), false);
  assert.equal(priceLookupKey('pro', 'year'), 'tyche_pro_year');
  assert.equal(effectivePlan(null), 'free');
  assert.equal(effectivePlan({ plan: 'pro', status: 'active' }), 'pro');
  assert.equal(effectivePlan({ plan: 'pro', status: 'canceled' }), 'free');
  assert.equal(effectivePlan({ plan: 'elite', status: 'comped', comped: true }), 'elite');
  assert.equal(effectivePlan({ plan: 'pro', status: 'active', current_period_end: '2020-01-01T00:00:00Z' }), 'free', 'long past the paid period');
});

test('founder site (billing off): every feature, no card limit', async () => {
  const db = fakeDb({ subscriptions: [], snap_items: [], collection_items: [] });
  assert.equal(await requireFeature(db, U, 'connector'), null);
  assert.equal(await requireCards(db, U, 99999), null);
  assert.deepEqual(await usageFor(db, U), { plan: 'elite', used: null, limit: null });
});

test('Tyche Cards: card limit per month, paid features need the right plan', async () => {
  on();
  const snaps = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, user_id: U, identified_at: thisMonth }));
  snaps.push({ id: 'old', user_id: U, identified_at: '2020-01-01T00:00:00Z' }, { id: 'other', user_id: 'u2', identified_at: thisMonth });
  const db = fakeDb({ subscriptions: [], snap_items: snaps, collection_items: [] });
  assert.deepEqual(await usageFor(db, U), { plan: 'free', used: 25, limit: 25 });
  const full = await requireCards(db, U, 1);
  assert.equal(full.status, 402);
  const b = await body(full);
  assert.equal(b.code, 'UPGRADE'); assert.equal(b.need, 'basic');
  assert.match(b.error, /used all 25 cards in your Free plan this month\. Basic includes 300 a month/);
  const gated = await body(await requireFeature(db, U, 'repricer'));
  assert.equal(gated.need, 'pro'); assert.match(gated.error, /The repricer is part of the Pro plan/);

  db.tables.subscriptions.push({ user_id: U, plan: 'pro', status: 'active' });
  assert.equal(await requireCards(db, U, 1), null);
  assert.equal(await requireFeature(db, U, 'repricer'), null);
  assert.equal((await requireFeature(db, U, 'buy_offers')).status, 402);
  assert.equal(await planFor(db, U), 'pro');
});

test('checkout: creates the Stripe customer once, uses the price by lookup key, success back to the app', async () => {
  on();
  const db = fakeDb({ subscriptions: [] });
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([init.method, String(url).replace('https://api.stripe.com/v1', ''), init.body || '']);
    if (String(url).includes('/customers')) return Response.json({ id: 'cus_1' });
    if (String(url).includes('/prices')) return Response.json({ data: [{ id: 'price_pro_m' }] });
    if (String(url).includes('/checkout/sessions')) return Response.json({ url: 'https://checkout.stripe.com/c/pay/x' });
    return Response.json({ url: 'https://billing.stripe.com/p/session/y' });
  };
  const url = await checkoutUrl({ db, user: { id: U, email: 'a@b.co' }, plan: 'pro', interval: 'month', origin: 'https://tychecards.netlify.app', opts: { fetchImpl } });
  assert.equal(url, 'https://checkout.stripe.com/c/pay/x');
  assert.equal(db.tables.subscriptions[0].stripe_customer_id, 'cus_1');
  assert.match(calls[1][1], /lookup_keys%5B0%5D=tyche_pro_month/);
  const sess = new URLSearchParams(calls[2][2]);
  assert.equal(sess.get('mode'), 'subscription'); assert.equal(sess.get('customer'), 'cus_1'); assert.equal(sess.get('line_items[0][price]'), 'price_pro_m');
  assert.equal(sess.get('client_reference_id'), U); assert.equal(sess.get('subscription_data[metadata][user_id]'), U);
  assert.equal(sess.get('success_url'), 'https://tychecards.netlify.app/app?billing=success');
  await assert.rejects(checkoutUrl({ db, user: { id: U }, plan: 'gold', interval: 'month', origin: 'x', opts: { fetchImpl } }), /Choose Basic, Pro or Elite/);
  // Already paying: change plans in the customer portal instead.
  Object.assign(db.tables.subscriptions[0], { stripe_subscription_id: 'sub_1', status: 'active', plan: 'pro' });
  assert.equal(await checkoutUrl({ db, user: { id: U }, plan: 'elite', interval: 'month', origin: 'x', opts: { fetchImpl } }), 'https://billing.stripe.com/p/session/y');
  // Founders on a comped plan never get sent to checkout.
  const comp = fakeDb({ subscriptions: [{ user_id: U, plan: 'elite', status: 'comped', comped: true }] });
  await assert.rejects(checkoutUrl({ db: comp, user: { id: U }, plan: 'pro', interval: 'month', origin: 'x', opts: { fetchImpl } }), /complimentary/);
  await assert.rejects(portalUrl({ db: fakeDb({ subscriptions: [] }), user: { id: U }, origin: 'x', opts: { fetchImpl } }), /Choose a plan first/);
  assert.equal(formEncode({ a: { b: [{ c: 1 }] } }).toString(), 'a%5Bb%5D%5B0%5D%5Bc%5D=1');
});

test('webhook: the event is re-read from Stripe; the plan follows the subscription; comped accounts are left alone', async () => {
  on();
  const db = fakeDb({ subscriptions: [{ user_id: U, plan: 'free', status: 'active', stripe_customer_id: 'cus_1' }] });
  const sub = (over = {}) => ({ id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false, metadata: { app: 'tyche_cards', user_id: U },
    items: { data: [{ current_period_end: 1800000000, price: { lookup_key: 'tyche_elite_year', recurring: { interval: 'year' } } }] }, ...over });
  let current = sub();
  const fetchImpl = async (url) => {
    if (String(url).includes('/events/evt_1')) return Response.json({ type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_1', client_reference_id: U } } });
    if (String(url).includes('/events/evt_2')) return Response.json({ type: 'customer.subscription.updated', data: { object: { id: 'sub_1' } } });
    if (String(url).includes('/events/evt_3')) return Response.json({ type: 'invoice.paid', data: { object: {} } });
    if (String(url).includes('/subscriptions/sub_1')) return Response.json(current);
    return new Response('{}', { status: 404 });
  };
  const r = await handleStripeEvent({ db, eventId: 'evt_1', opts: { fetchImpl } });
  assert.deepEqual(r, { userId: U, plan: 'elite', status: 'active' });
  const row = db.tables.subscriptions[0];
  assert.deepEqual([row.plan, row.billing_interval, row.stripe_subscription_id, row.current_period_end], ['elite', 'year', 'sub_1', new Date(1800000000 * 1000).toISOString()]);
  current = sub({ status: 'canceled' });
  await handleStripeEvent({ db, eventId: 'evt_2', opts: { fetchImpl } });
  assert.equal(effectivePlan(db.tables.subscriptions[0]), 'free');
  assert.deepEqual(await handleStripeEvent({ db, eventId: 'evt_3', opts: { fetchImpl } }), { ignored: 'invoice.paid' });
  await assert.rejects(handleStripeEvent({ db, eventId: 'not-an-event', opts: { fetchImpl } }), /Not a Stripe event/);
  db.tables.subscriptions[0] = { user_id: U, plan: 'elite', status: 'comped', comped: true, stripe_customer_id: 'cus_1' };
  assert.deepEqual(await handleStripeEvent({ db, eventId: 'evt_1', opts: { fetchImpl } }), { ignored: 'comped account' });
  assert.deepEqual(rowFromSubscription(sub()).plan, 'elite');
});
