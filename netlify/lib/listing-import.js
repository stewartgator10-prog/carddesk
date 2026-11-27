// netlify/lib/listing-import.js
// Brings eBay listings made before CardDesk into the Snap tab as live cards (status 'listed'), so their
// photos, title and description can be edited in CardDesk and sent back to eBay.
// Importing changes nothing on eBay: it reads the listing and copies its photos into CardDesk storage.
// The listing's inventory row, price and sales matching already exist from the eBay sync.
import crypto from 'node:crypto';
import { tradingCall } from './trading-price.js';
import { wrap, responseOf, FALLBACK_CONDITION_VALUES } from './ebay-listing.js';
import { htmlToText, gameFromTitle, MAX_LISTING_PHOTOS } from './snap-logic.js';
import { cropCardPhoto } from './photo-crop.js';

export const IMPORT_PER_CALL = 4;   // listings per request; each is one eBay call plus its photos
const BUCKET = 'snap-photos';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
const text = (v) => (v == null ? null : typeof v === 'object' ? (v['#text'] ?? null) : String(v));
const CONDITION_BY_VALUE = Object.fromEntries(Object.entries(FALLBACK_CONDITION_VALUES).filter(([k]) => k !== 'DMG').map(([k, v]) => [v, k]));

// The seller's active listings that aren't CardDesk cards yet.
export async function pendingImports({ db, userId }) {
  const [listings, cards] = await Promise.all([
    must(db.from('ebay_listings').select('item_id, title, listing_type').eq('user_id', userId).eq('status', 'Active')),
    must(db.from('snap_items').select('ebay_item_id').eq('user_id', userId).in('status', ['listed', 'approved'])),
  ]);
  const have = new Set(cards.map((c) => String(c.ebay_item_id)).filter(Boolean));
  const pending = listings.filter((l) => !have.has(String(l.item_id)) && (!l.listing_type || l.listing_type === 'FixedPriceItem'));
  const imported = await must(db.from('snap_items').select('id, ebay_live, ebay_picture_urls').eq('user_id', userId).eq('status', 'listed').not('imported_from_ebay_at', 'is', null));
  return { active: listings.length, inCardDesk: listings.length - pending.length, pending: pending.map((l) => String(l.item_id)),
    needsFullSize: imported.filter(needsFullSize).map((c) => c.id) };
}

export const buildGetItemXml = (itemId) => wrap('GetItem', `<ItemID>${String(itemId).replace(/[^0-9]/g, '')}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics>`);

// eBay's GetItem answer -> the parts of a Snap card.
export function cardFromItem(it) {
  const pics = [].concat(it.PictureDetails?.PictureURL || []).map(text).filter(Boolean).slice(0, MAX_LISTING_PHOTOS);
  const descriptors = [].concat(it.ConditionDescriptors?.ConditionDescriptor || []);
  const cardCond = descriptors.find((d) => text(d.Name) === '40001');
  const condValue = cardCond ? text([].concat(cardCond.Value || [])[0]) : null;
  const graded = text(it.ConditionID) === '2750';
  const title = text(it.Title) || '';
  return {
    title,
    description: htmlToText(text(it.Description)),
    price: Number(text(it.StartPrice) ?? text(it.SellingStatus?.CurrentPrice)) || null,
    sku: text(it.SKU),
    listed_at: text(it.ListingDetails?.StartTime) || null,
    condition: (!graded && CONDITION_BY_VALUE[condValue]) || 'NM',
    game: gameFromTitle(title),
    graded,
    pictures: pics,
  };
}

// GetItem hands back small preview links (".../z/<id>/$_1.JPG" is 400 pixels). The same picture at
// full size (up to 1600 pixels) lives at ".../images/g/<id>/s-l1600.jpg".
export function fullSizeEbayPhoto(url) {
  const u = String(url || '');
  const z = u.match(/^https:\/\/i\.ebayimg\.com\/.*\/z\/([^/]+)\/\$_\d+\.(?:jpe?g|png|webp)/i);
  if (z) return `https://i.ebayimg.com/images/g/${z[1]}/s-l1600.jpg`;
  const g = u.match(/^(https:\/\/i\.ebayimg\.com\/images\/g\/[^/]+)\/s-l\d+\.(?:jpe?g|png|webp)/i);
  if (g) return `${g[1]}/s-l1600.jpg`;
  return u;
}

