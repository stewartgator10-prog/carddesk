// netlify/functions/ebay-search.js
import { requireUser } from '../lib/auth.js';
// Live eBay listing search using the Browse API.
// Uses Client Credentials OAuth flow. Token is cached in-memory for ~2 hours.

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;

  if (!appId || !certId) {
    throw new Error('Missing EBAY_APP_ID or EBAY_CERT_ID environment variable.');
  }

  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');

  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`eBay OAuth failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in * 1000);
  return cachedToken;
}

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(req.url);
    const query = url.searchParams.get('q');
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '20'), 50);
    const sortBy = url.searchParams.get('sort') || 'price'; // 'price', 'newlyListed', or 'bestMatch'

    if (!query) {
      return new Response(JSON.stringify({ error: 'Missing q parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const token = await getAccessToken();

    // Browse API search
    const searchParams = new URLSearchParams({
      q: query,
      limit: String(limit),
      category_ids: '2536', // Collectible Card Games category
    });

    if (sortBy === 'price') searchParams.set('sort', 'price');
    if (sortBy === 'newlyListed') searchParams.set('sort', 'newlyListed');

    const apiUrl = `https://api.ebay.com/buy/browse/v1/item_summary/search?${searchParams.toString()}`;

    const ebayRes = await fetch(apiUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'X-EBAY-C-ENDUSERCTX': 'contextualLocation=country=US,zip=15009',
      },
    });

    if (!ebayRes.ok) {
      const errText = await ebayRes.text();
      return new Response(JSON.stringify({ error: 'eBay API error', detail: errText, status: ebayRes.status }), {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await ebayRes.json();

    const items = (data.itemSummaries || []).map(item => ({
      id: item.itemId,
      title: item.title,
      price: parseFloat(item.price?.value || 0),
      currency: item.price?.currency || 'USD',
      condition: item.condition || 'Not specified',
      shippingCost: parseFloat(item.shippingOptions?.[0]?.shippingCost?.value || 0),
      shippingType: item.shippingOptions?.[0]?.shippingCostType || 'CALCULATED',
      seller: item.seller?.username || 'unknown',
      sellerFeedback: item.seller?.feedbackPercentage || null,
      image: item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null,
      url: item.itemWebUrl || `https://www.ebay.com/itm/${item.itemId}`,
      listingType: item.buyingOptions?.join(',') || '',
      itemLocation: item.itemLocation?.country || '',
    }));

    return new Response(JSON.stringify({
      query,
      total: data.total || items.length,
      items,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Server error', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = {
  path: '/api/ebay-search',
};
