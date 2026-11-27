// netlify/lib/snap-photos.js
// A listing's photos: order, main photo, remove, and straighten-and-crop edits (by the AI or by hand),
// plus sending changed photos to a card that is already live on eBay.
//
// Edits never overwrite a photo. The edited copy is a new file and photo_edits remembers where it
// came from: photo_edits[editedPath] = { original, corners, by: 'ai' | 'manual', at }.
// Undo puts the original back; editing again always starts from the original.
import crypto from 'node:crypto';
import { cropCardPhoto, validCorners } from './photo-crop.js';
import { readCorners } from './card-vision.js';
import { listingPhotoPaths, MAX_LISTING_PHOTOS, liveChanges } from './snap-logic.js';
import { usageRow, logUsage, checkBudget } from './ai-usage.js';
import { uploadListingPhotos, responseOf, wrap, descriptionHtml } from './ebay-listing.js';
import { tradingCall } from './trading-price.js';

const BUCKET = 'snap-photos';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
const editsOf = (item) => (item?.photo_edits && typeof item.photo_edits === 'object' ? { ...item.photo_edits } : {});
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// What every photo change does to the rest of the card: eBay's copies are out of date, and a
// passed eBay check no longer describes the listing (a live listing keeps its state).
function changed(item, order, edits) {
  const patch = { photo_path: order[0], extra_photo_paths: order.slice(1), back_photo_path: null, photo_edits: edits, ebay_picture_urls: null };
  if (item.status !== 'listed') Object.assign(patch, { publish_state: null, publish_check: null });
  return patch;
}

async function save(db, userId, item, patch) {
  await must(db.from('snap_items').update(patch).eq('id', item.id).eq('user_id', userId));
  return { ...item, ...patch };
}

function ownPhoto(item, userId, path) {
  if (!path || !String(path).startsWith(`${userId}/`)) throw fail('That photo does not belong to you.', 403);
  if (!listingPhotoPaths(item).includes(path)) throw fail('That photo is not on this card.', 404);
}

async function download(db, path) {
  const { data, error } = await db.storage.from(BUCKET).download(path);
  if (error || !data) throw fail(`Couldn't open the photo: ${error?.message || 'missing'}`, 404);
  return Buffer.from(await data.arrayBuffer());
}

const editedName = (original) => `${String(original).replace(/(-edit-[a-z0-9]+)?\.jpe?g$/i, '')}-edit-${crypto.randomBytes(4).toString('hex')}.jpg`;

// Straightens `path` (or, if it is already an edit, its original) with these corners and puts the
// result in the photo's place in the listing.
export async function applyCrop({ db, userId, item, path, corners, by = 'manual', refine = false }) {
  ownPhoto(item, userId, path);
  if (item.photo_crop && path === item.photo_path) throw fail('This photo is a whole binder page. Replace it with a photo of the card itself first.', 409);
  if (!validCorners(corners)) throw fail('Those corners don\'t outline a card. Drag the four handles onto the card\'s corners.');
  const edits = editsOf(item);
  const original = edits[path]?.original || path;
  const graded = !!item.extraction?.graded;
  const out = cropCardPhoto(await download(db, original), corners, { refine, game: item.game, graded });
  const newPath = editedName(original);
  const up = await db.storage.from(BUCKET).upload(newPath, out.jpeg, { contentType: 'image/jpeg', upsert: false });
  if (up.error) throw new Error(`Couldn't save the edited photo: ${up.error.message}`);
  delete edits[path];
  edits[newPath] = { original, corners: out.corners, by, at: new Date().toISOString() };
  const order = listingPhotoPaths(item).map((p) => (p === path ? newPath : p));
  const saved = await save(db, userId, item, changed(item, order, edits));
  if (path !== original) await db.storage.from(BUCKET).remove([path]).catch(() => {}); // the previous edit
  return saved;
}

// Puts the original photo back.
export async function undoEdit({ db, userId, item, path }) {
  ownPhoto(item, userId, path);
  const edits = editsOf(item);
  const original = edits[path]?.original;
  if (!original) throw fail('This photo has not been edited.', 409);
  delete edits[path];
  const order = listingPhotoPaths(item).map((p) => (p === path ? original : p));
  const saved = await save(db, userId, item, changed(item, order, edits));
  await db.storage.from(BUCKET).remove([path]).catch(() => {});
  return saved;
}

// New order for the listing's photos: the first is the main photo. Photos left out are removed.
export async function setPhotoOrder({ db, userId, item, paths }) {
  const current = listingPhotoPaths(item);
  const order = [...new Set((Array.isArray(paths) ? paths : []).map(String))];
  if (!order.length) throw fail('A listing needs at least one photo.');
  if (order.length > MAX_LISTING_PHOTOS) throw fail(`A listing can have up to ${MAX_LISTING_PHOTOS} photos.`);
  const unknown = order.filter((p) => !current.includes(p));
  if (unknown.length) throw fail('One of those photos is not on this card. Reload and try again.', 409);
  if (item.photo_crop && order[0] !== item.photo_path) throw fail('Replace the binder-page photo with a photo of the card before changing the main photo.', 409);
  const removed = current.filter((p) => !order.includes(p));
  const edits = editsOf(item);
  const files = [];
  for (const p of removed) { files.push(p); if (edits[p]) { files.push(edits[p].original); delete edits[p]; } }
  if (order.join('\n') === current.join('\n')) return item;
  const saved = await save(db, userId, item, changed(item, order, edits));
  if (files.length) await db.storage.from(BUCKET).remove(files).catch(() => {});
  return saved;
}

