// Older eBay listings brought into CardDesk, edited, and sent back to eBay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './fake-db.js';
import { pendingImports, importListings, importListing, cardFromItem, buildGetItemXml } from '../netlify/lib/listing-import.js';
import { pushChangesToEbay, buildReviseXml } from '../netlify/lib/snap-photos.js';
import { liveChanges, htmlToText, gameFromTitle } from '../netlify/lib/snap-logic.js';
import { parseXml } from '../netlify/lib/ebay-listing.js';

const U = 'u1';
const getItem = (id, over = '') => `<?xml version="1.0"?><GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item>
  <ItemID>${id}</ItemID><Title>Pidgeot ex 164/165 Pokemon 151 Full Art NM</Title><SKU>JB-77</SKU>
  <Description>&lt;div&gt;&lt;h2&gt;Pidgeot ex&lt;/h2&gt;&lt;p&gt;Pack fresh &amp;amp; sleeved.&lt;br&gt;Ships fast.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Near Mint&lt;/li&gt;&lt;/ul&gt;&lt;/div&gt;</Description>
  <StartPrice currencyID="USD">24.99</StartPrice><ListingDetails><StartTime>2026-03-02T10:00:00.000Z</StartTime></ListingDetails>
  <SellingStatus><ListingStatus>Active</ListingStatus></SellingStatus><ConditionID>4000</ConditionID>
  <ConditionDescriptors><ConditionDescriptor><Name>40001</Name><Value>400015</Value></ConditionDescriptor></ConditionDescriptors>
  <PictureDetails><PictureURL>https://i.ebayimg.com/00/s/a/$_57.JPG</PictureURL><PictureURL>https://i.ebayimg.com/00/s/b/$_57.JPG</PictureURL></PictureDetails>${over}
</Item></GetItemResponse>`;
const jpegResponse = () => new Response(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { status: 200, headers: { 'content-type': 'image/jpeg' } });

function setup() {
  return fakeDb({
    ebay_listings: [
      { user_id: U, item_id: '111', title: 'Pidgeot ex', status: 'Active', listing_type: 'FixedPriceItem' },
      { user_id: U, item_id: '222', title: 'Charizard', status: 'Active', listing_type: 'FixedPriceItem' },
      { user_id: U, item_id: '333', title: 'Auction', status: 'Active', listing_type: 'Chinese' },
      { user_id: U, item_id: '444', title: 'Ended', status: 'Completed', listing_type: 'FixedPriceItem' },
    ],
    snap_items: [{ id: 's1', user_id: U, status: 'listed', ebay_item_id: '222', photo_path: 'u1/b/s1.jpg' }],
  });
}

test('description HTML to editable text; game from a hand-written title', () => {
  assert.equal(htmlToText('<div><h2>Pidgeot ex</h2><p>Pack fresh &amp; sleeved.<br>Ships fast.</p><ul><li>Near Mint</li></ul><style>p{}</style></div>'),
    'Pidgeot ex\n\nPack fresh & sleeved.\nShips fast.\n\n- Near Mint');
  assert.equal(htmlToText('caf&eacute;&#233; &#x2014; &nbsp;ok'), 'caf&eacute;é — ok');
  assert.equal(gameFromTitle('Black Lotus MTG Alpha'), 'mtg');
  assert.equal(gameFromTitle('Blue-Eyes Yu-Gi-Oh LOB-001'), 'yugioh');
  assert.equal(gameFromTitle('Pidgeot ex Pokemon 151'), 'pokemon');
  assert.match(buildGetItemXml('12a3'), /<ItemID>123<\/ItemID>/);
});

test('pending: active Buy It Now listings that are not cards yet', async () => {
  const p = await pendingImports({ db: setup(), userId: U });
  assert.deepEqual(p, { active: 3, inCardDesk: 2, pending: ['111'] });
});

test('import: reads the listing, copies its photos, saves a live card with nothing to send back', async () => {
  const db = setup();
  const seen = [];
  const call = async (tok, name, xml) => { seen.push(name); assert.match(xml, /<ItemID>111<\/ItemID>/); return getItem('111'); };
  const fetchImpl = async (url) => { seen.push(url); return jpegResponse(); };
  const r = await importListing({ db, userId: U, token: 't', itemId: '111', call, fetchImpl });
  const card = r.item;
  assert.equal(card.status, 'listed'); assert.equal(card.ebay_item_id, '111'); assert.equal(card.price, 24.99);
  assert.equal(card.condition, 'LP'); assert.equal(card.game, 'pokemon'); assert.equal(card.sku, 'JB-77');
  assert.equal(card.description, 'Pidgeot ex\n\nPack fresh & sleeved.\nShips fast.\n\n- Near Mint');
  assert.match(card.photo_path, /^u1\/ebay-import\/.+-p1\.jpg$/); assert.equal(card.extra_photo_paths.length, 1);
  assert.ok(db.files[card.photo_path], 'photo copied into storage');
  assert.deepEqual(card.ebay_picture_urls, ['https://i.ebayimg.com/00/s/a/$_57.JPG', 'https://i.ebayimg.com/00/s/b/$_57.JPG']);
  assert.deepEqual(liveChanges(card), [], 'freshly imported: eBay already shows all of it');
  assert.deepEqual(seen, ['GetItem', 'https://i.ebayimg.com/00/s/a/$_57.JPG', 'https://i.ebayimg.com/00/s/b/$_57.JPG']);
  // A second import of the same listing does nothing.
  assert.equal((await importListing({ db, userId: U, token: 't', itemId: '111', call, fetchImpl })).skipped, true);
  assert.equal(db.tables.snap_items.length, 2);
  await assert.rejects(importListing({ db, userId: U, token: 't', itemId: '999', call, fetchImpl }), /Not one of your eBay listings/);
});

