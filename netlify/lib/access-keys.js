// netlify/lib/access-keys.js
// Personal access keys: a long random secret the seller pastes into an AI app (Muse, Grok...) that
// can't run the OAuth "Sign in with CardDesk" flow. The connector accepts it in place of a sign-in.
// Only a SHA-256 hash is stored, so a database leak doesn't leak working keys.
import crypto from 'node:crypto';

export const KEY_PREFIX = 'cdk_';
export const MAX_KEYS = 10;
const hashKey = (key) => crypto.createHash('sha256').update(String(key)).digest('hex');
async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const view = (k) => ({ id: k.id, name: k.name, prefix: k.prefix, created_at: k.created_at, last_used_at: k.last_used_at || null });

export const looksLikeKey = (s) => typeof s === 'string' && s.startsWith(KEY_PREFIX) && s.length >= 30;

export async function createKey({ db, user, name }) {
  const label = String(name || '').trim().slice(0, 40) || 'AI app';
  const active = await must(db.from('access_keys').select('id').eq('user_id', user.id).is('revoked_at', null));
  if (active.length >= MAX_KEYS) throw fail(`You already have ${MAX_KEYS} keys. Revoke one you no longer use first.`, 409);
  const key = `${KEY_PREFIX}${crypto.randomBytes(24).toString('base64url')}`;
  const row = { id: crypto.randomUUID(), user_id: user.id, email: user.email || null, name: label, prefix: key.slice(0, 10), key_hash: hashKey(key), created_at: new Date().toISOString(), last_used_at: null, revoked_at: null };
  await must(db.from('access_keys').insert(row));
  return { ...view(row), key };   // the only time the key itself leaves the server
}

export async function listKeys({ db, userId }) {
  const rows = await must(db.from('access_keys').select('*').eq('user_id', userId).is('revoked_at', null));
  return rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(view);
}

export async function revokeKey({ db, userId, id }) {
  const rows = await must(db.from('access_keys').select('id').eq('user_id', userId).eq('id', id).is('revoked_at', null));
  if (!rows.length) throw fail('Key not found.', 404);
  await must(db.from('access_keys').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId).eq('id', id));
  return { revoked: id };
}

// The signed-in user a key belongs to, or null. The owner's email must still be on ALLOWED_EMAILS
// (when that list is set), so removing someone from it also stops their keys.
export async function userFromKey({ db, key, allowedEmails = process.env.ALLOWED_EMAILS || '' }) {
  if (!looksLikeKey(key)) return null;
  const rows = await must(db.from('access_keys').select('*').eq('key_hash', hashKey(key)).is('revoked_at', null));
  const k = rows[0];
  if (!k) return null;
  const allowed = String(allowedEmails).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (allowed.length && !allowed.includes(String(k.email || '').toLowerCase())) return null;
  // Note the last use, at most once a minute.
  if (!k.last_used_at || Date.now() - Date.parse(k.last_used_at) > 60_000) {
    await db.from('access_keys').update({ last_used_at: new Date().toISOString() }).eq('id', k.id);
  }
  return { id: k.user_id, email: k.email, via: 'access_key', keyName: k.name };
}
