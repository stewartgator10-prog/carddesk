// A listing's photos: auto-crop on snap, manual crop, undo, reorder/remove, budget, live eBay update.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import jpeg from 'jpeg-js';
import { fakeDb } from './fake-db.js';
import { applyCrop, undoEdit, setPhotoOrder, autoCrop, autoCropOnSnap, pushPhotosToEbay, buildPictureReviseXml, photosOutOfDate } from '../netlify/lib/snap-photos.js';
import { decodeJpeg } from '../netlify/lib/photo-crop.js';
import { SNAP_DEFAULTS } from '../netlify/lib/snap-logic.js';

const U = 'u1';
const W = 400, H = 300;
// A dark table with a light upright card from (100,40) to (300,270).
function photo() {
  const d = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { const x = i % W, y = (i / W) | 0; const v = x >= 100 && x < 300 && y >= 40 && y < 270 ? 220 : 30; d.set([v, v, v, 255], i * 4); }
  return Buffer.from(jpeg.encode({ width: W, height: H, data: d }, 92).data);
}
const corners = { tl: { x: 100 / W, y: 40 / H }, tr: { x: 300 / W, y: 40 / H }, br: { x: 300 / W, y: 270 / H }, bl: { x: 100 / W, y: 270 / H } };
function setup(over = {}) {
  const files = { [`${U}/b/c1.jpg`]: photo(), [`${U}/b/c1-x-1.jpg`]: photo(), [`${U}/b/c1-x-2.jpg`]: photo() };
  const item = { id: 'c1', user_id: U, status: 'approved', game: 'pokemon', photo_path: `${U}/b/c1.jpg`, extra_photo_paths: [`${U}/b/c1-x-1.jpg`, `${U}/b/c1-x-2.jpg`],
    photo_edits: {}, publish_state: 'checked', publish_check: { ok: true }, ebay_picture_urls: ['a', 'b', 'c'], ...over };
  const db = fakeDb({ snap_items: [item], settings: [], api_usage: [], ebay_listings: [{ user_id: U, item_id: '99', image_url: 'old' }] }, {}, { files });
  return { db, item: db.tables.snap_items[0] };
}

test('manual crop: new edited file in the same place, original kept, check reset; editing again starts from the original', async () => {
  const { db, item } = setup();
  const a = await applyCrop({ db, userId: U, item, path: `${U}/b/c1-x-1.jpg`, corners });
  const edited = a.extra_photo_paths[0];
  assert.match(edited, /^u1\/b\/c1-x-1-edit-[0-9a-f]{8}\.jpg$/);
  assert.equal(a.photo_path, `${U}/b/c1.jpg`);
  assert.deepEqual(a.photo_edits[edited].original, `${U}/b/c1-x-1.jpg`);
  assert.equal(a.photo_edits[edited].by, 'manual');
  assert.ok(db.files[`${U}/b/c1-x-1.jpg`], 'original kept');
  const out = decodeJpeg(db.files[edited]);
  assert.equal(out.width, 1200); assert.equal(out.height, Math.round(1200 * 88 / 63));   // card proportions, filling the image
  assert.equal(a.publish_state, null); assert.equal(a.ebay_picture_urls, null);

  const b = await applyCrop({ db, userId: U, item: db.tables.snap_items[0], path: edited, corners });
  const again = b.extra_photo_paths[0];
  assert.notEqual(again, edited);
  assert.equal(b.photo_edits[again].original, `${U}/b/c1-x-1.jpg`);
  assert.equal(db.files[edited], undefined, 'the previous edit is tidied up');
  assert.equal(Object.keys(b.photo_edits).length, 1);

  const c = await undoEdit({ db, userId: U, item: db.tables.snap_items[0], path: again });
  assert.equal(c.extra_photo_paths[0], `${U}/b/c1-x-1.jpg`);
  assert.deepEqual(c.photo_edits, {});
  assert.equal(db.files[again], undefined);
});

