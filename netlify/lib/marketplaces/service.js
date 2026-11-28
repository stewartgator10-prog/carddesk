// netlify/lib/marketplaces/service.js
// What the marketplace endpoints do, without the HTTP: connect / disconnect a marketplace, list a
// card on it, change its price or stock, end it, and check for sales now. Plan checks
// (requireFeature) stay in the functions. Nothing returned here ever holds a token or a sealed one.
import { adapterFor, ACCOUNT_MARKETPLACES, MARKETPLACE_LABELS, contextFor } from './registry.js';
import { MarketplaceError, isMarketplaceError } from './errors.js';
import { seal, hasBoxKey } from '../secret-box.js';
import { runSaleCheck } from '../sell-once.js';

async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
const nowIso = () => new Date().toISOString();
const LIVE = ['active', 'ending'];
export const SALES_CHECK_GAP_MS = 30_000;

// A listing row as the browser may see it.
export function publicListing(l) {
  if (!l) return null;
  const { raw, ...rest } = l;   // eslint-disable-line no-unused-vars
  return rest;
}

function publicAccount(marketplace, a, activeCount) {
  if (!a) return { marketplace, connected: false, activeCount };
  return {
    marketplace, connected: true, username: a.external_username || null, status: a.status || 'connected', lastError: a.last_error || null,
    salesCheckedAt: a.sales_checked_at || null, activeCount, connectedAt: a.created_at || null,
    settings: { shippingProfileId: a.settings?.shipping_profile_id || null, shippingProfiles: a.settings?.shipping_profiles || [] },
  };
}

export async function listMarketplaces(db, userId) {
  const [ebay, accounts, live] = await Promise.all([
    must(db.from('ebay_accounts').select('ebay_username, last_synced_at, orders_synced_at').eq('user_id', userId).maybeSingle()),
    must(db.from('marketplace_accounts').select('marketplace, external_username, status, last_error, sales_checked_at, settings, created_at').eq('user_id', userId)),
    must(db.from('marketplace_listings').select('marketplace, status').eq('user_id', userId).in('status', LIVE)),
  ]);
  const count = (m) => live.filter((l) => l.marketplace === m).length;
  return [
    ebay ? { marketplace: 'ebay', connected: true, username: ebay.ebay_username || null, status: 'connected', salesCheckedAt: ebay.orders_synced_at || null, activeCount: count('ebay') }
      : { marketplace: 'ebay', connected: false, activeCount: count('ebay') },
    ...ACCOUNT_MARKETPLACES.map((m) => publicAccount(m, accounts.find((a) => a.marketplace === m), count(m))),
  ];
}

export async function connectMarketplace(db, userId, { marketplace, token }, deps = {}) {
  if (!ACCOUNT_MARKETPLACES.includes(marketplace)) throw new MarketplaceError('not_set_up', `${MARKETPLACE_LABELS[marketplace] || 'That marketplace'} can't be connected here yet.`);
  if (!hasBoxKey(deps.env)) throw new MarketplaceError('not_set_up', `${MARKETPLACE_LABELS[marketplace]} isn't set up on this site yet.`);
  const adapter = adapterFor(marketplace);
  const who = await adapter.connect(db, userId, { token }, deps);
  const now = nowIso();
  const existing = await must(db.from('marketplace_accounts').select('id, settings, sales_checked_at').eq('user_id', userId).eq('marketplace', marketplace).maybeSingle());
  const row = {
    user_id: userId, marketplace, auth_kind: who.authKind || 'personal_token', access_token_enc: seal(String(token).trim()),
    refresh_token_enc: null, token_expires_at: null, scopes: who.scopes || null, external_user_id: who.externalUserId, external_username: who.username,
    status: 'connected', last_error: null, settings: { ...(existing?.settings || {}), ...who.settings, ...(existing?.settings?.shipping_profile_id ? { shipping_profile_id: existing.settings.shipping_profile_id } : {}) },
    // A fresh connection looks back a day for sales; a reconnect carries on from the last check.
    sales_checked_at: existing?.sales_checked_at || new Date(Date.now() - 864e5).toISOString(), updated_at: now,
  };
  await must(db.from('marketplace_accounts').upsert(row, { onConflict: 'user_id,marketplace' }));
  return (await listMarketplaces(db, userId)).find((m) => m.marketplace === marketplace);
}

