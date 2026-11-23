// Snap to List phase 2: learning the seller's setup, building the listing, photo upload,
// the free eBay check, and publishing with its guards. eBay is always simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickTemplateListings, pickPolicies, templateFromItem, conditionValuesFromPolicy, learnTemplates, buildItemXml, buildSpecifics,
  bestOfferPrices, shippingProfileFor, pictureUploadBody, uploadPicture, checkSnapItem, publishSnapItem, listingSignature, parseXml,
  FALLBACK_CONDITION_VALUES, listingUuid,
} from '../netlify/lib/ebay-listing.js';
import { fakeDb } from './fake-db.js';

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
  assert.match(xml, /<MinimumBestOfferPrice currencyID="USD">3.72<\/MinimumBestOfferPrice>/);   // 76.15% of 4.89, rounded down
  assert.match(xml, /<Name>Character<\/Name><Value>Fuecoco<\/Value>/);   // per-card value, not the template's "Briar"
  assert.doesNotMatch(xml, /Briar/);
  assert.match(xml, /<Name>Manufacturer<\/Name><Value>The Pokémon Company<\/Value>/); // static value copied
  assert.match(xml, /Ships in a sleeve &amp; toploader\./);
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

function publishDb(item) {
  return fakeDb({
    snap_items: [item], inventory: [], ebay_listings: [], settings: [],
    ebay_accounts: [{ id: 'acct', user_id: U, listing_templates: templates }],
  }, null, { files: { 'u1/b/front.jpg': 'front', 'u1/b/back.jpg': 'back' } });
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
  await assert.rejects(publishSnapItem({ db, userId: U, token: 't', item: item(), settings: {}, call: async () => { throw new Error('should not call'); } }), /check on this card first/);
  await checkSnapItem({ db, userId: U, token: 't', item: item(), settings: {}, fetchImpl: uploadOk, call: async () => verifyOk });

  await assert.rejects(publishSnapItem({ db, userId: U, token: 't', item: { ...item(), price: 1.99 }, settings: {}, call: async () => { throw new Error('no'); } }), /changed after it was checked/);

  const sent = [];
  const r = await publishSnapItem({ db, userId: U, token: 't', item: item(), settings: {}, call: async (_t, name, body) => { sent.push([name, body]); return '<AddFixedPriceItemResponse><Ack>Success</Ack><ItemID>407999000111</ItemID><Fees><Fee><Name>ListingFee</Name><Fee>0.0</Fee></Fee></Fees></AddFixedPriceItemResponse>'; } });
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

  // A second publish of the same card is refused before eBay is called.
  await assert.rejects(publishSnapItem({ db, userId: U, token: 't', item: item(), settings: {}, call: async () => { throw new Error('no'); } }), /Only approved cards/);
});

test('publish: a lost response retried comes back as a duplicate and is still recorded once', async () => {
  const db = publishDb(card());
  await checkSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: {}, fetchImpl: uploadOk, call: async () => verifyOk });
  const r = await publishSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: {}, call: async () =>
    '<AddFixedPriceItemResponse><Ack>Failure</Ack><Errors><LongMessage>Duplicate UUID used.</LongMessage><SeverityCode>Error</SeverityCode></Errors><DuplicateInvocationDetails><DuplicateInvocationID>0F8F</DuplicateInvocationID><Status>Success</Status><InvocationTrackingID>407999000222</InvocationTrackingID></DuplicateInvocationDetails></AddFixedPriceItemResponse>' });
  assert.equal(r.itemId, '407999000222');
  assert.equal(db.tables.inventory.length, 1);
});

test('publish failure leaves the card approved and records why', async () => {
  const db = publishDb(card());
  await checkSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: {}, fetchImpl: uploadOk, call: async () => verifyOk });
  await assert.rejects(publishSnapItem({ db, userId: U, token: 't', item: db.tables.snap_items[0], settings: {}, call: async () =>
    '<AddFixedPriceItemResponse><Ack>Failure</Ack><Errors><LongMessage>Selling limit reached.</LongMessage><SeverityCode>Error</SeverityCode></Errors></AddFixedPriceItemResponse>' }), /Selling limit/);
  assert.equal(db.tables.snap_items[0].status, 'approved');
  assert.equal(db.tables.snap_items[0].publish_state, 'failed');
  assert.equal(db.tables.inventory.length, 0);
});
