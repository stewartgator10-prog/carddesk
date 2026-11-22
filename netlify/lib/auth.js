// netlify/lib/auth.js
// Verifies the Supabase session JWT the browser sends as "Authorization: Bearer <token>".
// Contract (shared with the Supabase-login work): requireUser(req) resolves to
// { user, token } on success, or a 401 Response to return as-is.
// NOTE: the login branch ships its own copy of this file with the same contract;
// if both land, keep that one.
import { createClient } from '@supabase/supabase-js';

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export async function requireUser(req) {
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return json(401, { error: 'Not signed in.' });

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  if (!url || !key) return json(500, { error: 'Supabase env vars missing on the server.' });

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return json(401, { error: 'Session expired. Sign in again.' });
  return { user: data.user, token };
}
