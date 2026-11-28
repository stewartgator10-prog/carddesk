// Snap to List phase 2: learning the seller's setup, building the listing, photo upload,
// the free eBay check, and publishing with its guards. eBay is always simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickTemplateListings, pickPolicies, templateFromItem, conditionValuesFromPolicy, learnTemplates, buildItemXml, buildSpecifics,
  bestOfferPrices, shippingProfileFor, pictureUploadBody, uploadPicture, checkSnapItem, publishSnapItem, listingSignature, parseXml,
  FALLBACK_CONDITION_VALUES, listingUuid, endFixedPriceItem,
} from '../netlify/lib/ebay-listing.js';
import { fakeDb } from './fake-db.js';
import { listingPhotoPaths, MAX_LISTING_PHOTOS } from '../netlify/lib/snap-logic.js';

const U = 'u1';
const prof = (ship, shipName) => ({ SellerProfiles: {
  SellerShippingProfile: { ShippingProfileID: ship, ShippingProfileName: shipName },
  SellerReturnProfile: { ReturnProfileID: '274881267018', ReturnProfileName: 'No Return Accepted' },
  SellerPaymentProfile: { PaymentProfileID: '274881269018', PaymentProfileName: 'eBay Managed Payments' } } });
const listings = [
  { user_id: U, item_id: '1', title: 'Fuecoco 035/193 Paldea Evolved Reverse Holo', status: 'Active', listing_type: 'FixedPriceItem', start_time: '2026-11-01', raw: prof('275074476018', 'Calculated: US_eBayStandardEnvelope') },
  { user_id: U, item_id: '2', title: 'Briar 100/131 Prismatic Evolutions Reverse Holo', status: 'Active', listing_type: 'FixedPriceItem', start_time: '2026-11-10', raw: prof('275074476018', 'Calculated: US_eBayStandardEnvelope') },
  { user_id: U, item_id: '3', title: 'Shivan Dragon Welcome Deck 2017 Regular Rare Magic The Gathering TCG LP', status: 'Active', listing_type: 'FixedPriceItem', start_time: '2026-10-01', raw: prof('274881268018', 'Calculated: USPSParcel , 3 business days') },
  { user_id: U, item_id: '4', title: 'Charizard PSA 9 Base Set', status: 'Active', listing_type: 'FixedPriceItem', start_time: '2026-11-20', raw: prof('274881268018', 'Calculated: USPSParcel') },
];

const getItemXml = (id, price = '28.89') => `<GetItemResponse xmlns="urn:ebay:apis:eBLBaseComponents"><Ack>Success</Ack><Item>
  <ItemID>${id}</ItemID><StartPrice currencyID="USD">${price}</StartPrice>
  <PrimaryCategory><CategoryID>183454</CategoryID></PrimaryCategory><ConditionID>4000</ConditionID>
  <ConditionDescriptors><ConditionDescriptor><Name>40001</Name><Value>400010</Value></ConditionDescriptor></ConditionDescriptors>
  <ItemSpecifics>
    <NameValueList><Name>Game</Name><Value>Pokémon TCG</Value></NameValueList>
    <NameValueList><Name>Manufacturer</Name><Value>The Pokémon Company</Value></NameValueList>
    <NameValueList><Name>Character</Name><Value>Briar</Value></NameValueList>
    <NameValueList><Name>Card Name</Name><Value>Briar</Value></NameValueList>
    <NameValueList><Name>Finish</Name><Value>Reverse Holo</Value></NameValueList>
    <NameValueList><Name>Graded</Name><Value>No</Value></NameValueList>
  </ItemSpecifics>
  <Location>Pittsburgh, PA</Location><PostalCode>15009</PostalCode><Country>US</Country><Currency>USD</Currency><DispatchTimeMax>3</DispatchTimeMax>
  <BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>
  <ListingDetails><MinimumBestOfferPrice currencyID="USD">22.00</MinimumBestOfferPrice><BestOfferAutoAcceptPrice currencyID="USD">26.00</BestOfferAutoAcceptPrice></ListingDetails>
</Item></GetItemResponse>`;

const metadata = { itemConditionPolicies: [{ categoryId: '183454', itemConditions: [{ conditionId: '4000', conditionDescriptors: [{ conditionDescriptorId: '40001', conditionDescriptorValues: [
  { conditionDescriptorValueId: '400010', conditionDescriptorValueName: 'Near Mint or Better' },
  { conditionDescriptorValueId: '400015', conditionDescriptorValueName: 'Lightly Played (Excellent)' },
  { conditionDescriptorValueId: '400016', conditionDescriptorValueName: 'Moderately Played (Very Good)' },
  { conditionDescriptorValueId: '400017', conditionDescriptorValueName: 'Heavily Played (Poor)' },
] }] }] }] };

