// netlify/functions/ebay-listings.js
// GET  /api/ebay-listings          -> { account, listings }  (account is null if not connected)
// POST /api/ebay-listings          -> runs a sync from eBay, then returns { account, listings, sync }
// DELETE /api/ebay-listings        -> disconnects the eBay account (deletes tokens + listing snapshot)
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, json, syncListings } from '../lib/ebay-seller.js';

async function load(supabase, userId) {
  const { data: acct, error } = await supabase.from('ebay_accounts')
    .select('ebay_username, last_synced_at, created_at, refresh_token_expires_at')
    .eq('user_id', userId).maybeSingle();
  if (error) throw error;
  if (!acct) return { account: null, listings: [] };
  const { data: listings, error: lErr } = await supabase.from('ebay_listings')
    .select('item_id, title, sku, price, currency, quantity, quantity_available, quantity_sold, watch_count, listing_type, start_time, end_time, view_url, image_url, status, synced_at')
    .eq('user_id', userId)
    .order('status', { ascending: true })
    .order('start_time', { ascending: false });
  if (lErr) throw lErr;
  return { account: acct, listings };
}

export default async (req) => {
  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;
  const userId = auth.user.id;

  try {
    const supabase = getSupabaseAdmin();
    if (req.method === 'GET') return json(200, await load(supabase, userId));

    if (req.method === 'POST') {
      const sync = await syncListings(supabase, userId);
      return json(200, { ...(await load(supabase, userId)), sync });
    }

    if (req.method === 'DELETE') {
      const { error } = await supabase.from('ebay_accounts').delete().eq('user_id', userId);
      if (error) throw error;
      return json(200, { account: null, listings: [] });
    }

    return json(405, { error: 'Method not allowed.' });
  } catch (err) {
    const status = err.code === 'EBAY_NOT_CONNECTED' || err.code === 'EBAY_RECONNECT' ? 409 : 500;
    console.error('ebay-listings', err);
    return json(status, { error: err.message, code: err.code || null });
  }
};
