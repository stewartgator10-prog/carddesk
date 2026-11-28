// netlify/functions/stripe-webhook.js
// POST /api/stripe-webhook  (called by Stripe)
// Keeps each user's plan in step with Stripe: checkout completed, plan changed, renewed, cancelled.
// The event is re-read from Stripe by its id before anything changes, so a forged request can't
// grant a plan. No signing secret is needed.
import { getSupabaseAdmin, json } from '../lib/ebay-seller.js';
import { billingEnabled, handleStripeEvent } from '../lib/billing.js';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
  if (!billingEnabled()) return json(200, { ignored: 'billing off on this site' });
  const body = await req.json().catch(() => null);
  try {
    const r = await handleStripeEvent({ db: getSupabaseAdmin(), eventId: body?.id });
    console.info('stripe event', body?.type, JSON.stringify(r));
    return json(200, { received: true });
  } catch (err) {
    console.error('stripe webhook', err.message);
    return json(err.status && err.status < 500 ? 400 : 500, { error: err.message });   // 5xx: Stripe retries
  }
};

export const config = { path: '/api/stripe-webhook' };
