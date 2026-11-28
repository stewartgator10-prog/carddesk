import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && anonKey);

export const supabase = supabaseConfigured
  ? createClient(url, anonKey, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

// fetch() for our own Netlify Functions, with the signed-in user's token attached.
export async function apiFetch(path, init = {}) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init.headers || {});
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  // A plan limit (Tyche Cards): tell the app so it can offer the upgrade. The caller still gets the response.
  if (res.status === 402) {
    res.clone().json().then((b) => { if (b?.code === 'UPGRADE') window.dispatchEvent(new CustomEvent('tyche:upgrade', { detail: b })); }).catch(() => {});
  }
  return res;
}
