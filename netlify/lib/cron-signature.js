// netlify/lib/cron-signature.js
// The nightly schedule starts the long-running refresh by calling a background function over HTTP.
// That call is signed with an HMAC of a timestamp, keyed by the server-only service-role key,
// so nobody else can trigger the job and no extra secret needs to be configured.
import crypto from 'node:crypto';

const key = () => process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export function signCron(ts = Date.now()) {
  return { ts: String(ts), sig: crypto.createHmac('sha256', key()).update(`market-refresh:${ts}`).digest('hex') };
}

export function verifyCron(ts, sig, now = Date.now(), maxAgeMs = 10 * 60_000) {
  if (!key() || !ts || !sig || !/^\d+$/.test(String(ts))) return false;
  if (Math.abs(now - Number(ts)) > maxAgeMs) return false;
  const expected = Buffer.from(signCron(ts).sig, 'hex');
  const given = Buffer.from(String(sig), 'hex');
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
