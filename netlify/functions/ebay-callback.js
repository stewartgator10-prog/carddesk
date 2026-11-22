// netlify/functions/ebay-callback.js
// GET /api/ebay-callback?code=...&state=...
// Set this URL as the "auth accepted URL" on your RuName in the eBay developer portal:
//   https://<your-site>/api/ebay-callback
// (and the same URL with ?declined=1 as the "auth declined URL").
import { connectWithCode, getSupabaseAdmin } from '../lib/ebay-seller.js';

const appUrl = () => process.env.APP_URL || process.env.URL || '';
const back = (params) =>
  new Response(null, { status: 302, headers: { Location: `${appUrl()}/?tab=listings&${new URLSearchParams(params)}` } });

export default async (req) => {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  // Log which parameters eBay sent (names only, never values) to debug redirects.
  console.log('ebay-callback params:', [...url.searchParams.keys()].join(',') || '(none)');

  if (url.searchParams.get('declined') || url.searchParams.get('error') || !code) {
    return back({ ebay: 'declined' });
  }
  if (!state) return back({ ebay: 'error', reason: 'missing state, use Connect eBay in CardDesk' });

  try {
    const supabase = getSupabaseAdmin();
    const { data: st, error: stErr } = await supabase
      .from('ebay_oauth_states').delete().eq('state', state).select().maybeSingle();
    if (stErr) throw stErr;
    if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) {
      return back({ ebay: 'error', reason: 'link expired, try Connect again' });
    }
    await connectWithCode(supabase, st.user_id, code);
    return back({ ebay: 'connected' });
  } catch (err) {
    console.error('ebay-callback', err);
    return back({ ebay: 'error', reason: err.message.slice(0, 200) });
  }
};
