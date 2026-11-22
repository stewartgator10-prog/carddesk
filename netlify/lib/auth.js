// PROVISIONAL STAND-IN. The real file comes from the "Move carddesk data to
// Supabase" branch; when merging, keep that version and delete this one.
// Same contract: requireUser(req) -> { user, token } or a 401 Response.
import { createClient } from '@supabase/supabase-js';

export async function requireUser(req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const unauthorized = new Response(JSON.stringify({ error: 'Sign in required' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  if (!token) return unauthorized;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const { data, error } = await createClient(url, anon).auth.getUser(token);
  if (error || !data?.user) return unauthorized;
  return { user: data.user, token };
}
