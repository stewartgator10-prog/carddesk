// netlify/lib/billing.js
// Tyche Cards billing: which plan a user is on, how many cards they've used this month, gating paid
// features, and talking to Stripe (Checkout, the customer portal, subscription events).
//
// BILLING_ENABLED=true turns all of this on. It is set only on the Tyche Cards site; on the founder
// site (jaxspic) every check passes, so it works exactly as before.
// STRIPE_SECRET_KEY (a restricted key is fine) lives only in Netlify's environment variables.
import { PLANS, FEATURE_PLAN, FEATURE_LABELS, hasFeature, cardLimit, effectivePlan, monthStartIso, priceLookupKey } from './plans.js';

export const billingEnabled = () => process.env.BILLING_ENABLED === 'true';
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }

export async function getSubscription(db, userId) {
  const rows = await must(db.from('subscriptions').select('*').eq('user_id', userId));
  return rows[0] || null;
}

export async function planFor(db, userId) {
  if (!billingEnabled()) return 'elite';
  return effectivePlan(await getSubscription(db, userId));
}

// Cards read by the AI this calendar month: snaps identified plus collection scans.
export async function cardsUsed(db, userId, now = new Date()) {
  const since = monthStartIso(now);
  const [snaps, coll] = await Promise.all([
    must(db.from('snap_items').select('id').eq('user_id', userId).gte('identified_at', since)),
    must(db.from('collection_items').select('id').eq('user_id', userId).gte('created_at', since)),
  ]);
  return snaps.length + coll.length;
}

export async function usageFor(db, userId) {
  const plan = await planFor(db, userId);
  if (!billingEnabled()) return { plan, used: null, limit: null };
  return { plan, used: await cardsUsed(db, userId), limit: cardLimit(plan) };
}

const upgrade = (message, extra = {}) => json(402, { error: message, code: 'UPGRADE', ...extra });

// null when allowed, otherwise a 402 Response explaining which plan unlocks it.
export async function requireFeature(db, userId, feature) {
  if (!billingEnabled()) return null;
  const plan = await planFor(db, userId);
  if (hasFeature(plan, feature)) return null;
  const need = FEATURE_PLAN[feature];
  return upgrade(`${FEATURE_LABELS[feature] || 'This'} is part of the ${PLANS[need].name} plan. Upgrade in Plan & billing to use it.`, { feature, need, plan });
}

// null when the user can read `n` more cards this month, otherwise a 402 Response.
export async function requireCards(db, userId, n = 1) {
  if (!billingEnabled()) return null;
  const { plan, used, limit } = await usageFor(db, userId);
  if (used + n <= limit) return null;
  const next = { free: 'basic', basic: 'pro', pro: 'elite' }[plan];
  return upgrade(`You've used all ${limit} cards in your ${PLANS[plan].name} plan this month.${next ? ` ${PLANS[next].name} includes ${PLANS[next].cards.toLocaleString('en-US')} a month.` : ' Your count resets on the 1st.'}`,
    { feature: 'cards', need: next || null, plan, used, limit });
}

