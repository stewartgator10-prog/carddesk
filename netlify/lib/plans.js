// netlify/lib/plans.js
// Tyche Cards plans: what each includes and costs. Shared by the server (limits) and the app
// (pricing, upgrade prompts). Browser-safe: no Node imports.
//
// Plans are enforced only where BILLING_ENABLED is set (the Tyche Cards site). The founder
// site leaves it unset, so everyone there has every feature with no card limit.

export const PLAN_ORDER = ['free', 'basic', 'pro', 'elite'];

export const PLANS = {
  free: { name: 'Free', month: 0, year: 0, cards: 25,
    blurb: 'Try it on your next stack.',
    features: ['25 cards a month', 'AI card identification and pricing', 'Automatic photo cleanup', 'Publish to eBay'] },
  basic: { name: 'Basic', month: 19, year: 190, cards: 300,
    blurb: 'For steady weekly listers.',
    features: ['300 cards a month', 'Everything in Free', 'Edit live eBay listings', 'Email support'] },
  pro: { name: 'Pro', month: 39, year: 390, cards: 1000, popular: true,
    blurb: 'Run the whole selling side.',
    features: ['1,000 cards a month', 'Everything in Basic', 'Repricer with market and comps', 'Best Offer and promotion on every listing', 'Collection tracking with sell alerts', 'Profit per card and sales matching', 'List on Whatnot too, sold once everywhere'] },
  elite: { name: 'Elite', month: 79, year: 790, cards: 3000,
    blurb: 'For high-volume sellers and shops.',
    features: ['3,000 cards a month', 'Everything in Pro', 'Buy offers from a binder photo', 'AI app connector (Claude, Muse and others)', 'Import your existing eBay listings', 'Priority support'] },
};

// The lowest plan that includes each feature.
export const FEATURE_PLAN = {
  live_edit: 'basic',
  repricer: 'pro',
  automation: 'pro',     // Best Offer and promotion on new listings
  collection: 'pro',
  profit: 'pro',
  cross_list: 'pro',   // listing on Whatnot (and later Shopify, TCGplayer)
  buy_offers: 'elite',
  connector: 'elite',
  import: 'elite',
};

export const FEATURE_LABELS = {
  live_edit: 'Editing live eBay listings',
  repricer: 'The repricer',
  automation: 'Automatic Best Offer and promotion',
  collection: 'Collection tracking',
  profit: 'Profit and sales tracking',
  cross_list: 'Listing on more marketplaces',
  buy_offers: 'Buy offers',
  connector: 'The AI app connector',
  import: 'Importing existing eBay listings',
};

export const priceLookupKey = (plan, interval) => `tyche_${plan}_${interval}`;
export const planRank = (plan) => Math.max(0, PLAN_ORDER.indexOf(plan));
export const hasFeature = (plan, feature) => planRank(plan) >= planRank(FEATURE_PLAN[feature] || 'free');
export const cardLimit = (plan) => (PLANS[plan] || PLANS.free).cards;

// A subscription row -> the plan in effect. Lapsed or unpaid subscriptions fall back to Free.
const LIVE = ['active', 'trialing', 'past_due', 'comped'];
export function effectivePlan(row, now = Date.now()) {
  if (!row || !PLANS[row.plan]) return 'free';
  if (row.comped) return row.plan;
  if (!LIVE.includes(row.status)) return 'free';
  if (row.current_period_end && Date.parse(row.current_period_end) + 3 * 86400_000 < now) return 'free';   // 3 days' grace
  return row.plan;
}

export const monthStartIso = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