test('template listings and policies are picked from the seller\'s own listings', () => {
  const p = pickTemplateListings(listings);
  assert.equal(p.pokemon.item_id, '2');   // newest Pokémon single (the PSA slab is skipped)
  assert.equal(p.mtg.item_id, '3');
  const pol = pickPolicies(listings);
  assert.equal(pol.envelope.id, '275074476018');
  assert.equal(pol.parcel.id, '274881268018');
  assert.equal(pol.returnProfile.id, '274881267018');
});

test('condition codes come from eBay\'s own list, with a fallback', () => {
  assert.deepEqual(conditionValuesFromPolicy(metadata), { values: { NM: '400010', LP: '400015', MP: '400016', HP: '400017', DMG: '400017' }, source: 'ebay' });
  assert.deepEqual(conditionValuesFromPolicy(null), { values: FALLBACK_CONDITION_VALUES, source: 'fallback' });
});

test('learning reads one listing per game and stores the setup on the eBay account', async () => {
  const db = fakeDb({ ebay_listings: listings.map((l) => ({ ...l })), ebay_accounts: [{ id: 'acct', user_id: U }] });
  const calls = [];
  const t = await learnTemplates({ db, userId: U, token: 'tok', call: async (_t, name, body) => { calls.push([name, body.match(/<ItemID>(\d+)/)[1]]); return getItemXml(body.match(/<ItemID>(\d+)/)[1]); },
    fetchImpl: async () => new Response(JSON.stringify(metadata)) });
  assert.deepEqual(calls, [['GetItem', '2'], ['GetItem', '3']]);
  assert.equal(t.pokemon.categoryId, '183454');
  assert.equal(t.pokemon.postalCode, '15009');
  assert.equal(t.pokemon.bestOffer.enabled, true);
  assert.equal(t.pokemon.bestOffer.declinePct, 76.15); // 22 / 28.89
  assert.equal(t.conditions.source, 'ebay');
  assert.ok(db.tables.ebay_accounts[0].listing_templates.pokemon);
});

const templates = {
  pokemon: templateFromItem(parseXml(getItemXml('2')).GetItemResponse.Item[0]),
  mtg: null,
  policies: pickPolicies(listings),
  conditions: { values: { NM: '400010', LP: '400015', MP: '400016', HP: '400017', DMG: '400017' }, source: 'ebay' },
};
const card = (over = {}) => ({
  id: '0f8fad5b-d9cb-469f-a165-70867728950e', user_id: U, status: 'approved', game: 'pokemon', card_name: 'Fuecoco', catalog_set: 'Paldea Evolved',
  catalog_number: '035/193', finish: 'reverse_holo', condition: 'LP', language: 'English', price: 4.89, title: 'Fuecoco 035/193 Paldea Evolved Reverse Holo',
  photo_path: 'u1/b/front.jpg', back_photo_path: 'u1/b/back.jpg', cost_basis: 0.5, cost_source: 'purchase', purchase_id: 'p1', ...over,
});