export async function saveMarketplaceSettings(db, userId, { marketplace, shippingProfileId }) {
  const a = await must(db.from('marketplace_accounts').select('id, settings').eq('user_id', userId).eq('marketplace', marketplace).maybeSingle());
  if (!a) throw new MarketplaceError('reconnect', `${MARKETPLACE_LABELS[marketplace] || 'That marketplace'} isn't connected.`);
  const known = (a.settings?.shipping_profiles || []).map((p) => p.id);
  if (shippingProfileId != null && known.length && !known.includes(String(shippingProfileId))) throw new MarketplaceError('rejected', 'Pick one of your Whatnot shipping profiles.');
  await must(db.from('marketplace_accounts').update({ settings: { ...(a.settings || {}), shipping_profile_id: shippingProfileId ? String(shippingProfileId) : null }, updated_at: nowIso() }).eq('id', a.id));
  return (await listMarketplaces(db, userId)).find((m) => m.marketplace === marketplace);
}

// Deletes the connection (and token) either way; optionally ends the live listings first.
export async function disconnectMarketplace(db, userId, { marketplace, endListings = false }, deps = {}) {
  if (!ACCOUNT_MARKETPLACES.includes(marketplace)) throw new MarketplaceError('rejected', 'Disconnect eBay with the eBay button.');
  const live = await must(db.from('marketplace_listings').select('*').eq('user_id', userId).eq('marketplace', marketplace).in('status', LIVE));
  const result = { ended: 0, left: 0, problems: [] };
  const account = await must(db.from('marketplace_accounts').select('*').eq('user_id', userId).eq('marketplace', marketplace).maybeSingle());
  const now = nowIso();
  if (account) {
    const ctx = await contextFor(db, userId, marketplace, { ...deps, accounts: { [marketplace]: account } });
    for (const l of live) {
      if (endListings) {
        try {
          await adapterFor(marketplace).endListing(ctx, l, { reason: 'seller' });
          await must(db.from('marketplace_listings').update({ status: 'ended', ended_reason: 'seller', ended_at: now, last_error: null, updated_at: now }).eq('id', l.id));
          result.ended++;
          continue;
        } catch (e) { result.problems.push(`${l.external_id}: ${isMarketplaceError(e) ? e.sellerMessage : 'could not end'}`); }
      }
      await must(db.from('marketplace_listings').update({ status: 'ended', ended_reason: 'disconnected', ended_at: now,
        last_error: `Left up on ${MARKETPLACE_LABELS[marketplace]} when you disconnected. We no longer watch it for sales.`, updated_at: now }).eq('id', l.id));
      result.left++;
    }
    try { await adapterFor(marketplace).disconnect?.(ctx); } catch { /* the row goes anyway */ }
  }
  await must(db.from('marketplace_accounts').delete().eq('user_id', userId).eq('marketplace', marketplace));
  return { ...result, marketplaces: await listMarketplaces(db, userId) };
}

async function loadCard(db, userId, snapItemId) {
  const card = await must(db.from('snap_items').select('*').eq('id', String(snapItemId)).eq('user_id', userId).maybeSingle());
  if (!card) throw Object.assign(new MarketplaceError('not_found', 'Card not found.'), { status: 404 });
  return card;
}

async function loadListing(db, userId, listingId) {
  const l = await must(db.from('marketplace_listings').select('*').eq('id', String(listingId)).eq('user_id', userId).maybeSingle());
  if (!l) throw new MarketplaceError('not_found', 'That listing isn\'t in Tyche Cards.');
  return l;
}

const markReconnect = async (db, userId, marketplace, e) => {
  if (e?.code === 'reconnect' && ACCOUNT_MARKETPLACES.includes(marketplace)) {
    await db.from('marketplace_accounts').update({ status: 'reconnect', last_error: e.sellerMessage, updated_at: nowIso() }).eq('user_id', userId).eq('marketplace', marketplace);
  }
};

// A card listed on eBay before cross-listing existed (or brought in from eBay) gets its eBay row
// now, so a sale on the other marketplace can take it off eBay.
async function ensureEbayRow(db, userId, card) {
  if (card.status !== 'listed' || !card.ebay_item_id) return;
  const has = await must(db.from('marketplace_listings').select('id').eq('user_id', userId).eq('marketplace', 'ebay').eq('external_id', String(card.ebay_item_id)));
  if (has.length) return;
  const inv = await must(db.from('inventory').select('id').eq('user_id', userId).eq('ebay_item_id', card.ebay_item_id));
  const el = await must(db.from('ebay_listings').select('status, quantity_available').eq('user_id', userId).eq('item_id', card.ebay_item_id));
  if (el[0] && el[0].status !== 'Active') return;
  await must(db.from('marketplace_listings').upsert({
    user_id: userId, snap_item_id: card.id, inventory_id: inv[0]?.id || null, marketplace: 'ebay', external_id: String(card.ebay_item_id),
    url: card.ebay_url || `https://www.ebay.com/itm/${card.ebay_item_id}`, price: card.price, quantity: el[0]?.quantity_available ?? card.quantity ?? 1,
    status: 'active', listed_at: card.listed_at || nowIso(), synced_at: nowIso(),
  }, { onConflict: 'user_id,marketplace,external_id' }));
}

