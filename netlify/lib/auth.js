// Shared by the Netlify Functions: only signed-in CardDesk users may call them.
// The browser sends the Supabase access token as `Authorization: Bearer <token>`.
// We ask Supabase Auth who the token belongs to (this also catches expired or
// signed-out tokens), and optionally check the email against ALLOWED_EMAILS.

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;

const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Small cache so a burst of searches doesn't hit Supabase Auth every time.
const cache = new Map(); // token -> { user, expires }

export async function requireUser(req) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return json(500, { error: 'Server is missing SUPABASE_URL / SUPABASE_ANON_KEY.' });
  }
  const header = req.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return json(401, { error: 'Sign in to use this.' });

  const hit = cache.get(token);
  let user = hit && hit.expires > Date.now() ? hit.user : null;

  if (!user) {
    let res;
    try {
      res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
      });
    } catch {
      return json(503, { error: 'Could not reach the sign-in service. Try again.' });
    }
    if (!res.ok) return json(401, { error: 'Your session has expired. Sign in again.' });
    user = await res.json();
    if (cache.size > 200) cache.clear();
    cache.set(token, { user, expires: Date.now() + 60_000 });
  }

  const allowed = (process.env.ALLOWED_EMAILS || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes((user.email || '').toLowerCase())) {
    return json(403, { error: 'This account is not allowed to use CardDesk.' });
  }

  return { user, token };
}