test('listing XML: his category, condition code, specifics, location, policies by price, Best Offer at his %', () => {
  const xml = buildItemXml({ item: card(), templates, settings: { snapShipCutoff: 20, snapDescriptionFooter: 'Ships in a sleeve & toploader.' }, pictureUrls: ['https://i.ebayimg.com/a.jpg', 'https://i.ebayimg.com/b.jpg'] });
  assert.match(xml, /<CategoryID>183454<\/CategoryID>/);
  assert.match(xml, /<ConditionID>4000<\/ConditionID><ConditionDescriptors><ConditionDescriptor><Name>40001<\/Name><Value>400015<\/Value>/); // LP
  assert.match(xml, /<StartPrice currencyID="USD">4.89<\/StartPrice>/);
  assert.match(xml, /<ShippingProfileID>275074476018<\/ShippingProfileID>/); // envelope under $20
  assert.match(xml, /<ReturnProfileID>274881267018/);
  assert.match(xml, /<PostalCode>15009<\/PostalCode>/);
  assert.match(xml, /<ListingDuration>GTC<\/ListingDuration>/);
  assert.match(xml, /<UUID>0F8FAD5BD9CB469FA16570867728950E<\/UUID>/);
  assert.equal((xml.match(/<PictureURL>/g) || []).length, 2);
  assert.match(xml, /<BestOfferDetails><BestOfferEnabled>true<\/BestOfferEnabled><\/BestOfferDetails><ListingDetails><MinimumBestOfferPrice currencyID="USD">4.39<\/MinimumBestOfferPrice><BestOfferAutoAcceptPrice currencyID="USD">4.40<\/BestOfferAutoAcceptPrice>/); // accept 90% of 4.89 and up, decline below
  assert.match(xml, /<Name>Character<\/Name><Value>Fuecoco<\/Value>/);   // per-card value, not the template's "Briar"
  assert.doesNotMatch(xml, /Briar/);
  assert.match(xml, /<Name>Manufacturer<\/Name><Value>The Pokémon Company<\/Value>/); // static value copied
  assert.match(xml, /<Description><!\[CDATA\[<p>This is Fuecoco \(035\/193\) from the Pokemon Paldea Evolved set, a reverse holo printing\. Lightly played copy\. Please look closely at the photos/);
  assert.doesNotMatch(xml, /Ships in a sleeve|The photos show the actual card|<li>/);                       // no shipping talk, boilerplate or spec list
  assert.match(buildItemXml({ item: card({ description: 'My own words & more.' }), templates, settings: {}, pictureUrls: [] }), /<p>My own words &amp; more\.<\/p>/);
  assert.match(buildItemXml({ item: card({ price: 25 }), templates, settings: {}, pictureUrls: [] }), /<ShippingProfileID>274881268018</); // parcel at $20+
  assert.equal(listingUuid(card().id).length, 32);
});

test('specifics, Best Offer and shipping edge cases', () => {
  const s = buildSpecifics(card({ finish: 'holo' }), { itemSpecifics: [] });
  assert.deepEqual(s.find((x) => x.name === 'Game').values, ['Pokémon TCG']);   // always sent
  assert.equal(s.find((x) => x.name === 'Finish'), undefined);                  // only when his listings use it
  assert.deepEqual(bestOfferPrices(1.00, { enabled: true, declinePct: 99.9, acceptPct: 99.95 }), { decline: 0.99, accept: null });
  assert.equal(bestOfferPrices(5, { enabled: false }), null);
  assert.equal(shippingProfileFor(19.99, templates).id, '275074476018');
  assert.equal(shippingProfileFor(20, templates).id, '274881268018');
});

test('photo upload sends the XML part then the image bytes', async () => {
  const { body, boundary } = pictureUploadBody(Buffer.from([0xff, 0xd8, 0xff]), 'SNAP-1');
  const s = body.toString('latin1');
  assert.match(s, new RegExp(`^--${boundary}\\r\\nContent-Disposition: form-data; name="XML Payload"`));
  assert.ok(s.indexOf('<UploadSiteHostedPicturesRequest') < s.indexOf('filename="SNAP-1.jpg"'));
  assert.ok(s.includes('\xff\xd8\xff'));
  assert.ok(s.endsWith(`--${boundary}--\r\n`));
  const url = await uploadPicture({ token: 't', imageBytes: Buffer.from('x'), name: 'n', fetchImpl: async (_u, init) => {
    assert.equal(init.headers['X-EBAY-API-CALL-NAME'], 'UploadSiteHostedPictures');
    assert.match(init.headers['Content-Type'], /^multipart\/form-data; boundary=/);
    return new Response('<UploadSiteHostedPicturesResponse><Ack>Success</Ack><SiteHostedPictureDetails><FullURL>https://i.ebayimg.com/x.jpg</FullURL></SiteHostedPictureDetails></UploadSiteHostedPicturesResponse>');
  } });
  assert.equal(url, 'https://i.ebayimg.com/x.jpg');
});

test('photo upload: eBay Media API from a private link first, then as a file, then the older Trading call; errors list every reason', async () => {
  const gone = () => new Response(JSON.stringify({ errors: [{ message: 'Resource not found' }] }), { status: 404 });
  const tradingOk = (u) => new Response(`<UploadSiteHostedPicturesResponse><Ack>Success</Ack><SiteHostedPictureDetails><FullURL>${u}</FullURL></SiteHostedPictureDetails></UploadSiteHostedPicturesResponse>`);
  const created = (id) => new Response('', { status: 201, headers: { Location: `https://apim.ebay.com/commerce/media/v1_beta/image/${id}` } });

  // Media from the link: 201 + Location, then reading the image gives its eBay URL.
  const seen = [];
  const viaMedia = await uploadPicture({ token: 'tok', url: 'https://x.supabase.co/sign/a.jpg?token=1', imageBytes: () => { throw new Error('not needed'); }, name: 'n',
    fetchImpl: async (u, init = {}) => {
      seen.push(`${init.method || 'GET'} ${u.replace('https://apim.ebay.com/commerce/media/v1_beta', '')}`);
      assert.equal(init.headers.Authorization, 'Bearer tok');
      if (u.endsWith('/create_image_from_url')) { assert.deepEqual(JSON.parse(init.body), { imageUrl: 'https://x.supabase.co/sign/a.jpg?token=1' }); return created('IMG1'); }
      return new Response(JSON.stringify({ imageUrl: 'https://i.ebayimg.com/images/g/IMG1/s-l1600.jpg' }));
    } });
  assert.equal(viaMedia, 'https://i.ebayimg.com/images/g/IMG1/s-l1600.jpg');
  assert.deepEqual(seen, ['POST /image/create_image_from_url', 'GET /image/IMG1']);

  // eBay can't fetch the link: the file goes to Media instead.
  const viaFile = await uploadPicture({ token: 't', url: 'https://x/a.jpg', imageBytes: async () => Buffer.from('jpeg'), name: 'n',
    fetchImpl: async (u, init = {}) => {
      if (u.endsWith('/create_image_from_url')) return new Response(JSON.stringify({ errors: [{ longMessage: 'Could not download the image.' }] }), { status: 400 });
      if (u.endsWith('/create_image_from_file')) { assert.ok(init.body instanceof FormData); return new Response(JSON.stringify({ imageUrl: 'https://i.ebayimg.com/f.jpg' }), { status: 201 }); }
      throw new Error(`unexpected ${u}`);
    } });
  assert.equal(viaFile, 'https://i.ebayimg.com/f.jpg');

  // Media unavailable: the older Trading call is still tried.
  const viaTrading = await uploadPicture({ token: 't', url: 'https://x/a.jpg', imageBytes: Buffer.from('jpeg'), name: 'n',
    fetchImpl: async (u) => (u.includes('apim.ebay.com') ? gone() : tradingOk('https://i.ebayimg.com/t.jpg')) });
  assert.equal(viaTrading, 'https://i.ebayimg.com/t.jpg');

  await assert.rejects(uploadPicture({ token: 't', url: 'https://x/a.jpg', imageBytes: Buffer.from('jpeg'), name: 'n',
    fetchImpl: async (u) => (u.includes('apim.ebay.com') ? gone() : new Response('Resource not found', { status: 404 })) }),
  /media link HTTP 404: Resource not found \| media file HTTP 404: Resource not found \| from link HTTP 404: Resource not found \| as a file HTTP 404: Resource not found/);
});

function publishDb(item, moreFiles = {}) {
  return fakeDb({
    snap_items: [item], inventory: [], ebay_listings: [], settings: [],
    ebay_accounts: [{ id: 'acct', user_id: U, listing_templates: templates }],
  }, null, { files: { 'u1/b/front.jpg': 'front', 'u1/b/back.jpg': 'back', ...moreFiles } });
}
const uploadOk = async () => new Response('<UploadSiteHostedPicturesResponse><Ack>Success</Ack><SiteHostedPictureDetails><FullURL>https://i.ebayimg.com/p.jpg</FullURL></SiteHostedPictureDetails></UploadSiteHostedPicturesResponse>');
const verifyOk = '<VerifyAddFixedPriceItemResponse><Ack>Warning</Ack><Errors><ShortMessage>Shipping</ShortMessage><LongMessage>Consider adding a weight.</LongMessage><SeverityCode>Warning</SeverityCode></Errors><Fees><Fee><Name>InsertionFee</Name><Fee currencyID="USD">0.0</Fee></Fee><Fee><Name>ListingFee</Name><Fee currencyID="USD">0.0</Fee></Fee></Fees></VerifyAddFixedPriceItemResponse>';

test('check uploads both photos, runs eBay\'s free verify, and nothing is listed', async () => {
  const db = publishDb(card());
  const calls = [];
  const out = await checkSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: {}, fetchImpl: uploadOk,
    call: async (_t, name) => { calls.push(name); return verifyOk; } });
  assert.deepEqual(calls, ['VerifyAddFixedPriceItem']);
  const row = db.tables.snap_items[0];
  assert.equal(row.publish_state, 'checked');
  assert.equal(row.ebay_picture_urls.length, 2);
  assert.equal(row.publish_check.ok, true);
  assert.deepEqual(row.publish_check.warnings, ['Consider adding a weight.']);
  assert.equal(row.publish_check.signature, listingSignature(row));
  assert.equal(out.sku, 'SNAP-0F8FAD5BD9');
  assert.equal(db.tables.inventory.length, 0);

  const bad = publishDb(card());
  await checkSnapItem({ db: bad, userId: U, token: 't', item: bad.tables.snap_items[0], settings: {}, fetchImpl: uploadOk,
    call: async () => '<VerifyAddFixedPriceItemResponse><Ack>Failure</Ack><Errors><LongMessage>The item specific Game is missing.</LongMessage><ErrorCode>21919303</ErrorCode><SeverityCode>Error</SeverityCode></Errors></VerifyAddFixedPriceItemResponse>' });
  assert.equal(bad.tables.snap_items[0].publish_state, 'check_failed');
  assert.deepEqual(bad.tables.snap_items[0].publish_check.errors, ['The item specific Game is missing. (21919303)']);
});