export async function createCrossListing(db, userId, { marketplace, snapItemId, price, quantity }, deps = {}) {
  if (!ACCOUNT_MARKETPLACES.includes(marketplace)) throw new MarketplaceError('rejected', 'List on eBay with Check and Publish on the card.');
  const card = await loadCard(db, userId, snapItemId);
  if (!['approved', 'listed'].includes(card.status)) throw new MarketplaceError('rejected', 'Approve the card first.');
  if (card.photo_crop) throw new MarketplaceError('rejected', 'This card only has a binder-page photo. Replace it with a photo of the card itself first.');
  if (!card.title) throw new MarketplaceError('rejected', 'The card needs a title first.');
  const mine = await must(db.from('marketplace_listings').select('*').eq('user_id', userId).eq('snap_item_id', card.id).eq('marketplace', marketplace));
  if (mine.some((l) => LIVE.includes(l.status))) throw new MarketplaceError('rejected', `This card is already on ${MARKETPLACE_LABELS[marketplace]}.`);
  const failed = mine.filter((l) => l.status === 'failed');
  const adopt = failed.find((l) => l.external_id)?.external_id || null;
  const qty = Math.max(1, Math.floor(Number(quantity ?? card.quantity ?? 1) || 1));
  const p = Number(price ?? card.price);
  const ctx = await contextFor(db, userId, marketplace, deps);
  if (ctx.account.status === 'reconnect') throw new MarketplaceError('reconnect', ctx.account.last_error || `${MARKETPLACE_LABELS[marketplace]} stopped accepting your token. Paste a new one in Marketplaces.`);
  await ensureEbayRow(db, userId, card);
  const now = nowIso();
  try {
    const r = await adapterFor(marketplace).createListing(ctx, card, { price: p, quantity: qty, adopt, settings: deps.settings || {} });
    const inv = card.ebay_item_id ? await must(db.from('inventory').select('id').eq('user_id', userId).eq('ebay_item_id', card.ebay_item_id)) : [];
    await must(db.from('marketplace_listings').upsert({
      user_id: userId, snap_item_id: card.id, inventory_id: inv[0]?.id || null, marketplace, external_id: r.externalId, external_variant_id: r.variantId,
      external_listing_id: r.listingId, url: r.url, price: r.price, currency: 'USD', quantity: r.quantity, status: 'active', ended_reason: null,
      last_error: null, listed_at: now, ended_at: null, sold_at: null, synced_at: now, updated_at: now,
    }, { onConflict: 'user_id,marketplace,external_id' }));
    for (const f of failed.filter((x) => x.external_id !== r.externalId)) await must(db.from('marketplace_listings').delete().eq('id', f.id));
    if (Number(card.quantity) !== qty) await must(db.from('snap_items').update({ quantity: qty }).eq('id', card.id).eq('user_id', userId));
    return publicListing(await must(db.from('marketplace_listings').select('*').eq('user_id', userId).eq('marketplace', marketplace).eq('external_id', r.externalId).maybeSingle()));
  } catch (e) {
    await markReconnect(db, userId, marketplace, e);
    const msg = isMarketplaceError(e) ? e.sellerMessage : 'Something went wrong. Try again.';
    const row = { user_id: userId, snap_item_id: card.id, marketplace, status: 'failed', last_error: msg, price: p, quantity: qty, updated_at: now };
    const keep = failed[0];
    if (e.partial?.externalId) {
      if (keep && !keep.external_id) await must(db.from('marketplace_listings').delete().eq('id', keep.id));
      await must(db.from('marketplace_listings').upsert({ ...row, external_id: e.partial.externalId, url: e.partial.url || null }, { onConflict: 'user_id,marketplace,external_id' }));
    } else if (keep) await must(db.from('marketplace_listings').update(row).eq('id', keep.id));
    else await must(db.from('marketplace_listings').insert(row));
    throw e;
  }
}

