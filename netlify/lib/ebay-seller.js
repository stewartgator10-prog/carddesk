// PROVISIONAL STAND-IN. The real file comes from the "Connect eBay seller
// account" branch; when merging, keep that version and delete this one.
// Same contract: getSupabaseAdmin(), getSellerAccessToken(supabaseAdmin, userId).
import { createClient } from '@supabase/supabase-js';

let admin;
export function getSupabaseAdmin() {
  admin ||= createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  return admin;
}

export async function getSellerAccessToken(db, userId) {
  const { data: acct, error } = await db.from('ebay_accounts').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!acct) throw Object.assign(new Error('eBay account not connected'), { status: 401 });
  if (acct.access_token && new Date(acct.access_token_expires_at) - Date.now() > 5 * 60_000) return acct.access_token;

  const basic = Buffer.from(`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: acct.refresh_token, scope: acct.scopes || '' }),
  });
  if (!res.ok) throw Object.assign(new Error(`eBay token refresh failed: ${res.status}`), { status: 401, detail: await res.text() });
  const t = await res.json();
  await db.from('ebay_accounts').update({
    access_token: t.access_token,
    access_token_expires_at: new Date(Date.now() + t.expires_in * 1000).toISOString(),
  }).eq('user_id', userId);
  return t.access_token;
}
