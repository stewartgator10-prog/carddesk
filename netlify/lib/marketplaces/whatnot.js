// netlify/lib/marketplaces/whatnot.js
// The Whatnot adapter: connect with a seller's personal access token, list a card as Buy It Now in
// their Whatnot shop, change its price or quantity, end it, and read sales.
// Every call follows the saved OpenAPI spec (docs/marketplaces/whatnot-api/openapi.json, Seller API
// v2, beta). What the spec leaves open is listed in docs/marketplaces/whatnot.md ("Still to check on
// a live shop") and marked `CONFIRM:` below.
//
// Listing a card is four calls (the spec's "Products" guide):
//   1. POST /products                      title, description, external_id (our card id), category,
//                                          attributes, media, dimension_profile, hazardous_material
//   2. GET  /products/{id}/variants        the one variant Whatnot made (a card has no options)
//   3. PATCH /products/{id}/variants       { variants: [{ id, price: Money, sku, external_id }] }
//      POST /inventory/set                 { items: [{ variant_id, quantity, idempotency_key }] }
//   4. POST /merchandising/products/{id}   { transaction_type: 'buy_it_now', reserve_for_live: false }
//                                          (not reserved for live = for sale in the profile shop)
import crypto from 'node:crypto';
import { whatnotClient } from './whatnot-client.js';
import { MarketplaceError } from './errors.js';
import { open } from '../secret-box.js';
import { snapSku } from '../ebay-listing.js';
import { listingPhotoPaths, MAX_LISTING_PHOTOS, LISTABLE_GAMES } from '../snap-logic.js';
import { buildDescription } from '../listing-copy.js';
import { categoryFor, categoryIdFor, productAttributes } from './whatnot-details.js';

import { TOKEN_PREFIX, APP_TOKEN_PREFIX, WHATNOT_SCOPES, TOKEN_PAGE, CONDITION_LABELS } from './whatnot-info.js';

export { TOKEN_PREFIX, APP_TOKEN_PREFIX, WHATNOT_SCOPES, TOKEN_PAGE, CONDITION_LABELS, categoryFor, categoryIdFor, productAttributes };
// CONFIRM: the spec sets no limit on a product's images; we send at most as many as eBay takes.
export const MAX_WHATNOT_PHOTOS = MAX_LISTING_PHOTOS;
const PAGE = 50;                                         // the spec's maximum page size

// A card-sized package when the seller has no Whatnot shipping profile: 3 oz, 9 x 6 x 1 in, or the
// seller's own numbers from Snap settings (the same ones eBay listings use).
export function inlineDimensionProfile(settings = {}) {
  const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    weight: { value: num(settings.snapPackageWeightOz, 3), unit: 'ounce' },
    dimensions: { length: num(settings.snapPackageLengthIn, 9), width: num(settings.snapPackageWidthIn, 6), height: num(settings.snapPackageDepthIn, 1), unit: 'inch' },
  };
}

export const money = (n, currency = 'USD') => ({ amount: Number(n).toFixed(2), currency });

export function descriptionText(card) {
  const body = String(card.description || '').trim() || buildDescription(card);
  const x = card.extraction || {};
  const slab = [card.grader || x.grader, card.grade || x.grade].filter(Boolean).join(' ');
  const cond = x.graded ? `Graded${slab ? ` (${slab})` : ''}` : CONDITION_LABELS[card.condition] || CONDITION_LABELS.NM;
  return `Condition: ${cond}\n\n${body}`.trim();
}

// The POST /products body (CreateProductRequest). No price or quantity: those go on the variant.
// `category` is from categoryFor(card); the card details sent are only the ones that category takes.
// dimension_profile is required: the seller's chosen Whatnot profile by id, or our own package
// (weight + dimensions), which Whatnot saves as a profile.
export function productBody(card, { photoUrls, category, categoryId, account, settings = {} }) {
  const cat = category || { id: String(categoryId), attrs: categoryFor(card)?.attrs || {} };
  const profileId = account?.settings?.shipping_profile_id;
  const attributes = productAttributes(card, cat);
  return {
    title: String(card.title || '').slice(0, 80),
    description: descriptionText(card),
    external_id: String(card.id).slice(0, 150),
    category: { id: String(cat.id) },
    ...(attributes.length ? { attributes } : {}),
    media: photoUrls.slice(0, MAX_WHATNOT_PHOTOS).map((url, i) => ({ url, alt: i === 0 ? String(card.title || '').slice(0, 120) : null })),
    dimension_profile: profileId ? { id: String(profileId) } : inlineDimensionProfile(settings),
    hazardous_material: 'not_hazardous',
  };
}

