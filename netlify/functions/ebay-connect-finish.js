// netlify/functions/ebay-connect-finish.js
// POST /api/ebay-connect-finish  { url }   (signed-in user)
// Fallback for when eBay leaves the user on its own "Authorization successfully
// completed" page instead of redirecting back. That page's address contains the
// one-time ?code=... ; the user pastes the address and we finish the connection.
// The code expires about 5 minutes after it is issued.
import { requireUser } from '../lib/auth.js';
import { connectWithCode, getSupabaseAdmin, json } from '../lib/ebay-seller.js';

export default async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  let pasted = '';
  try { pasted = String((await req.json()).url || '').trim(); } catch { /* handled below */ }

  let code = null;
  let state = null;
  try {
    const u = new URL(pasted);
    if (!/(^|\.)ebay\.com$/i.test(u.hostname)) throw new Error('not ebay');
    code = u.searchParams.get('code');
    state = u.searchParams.get('state');
  } catch {
    return json(400, { error: "That doesn't look like the address of eBay's page. Copy the full address from the browser bar." });
  }
  if (!code) return json(400, { error: "That eBay address has no sign-in code in it. Click Connect eBay again, then copy the address of eBay's Thank You page." });

  try {
    const supabase = getSupabaseAdmin();
    // If eBay kept our state, it must belong to this user.
    if (state) {
      const { data: st } = await supabase.from('ebay_oauth_states')
        .delete().eq('state', state).select().maybeSingle();
      if (st && st.user_id !== auth.user.id) return json(403, { error: 'This eBay sign-in was started by a different CardDesk user.' });
    }
    const identity = await connectWithCode(supabase, auth.user.id, code);
    return json(200, { ok: true, ebay_username: identity.ebay_username || null });
  } catch (err) {
    console.error('ebay-connect-finish', err);
    const expired = /invalid_grant|expired/i.test(err.message);
    return json(400, {
      error: expired
        ? 'That eBay code has expired (they last about 5 minutes). Click Connect eBay again and paste the new address right away.'
        : err.message,
    });
  }
};