test('publish: only after a passing check of the same listing; then stock + listing are recorded', async () => {
  const db = publishDb(card());
  const item = () => db.tables.snap_items[0];
  await assert.rejects(publishSnapItem({ db, userId: U, token: 't', item: item(), settings: { snapPromotePct: 0 }, call: async () => { throw new Error('should not call'); } }), /check on this card first/);
  await checkSnapItem({ db, userId: U, token: 't', item: item(), settings: {}, fetchImpl: uploadOk, call: async () => verifyOk });

  await assert.rejects(publishSnapItem({ db, userId: U, token: 't', item: { ...item(), price: 1.99 }, settings: { snapPromotePct: 0 }, call: async () => { throw new Error('no'); } }), /changed after it was checked/);

  const sent = [];
  const r = await publishSnapItem({ db, userId: U, token: 't', item: item(), settings: { snapPromotePct: 0 }, call: async (_t, name, body) => { sent.push([name, body]); return '<AddFixedPriceItemResponse><Ack>Success</Ack><ItemID>407999000111</ItemID><Fees><Fee><Name>ListingFee</Name><Fee>0.0</Fee></Fee></Fees></AddFixedPriceItemResponse>'; } });
  assert.equal(r.itemId, '407999000111');
  assert.equal(sent[0][0], 'AddFixedPriceItem');
  assert.match(sent[0][1], /<UUID>0F8FAD5BD9CB469FA16570867728950E<\/UUID>/);
  assert.equal(item().status, 'listed');
  assert.equal(item().ebay_url, 'https://www.ebay.com/itm/407999000111');
  const inv = db.tables.inventory[0];
  assert.equal(inv.ebay_item_id, '407999000111');
  assert.equal(inv.cost_basis, 0.5);
  assert.equal(inv.cost_source, 'purchase');
  assert.equal(inv.purchase_id, 'p1');
  assert.equal(inv.status, 'In Stock');
  assert.equal(db.tables.ebay_listings[0].status, 'Active');
  assert.match(sent[0][1], /<Quantity>1<\/Quantity>/);
  // Where the card is listed, for cross-listing.
  const ml = db.tables.marketplace_listings;
  assert.equal(ml.length, 1);
  assert.deepEqual([ml[0].marketplace, ml[0].external_id, ml[0].snap_item_id, ml[0].inventory_id, ml[0].status, ml[0].quantity], ['ebay', '407999000111', item().id, inv.id, 'active', 1]);

  // A second publish of the same card is refused before eBay is called.
  await assert.rejects(publishSnapItem({ db, userId: U, token: 't', item: item(), settings: { snapPromotePct: 0 }, call: async () => { throw new Error('no'); } }), /Only approved cards/);
});

