// Browser client for the Repricer's Netlify functions. apiFetch attaches the CardDesk login token.
import { apiFetch } from '../lib/supabase.js';

async function readJson(res) {
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || data.error) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error || `HTTP ${res.status}`);
  return data;
}

export async function fetchSellerListings() {
  return readJson(await apiFetch('/api/seller-listings'));
}

export async function pushPriceChanges(changes) {
  return readJson(await apiFetch('/api/seller-reprice', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ changes }),
  }));
}