// ---------- Stripe ----------
const STRIPE = 'https://api.stripe.com/v1';
// Stripe's form encoding: nested objects and arrays as a[b][0]=c.
export function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? formEncode(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(method, path, params = null, { fetchImpl = fetch, key = process.env.STRIPE_SECRET_KEY } = {}) {
  if (!key) throw Object.assign(new Error('Billing is not set up yet (STRIPE_SECRET_KEY is missing in Netlify).'), { status: 503 });
  const qs = method === 'GET' && params ? `?${formEncode(params)}` : '';
  const res = await fetchImpl(`${STRIPE}${path}${qs}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' || !params ? undefined : formEncode(params).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error?.message || `Stripe ${res.status}`), { status: res.status >= 500 ? 502 : 400 });
  return body;
}

async function priceId(plan, interval, opts) {
  const key = priceLookupKey(plan, interval);
  const r = await stripe('GET', '/prices', { lookup_keys: [key], active: true, limit: 1 }, opts);
  if (!r.data?.[0]) throw Object.assign(new Error(`No Stripe price found for ${key}.`), { status: 500 });
  return r.data[0].id;
}

async function customerFor(db, user, opts) {
  const sub = await getSubscription(db, user.id);
  if (sub?.stripe_customer_id) return sub.stripe_customer_id;
  const c = await stripe('POST', '/customers', { email: user.email, metadata: { app: 'tyche_cards', user_id: user.id } }, opts);
  await must(db.from('subscriptions').upsert({ user_id: user.id, plan: sub?.plan || 'free', status: sub?.status || 'active', stripe_customer_id: c.id, updated_at: new Date().toISOString() }, { onConflict: 'user_id' }));
  return c.id;
}

// A Stripe Checkout page for a paid plan. Users who already pay change plans in the portal instead.
export async function checkoutUrl({ db, user, plan, interval, origin, opts }) {
  if (!['basic', 'pro', 'elite'].includes(plan)) throw Object.assign(new Error('Choose Basic, Pro or Elite.'), { status: 400 });
  if (!['month', 'year'].includes(interval)) throw Object.assign(new Error('Choose monthly or yearly.'), { status: 400 });
  const sub = await getSubscription(db, user.id);
  if (sub?.comped) throw Object.assign(new Error('Your account is on a complimentary plan already.'), { status: 409 });
  if (sub?.stripe_subscription_id && ['active', 'trialing', 'past_due'].includes(sub.status)) {
    return portalUrl({ db, user, origin, opts });   // change plan there, with proration
  }
  const customer = await customerFor(db, user, opts);
  const s = await stripe('POST', '/checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: user.id,
    line_items: [{ price: await priceId(plan, interval, opts), quantity: 1 }],
    allow_promotion_codes: true, automatic_tax: { enabled: process.env.STRIPE_AUTOMATIC_TAX === 'true' },
    customer_update: process.env.STRIPE_AUTOMATIC_TAX === 'true' ? { address: 'auto' } : undefined,
    subscription_data: { metadata: { app: 'tyche_cards', user_id: user.id, plan } },
    metadata: { app: 'tyche_cards', user_id: user.id, plan },
    success_url: `${origin}/app?billing=success`, cancel_url: `${origin}/app?billing=cancelled`,
  }, opts);
  return s.url;
}

export async function portalUrl({ db, user, origin, opts }) {
  const sub = await getSubscription(db, user.id);
  if (!sub?.stripe_customer_id) throw Object.assign(new Error('There is no billing account yet. Choose a plan first.'), { status: 409 });
  const s = await stripe('POST', '/billing_portal/sessions', { customer: sub.stripe_customer_id, return_url: `${origin}/app` }, opts);
  return s.url;
}

// A Stripe subscription -> our row. The plan comes from the price's lookup key.
export function rowFromSubscription(s) {
  const item = s.items?.data?.[0];
  const key = item?.price?.lookup_key || '';
  const m = key.match(/^tyche_(basic|pro|elite)_(month|year)$/);
  const end = item?.current_period_end ?? s.current_period_end;
  return {
    plan: m ? m[1] : (s.metadata?.plan || 'free'),
    billing_interval: m ? m[2] : (item?.price?.recurring?.interval || null),
    status: s.status,
    stripe_subscription_id: s.id,
    stripe_customer_id: typeof s.customer === 'string' ? s.customer : s.customer?.id,
    current_period_end: end ? new Date(end * 1000).toISOString() : null,
    cancel_at_period_end: !!s.cancel_at_period_end,
    updated_at: new Date().toISOString(),
  };
}

// Webhook: the event is fetched back from Stripe by id, so only genuine events are acted on
// (no signing secret to manage). Returns what was done, for the log.
export async function handleStripeEvent({ db, eventId, opts }) {
  if (!/^evt_[A-Za-z0-9]+$/.test(String(eventId || ''))) throw Object.assign(new Error('Not a Stripe event.'), { status: 400 });
  const ev = await stripe('GET', `/events/${eventId}`, null, opts);
  const obj = ev.data?.object || {};
  let subscription = null;
  if (ev.type === 'checkout.session.completed' && obj.mode === 'subscription' && obj.subscription) {
    subscription = await stripe('GET', `/subscriptions/${obj.subscription}`, null, opts);
  } else if (/^customer\.subscription\.(created|updated|deleted|paused|resumed)$/.test(ev.type)) {
    subscription = await stripe('GET', `/subscriptions/${obj.id}`, null, opts);   // the latest state, not the event's snapshot
  } else {
    return { ignored: ev.type };
  }
  if (subscription.metadata?.app && subscription.metadata.app !== 'tyche_cards') return { ignored: 'other app' };
  const row = rowFromSubscription(subscription);
  // Which user: the subscription's metadata, else the customer we created for them.
  let userId = subscription.metadata?.user_id || obj.client_reference_id || null;
  if (!userId) {
    const hit = await must(db.from('subscriptions').select('user_id').eq('stripe_customer_id', row.stripe_customer_id));
    userId = hit[0]?.user_id || null;
  }
  if (!userId) return { ignored: 'no matching user' };
  const existing = await getSubscription(db, userId);
  if (existing?.comped) return { ignored: 'comped account' };
  await must(db.from('subscriptions').upsert({ user_id: userId, comped: false, ...row }, { onConflict: 'user_id' }));
  return { userId, plan: row.plan, status: row.status };
}
