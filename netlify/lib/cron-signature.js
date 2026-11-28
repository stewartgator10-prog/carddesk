// netlify/lib/cron-signature.js
// Scheduled functions start long-running background jobs by calling them over HTTP. That call is
// signed with an HMAC of a purpose and a timestamp, keyed by the server-only service-role key, so
// nobody else can trigger a job, a signature for one job can't start another, and no extra secret
// needs to be configured. Purposes: 'market-refresh' (nightly comps), 'sales-check' (sell once).
import crypto from 'node:crypto';

const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';
export const PURPOSES = ['market-refresh', 'sales-check'];

export function signCron(ts = Date.now(), purpose = 'market-refresh') {
  return { ts: String(ts), sig: crypto.createHmac('sha256', key()).update(`${purpose}:${ts}`).digest('hex') };
}

export function verifyCron(ts, sig, now = Date.now(), maxAgeMs = 10 * 60_000, purpose = 'market-refresh') {
  if (!key() || !ts || !sig || !/^\d+$/.test(String(ts)) || !PURPOSES.includes(purpose)) return false;
  if (Math.abs(now - Number(ts)) > maxAgeMs) return false;
  const expected = Buffer.from(signCron(ts, purpose).sig, 'hex');
  const given = Buffer.from(String(sig), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
