// netlify/lib/ebay-seller.js
// Shared server-side helpers for the eBay *seller* (user-token) integration.
// Used by the ebay-* Netlify Functions, and by the orders/fees and price-editing work.
//
// Env vars:
//   EBAY_APP_ID, EBAY_CERT_ID      eBay production keyset (already used by ebay-search)
//   EBAY_RU_NAME                   the RuName ("eBay Redirect URL name") from the eBay dev portal
//   SUPABASE_URL                   Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY      service-role key (server only, never in VITE_ vars)
import { createClient } from '@supabase/supabase-js';
import { XMLParser } from 'fast-xml-parser';

export const EBAY_SCOPES = [
  'https://api.ebay.com/oauth/api_scope',
  'https://api.ebay.com/oauth/api_scope/sell.inventory',
  'https://api.ebay.com/oauth/api_scope/sell.account',
  'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
  'https://api.ebay.com/oauth/api_scope/sell.finances',
  'https://api.ebay.com/oauth/api_scope/commerce.identity.readonly',
];

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const AUTHORIZE_URL = 'https://auth.ebay.com/oauth2/authorize';
const TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const TRADING_COMPAT_LEVEL = '1311';

export const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let adminClient = null;
export function getSupabaseAdmin() {
  if (adminClient) return adminClient;
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.');
  adminClient = createClient(url, key, { auth: { persistSession: false } });
  return adminClient;
}

function basicAuth() {
  const { EBAY_APP_ID } = process.env;
  // The Netlify site stores the secret as `ebay_Cert_ID`; accept either spelling.
  const EBAY_CERT_ID = process.env.EBAY_CERT_ID || process.env.ebay_Cert_ID;
  if (!EBAY_APP_ID || !EBAY_CERT_ID) throw new Error('Missing EBAY_APP_ID or EBAY_CERT_ID.');
  return 'Basic ' + Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString('base64');
}

function ruName() {
  if (!process.env.EBAY_RU_NAME) throw new Error('Missing EBAY_RU_NAME (eBay redirect URL name).');
  return process.env.EBAY_RU_NAME;
}

export function buildAuthorizeUrl(state) {
  // Match the format of eBay's own "branded OAuth sign-in" link: spaces in the
  // scope list encoded as %20 (not +) and no extra prompt parameter.
  const params = [
    ['client_id', process.env.EBAY_APP_ID],
    ['redirect_uri', ruName()],
    ['response_type', 'code'],
    ['scope', EBAY_SCOPES.join(' ')],
    ['state', state],
  ];
  return `${AUTHORIZE_URL}?${params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: basicAuth() },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`eBay token request failed (${res.status}): ${data.error_description || data.error || 'unknown error'}`);
  }
  return data;
}

export function exchangeCodeForTokens(code) {
  return tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: ruName() });
}

export function refreshAccessToken(refreshToken) {
  return tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: EBAY_SCOPES.join(' ') });
}

export async function getEbayIdentity(accessToken) {
  const res = await fetch('https://apiz.ebay.com/commerce/identity/v1/user/', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return {}; // identity is nice-to-have; don't block the connection on it
  const d = await res.json();
  return { ebay_user_id: d.userId || null, ebay_username: d.username || null };
}

export async function getAccount(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('ebay_accounts').select('*').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  return data;
}

// Returns a valid user access token for this user's eBay account, refreshing
// (and saving) it when it is missing or within 5 minutes of expiry.
// Throws an Error with code 'EBAY_NOT_CONNECTED' / 'EBAY_RECONNECT' when the
// user needs to (re)connect.
export async function getSellerAccessToken(supabaseAdmin, userId) {
  const acct = await getAccount(supabaseAdmin, userId);
  if (!acct) {
    const e = new Error('eBay account not connected.');
    e.code = 'EBAY_NOT_CONNECTED';
    throw e;
  }
  const expiresAt = new Date(acct.access_token_expires_at).getTime();
  if (acct.access_token && expiresAt - Date.now() > 5 * 60_000) return acct.access_token;

  let t;
  try {
    t = await refreshAccessToken(acct.refresh_token);
  } catch (err) {
    const e = new Error('eBay sign-in expired. Reconnect your eBay account.');
    e.code = 'EBAY_RECONNECT';
    e.cause = err;
    throw e;
  }
  const access_token_expires_at = new Date(Date.now() + t.expires_in * 1000).toISOString();
  const { error } = await supabaseAdmin.from('ebay_accounts')
    .update({ access_token: t.access_token, access_token_expires_at, updated_at: new Date().toISOString() })
    .eq('id', acct.id);
  if (error) throw error;
  return t.access_token;
}

// ---------- Trading API (XML) ----------
// Listings created on eBay.com (not via the Inventory API) are only fully
// readable/editable through the Trading API. It accepts the OAuth user token
// in the X-EBAY-API-IAF-TOKEN header.
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  isArray: (name) => ['Item', 'Errors'].includes(name),
});

export async function tradingCall(accessToken, callName, innerXml) {
  const body = `<?xml version="1.0" encoding="utf-8"?>
<${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents">
  <ErrorLanguage>en_US</ErrorLanguage>
  <WarningLevel>High</WarningLevel>
  ${innerXml}
</${callName}Request>`;
  const res = await fetch(TRADING_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-SITEID': '0', // US
      'X-EBAY-API-COMPATIBILITY-LEVEL': TRADING_COMPAT_LEVEL,
      'X-EBAY-API-IAF-TOKEN': accessToken,
    },
    body,
  });
  const text = await res.text();
  const parsed = xml.parse(text)?.[`${callName}Response`];
  if (!res.ok || !parsed) throw new Error(`Trading API ${callName} failed (${res.status}).`);
  if (parsed.Ack === 'Failure') {
    const msg = (parsed.Errors || []).map((e) => e.LongMessage || e.ShortMessage).join('; ');
    throw new Error(`Trading API ${callName}: ${msg || 'Failure'}`);
  }
  return parsed;
}

const num = (v) => (v === undefined || v === null || v === '' ? null : Number(v?.['#text'] ?? v));

// Maps a GetMyeBaySelling ActiveList <Item> to an ebay_listings row.
export function mapTradingItem(item) {
  const price = item.SellingStatus?.CurrentPrice ?? item.BuyItNowPrice ?? item.StartPrice;
  const quantity = num(item.Quantity);
  const sold = num(item.SellingStatus?.QuantitySold) ?? 0;
  return {
    item_id: String(item.ItemID),
    title: item.Title ?? null,
    sku: item.SKU ?? null,
    price: num(price),
    currency: price?.['@_currencyID'] ?? 'USD',
    quantity,
    quantity_available: num(item.QuantityAvailable) ?? (quantity !== null ? quantity - sold : null),
    quantity_sold: sold,
    watch_count: num(item.WatchCount),
    listing_type: item.ListingType ?? null,
    start_time: item.ListingDetails?.StartTime ?? null,
    end_time: item.ListingDetails?.EndTime ?? null,
    view_url: item.ListingDetails?.ViewItemURL ?? `https://www.ebay.com/itm/${item.ItemID}`,
    image_url: item.PictureDetails?.GalleryURL ?? null,
    raw: item,
  };
}