export async function updateCrossListing(db, userId, { listingId, price, quantity }, deps = {}) {
  const l = await loadListing(db, userId, listingId);
  if (l.status !== 'active') throw new MarketplaceError('rejected', 'That listing isn\'t live any more.');
  if (price == null && quantity == null) throw new MarketplaceError('rejected', 'Nothing to change.');
  if (quantity != null && !(Number(quantity) >= 1)) throw new MarketplaceError('rejected', 'Set a quantity of at least 1, or end the listing.');
  try {
    const ctx = await contextFor(db, userId, l.marketplace, deps);
    const r = await adapterFor(l.marketplace).updateListing(ctx, l, { price: price != null ? Number(price) : undefined, quantity: quantity != null ? Math.floor(Number(quantity)) : undefined });
    const now = nowIso();
    await must(db.from('marketplace_listings').update({ price: r.price, quantity: r.quantity, last_error: null, synced_at: now, updated_at: now }).eq('id', l.id));
    return publicListing({ ...l, price: r.price, quantity: r.quantity, last_error: null });
  } catch (e) { await markReconnect(db, userId, l.marketplace, e); throw e; }
}

export async function endCrossListing(db, userId, { listingId }, deps = {}) {
  const l = await loadListing(db, userId, listingId);
  if (!LIVE.includes(l.status)) return publicListing(l);
  try {
    const ctx = await contextFor(db, userId, l.marketplace, deps);
    await adapterFor(l.marketplace).endListing(ctx, l, { reason: 'seller' });
  } catch (e) {
    await markReconnect(db, userId, l.marketplace, e);
    await db.from('marketplace_listings').update({ last_error: isMarketplaceError(e) ? e.sellerMessage : 'Could not end it.', updated_at: nowIso() }).eq('id', l.id);
    throw e;
  }
  const now = nowIso();
  const card = l.snap_item_id ? await must(db.from('snap_items').select('quantity, sale_note').eq('id', l.snap_item_id).eq('user_id', userId).maybeSingle()) : null;
  const reason = card && Number(card.quantity) === 0 ? 'sold_elsewhere' : 'seller';
  await must(db.from('marketplace_listings').update({ status: 'ended', ended_reason: reason, ended_at: now, last_error: null, updated_at: now }).eq('id', l.id));
  // An "End on eBay" from a sale note: the note now says it ended.
  if (card?.sale_note?.ended) {
    const ended = card.sale_note.ended.map((x) => (x.marketplace === l.marketplace ? { marketplace: l.marketplace, ok: true } : x));
    await must(db.from('snap_items').update({ sale_note: { ...card.sale_note, ended } }).eq('id', l.snap_item_id).eq('user_id', userId));
  }
  return publicListing({ ...l, status: 'ended', ended_reason: reason, ended_at: now, last_error: null });
}

// The card's stock, pushed to every live listing of it.
export async function setStock(db, userId, { snapItemId, quantity }, deps = {}) {
  const q = Math.floor(Number(quantity));
  if (!(q >= 1) || q > 999) throw new MarketplaceError('rejected', 'Set a quantity from 1 to 999. To stop selling, end the listing.');
  const card = await loadCard(db, userId, snapItemId);
  await must(db.from('snap_items').update({ quantity: q, sold_out_at: null }).eq('id', card.id).eq('user_id', userId));
  const live = await must(db.from('marketplace_listings').select('*').eq('user_id', userId).eq('snap_item_id', card.id).eq('status', 'active'));
  const results = [];
  for (const l of live) {
    try { const r = await updateCrossListing(db, userId, { listingId: l.id, quantity: q }, deps); results.push({ marketplace: l.marketplace, ok: true, quantity: r.quantity }); }
    catch (e) { results.push({ marketplace: l.marketplace, ok: false, error: isMarketplaceError(e) ? e.sellerMessage : 'Could not change it.' }); }
  }
  return { quantity: q, results };
}

// "Check for sales now". At most once every 30 seconds per seller.
export async function checkSalesNow(db, userId, deps = {}) {
  const accounts = await must(db.from('marketplace_accounts').select('sales_checked_at').eq('user_id', userId));
  const last = Math.max(0, ...accounts.map((a) => Date.parse(a.sales_checked_at || 0) || 0));
  if (Date.now() - last < SALES_CHECK_GAP_MS) throw Object.assign(new MarketplaceError('rate_limited', 'Checked a moment ago. Try again in 30 seconds.'), { status: 429 });
  const r = await runSaleCheck({ db, userId, deps });
  return { checked: r.checked, newSales: r.newSales, ended: r.ended, updated: r.updated, doubleSales: r.doubleSales, problems: r.problems };
}