async function fetchPhoto(url, fetchImpl) {
  const res = await fetchImpl(url, { headers: { Accept: 'image/jpeg,image/*;q=0.8' } });
  if (!res.ok) throw new Error(`photo HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
  if (!type.startsWith('image/')) throw new Error(`photo is ${type}`);
  return { bytes: Buffer.from(await res.arrayBuffer()), type };
}
// The full-size picture, or the link as given if eBay has no larger one.
async function fetchBest(url, fetchImpl) {
  const big = fullSizeEbayPhoto(url);
  if (big !== url) { try { return await fetchPhoto(big, fetchImpl); } catch { /* fall back to the given link */ } }
  return fetchPhoto(url, fetchImpl);
}

async function copyPhoto({ db, url, path, fetchImpl }) {
  const { bytes, type } = await fetchBest(url, fetchImpl);
  const up = await db.storage.from(BUCKET).upload(path, bytes, { contentType: type, upsert: false });
  if (up.error) throw new Error(up.error.message);
  return path;
}
// One listing: read it from eBay, copy its photos, save the card. Returns the new card.
export async function importListing({ db, userId, token, itemId, call = tradingCall, fetchImpl = fetch }) {
  const id = String(itemId);
  const own = await must(db.from('ebay_listings').select('item_id').eq('user_id', userId).eq('item_id', id));
  if (!own.length) throw fail('Not one of your eBay listings.', 404);
  const existing = await must(db.from('snap_items').select('id').eq('user_id', userId).eq('ebay_item_id', id).in('status', ['listed', 'approved']));
  if (existing.length) return { skipped: true, id: existing[0].id };

  const xml = await call(token, 'GetItem', buildGetItemXml(id));
  const { r, errors } = responseOf(xml, 'GetItem');
  if (errors.length || !r.Item) throw new Error(errors.join('; ') || 'eBay returned no listing');
  const item = Array.isArray(r.Item) ? r.Item[0] : r.Item;
  if (text(item.SellingStatus?.ListingStatus) && text(item.SellingStatus.ListingStatus) !== 'Active') throw new Error('this listing has ended');
  const c = cardFromItem(item);
  if (!c.pictures.length) throw new Error('the listing has no photos');

  const snapId = crypto.randomUUID();
  const base = `${userId}/ebay-import/${snapId}`;
  const copies = await Promise.allSettled(c.pictures.map((u, n) => copyPhoto({ db, url: u, path: `${base}-p${n + 1}.jpg`, fetchImpl })));
  const paths = copies.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  const bad = copies.find((x) => x.status === 'rejected');
  if (bad) {   // all or nothing: a card missing some of its photos would drop them from eBay on the next update
    if (paths.length) await db.storage.from(BUCKET).remove(paths).catch(() => {});
    throw bad.reason;
  }
  const now = new Date().toISOString();
  const row = {
    id: snapId, user_id: userId, batch_id: 'ebay-import', status: 'listed', publish_state: 'listed',
    photo_path: paths[0], extra_photo_paths: paths.slice(1), photo_edits: {}, review_reasons: [],
    title: c.title, card_name: c.title, description: c.description, price: c.price, condition: c.condition, game: c.game,
    sku: c.sku, ebay_item_id: id, ebay_url: `https://www.ebay.com/itm/${id}`, listed_at: c.listed_at || now,
    ebay_picture_urls: c.pictures,
    ebay_live: { title: c.title, description: c.description, full_size: true, photos: Object.fromEntries(paths.map((p, n) => [p, c.pictures[n]])) },
    extraction: c.graded ? { graded: true } : null, imported_from_ebay_at: now,
  };
  try {
    await must(db.from('snap_items').insert(row));
  } catch (err) {
    await db.storage.from(BUCKET).remove(paths).catch(() => {});
    throw err;
  }
  return { imported: true, item: row };
}

