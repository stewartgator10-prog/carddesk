// netlify/functions/snap-identify.js
// POST /api/snap-identify { id }  (signed-in user)
// Identifies one queued card photo: Claude read -> catalog match -> price and title -> review flags.
// Returns { item, cost, budget }. Every Claude call is logged to api_usage with its estimated cost.
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, json } from '../lib/ebay-seller.js';
import { identifySnapItem } from '../lib/snap-identify.js';
import { requireFeature, requireCards } from '../lib/billing.js';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const { id } = (await req.json().catch(() => null)) || {};
  if (!id || typeof id !== 'string') return json(400, { error: 'id is required' });

  const db = getSupabaseAdmin();
  const { data: item, error } = await db.from('snap_items').select('*').eq('id', id).eq('user_id', auth.user.id).maybeSingle();
  if (error) return json(500, { error: error.message });
  if (!item) return json(404, { error: 'Card not found' });
  if (['approved', 'listed', 'discarded'].includes(item.status)) return json(409, { error: `This card is already ${item.status}.` });
  if (!item.identified_at) { const no = await requireCards(db, auth.user.id, 1); if (no) return no; }

  try {
    return json(200, await identifySnapItem({ db, userId: auth.user.id, item }));
  } catch (err) {
    console.error('snap-identify', err);
    const status = err.code === 'BUDGET' ? 429 : err.code === 'NO_API_KEY' ? 503 : 502;
    return json(status, { error: err.message, code: err.code || null });
  }
};

export const config = { path: '/api/snap-identify' };
