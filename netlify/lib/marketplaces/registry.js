// netlify/lib/marketplaces/registry.js
// Every marketplace a card can be listed on, behind one contract:
//   { id, label, authKinds,
//     connect(db, userId, { token }, deps)          -> { externalUserId, username, scopes, settings }  validates, never stores
//     createListing(ctx, card, { price, quantity }) -> { externalId, variantId, listingId, url, price, quantity }
//     updateListing(ctx, listing, { price?, quantity? }) -> { price, quantity }
//     endListing(ctx, listing, { reason })           -> { ok }   idempotent: "already gone" is ok
//     fetchSales(ctx, { since })                     -> [{ orderId, lineId, externalId, quantity, price, at, status }] }
// ctx = { db, userId, account, fetchImpl, ... }. Errors are MarketplaceError (./errors.js).
// Shopify and TCGplayer add one file each and one line here.
import { ebay } from './ebay.js';
import { whatnot } from './whatnot.js';
import { MarketplaceError } from './errors.js';

export const ADAPTERS = { ebay, whatnot };
export const CONTRACT = ['connect', 'createListing', 'updateListing', 'endListing', 'fetchSales'];
// Marketplaces connected through marketplace_accounts (eBay has its own table).
export const ACCOUNT_MARKETPLACES = ['whatnot'];
export const MARKETPLACE_LABELS = { ebay: 'eBay', whatnot: 'Whatnot', shopify: 'Shopify', tcgplayer: 'TCGplayer' };

export function adapterFor(id) {
  const a = ADAPTERS[id];
  if (!a) throw new MarketplaceError('not_set_up', `${MARKETPLACE_LABELS[id] || 'That marketplace'} isn't available yet.`);
  return a;
}

async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }

export async function loadAccount(db, userId, marketplace) {
  if (marketplace === 'ebay') return must(db.from('ebay_accounts').select('id, ebay_username').eq('user_id', userId).maybeSingle());
  return must(db.from('marketplace_accounts').select('*').eq('user_id', userId).eq('marketplace', marketplace).maybeSingle());
}

// The context an adapter call needs. `deps` (fetchImpl, call, sleep, now, token) come from tests.
export async function contextFor(db, userId, marketplace, deps = {}) {
  const account = deps.accounts?.[marketplace] ?? await loadAccount(db, userId, marketplace);
  if (!account) throw new MarketplaceError('reconnect', `${MARKETPLACE_LABELS[marketplace]} isn't connected. Connect it in Marketplaces.`);
  const extra = deps.byMarketplace?.[marketplace] || {};
  return { db, userId, account, fetchImpl: deps.fetchImpl, sleep: deps.sleep, now: deps.now, call: deps.call, ...extra };
}
