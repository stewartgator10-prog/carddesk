// netlify/lib/ebay-browse.js
// eBay Browse API (public listing search) with an app token (client credentials), cached in memory.
// Used by Live eBay Search and by the competition check in automatic comps.

let cachedToken = null;
let tokenExpiresAt = 0;

export async function getAppToken(fetchImpl = fetch) {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID || process.env.ebay_Cert_ID; // the site stores it as ebay_Cert_ID
  if (!appId || !certId) throw new Error('Missing EBAY_APP_ID or EBAY_CERT_ID environment variable.');
  const res = await fetchImpl('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${Buffer.from(`${appId}:${certId}`).toString('base64')}` },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });
  if (!res.ok) throw new Error(`eBay OAuth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + data.expires_in * 1000;
  return cachedToken;
}

// One page of Browse search results (raw itemSummaries).
export async function browseSearch({ q, limit = 50, sort = null, fixedPriceOnly = false, categoryIds = '2536', zip = '15009', fetchImpl = fetch }) {
  const token = await getAppToken(fetchImpl);
  const params = new URLSearchParams({ q, limit: String(Math.min(Math.max(Number(limit) || 20, 1), 200)), category_ids: categoryIds });
  if (sort) params.set('sort', sort);
  if (fixedPriceOnly) params.set('filter', 'buyingOptions:{FIXED_PRICE}');
  const res = await fetchImpl(`https://api.ebay.com/buy/browse/v1/item_summary/search?${params}`, {
    headers: { Authorization: `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US', 'X-EBAY-C-ENDUSERCTX': `contextualLocation=country=US,zip=${zip}` },
  });
  if (!res.ok) {
    const err = new Error(`eBay search failed (${res.status})`);
    err.status = res.status; err.detail = await res.text();
    throw err;
  }
  const data = await res.json();
  return { total: data.total || 0, items: data.itemSummaries || [] };
}