// ---------- context ----------
export function tokenOf(account) {
  if (!account?.access_token_enc) throw new MarketplaceError('reconnect', 'Whatnot isn\'t connected. Paste a Whatnot token in Marketplaces.');
  try { return open(account.access_token_enc); } catch (e) {
    throw new MarketplaceError('not_set_up', e.code === 'NO_KEY' || e.code === 'BAD_KEY' ? 'Whatnot isn\'t set up on this site yet.' : 'Your saved Whatnot token can\'t be read on this site. Paste it again in Marketplaces.');
  }
}

const clientFor = (ctx, token = tokenOf(ctx.account)) =>
  whatnotClient({ token, key: `whatnot:${ctx.userId}`, fetchImpl: ctx.fetchImpl, sleep: ctx.sleep, now: ctx.now });

// Photos Whatnot can copy: the permanent eBay picture links when the card has them, otherwise
// 1-hour private links to the seller's own photos.
export async function photoUrlsFor(db, userId, card) {
  if ((card.ebay_picture_urls || []).length) return card.ebay_picture_urls.slice(0, MAX_WHATNOT_PHOTOS);
  const paths = listingPhotoPaths(card).slice(0, MAX_WHATNOT_PHOTOS);
  if (paths.some((p) => !String(p).startsWith(`${userId}/`))) throw new MarketplaceError('rejected', 'One of the photos does not belong to you.');
  const bucket = db.storage.from('snap-photos');
  if (typeof bucket.createSignedUrl !== 'function') return [];
  const out = [];
  for (const p of paths) {
    const { data, error } = await bucket.createSignedUrl(p, 3600);
    if (!error && data?.signedUrl) out.push(data.signedUrl);
  }
  return out;
}

async function pageAll(c, path, query, { maxPages = 10, stop = () => false } = {}) {
  const out = [];
  let cursor = null;
  for (let i = 0; i < maxPages; i++) {
    const page = await c.get(path, { limit: PAGE, ...query, ...(cursor ? { cursor } : {}) });
    const rows = page?.data || [];
    out.push(...rows);
    cursor = page?.next_cursor || null;
    if (stop(rows) || !cursor || !rows.length) break;
  }
  return out;
}

// GET /products takes only limit, cursor and reverse (newest first), so a create whose answer was
// lost is found by paging the newest products for our external_id (the card id).
export async function findProductByExternalId(c, externalId, maxPages = 4) {
  let hit = null;
  await pageAll(c, '/products', { reverse: true }, { maxPages, stop: (rows) => { hit = rows.find((p) => p.external_id === String(externalId)) || null; return !!hit; } });
  return hit;
}

// PATCH /products/{id}/variants answers 207 with { variants, errors }; errors are only listed with
// allow_partial_updates (we don't send it, so a bad patch is a 422 and nothing is written).
const VARIANT_ERRORS = {
  variant_not_found: 'Whatnot can\'t find that listing any more.',
  variant_not_editable: 'Whatnot won\'t let this listing\'s price change right now (it may be in a live show or sold).',
  variants_not_supported: 'Whatnot won\'t take a price for this listing.',
  pricing_transaction_type_mismatch: 'Whatnot has this listing set up as an auction. Change it on Whatnot.',
};
function variantErrors(result) {
  const errs = result?.errors || [];
  if (errs.length) throw new MarketplaceError('rejected', VARIANT_ERRORS[errs[0].code] || `Whatnot said: ${errs.map((e) => e.message || e.code).join('; ')}`);
}

// POST /inventory/set answers 207 with one InventoryResult per item. The idempotency key makes a
// retried request (after a 429) apply once.
const INVENTORY_ERRORS = {
  not_editable: 'Whatnot won\'t let this listing\'s quantity change right now (it may be in a live show).',
  inventory_not_supported: 'Whatnot doesn\'t keep a quantity for this listing.',
  variant_not_found: 'Whatnot can\'t find that listing any more.',
  inventory_level_not_found: 'Whatnot can\'t find that listing\'s stock any more.',
};
async function setQuantity(c, variantId, quantity, { missingOk = false } = {}) {
  const r = await c.post('/inventory/set', { items: [{ variant_id: String(variantId), quantity: Math.max(0, Math.floor(quantity)), idempotency_key: crypto.randomUUID() }] });
  const st = r?.results?.[0]?.status;
  if (['applied', 'already_applied'].includes(st)) return r.results[0].new_quantity ?? quantity;
  if (missingOk && ['variant_not_found', 'inventory_level_not_found'].includes(st)) return 0;
  throw new MarketplaceError('rejected', INVENTORY_ERRORS[st] || 'Whatnot didn\'t change the quantity. Try again in a minute.');
}

