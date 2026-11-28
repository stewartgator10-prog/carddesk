// netlify/functions/billing.js
// Plan & billing for the signed-in user (Tyche Cards).
//   GET  /api/billing                                  -> { enabled, plan, used, limit, subscription }
//   POST /api/billing { action: 'checkout', plan, interval }  -> { url }  Stripe Checkout (or the portal if already paying)
//   POST /api/billing { action: 'portal' }                    -> { url }  Stripe customer portal: change plan, card, cancel
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, json } from '../lib/ebay-seller.js';
import { billingEnabled, usageFor, getSubscription, checkoutUrl, portalUrl } from '../lib/billing.js';

const originOf = (req) => process.env.SITE_URL || process.env.URL || new URL(req.url).origin;

export default async (req) => {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const db = getSupabaseAdmin();
  try {
    if (req.method === 'GET') {
      const usage = await usageFor(db, auth.user.id);
      const sub = billingEnabled() ? await getSubscription(db, auth.user.id) : null;
      return json(200, { enabled: billingEnabled(), ...usage,
        subscription: sub && { plan: sub.plan, status: sub.status, interval: sub.billing_interval, renews: sub.current_period_end, cancelAtPeriodEnd: sub.cancel_at_period_end, comped: sub.comped, hasBilling: !!sub.stripe_customer_id } });
    }
    if (req.method !== 'POST') return json(405, { error: 'Use GET or POST.' });
    if (!billingEnabled()) return json(409, { error: 'Billing is not used on this site.' });
    const body = (await req.json().catch(() => null)) || {};
    const origin = originOf(req);
    if (body.action === 'checkout') return json(200, { url: await checkoutUrl({ db, user: auth.user, plan: body.plan, interval: body.interval, origin }) });
    if (body.action === 'portal') return json(200, { url: await portalUrl({ db, user: auth.user, origin }) });
    return json(400, { error: 'Unknown action.' });
  } catch (err) {
    console.error('billing', err);
    return json(err.status || 500, { error: err.message });
  }
};

export const config = { path: '/api/billing' };