// The AI finds the card's corners; refinement then snaps them onto the card's real edges.
// About a cent a photo, logged and counted in the monthly AI budget like every other Claude call.
export async function autoCrop({ db, userId, item, path, settings, deps = {} }) {
  ownPhoto(item, userId, path);
  const budget = await checkBudget(db, userId, settings);
  if (!budget.ok) throw Object.assign(fail(`Monthly AI budget reached ($${budget.spent.toFixed(2)} of $${budget.budget.toFixed(2)}). Place the corners by hand, or raise the budget in Snap settings.`, 429), { code: 'BUDGET' });
  const original = editsOf(item)[path]?.original || path;
  const bytes = await download(db, original);
  const model = settings.snapModel;
  let r;
  try {
    r = await (deps.readCorners || readCorners)({ model, image: { base64: bytes.toString('base64'), mediaType: 'image/jpeg' } });
    await logUsage(db, usageRow({ userId, model, purpose: 'photo_crop', usage: r.usage, latencyMs: r.latencyMs, requestId: r.requestId, snapItemId: item.id }));
  } catch (err) {
    if (err.usage) await logUsage(db, usageRow({ userId, model, purpose: 'photo_crop', usage: err.usage, latencyMs: err.latencyMs, requestId: err.requestId, snapItemId: item.id, ok: false, error: err.message }));
    throw err;
  }
  if (!r.read.card_found || !validCorners(r.read.card_corners)) {
    throw fail('The AI couldn\'t find all four corners of one card in this photo. Place them by hand with Edit.', 422);
  }
  return applyCrop({ db, userId, item, path, corners: r.read.card_corners, by: 'ai', refine: true });
}

// Right after a snap is identified: the read already holds the card's corners, so this costs nothing
// extra. Any problem leaves the photo as it was; it never fails the identification.
export async function autoCropOnSnap({ db, userId, item, read, settings }) {
  if (settings?.snapAutoCrop === false || !read?.is_trading_card || !validCorners(read?.card_corners)) return null;
  if (item.photo_crop || editsOf(item)[item.photo_path]) return null;
  try {
    return await applyCrop({ db, userId, item, path: item.photo_path, corners: read.card_corners, by: 'ai', refine: true });
  } catch (err) {
    console.error('auto crop', err.message);
    return null;
  }
}

// A card already live on eBay: send what changed (photos, title, description) in one revision.
const cdata = (v) => `<![CDATA[${String(v ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
export function buildReviseXml(itemId, { urls = null, title = null, descriptionHtml: desc = null } = {}) {
  const parts = [
    title != null ? `<Title>${esc(title)}</Title>` : '',
    desc != null ? `<Description>${cdata(desc)}</Description>` : '',
    urls ? `<PictureDetails>${urls.map((u) => `<PictureURL>${esc(u)}</PictureURL>`).join('')}</PictureDetails>` : '',
  ].join('');
  return wrap('ReviseFixedPriceItem', `<Item><ItemID>${esc(itemId)}</ItemID>${parts}</Item>`);
}
export const buildPictureReviseXml = (itemId, urls) => buildReviseXml(itemId, { urls });

export async function pushChangesToEbay({ db, userId, token, item, call = tradingCall, fetchImpl = fetch }) {
  if (item.status !== 'listed' || !item.ebay_item_id) throw fail('This card is not live on eBay. Its photos go up when you check and publish it.', 409);
  const changes = liveChanges(item);
  if (!changes.length) throw fail('Nothing to update: eBay already shows this card\'s photos, title and description.', 409);
  const title = String(item.title || '').trim();
  if (changes.includes('title') && (!title || title.length > 80)) throw fail('The title must be 1 to 80 characters.', 400);
  let urls = null;
  if (changes.includes('photos')) {
    const paths = listingPhotoPaths(item);
    if (paths.some((p) => !String(p).startsWith(`${userId}/`))) throw fail('One of the photos does not belong to you.', 403);
    urls = await uploadListingPhotos({ db, token, item, paths, fetchImpl });
  }
  const xml = await call(token, 'ReviseFixedPriceItem', buildReviseXml(item.ebay_item_id, {
    urls,
    title: changes.includes('title') ? title : null,
    descriptionHtml: changes.includes('description') ? descriptionHtml(item) : null,
  }));
  const { errors } = responseOf(xml, 'ReviseFixedPriceItem');
  if (errors.length) throw fail(`eBay didn't take the changes: ${errors.join('; ')}`, 502);
  const patch = { ebay_live: { title: item.title ?? null, description: item.description ?? null } };
  if (urls) patch.ebay_picture_urls = urls;
  await must(db.from('snap_items').update(patch).eq('id', item.id).eq('user_id', userId));
  const listing = {};
  if (urls) listing.image_url = urls[0];
  if (changes.includes('title')) listing.title = title;
  if (Object.keys(listing).length) await db.from('ebay_listings').update(listing).eq('user_id', userId).eq('item_id', String(item.ebay_item_id));
  return { ...item, ...patch, updated: changes };
}
export const pushPhotosToEbay = pushChangesToEbay;

// Photos on a live card that eBay doesn't have yet.
export const photosOutOfDate = (item) => item?.status === 'listed' && !(item.ebay_picture_urls || []).length;