test('ownership and sanity: other people\'s photos, photos not on the card, nonsense corners', async () => {
  const { db, item } = setup();
  await assert.rejects(applyCrop({ db, userId: U, item, path: 'u2/b/x.jpg', corners }), (e) => e.status === 403);
  await assert.rejects(applyCrop({ db, userId: U, item, path: `${U}/b/other.jpg`, corners }), (e) => e.status === 404);
  await assert.rejects(applyCrop({ db, userId: U, item, path: item.photo_path, corners: { tl: corners.tl } }), /don't outline a card/);
  await assert.rejects(undoEdit({ db, userId: U, item, path: item.photo_path }), /not been edited/);
});

test('order: reorder sets the main photo, removing deletes the photo and its original', async () => {
  const { db, item } = setup();
  const a = await applyCrop({ db, userId: U, item, path: `${U}/b/c1-x-2.jpg`, corners });
  const edited = a.extra_photo_paths[1];
  const b = await setPhotoOrder({ db, userId: U, item: db.tables.snap_items[0], paths: [edited, `${U}/b/c1.jpg`] });
  assert.equal(b.photo_path, edited);
  assert.deepEqual(b.extra_photo_paths, [`${U}/b/c1.jpg`]);
  assert.equal(db.files[`${U}/b/c1-x-1.jpg`], undefined, 'removed photo deleted');
  const c = await setPhotoOrder({ db, userId: U, item: db.tables.snap_items[0], paths: [`${U}/b/c1.jpg`] });
  assert.equal(db.files[edited], undefined); assert.equal(db.files[`${U}/b/c1-x-2.jpg`], undefined, 'its original too');
  assert.deepEqual(c.photo_edits, {});
  await assert.rejects(setPhotoOrder({ db, userId: U, item: db.tables.snap_items[0], paths: [] }), /at least one photo/);
  await assert.rejects(setPhotoOrder({ db, userId: U, item: db.tables.snap_items[0], paths: ['u1/b/zzz.jpg'] }), (e) => e.status === 409);
});

test('auto-crop on snap uses the corners from the identify read; off switch, binder pages and bad corners leave the photo alone', async () => {
  const { db, item } = setup({ status: 'ready', extra_photo_paths: [] });
  const read = { is_trading_card: true, card_corners: { tl: { x: 0.26, y: 0.12 }, tr: { x: 0.74, y: 0.14 }, br: { x: 0.76, y: 0.9 }, bl: { x: 0.24, y: 0.88 } } };
  const done = await autoCropOnSnap({ db, userId: U, item, read, settings: SNAP_DEFAULTS });
  assert.match(done.photo_path, /-edit-/);
  assert.equal(done.photo_edits[done.photo_path].by, 'ai');
  // Refinement moved the rough corners onto the real edges (100..300 x 40..270).
  const c = done.photo_edits[done.photo_path].corners;
  assert.ok(Math.abs(c.tl.x * W - 100) < 4 && Math.abs(c.br.y * H - 270) < 4, JSON.stringify(c));
  assert.equal(await autoCropOnSnap({ db, userId: U, item: db.tables.snap_items[0], read, settings: SNAP_DEFAULTS }), null, 'never twice');
  const s2 = setup();
  assert.equal(await autoCropOnSnap({ db: s2.db, userId: U, item: s2.item, read, settings: { ...SNAP_DEFAULTS, snapAutoCrop: false } }), null);
  assert.equal(await autoCropOnSnap({ db: s2.db, userId: U, item: { ...s2.item, photo_crop: { x: 0, y: 0, w: 0.3, h: 0.3 } }, read, settings: SNAP_DEFAULTS }), null);
  assert.equal(await autoCropOnSnap({ db: s2.db, userId: U, item: s2.item, read: { ...read, card_corners: null }, settings: SNAP_DEFAULTS }), null);
  assert.equal(await autoCropOnSnap({ db: s2.db, userId: U, item: { ...s2.item, photo_path: `${U}/b/missing.jpg`, extra_photo_paths: [] }, read, settings: SNAP_DEFAULTS }), null, 'a problem never fails the snap');
});

test('AI auto-crop of an added photo: logged as photo_crop, budget respected, no card found explains itself', async () => {
  const { db, item } = setup();
  const deps = { readCorners: async () => ({ read: { card_found: true, graded: false, card_corners: corners }, usage: { input_tokens: 1600, output_tokens: 120 }, latencyMs: 900 }) };
  const a = await autoCrop({ db, userId: U, item, path: `${U}/b/c1-x-1.jpg`, settings: SNAP_DEFAULTS, deps });
  assert.match(a.extra_photo_paths[0], /-edit-/);
  assert.equal(db.tables.api_usage.length, 1);
  assert.equal(db.tables.api_usage[0].purpose, 'photo_crop');
  assert.ok(db.tables.api_usage[0].cost_usd > 0 && db.tables.api_usage[0].cost_usd < 0.03, String(db.tables.api_usage[0].cost_usd));

  const none = { readCorners: async () => ({ read: { card_found: false, graded: false, card_corners: null }, usage: { input_tokens: 1600, output_tokens: 20 } }) };
  await assert.rejects(autoCrop({ db, userId: U, item: db.tables.snap_items[0], path: `${U}/b/c1-x-2.jpg`, settings: SNAP_DEFAULTS, deps: none }), /Place them by hand/);

  let called = false;
  db.tables.api_usage.push({ user_id: U, cost_usd: 5, created_at: new Date().toISOString() });
  await assert.rejects(autoCrop({ db, userId: U, item: db.tables.snap_items[0], path: `${U}/b/c1-x-2.jpg`, settings: { ...SNAP_DEFAULTS, aiMonthlyBudget: 1 }, deps: { readCorners: async () => { called = true; } } }), (e) => e.code === 'BUDGET');
  assert.equal(called, false);
});

test('live listing: photo changes mark it out of date; sending replaces the pictures on eBay', async () => {
  const { db, item } = setup({ status: 'listed', ebay_item_id: '99', publish_state: 'listed' });
  const a = await applyCrop({ db, userId: U, item, path: item.photo_path, corners });
  assert.equal(a.publish_state, 'listed', 'a live listing keeps its state');
  assert.ok(photosOutOfDate(a));
  const sent = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('create_image')) return new Response('', { status: 201, headers: { location: `https://apim.ebay.com/commerce/media/v1_beta/image/img${sent.length}` } });
    sent.push(url);
    return new Response(JSON.stringify({ imageUrl: `https://i.ebayimg.com/p${sent.length}.jpg` }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  let xmlSent = null;
  const call = async (token, name, xml) => { xmlSent = xml; return '<ReviseFixedPriceItemResponse><Ack>Success</Ack></ReviseFixedPriceItemResponse>'; };
  const b = await pushPhotosToEbay({ db, userId: U, token: 't', item: db.tables.snap_items[0], call, fetchImpl });
  assert.equal(b.ebay_picture_urls.length, 3);
  assert.match(xmlSent, /<ItemID>99<\/ItemID><PictureDetails>(<PictureURL>[^<]+<\/PictureURL>){3}<\/PictureDetails>/);
  assert.equal(db.tables.ebay_listings[0].image_url, b.ebay_picture_urls[0]);
  assert.ok(!photosOutOfDate(b));
  await assert.rejects(pushPhotosToEbay({ db, userId: U, token: 't', item: { ...item, status: 'approved' }, call, fetchImpl }), /not live on eBay/);
  assert.match(buildPictureReviseXml('1', ['a&b']), /a&amp;b/);
});