// ---------- the adapter ----------
export const whatnot = {
  id: 'whatnot',
  label: 'Whatnot',
  authKinds: ['personal_token', 'oauth'],
  tokenPage: TOKEN_PAGE,
  scopes: WHATNOT_SCOPES,

  // Checks the token and finds the seller; stores nothing.
  async connect(_db, userId, { token }, { fetchImpl, sleep, now } = {}) {
    const t = String(token || '').trim();
    const kind = t.startsWith(TOKEN_PREFIX) ? 'personal_token' : t.startsWith(APP_TOKEN_PREFIX) ? 'oauth' : null;
    if (!kind) throw new MarketplaceError('rejected', `That doesn't look like a Whatnot token. It starts with ${TOKEN_PREFIX}.`);
    const c = whatnotClient({ token: t, key: `whatnot:${userId}`, fetchImpl, sleep, now });
    let me;
    try { me = await c.get('/users/me'); } catch (e) {
      if (e.code === 'reconnect' || e.code === 'missing_scope' || e.code === 'not_found') throw new MarketplaceError('rejected', 'Whatnot didn\'t accept that token. Check you copied all of it.');
      throw e;
    }
    try { await c.get('/orders', { limit: 1 }); } catch (e) {
      if (e.code === 'missing_scope') throw new MarketplaceError('missing_scope', 'This token can\'t read your orders. Make a new one with read:orders ticked.');
      throw e;
    }
    let profiles = [];
    try { profiles = (await c.get('/shipping/dimension_profiles', { limit: PAGE }))?.data || []; } catch (e) {
      if (e.code === 'missing_scope') throw new MarketplaceError('missing_scope', 'This token can\'t read your listings. Make a new one with read:inventory and write:inventory ticked.');
      throw e;
    }
    // PageResponse[DimensionProfile]: the seller's own active profiles. Picks a card-sized one.
    const usable = profiles.filter((p) => p?.id && p.active !== false);
    const small = usable.find((p) => p.weight?.unit === 'ounce' && Number(p.weight.value) <= 8) || usable[0] || null;
    return {
      authKind: kind, externalUserId: me?.id ? String(me.id) : null, username: me?.username || null, scopes: null,
      settings: { shipping_profile_id: small?.id ? String(small.id) : null, shipping_profiles: usable.map((p) => ({ id: String(p.id), name: p.name || null })).slice(0, 20) },
    };
  },

  // Lists one card as Buy It Now in the seller's shop. `adopt` is a product id from an earlier try.
  async createListing(ctx, card, { price, quantity = 1, adopt = null, settings = {} } = {}) {
    const category = categoryFor(card);
    if (!category) throw new MarketplaceError('rejected', card.game === 'sports' ? 'Sports cards can\'t be listed on Whatnot from here yet.' : 'Whatnot has no card category for this game.');
    if (!(Number(price) >= 1)) throw new MarketplaceError('rejected', 'Set a Whatnot price of at least $1.00.');
    if (!(Number(quantity) >= 1)) throw new MarketplaceError('rejected', 'Set a quantity of at least 1.');
    const c = clientFor(ctx);
    let product = null;
    if (adopt) product = await c.get(`/products/${encodeURIComponent(adopt)}`, undefined, { allow: [404] }).then((p) => (p?.id ? p : null));
    if (!product) product = await findProductByExternalId(c, card.id);
    if (!product) {
      const photoUrls = await photoUrlsFor(ctx.db, ctx.userId, card);
      if (!photoUrls.length) throw new MarketplaceError('rejected', 'Whatnot needs at least one photo of the card.');
      product = await c.post('/products', productBody(card, { photoUrls, category, account: ctx.account, settings }));
    }
    const productId = String(product.id);
    try {
      const variants = await c.get(`/products/${encodeURIComponent(productId)}/variants`, { limit: PAGE });
      const variant = variants?.data?.[0];
      if (!variant?.id) throw new MarketplaceError('rejected', 'Whatnot made the product but returned no variant to price.');
      variantErrors(await c.patch(`/products/${encodeURIComponent(productId)}/variants`, {
        variants: [{ id: String(variant.id), price: money(price), sku: snapSku(card.id), external_id: String(card.id) }],
      }));
      const qty = await setQuantity(c, variant.id, quantity);
      // Publishes it: Buy It Now, not held for live shows, so it is for sale in the profile shop.
      await c.post(`/merchandising/products/${encodeURIComponent(productId)}`, { transaction_type: 'buy_it_now', reserve_for_live: false });
      // Product.url is the product in the seller's Whatnot inventory dashboard.
      return { externalId: productId, variantId: String(variant.id), listingId: null, url: product.url || null, price: Number(price), quantity: qty };
    } catch (e) {
      e.partial = { externalId: productId, url: product.url || null };
      throw e;
    }
  },

  async updateListing(ctx, listing, { price, quantity } = {}) {
    const c = clientFor(ctx);
    const out = { price: listing.price != null ? Number(listing.price) : null, quantity: listing.quantity };
    if (price != null) {
      if (!(Number(price) >= 1)) throw new MarketplaceError('rejected', 'Set a Whatnot price of at least $1.00.');
      variantErrors(await c.patch(`/products/${encodeURIComponent(listing.external_id)}/variants`, { variants: [{ id: String(listing.external_variant_id), price: money(price) }] }));
      out.price = Number(price);
    }
    if (quantity != null) out.quantity = await setQuantity(c, listing.external_variant_id, quantity);
    return out;
  },

  // Takes the card down. Quantity 0 means nobody can buy it and keeps the history; a card the seller
  // ends that never sold is also deleted from their catalog (DELETE answers 204, or 409 when Whatnot
  // keeps it, e.g. it has orders). "Already gone" (404) counts as ended.
  // CONFIRM: whether a quantity-0 product still shows in the profile shop as sold out.
  async endListing(ctx, listing, { reason = 'seller' } = {}) {
    const c = clientFor(ctx);
    try {
      if (listing.external_variant_id) await setQuantity(c, listing.external_variant_id, 0, { missingOk: true });
      if (reason === 'seller' && !listing.sold_at) await c.del(`/products/${encodeURIComponent(listing.external_id)}`, { allow: [404, 409] });
    } catch (e) {
      if (e.code === 'not_found') return { ok: true, gone: true };
      throw e;
    }
    return { ok: true };
  },

  // Sale lines since `since`. GET /orders takes only limit, cursor and reverse (newest first), so we
  // page back to `lookbackMs` before `since` (cancellations change older orders) and only open the
  // items (GET /orders/{id}/items, OrderItem.product_external_id = our card id) of orders updated in
  // the last window. Order status: pending, pending_fulfillment, completed, cancelled, failed.
  async fetchSales(ctx, { since = null, lookbackMs = 72 * 3600_000, windowMs = 30 * 60_000, maxPages = 10 } = {}) {
    const c = clientFor(ctx);
    const sinceMs = since ? Date.parse(since) : Date.now() - 7 * 864e5;
    const oldest = sinceMs - lookbackMs;
    const orders = await pageAll(c, '/orders', { reverse: true }, { maxPages, stop: (rows) => rows.some((o) => o.created_at && Date.parse(o.created_at) < oldest) });
    const fresh = orders.filter((o) => Date.parse(o.updated_at || o.created_at || 0) >= sinceMs - windowMs && Date.parse(o.created_at || 0) >= oldest);
    const out = [];
    for (const o of fresh) {
      const items = await pageAll(c, `/orders/${encodeURIComponent(o.id)}/items`, {}, { maxPages: 4 });
      for (const it of items) {
        out.push({
          orderId: String(o.id), lineId: String(it.id), externalId: it.product_id ? String(it.product_id) : null,
          cardId: it.product_external_id || null, variantId: it.variant_id || null,
          quantity: Number(it.quantity) || 1, price: it.unit_price?.amount != null ? Number(it.unit_price.amount) : null,
          currency: it.unit_price?.currency || 'USD', at: o.created_at || null,
          status: ['cancelled', 'failed'].includes(o.status) || o.cancelled_at ? 'cancelled' : o.status || 'pending', url: o.url || null,
        });
      }
    }
    return out;
  },

  // Personal tokens are deleted by the seller on Whatnot's token page; app installs are revoked here.
  async disconnect(ctx) {
    if (ctx.account?.auth_kind !== 'oauth') return { ok: true };
    await clientFor(ctx).post('/users/disconnect', {}, { allow: [401, 404] });
    return { ok: true };
  },
};

export const WHATNOT_GAMES = LISTABLE_GAMES;
