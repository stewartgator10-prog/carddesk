// netlify/functions/snap-trial.js
// Head-to-head model trial on the seller's own eBay listings (photo + title = known answer).
//   GET  /api/snap-trial?n=30                       -> { items, models, estimate }  sample to run
//   POST /api/snap-trial { trialId, model, itemId } -> one scored result, saved to model_trial_results
// The browser runs the cases one by one so each request stays well inside the function time limit.
// Only listings that belong to the signed-in user can be used, so no outside URLs are fetched.
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, json } from '../lib/ebay-seller.js';
import { pickTrialListings, runTrialCase } from '../lib/snap-identify.js';
import { SNAP_MODELS } from '../lib/card-vision.js';
import { costOf } from '../lib/ai-usage.js';

// Rough per-card size for the estimate: a ~1,500px photo plus the prompt in, a short JSON answer
// plus a little thinking out. The real cost of each call is measured and logged.
const EST_USAGE = { input_tokens: 2600, output_tokens: 700 };

export default async (req) => {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;
  const db = getSupabaseAdmin();

  try {
    if (req.method === 'GET') {
      const n = Math.min(Math.max(parseInt(new URL(req.url).searchParams.get('n'), 10) || 30, 1), 60);
      const { data, error } = await db.from('ebay_listings')
        .select('item_id, title, price, image_url').eq('user_id', userId).eq('status', 'Active');
      if (error) throw new Error(error.message);
      const items = pickTrialListings(data || [], n);
      const estimate = Object.fromEntries(SNAP_MODELS.map((m) => [m, Math.round(costOf(m, EST_USAGE) * items.length * 1e4) / 1e4]));
      return json(200, { items, models: SNAP_MODELS, estimate });
    }

    if (req.method === 'POST') {
      const { trialId, model, itemId } = (await req.json().catch(() => null)) || {};
      if (!trialId || !/^[\w-]{4,64}$/.test(String(trialId))) return json(400, { error: 'trialId is required' });
      if (!SNAP_MODELS.includes(model)) return json(400, { error: `model must be one of ${SNAP_MODELS.join(', ')}` });
      const { data: listing, error } = await db.from('ebay_listings')
        .select('item_id, title, price, image_url').eq('user_id', userId).eq('item_id', String(itemId)).maybeSingle();
      if (error) throw new Error(error.message);
      if (!listing) return json(404, { error: 'Listing not found' });
      return json(200, { result: await runTrialCase({ db, userId, trialId: String(trialId), model, listing }) });
    }

    return json(405, { error: 'Use GET or POST.' });
  } catch (err) {
    console.error('snap-trial', err);
    const status = err.code === 'BUDGET' ? 429 : err.code === 'NO_API_KEY' ? 503 : 500;
    return json(status, { error: err.message, code: err.code || null });
  }
};

export const config = { path: '/api/snap-trial' };