// A few listings per request (the browser loops until none are left).
export async function importListings({ db, userId, token, itemIds, call, fetchImpl }) {
  const ids = [...new Set((itemIds || []).map(String))].slice(0, IMPORT_PER_CALL);
  if (!ids.length) throw fail('item_ids is required.');
  return Promise.all(ids.map(async (itemId) => {
    try {
      const r = await importListing({ db, userId, token, itemId, call, fetchImpl });
      return { item_id: itemId, ok: true, skipped: !!r.skipped };
    } catch (err) {
      return { item_id: itemId, ok: false, error: err.message };
    }
  }));
}

// ---------- full-size photos for cards brought in before this fix ----------
// The first imports copied eBay's 400-pixel previews. Those are too small for eBay to take back
// (it needs 500 pixels) and too soft to straighten well. This re-copies each original at full size
// and redoes any straighten-and-crop from it with the same corners.
export const needsFullSize = (c) => !c.ebay_live?.full_size && !c.ebay_live?.photos;

export async function refreshFullSize({ db, userId, token, snapId, call = tradingCall, fetchImpl = fetch }) {
  const card = (await must(db.from('snap_items').select('*').eq('user_id', userId).eq('id', String(snapId))))[0];
  if (!card || !card.imported_from_ebay_at || !card.ebay_item_id) throw fail('Not a card brought in from eBay.', 404);
  if (!needsFullSize(card)) return { skipped: true };
  const xml = await call(token, 'GetItem', buildGetItemXml(card.ebay_item_id));
  const { r, errors } = responseOf(xml, 'GetItem');
  if (errors.length || !r.Item) throw new Error(errors.join('; ') || 'eBay returned no listing');
  const pics = cardFromItem(Array.isArray(r.Item) ? r.Item[0] : r.Item).pictures;
  const base = `${userId}/ebay-import/${card.id}`;
  const edits = card.photo_edits || {};
  const photos = {};
  for (const [n, url] of pics.entries()) {
    const original = `${base}-p${n + 1}.jpg`;
    const { bytes, type } = await fetchBest(url, fetchImpl);
    const up = await db.storage.from(BUCKET).upload(original, bytes, { contentType: type, upsert: true });
    if (up.error) throw new Error(up.error.message);
    photos[original] = url;
    // Straightened copies of this photo: redo them from the full-size original, same corners.
    for (const [edited, e] of Object.entries(edits)) {
      if (e?.original !== original || !e.corners) continue;
      try {
        const out = cropCardPhoto(bytes, e.corners, { refine: false, game: card.game, graded: !!card.extraction?.graded });
        const u2 = await db.storage.from(BUCKET).upload(edited, out.jpeg, { contentType: 'image/jpeg', upsert: true });
        if (u2.error) throw new Error(u2.error.message);
      } catch (err) { console.error('full-size recrop', edited, err.message); }
    }
  }
  // eBay still shows exactly these pictures, so unchanged ones can be reused on the next update.
  const ebayLive = { ...(card.ebay_live || {}), full_size: true, photos };
  await must(db.from('snap_items').update({ ebay_live: ebayLive }).eq('id', card.id).eq('user_id', userId));
  return { refreshed: pics.length };
}

export async function refreshFullSizeMany({ db, userId, token, snapIds, call, fetchImpl }) {
  const ids = [...new Set((snapIds || []).map(String))].slice(0, IMPORT_PER_CALL);
  if (!ids.length) throw fail('ids is required.');
  return Promise.all(ids.map(async (id) => {
    try { return { id, ok: true, ...(await refreshFullSize({ db, userId, token, snapId: id, call, fetchImpl })) }; }
    catch (err) { return { id, ok: false, error: err.message }; }
  }));
}