test('publish: a lost response retried comes back as a duplicate and is still recorded once', async () => {
  const db = publishDb(card());
  await checkSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: {}, fetchImpl: uploadOk, call: async () => verifyOk });
  const r = await publishSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: { snapPromotePct: 0 }, call: async () =>
    '<AddFixedPriceItemResponse><Ack>Failure</Ack><Errors><LongMessage>Duplicate UUID used.</LongMessage><SeverityCode>Error</SeverityCode></Errors><DuplicateInvocationDetails><DuplicateInvocationID>0F8F</DuplicateInvocationID><Status>Success</Status><InvocationTrackingID>407999000222</InvocationTrackingID></DuplicateInvocationDetails></AddFixedPriceItemResponse>' });
  assert.equal(r.itemId, '407999000222');
  assert.equal(db.tables.inventory.length, 1);
});

test('publish failure leaves the card approved and records why', async () => {
  const db = publishDb(card());
  await checkSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: {}, fetchImpl: uploadOk, call: async () => verifyOk });
  await assert.rejects(publishSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: { snapPromotePct: 0 }, call: async () =>
    '<AddFixedPriceItemResponse><Ack>Failure</Ack><Errors><LongMessage>Selling limit reached.</LongMessage><SeverityCode>Error</SeverityCode></Errors></AddFixedPriceItemResponse>' }), /Selling limit/);
  assert.equal(db.tables.snap_items[0].status, 'approved');
  assert.equal(db.tables.snap_items[0].publish_state, 'failed');
  assert.equal(db.tables.inventory.length, 0);
});

