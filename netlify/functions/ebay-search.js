// netlify/functions/ebay-search.js
import { requireUser } from '../lib/auth.js';
import { getAppToken as getAccessToken } from '../lib/ebay-browse.js';
// Live eBay listing search using the Browse API.
// App token (client credentials) comes from ../lib/ebay-browse.js, cached in memory.

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
  }

  const auth = await requireUser(req);
  if (auth instanceof Response) return auth;

  try {
    const url = new URL(req.url);
    const query = url.searchParams.get('q');
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit'), 10) || 20, 1), 50);
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
