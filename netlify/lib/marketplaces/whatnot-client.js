// netlify/lib/marketplaces/whatnot-client.js
// Talks to the Whatnot Seller API (beta): https://api.whatnot.com/seller-api/rest/v2
// - Authorization: Bearer <token>. The token is only ever placed in that header.
// - Whatnot allows 10 requests/second per seller; we keep to 8 (one request start every 125 ms per
//   seller, shared by every client in this function run) and on 429 wait Retry-After (max 10 s) and
//   retry up to 2 times, then give up with `rate_limited`.
// - 10 s timeout per request.
// - Errors become MarketplaceError with a message the seller can act on.
// `fetchImpl`, `sleep` and `now` are injectable so tests never reach Whatnot.
import { MarketplaceError } from './errors.js';

export const WHATNOT_API = 'https://api.whatnot.com/seller-api/rest/v2';
export const MIN_INTERVAL_MS = 125;     // 8 requests/second
export const TIMEOUT_MS = 10_000;
export const MAX_RETRIES = 2;
export const MAX_RETRY_WAIT_MS = 10_000;

const nextSlot = new Map();   // seller key -> earliest time the next request may start

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Whatnot's own words for a refused request. The spec documents one error body, for 422:
// HTTPValidationError { detail: [{ loc, msg, type }] }. 401/403/404/409 have no documented body; a
// merchandising 422 for a product that isn't ready "lists each field to fix" in `errors`. Anything
// else readable (a string detail or message) is used as is.
export function whatnotMessage(body) {
  if (!body || typeof body !== 'object') return typeof body === 'string' && !/^\s*</.test(body) ? body.slice(0, 200) : '';
  const d = body.detail ?? body.message ?? body.error ?? body.errors;
  if (typeof d === 'string') return d.slice(0, 200);
  if (Array.isArray(d)) {
    return d.map((x) => {
      if (typeof x === 'string') return x;
      const where = Array.isArray(x?.loc) ? x.loc.filter((p) => p !== 'body').join('.') : x?.field || '';
      const what = x?.msg || x?.message || x?.code || '';
      return where && what ? `${where}: ${what}` : what || where;
    }).filter(Boolean).join('; ').slice(0, 200);
  }
  if (d && typeof d === 'object') return whatnotMessage(d);
  return '';
}

// A refused request as an error the seller can act on. Whatnot's HTTP status is kept in `detail`
// for logs only: our endpoints answer with their own status for the error's code (httpStatusFor).
export function errorFor(status, said = '') {
  const d = { detail: { whatnotStatus: status } };
  if (status === 401) return new MarketplaceError('reconnect', 'Whatnot stopped accepting your token, so we can\'t see Whatnot sales. Paste a new one in Marketplaces.', d);
  if (status === 403) return new MarketplaceError('missing_scope', `Your Whatnot token is missing a permission this needs${said ? ` (${said})` : ''}. Make a new token with every box from the Marketplaces page ticked.`, d);
  if (status === 404) return new MarketplaceError('not_found', 'Whatnot can\'t find that listing any more.', d);
  if (status === 409) return new MarketplaceError('rejected', `Whatnot can't do that to this listing right now${said ? ` (${said})` : ''}. Check it on Whatnot.`, d);
  if (status === 429) return new MarketplaceError('rate_limited', 'Whatnot is busy, try again in a minute.', d);
  if (status >= 500) return new MarketplaceError('unavailable', 'Whatnot isn\'t answering right now. Try again in a few minutes.', d);
  return new MarketplaceError('rejected', said ? `Whatnot said: ${said}` : 'Whatnot turned that down. Check the card\'s details and try again.', d);
}

function retryAfterMs(res) {
  const v = res.headers?.get?.('retry-after');
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.min(n * 1000, MAX_RETRY_WAIT_MS);
  const at = v ? Date.parse(v) : NaN;
  if (Number.isFinite(at)) return Math.min(Math.max(0, at - Date.now()), MAX_RETRY_WAIT_MS);
  return 1000;
}

export function whatnotClient({ token, key = 'default', fetchImpl = fetch, sleep = realSleep, now = Date.now, minIntervalMs = MIN_INTERVAL_MS, timeoutMs = TIMEOUT_MS } = {}) {
  if (!token) throw new MarketplaceError('reconnect', 'Whatnot isn\'t connected. Paste a Whatnot token in Marketplaces.');

  async function throttle() {
    const t = now();
    const slot = Math.max(t, nextSlot.get(key) || 0);
    nextSlot.set(key, slot + minIntervalMs);
    if (slot > t) await sleep(slot - t);
  }

  async function once(method, url, body) {
    await throttle();
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
      return await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctl?.signal,
      });
    } catch (e) {
      const timedOut = e?.name === 'AbortError';
      throw new MarketplaceError('unavailable', timedOut ? 'Whatnot took too long to answer. Try again in a minute.' : 'Couldn\'t reach Whatnot. Try again in a minute.');
    } finally { if (timer) clearTimeout(timer); }
  }

  async function request(method, path, { query, body, allow = [] } = {}) {
    const qs = query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))}` : '';
    const url = `${WHATNOT_API}${path}${qs}`;
    for (let attempt = 0; ; attempt++) {
      const res = await once(method, url, body);
      if (res.status === 429 && attempt < MAX_RETRIES) { await sleep(retryAfterMs(res)); continue; }
      const text = res.status === 204 ? '' : await res.text().catch(() => '');
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      if (res.ok || allow.includes(res.status)) return { status: res.status, data };
      throw errorFor(res.status, whatnotMessage(data));
    }
  }

  return {
    request,
    get: (path, query, opts = {}) => request('GET', path, { query, ...opts }).then((r) => r.data),
    post: (path, body, opts = {}) => request('POST', path, { body, ...opts }).then((r) => r.data),
    patch: (path, body, opts = {}) => request('PATCH', path, { body, ...opts }).then((r) => r.data),
    del: (path, opts = {}) => request('DELETE', path, opts),
  };
}

// Test helper: forget the per-seller pacing between tests.
export const resetThrottle = () => nextSlot.clear();