test('a listing can carry several photos: main first, extras in order, capped, and only the seller\'s own', async () => {
  const extras = ['u1/b/x1.jpg', 'u1/b/x2.jpg', 'u1/b/x3.jpg'];
  const files = Object.fromEntries(extras.map((p) => [p, p]));
  assert.deepEqual(listingPhotoPaths({ photo_path: 'a', back_photo_path: 'old-back' }), ['a', 'old-back']);          // older cards
  assert.deepEqual(listingPhotoPaths({ photo_path: 'a', back_photo_path: 'old-back', extra_photo_paths: ['b', 'a', 'c'] }), ['a', 'b', 'c']);

  const db = publishDb(card({ back_photo_path: null, extra_photo_paths: extras }), files);
  const uploaded = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes('apim.ebay.com')) return new Response('{}', { status: 404 });
    const name = /filename="([^"]+)"/.exec(init.body.toString('latin1'))[1];
    uploaded.push(name);
    return new Response(`<UploadSiteHostedPicturesResponse><Ack>Success</Ack><SiteHostedPictureDetails><FullURL>https://i.ebayimg.com/${name}</FullURL></SiteHostedPictureDetails></UploadSiteHostedPicturesResponse>`);
  };
  let sentXml = '';
  await checkSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: {}, fetchImpl, call: async (_t, _n, xml) => { sentXml = xml; return verifyOk; } });
  const row = db.tables.snap_items[0];
  assert.deepEqual(row.ebay_picture_urls, [1, 2, 3, 4].map((n) => `https://i.ebayimg.com/SNAP-0F8FAD5BD9-${n}.jpg`));
  assert.equal(uploaded.length, 4);
  assert.equal((sentXml.match(/<PictureURL>/g) || []).length, 4);
  assert.ok(sentXml.indexOf('SNAP-0F8FAD5BD9-1.jpg') < sentXml.indexOf('SNAP-0F8FAD5BD9-4.jpg'));   // main photo leads the listing

  // A second check with the same photos does not upload them again.
  await checkSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: {}, fetchImpl, call: async () => verifyOk });
  assert.equal(uploaded.length, 4);

  const many = Array.from({ length: MAX_LISTING_PHOTOS }, (_, i) => `u1/b/m${i}.jpg`);
  const tooMany = publishDb(card({ back_photo_path: null, extra_photo_paths: many }));
  await assert.rejects(checkSnapItem({ db: tooMany, userId: U, token: 't', item: tooMany.tables.snap_items[0], settings: {}, fetchImpl, call: async () => verifyOk }), new RegExp(`up to ${MAX_LISTING_PHOTOS} photos`));
  const foreign = publishDb(card({ back_photo_path: null, extra_photo_paths: ['someone-else/b/x.jpg'] }));
  await assert.rejects(checkSnapItem({ db: foreign, userId: U, token: 't', item: foreign.tables.snap_items[0], settings: {}, fetchImpl, call: async () => verifyOk }), /does not belong to you/);
  assert.equal(uploaded.length, 4);
});

test('every listing carries the shipping package: 3 oz, 9 x 6 x 1 in by default, or the seller\'s own numbers', async () => {
  const { packageXml } = await import('../netlify/lib/ebay-listing.js');
  const xml = buildItemXml({ item: card(), templates, settings: {}, pictureUrls: ['https://i.ebayimg.com/a.jpg'] });
  assert.match(xml, /<ShippingPackageDetails><MeasurementUnit>English<\/MeasurementUnit><PackageDepth unit="in">1<\/PackageDepth><PackageLength unit="in">9<\/PackageLength><PackageWidth unit="in">6<\/PackageWidth><ShippingPackage>PackageThickEnvelope<\/ShippingPackage><WeightMajor unit="lbs">0<\/WeightMajor><WeightMinor unit="oz">3<\/WeightMinor><\/ShippingPackageDetails>/);
  assert.match(packageXml({ snapPackageWeightOz: 20, snapPackageLengthIn: 10, snapPackageWidthIn: 7.5, snapPackageDepthIn: 2 }), /<PackageDepth unit="in">2<.*<PackageLength unit="in">10<.*<PackageWidth unit="in">8<.*<WeightMajor unit="lbs">1<\/WeightMajor><WeightMinor unit="oz">4</);
  assert.match(packageXml({ snapPackageWeightOz: 'x' }), /<WeightMinor unit="oz">3</);
});

