// netlify/functions/parse-listing.js
// Parses eBay or TCGplayer listing URLs and returns structured data.
// For eBay: uses the Browse API getItem endpoint (clean, reliable).
// For TCGplayer: lightweight HTML fetch + regex extraction (best-effort).

let cachedToken = null;
let tokenExpiresAt = 0;

async function getEbayToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) return cachedToken;

  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  if (!appId || !certId) throw new Error('Missing eBay credentials');

  const credentials = Buffer.from(`${appId}:${certId}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`,
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope',
  });

  if (!res.ok) throw new Error(`Token request failed: ${res.status}`);
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in * 1000);
  return cachedToken;
}

function extractEbayItemId(url) {
  // Patterns: /itm/123456789012 or /itm/title/123456789012 or ?item=123456789012
  const patterns = [
    /\/itm\/(?:[^/]+\/)?(\d{10,15})/,
    /[?&]item=(\d{10,15})/,
    /hash=item([a-f0-9]+)/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

async function parseEbayUrl(url) {
  const itemId = extractEbayItemId(url);
  if (!itemId) {
    return { error: 'Could not extract eBay item ID from URL. Make sure the URL contains /itm/ followed by the item number.' };
  }

  const token = await getEbayToken();
  // The Browse API uses RESTful item URLs: https://api.ebay.com/buy/browse/v1/item/v1|<itemId>|0
  const apiUrl = `https://api.ebay.com/buy/browse/v1/item/v1|${itemId}|0`;

  const res = await fetch(apiUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
    },
  });

  if (!res.ok) {
    const text = await res.text();
    return { error: `eBay API returned ${res.status}: ${text}` };
  }

  const item = await res.json();

  return {
    source: 'eBay',
    title: item.title || '',
    cardName: item.title || '', // user can clean it up
    price: parseFloat(item.price?.value || 0),
    currency: item.price?.currency || 'USD',
    condition: item.condition || '',
    shippingCost: parseFloat(item.shippingOptions?.[0]?.shippingCost?.value || 0),
    seller: item.seller?.username || '',
    sellerFeedback: item.seller?.feedbackPercentage || null,
    image: item.image?.imageUrl || null,
    url: item.itemWebUrl || url,
    itemId,
  };
}

async function parseTcgplayerUrl(url) {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
    });

    if (!res.ok) {
      return { error: `TCGplayer page returned ${res.status}` };
    }

    const html = await res.text();

    // TCGplayer puts a lot in <title>, meta og: tags, and inline JSON
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const ogTitleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);
    const ogPriceMatch = html.match(/<meta\s+property="product:price:amount"\s+content="([^"]+)"/i);
    const priceMatch = html.match(/"marketPrice":\s*"?\$?([\d.]+)"?/i)
      || html.match(/"lowestPrice":\s*"?\$?([\d.]+)"?/i)
      || html.match(/\$([\d]+\.\d{2})/);

    let title = (ogTitleMatch?.[1] || titleMatch?.[1] || '').trim();
    title = title.replace(/\s*[|·-]\s*TCGplayer.*$/i, '').trim();

    const price = ogPriceMatch ? parseFloat(ogPriceMatch[1]) : (priceMatch ? parseFloat(priceMatch[1]) : 0);

    if (!title) {
      return { error: 'Could not parse TCGplayer page. Try copying the title and price manually.' };
    }

    return {
      source: 'TCGplayer',
      title,
      cardName: title,
      price,
      currency: 'USD',
      condition: 'NM',
      shippingCost: 0,
      seller: '',
      sellerFeedback: null,
      image: null,
      url,
      note: 'TCGplayer pages show market price, not a specific seller asking price. Verify before buying.',
    };
  } catch (err) {
    return { error: `TCGplayer parse failed: ${err.message}` };
  }
}

export default async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  try {
    const url = new URL(req.url);
    const listingUrl = url.searchParams.get('url');

    if (!listingUrl) {
      return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let result;
    if (listingUrl.includes('ebay.com')) {
      result = await parseEbayUrl(listingUrl);
    } else if (listingUrl.includes('tcgplayer.com')) {
      result = await parseTcgplayerUrl(listingUrl);
    } else {
      result = { error: 'URL must be from eBay or TCGplayer.' };
    }

    return new Response(JSON.stringify(result), {
      status: result.error ? 400 : 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Server error', detail: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
};

export const config = {
  path: '/api/parse-listing',
};
