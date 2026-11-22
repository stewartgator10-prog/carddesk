// Browser client for the Repricer's Netlify functions.
// Once Supabase login lands, call configureSellerApi({ getAccessToken }) at startup so requests
// carry the user's session token (the functions identify the seller from it).

let getAccessToken = async () => null;

export function configureSellerApi(opts = {}) {
  if (opts.getAccessToken) getAccessToken = opts.getAccessToken;
}

async function headers(extra = {}) {
  const token = await getAccessToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : extra;
}

async function readJson(res) {
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || data.error) throw new Error(data.detail ? `${data.error}: ${data.detail}` : data.error || `HTTP ${res.status}`);
  return data;
}

export async function fetchSellerListings() {
  return readJson(await fetch('/api/seller-listings', { headers: await headers() }));
}

export async function pushPriceChanges(changes) {
  return readJson(await fetch('/api/seller-reprice', {
    method: 'POST',
    headers: await headers({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ changes }),
  }));
}