test('Best Offer: accept at 90% and up, decline below, on or off per listing; new listings follow the settings', async () => {
  const { offerThresholds, buildBestOfferXml, setBestOffer } = await import('../netlify/lib/trading-price.js');
  assert.deepEqual(offerThresholds(10), { accept: 9, decline: 8.99 });
  assert.deepEqual(offerThresholds(0.99), { accept: 0.89, decline: 0.88 });
  assert.deepEqual(offerThresholds(25, 20), { accept: 20, decline: 19.99 });
  assert.deepEqual(offerThresholds(0.02), { accept: null, decline: null });            // too cheap for two thresholds

  const on = buildBestOfferXml({ itemId: '123', enabled: true, price: 4.89 });
  assert.match(on, /<ItemID>123<\/ItemID><BestOfferDetails><BestOfferEnabled>true<\/BestOfferEnabled><\/BestOfferDetails><ListingDetails><MinimumBestOfferPrice currencyID="USD">4.39<\/MinimumBestOfferPrice><BestOfferAutoAcceptPrice currencyID="USD">4.40</);
  const off = buildBestOfferXml({ itemId: '123', enabled: false, price: 4.89 });
  assert.match(off, /<BestOfferEnabled>false<\/BestOfferEnabled><\/BestOfferDetails><\/Item><DeletedField>Item.ListingDetails.MinimumBestOfferPrice<\/DeletedField><DeletedField>Item.ListingDetails.BestOfferAutoAcceptPrice<\/DeletedField>/);
  assert.doesNotMatch(off, /<StartPrice/);                                                // the price itself is left alone

  const sent = [];
  const r = await setBestOffer('t', { itemId: '123', enabled: false, price: 4.89 }, async (_t, name, body) => { sent.push(name); return '<ReviseFixedPriceItemResponse><Ack>Success</Ack></ReviseFixedPriceItemResponse>'; });
  assert.deepEqual([sent, r.enabled], [['ReviseFixedPriceItem'], false]);
  await assert.rejects(setBestOffer('t', { itemId: '1', enabled: true, price: 5 }, async () => '<R><Ack>Failure</Ack><Errors><SeverityCode>Error</SeverityCode><LongMessage>Nope.</LongMessage></Errors></R>'), /Nope\./);

  const offXml = buildItemXml({ item: card(), templates, settings: { snapBestOffer: false }, pictureUrls: [] });
  assert.match(offXml, /<BestOfferEnabled>false<\/BestOfferEnabled>/);
  assert.doesNotMatch(offXml, /MinimumBestOfferPrice/);
});

