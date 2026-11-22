// netlify/functions/ebay-connect.js
// POST /api/ebay-connect  (signed-in user) -> { url } to send the browser to eBay's consent page.
import crypto from 'node:crypto';
import { requireUser } from '../lib/auth.js';
import { buildAuthorizeUrl, getSupabaseAdmin, json } from '../lib/ebay-seller.js';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    const supabase = getSupabaseAdmin();
    const state = crypto.randomBytes(24).toString('base64url');
    // Clean up stale states, then store this one.
    await supabase.from('ebay_oauth_states').delete().lt('created_at', new Date(Date.now() - 15 * 60_000).toISOString());
    const { error } = await supabase.from('ebay_oauth_states').insert({ state, user_id: auth.user.id });
    if (error) throw error;
    return json(200, { url: buildAuthorizeUrl(state) });
  } catch (err) {
    return json(500, { error: err.message });
  }
};