// Pulls every active listing (200 per page) via GetMyeBaySelling.
export async function fetchActiveListings(accessToken) {
  const items = [];
  let page = 1;
  let totalPages = 1;
  do {
    const r = await tradingCall(accessToken, 'GetMyeBaySelling', `
  <DetailLevel>ReturnAll</DetailLevel>
  <ActiveList>
    <Include>true</Include>
    <Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>${page}</PageNumber></Pagination>
  </ActiveList>`);
    const list = r.ActiveList;
    items.push(...(list?.ItemArray?.Item || []));
    totalPages = Number(list?.PaginationResult?.TotalNumberOfPages || 1);
    page += 1;
  } while (page <= totalPages && page <= 50); // safety cap: 10,000 listings
  return items.map(mapTradingItem);
}

// Syncs active listings into Supabase. Listings no longer returned by eBay are
// marked 'Ended' (not deleted) so history and inventory links survive.
export async function syncListings(supabaseAdmin, userId) {
  const acct = await getAccount(supabaseAdmin, userId);
  if (!acct) {
    const e = new Error('eBay account not connected.');
    e.code = 'EBAY_NOT_CONNECTED';
    throw e;
  }
  const token = await getSellerAccessToken(supabaseAdmin, userId);
  const listings = await fetchActiveListings(token);
  const now = new Date().toISOString();

  const rows = listings.map((l) => ({ ...l, account_id: acct.id, user_id: userId, status: 'Active', synced_at: now }));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabaseAdmin.from('ebay_listings')
      .upsert(rows.slice(i, i + 500), { onConflict: 'account_id,item_id' });
    if (error) throw error;
  }

  // Anything still 'Active' that wasn't touched in this sync has ended/sold out.
  const { data: ended, error: endErr } = await supabaseAdmin.from('ebay_listings')
    .update({ status: 'Ended' })
    .eq('account_id', acct.id).eq('status', 'Active').lt('synced_at', now)
    .select('item_id');
  if (endErr) throw endErr;

  await supabaseAdmin.from('ebay_accounts').update({ last_synced_at: now, updated_at: now }).eq('id', acct.id);
  return { active: rows.length, ended: ended?.length || 0, synced_at: now };
}