test('Promoted Listings: new listings join one 2% campaign, created on first use; problems never undo the listing', async () => {
  const { promoteListing, promoRate, RECONNECT_FOR_PROMO } = await import('../netlify/lib/ebay-promote.js');
  assert.equal(promoRate({}), 2);
  assert.equal(promoRate({ snapPromotePct: 0 }), 0);
  const db = fakeDb({ ebay_accounts: [{ id: 'acct', user_id: U }] });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url.replace('https://api.ebay.com/sell/marketing/v1', '')} ${init.body}`);
    if (url.endsWith('/ad_campaign')) return new Response('', { status: 201, headers: { Location: 'https://api.ebay.com/sell/marketing/v1/ad_campaign/C1' } });
    return new Response('', { status: 201 });
  };
  const r = await promoteListing({ db, userId: U, token: 't', itemId: '407', settings: {}, fetchImpl });
  assert.deepEqual([r.ok, r.rate], [true, 2]);
  assert.match(calls[0], /^POST \/ad_campaign .*"fundingModel":"COST_PER_SALE","bidPercentage":"2"/);
  assert.equal(calls[1], 'POST /ad_campaign/C1/ad {"listingId":"407","bidPercentage":"2"}');
  assert.equal(db.tables.ebay_accounts[0].promo_campaign_id, 'C1');
  // Next listing reuses the campaign.
  await promoteListing({ db, userId: U, token: 't', itemId: '408', settings: {}, fetchImpl });
  assert.equal(calls.length, 3);
  // Without the marketing permission: a clear "reconnect" message, no throw.
  const denied = await promoteListing({ db, userId: U, token: 't', itemId: '409', settings: {}, fetchImpl: async () => new Response(JSON.stringify({ errors: [{ message: 'Insufficient permissions to fulfill the request.' }] }), { status: 403 }) });
  assert.deepEqual([denied.ok, denied.error], [false, RECONNECT_FOR_PROMO]);
  // A campaign that ended is replaced once.
  const db2 = fakeDb({ ebay_accounts: [{ id: 'acct', user_id: U, promo_campaign_id: 'OLD' }] });
  const seen = [];
  const r2 = await promoteListing({ db: db2, userId: U, token: 't', itemId: '410', settings: {}, fetchImpl: async (url, init) => {
    seen.push(url.split('/v1')[1]);
    if (url.includes('/OLD/ad')) return new Response(JSON.stringify({ errors: [{ message: 'The campaign has ended.' }] }), { status: 409 });
    if (url.endsWith('/ad_campaign')) return new Response('', { status: 201, headers: { Location: '/sell/marketing/v1/ad_campaign/NEW' } });
    return new Response('', { status: 201 });
  } });
  assert.deepEqual([r2.ok, seen], [true, ['/ad_campaign/OLD/ad', '/ad_campaign', '/ad_campaign/NEW/ad']]);
  assert.equal(db2.tables.ebay_accounts[0].promo_campaign_id, 'NEW');
});

test('the card\'s quantity goes on the eBay listing; quantity 1 keeps the check of cards checked before quantity existed', () => {
  const tpl = { pokemon: { categoryId: '183454', itemSpecifics: [] }, policies: {}, conditions: { values: FALLBACK_CONDITION_VALUES } };
  const base = { id: 'x', title: 'T', price: 5, game: 'pokemon', condition: 'NM' };
  assert.match(buildItemXml({ item: { ...base, quantity: 3 }, templates: tpl, pictureUrls: [] }), /<Quantity>3<\/Quantity>/);
  assert.match(buildItemXml({ item: base, templates: tpl, pictureUrls: [] }), /<Quantity>1<\/Quantity>/);
  assert.equal(listingSignature({ ...base, quantity: 1 }), listingSignature(base));
  assert.notEqual(listingSignature({ ...base, quantity: 2 }), listingSignature(base));
});

test('ending an eBay listing: EndFixedPriceItem, and "already ended" counts as done', async () => {
  const sent = [];
  const r = await endFixedPriceItem('t', '4071', async (_t, name, body) => { sent.push([name, body]); return '<EndFixedPriceItemResponse><Ack>Success</Ack><EndTime>2026-11-28T15:00:00.000Z</EndTime></EndFixedPriceItemResponse>'; });
  assert.deepEqual(r, { ok: true, endedAt: '2026-11-28T15:00:00.000Z' });
  assert.equal(sent[0][0], 'EndFixedPriceItem');
  assert.match(sent[0][1], /<ItemID>4071<\/ItemID><EndingReason>NotAvailable<\/EndingReason>/);
  const gone = await endFixedPriceItem('t', '4071', async () => '<EndFixedPriceItemResponse><Ack>Failure</Ack><Errors><LongMessage>The auction has already been closed.</LongMessage><ErrorCode>1047</ErrorCode><SeverityCode>Error</SeverityCode></Errors></EndFixedPriceItemResponse>');
  assert.deepEqual(gone, { ok: true, gone: true });
  await assert.rejects(endFixedPriceItem('t', '4071', async () => '<EndFixedPriceItemResponse><Ack>Failure</Ack><Errors><LongMessage>Internal error.</LongMessage><SeverityCode>Error</SeverityCode></Errors></EndFixedPriceItemResponse>'), /Internal error/);
});

const addOk = '<AddFixedPriceItemResponse><Ack>Success</Ack><ItemID>407999000222</ItemID><Fees><Fee><Name>ListingFee</Name><Fee>0.0</Fee></Fee></Fees></AddFixedPriceItemResponse>';

test('a card that sold out on another marketplace is never published to eBay again, even with a passing check', async () => {
  for (const over of [{ quantity: 0 }, { quantity: 1, sold_out_at: '2026-11-28T15:00:00.000Z' }]) {
    const db = publishDb(card());
    await checkSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: {}, fetchImpl: uploadOk, call: async () => verifyOk });
    Object.assign(db.tables.snap_items[0], over);   // sold on Whatnot after the eBay check
    await assert.rejects(publishSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: { snapPromotePct: 0 }, call: async () => { throw new Error('eBay was called'); } }),
      (e) => e.status === 409 && /sold out/.test(e.message));
    assert.equal(db.tables.snap_items[0].publish_state, 'checked');
    assert.equal(db.tables.inventory.length, 0);
  }
});

test('the listing is live on eBay: a failed marketplace_listings write is logged, not reported as a failed publish', async () => {
  const db = fakeDb({
    snap_items: [card()], inventory: [], ebay_listings: [], settings: [],
    ebay_accounts: [{ id: 'acct', user_id: U, listing_templates: templates }],
  }, null, { files: { 'u1/b/front.jpg': 'front', 'u1/b/back.jpg': 'back' },
    failOn: ({ table, op }) => (table === 'marketplace_listings' && op !== 'select' ? 'relation "public.marketplace_listings" does not exist' : null) });
  await checkSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: {}, fetchImpl: uploadOk, call: async () => verifyOk });
  const warn = console.warn; const logged = [];
  console.warn = (m) => logged.push(m);
  try {
    const r = await publishSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: { snapPromotePct: 0 }, call: async () => addOk });
    assert.equal(r.itemId, '407999000222');
  } finally { console.warn = warn; }
  assert.equal(db.tables.snap_items[0].status, 'listed');
  assert.equal(db.tables.inventory.length, 1);
  assert.match(logged.join(' '), /marketplace_listings write for eBay item 407999000222 failed/);
});
