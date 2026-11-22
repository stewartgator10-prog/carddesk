// netlify/functions/ebay-callback.js
// GET /api/ebay-callback?code=...&state=...
// Set this URL as the "auth accepted URL" on your RuName in the eBay developer portal:
//   https://<your-site>/api/ebay-callback
// (and the same URL with ?declined=1 as the "auth declined URL").
import {
  exchangeCodeForTokens, getEbayIdentity, getSupabaseAdmin, EBAY_SCOPES,
} from '../lib/ebay-seller.js';

const appUrl = () => process.env.APP_URL || process.env.URL || '';
const back = (params) =>
  new Response(null, { status: 302, headers: { Location: `${appUrl()}/?tab=listings&${new URLSearchParams(params)}` } });

export default async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (url.searchParams.get('declined') || url.searchParams.get('error') || !code) {
    return back({ ebay: 'declined' });
  }
  if (!state) return back({ ebay: 'error', reason: 'missing state' });

  try {
    const supabase = getSupabaseAdmin();
    const { data: st, error: stErr } = await supabase
      .from('ebay_oauth_states').delete().eq('state', state).select().maybeSingle();
    if (stErr) throw stErr;
    if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) {
      return back({ ebay: 'error', reason: 'link expired, try Connect again' });
    }

    const t = await exchangeCodeForTokens(code);
    const identity = await getEbayIdentity(t.access_token);
    const now = Date.now();
    const row = {
      user_id: st.user_id,
      ...identity,
      access_token: t.access_token,
      access_token_expires_at: new Date(now + t.expires_in * 1000).toISOString(),
      refresh_token: t.refresh_token,
      refresh_token_expires_at: t.refresh_token_expires_in
        ? new Date(now + t.refresh_token_expires_in * 1000).toISOString() : null,
      scopes: EBAY_SCOPES.join(' '),
      updated_at: new Date(now).toISOString(),
    };
    const { error } = await supabase.from('ebay_accounts').upsert(row, { onConflict: 'user_id' });
    if (error) throw error;
    return back({ ebay: 'connected' });
  } catch (err) {
    console.error('ebay-callback', err);
    return back({ ebay: 'error', reason: err.message.slice(0, 200) });
  }
};