test('batch import: a few per call, one failure does not stop the rest, nothing half-saved', async () => {
  const db = setup();
  db.tables.ebay_listings.push({ user_id: U, item_id: '555', title: 'x', status: 'Active' }, { user_id: U, item_id: '666', title: 'y', status: 'Active' });
  const call = async (tok, name, xml) => { const id = xml.match(/<ItemID>(\d+)/)[1]; return getItem(id, id === '666' ? '' : ''); };
  const fetchImpl = async (url) => (String(url).includes('/b/') && fetchImpl.failB ? new Response('nope', { status: 404 }) : jpegResponse());
  fetchImpl.failB = true;
  const out = await importListings({ db, userId: U, token: 't', itemIds: ['111', '555', '666', '111', '777', '888'], call, fetchImpl });
  assert.equal(out.length, 4, 'four per call, duplicates dropped');
  assert.ok(out.every((r) => r.ok === false && /photo HTTP 404/.test(r.error) || r.error === 'Not one of your eBay listings.'), JSON.stringify(out));
  assert.equal(db.tables.snap_items.length, 1, 'no card saved without its photos');
  assert.deepEqual(Object.keys(db.files), [], 'and the photos it did copy are removed');
  fetchImpl.failB = false;
  const ok = await importListings({ db, userId: U, token: 't', itemIds: ['111', '555'], call, fetchImpl });
  assert.deepEqual(ok.map((r) => r.ok), [true, true]);
  const ended = await importListings({ db, userId: U, token: 't', itemIds: ['666'], call: async () => getItem('666', '').replace('<ListingStatus>Active', '<ListingStatus>Completed'), fetchImpl });
  assert.match(ended[0].error, /ended/);
});

test('changes on a live card: title, description and photos go to eBay together; only what changed is sent', async () => {
  const db = setup();
  const r = await importListing({ db, userId: U, token: 't', itemId: '111', call: async () => getItem('111'), fetchImpl: async () => jpegResponse() });
  const card = db.tables.snap_items.find((c) => c.id === r.item.id);
  Object.assign(card, { title: 'Pidgeot ex 164/165 | Pokemon 151 | Full Art Ultra Rare' });
  assert.deepEqual(liveChanges(card), ['title']);
  let sent = null;
  const call = async (tok, name, xml) => { sent = xml; return '<ReviseFixedPriceItemResponse><Ack>Success</Ack></ReviseFixedPriceItemResponse>'; };
  const a = await pushChangesToEbay({ db, userId: U, token: 't', item: { ...card }, call });
  assert.match(sent, /<Title>Pidgeot ex 164\/165 \| Pokemon 151 \| Full Art Ultra Rare<\/Title>/);
  assert.doesNotMatch(sent, /Description|PictureDetails/, 'the old description and photos are left alone');
  assert.deepEqual(a.updated, ['title']);
  assert.deepEqual(liveChanges(card), []);
  assert.equal(db.tables.ebay_listings[0].title, 'Pidgeot ex 164/165 | Pokemon 151 | Full Art Ultra Rare');

  Object.assign(card, { description: 'Pack fresh.\n\nShips in a toploader.', ebay_picture_urls: null });
  assert.deepEqual(liveChanges(card), ['photos', 'description']);
  const fetchImpl = async (url) => (String(url).includes('create_image')
    ? new Response('', { status: 201, headers: { location: 'https://apim.ebay.com/commerce/media/v1_beta/image/i1' } })
    : new Response(JSON.stringify({ imageUrl: 'https://i.ebayimg.com/new.jpg' }), { status: 200, headers: { 'content-type': 'application/json' } }));
  db.storage.from().createSignedUrl = undefined;
  await pushChangesToEbay({ db, userId: U, token: 't', item: { ...card }, call, fetchImpl });
  assert.match(sent, /<Description><!\[CDATA\[<p>Pack fresh\.<\/p><p>Ships in a toploader\.<\/p>\]\]><\/Description>/);
  assert.match(sent, /<PictureDetails>(<PictureURL>https:\/\/i\.ebayimg\.com\/new\.jpg<\/PictureURL>){2}<\/PictureDetails>/);
  assert.doesNotMatch(sent, /<Title>/);
  assert.deepEqual(liveChanges(card), []);
  await assert.rejects(pushChangesToEbay({ db, userId: U, token: 't', item: { ...card }, call }), /Nothing to update/);
  await assert.rejects(pushChangesToEbay({ db, userId: U, token: 't', item: { ...card, title: 'x'.repeat(81) }, call }), /1 to 80/);
  assert.match(buildReviseXml('1', { title: 'A & B' }), /<Title>A &amp; B<\/Title>/);
});

test('GetItem parsing: photo list, graded slabs keep NM, missing pieces are null', () => {
  const r = parseXml(getItem('1', '')).GetItemResponse.Item[0];
  assert.equal(cardFromItem(r).pictures.length, 2);
  const g = parseXml(getItem('1').replace('<ConditionID>4000', '<ConditionID>2750')).GetItemResponse.Item[0];
  assert.deepEqual([cardFromItem(g).graded, cardFromItem(g).condition], [true, 'NM']);
});
