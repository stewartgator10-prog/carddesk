// A stand-in for the Whatnot Seller API: answers from tests/fixtures/whatnot (guessed shapes) and
// records every request, so tests never reach api.whatnot.com.
import fs from 'node:fs';

const dir = new URL('./fixtures/whatnot/', import.meta.url);
export const fixture = (name, swap = {}) => {
  let text = fs.readFileSync(new URL(name, dir), 'utf8');
  for (const [k, v] of Object.entries(swap)) text = text.split(k).join(v);
  return JSON.parse(text);
};
export const ERRORS = fixture('errors.json');

export function fakeWhatnot(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname !== 'api.whatnot.com') throw new Error(`unexpected host ${u.hostname}`);
    const path = u.pathname.replace('/seller-api/rest/v2', '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { method: init.method || 'GET', path, query: Object.fromEntries(u.searchParams), body, auth: init.headers?.Authorization };
    calls.push(call);
    const r = (await handler(call)) || { status: 404, body: ERRORS['404'] };
    const status = r.status || 200;
    return new Response(status === 204 ? null : JSON.stringify(r.body ?? {}), { status, headers: { 'Content-Type': 'application/json', ...(r.headers || {}) } });
  };
  return { fetchImpl, calls };
}
