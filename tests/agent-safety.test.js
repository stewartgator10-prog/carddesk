// Fixes from the Nov 2026 review: things a person or an AI agent calling the API could trip over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { xml, mapTradingItem } from '../netlify/lib/ebay-seller.js';
import { revisePrices, scaleBestOffer, buildReviseFixedPriceXml, parseReviseResponse } from '../netlify/lib/trading-price.js';
import { checkAgainstListings, validateChanges } from '../netlify/functions/seller-reprice.js';
import { extractEbayItemId } from '../netlify/functions/parse-listing.js';
import { detectCondition, conditionFromEbay, extractAskPrice, costForListing } from '../src/pricing/pricingLogic.js';

test('eBay XML keeps SKUs and titles as text (no 00123 -> 123)', () => {
  const r = xml.parse(`<GetMyeBaySellingResponse><ActiveList><ItemArray>
    <Item><ItemID>123456789012</ItemID><SKU>00123</SKU><Title>151</Title><Quantity>3</Quantity>
      <SellingStatus><CurrentPrice currencyID="USD">9.50</CurrentPrice><QuantitySold>1</QuantitySold></SellingStatus></Item>
    <Item><ItemID>2</ItemID><SKU>1e5</SKU><Title>Charizard</Title></Item>
  </ItemArray></ActiveList></GetMyeBaySellingResponse>`).GetMyeBaySellingResponse.ActiveList.ItemArray.Item;
  const [a, b] = r.map(mapTradingItem);
  assert.equal(a.sku, '00123');
  assert.equal(b.sku, '1e5');
  assert.equal(a.title, '151');
  assert.equal(a.item_id, '123456789012');
  assert.equal(a.price, 9.5);
  assert.equal(a.currency, 'USD');
  assert.equal(a.quantity, 3);
  assert.equal(a.quantity_available, 2);
});

test('Best Offer thresholds scale with the price and stay below it', () => {
  assert.deepEqual(scaleBestOffer({ oldPrice: 28.89, newPrice: 19.99, decline: 22, accept: 26 }), { decline: 15.22, accept: 17.99 });
  // already at/above the new price after scaling -> clamped under it
  assert.deepEqual(scaleBestOffer({ oldPrice: 10, newPrice: 9, decline: 9.99, accept: null }), { decline: 8.99, accept: null });
  // accept can't sit at or below decline; it is dropped rather than set wrong
  assert.equal(scaleBestOffer({ oldPrice: 10, newPrice: 1, decline: 9.98, accept: 9.99 }).accept, null);
  assert.match(buildReviseFixedPriceXml({ itemId: '1', newPrice: 19.99, decline: 15.22, accept: null }),
    /<StartPrice currencyID="USD">19.99<\/StartPrice><ListingDetails><MinimumBestOfferPrice currencyID="USD">15.22<\/MinimumBestOfferPrice><\/ListingDetails>/);
});

test('a price refused for Best Offer auto-decline is retried with scaled thresholds (the real-world failure)', async () => {
  const calls = [];
  const fake = async (_t, name, body) => {
    calls.push(name);
    if (name === 'ReviseInventoryStatus') {
      return `<R><Ack>Failure</Ack><Errors><LongMessage>Auto decline amount cannot be greater than or equal to the Buy It Now price.</LongMessage><SeverityCode>Error</SeverityCode></Errors></R>`;
    }
    if (name === 'GetItem') {
      return `<GetItemResponse><Ack>Success</Ack><Item><StartPrice currencyID="USD">28.89</StartPrice><ListingDetails><MinimumBestOfferPrice currencyID="USD">22.00</MinimumBestOfferPrice></ListingDetails></Item></GetItemResponse>`;
    }
    assert.match(body, /<MinimumBestOfferPrice currencyID="USD">15.22</);
    return `<ReviseFixedPriceItemResponse><Ack>Success</Ack></ReviseFixedPriceItemResponse>`;
  };
  const [r] = await revisePrices('tok', [{ itemId: '407295968974', oldPrice: 28.89, newPrice: 19.99 }], fake);
  assert.deepEqual(calls, ['ReviseInventoryStatus', 'GetItem', 'ReviseFixedPriceItem']);
  assert.equal(r.ok, true);
  assert.equal(r.price, 19.99);
  assert.match(r.warnings[0], /auto-decline 22.00 → 15.22/);
});

test('other eBay errors are not retried, and repeated errors are shown once', async () => {
  const calls = [];
  const fake = async (_t, name) => { calls.push(name); return `<R><Ack>Failure</Ack>${'<Errors><LongMessage>Item has ended.</LongMessage><SeverityCode>Error</SeverityCode></Errors>'.repeat(3)}</R>`; };
  const [r] = await revisePrices('tok', [{ itemId: '1', newPrice: 5 }], fake);
  assert.deepEqual(calls, ['ReviseInventoryStatus']);
  assert.equal(r.error, 'Item has ended.');
  assert.equal(parseReviseResponse('<R><Ack>Failure</Ack></R>', [{ itemId: '1' }])[0].error, 'eBay returned Failure');
});

test('server refuses prices for items that are not your active Buy It Now listings, and big swings unless confirmed', () => {
  const listings = [
    { item_id: '1', price: '40.00', status: 'Active', listing_type: 'FixedPriceItem' },
    { item_id: '2', price: '40.00', status: 'Active', listing_type: 'Chinese' },
    { item_id: '3', price: '40.00', status: 'Ended', listing_type: 'FixedPriceItem' },
  ];
  assert.equal(checkAgainstListings([{ itemId: '1', newPrice: 35 }], listings), null);
  assert.match(checkAgainstListings([{ itemId: '9', newPrice: 35 }], listings), /isn't one of your active/);
  assert.match(checkAgainstListings([{ itemId: '3', newPrice: 35 }], listings), /isn't one of your active/);
  assert.match(checkAgainstListings([{ itemId: '2', newPrice: 35 }], listings), /auction/);
  assert.match(checkAgainstListings([{ itemId: '1', newPrice: 4 }], listings), /50% or more/); // typo 4 for 40
  assert.equal(checkAgainstListings([{ itemId: '1', newPrice: 4 }], listings, { confirmLargeChanges: true }), null);
  assert.match(validateChanges([null]), /itemId/);
  assert.match(validateChanges([{ itemId: '1', newPrice: 'abc' }]), /between/);
});

test('eBay links with hash=item<hex> resolve to the real item number', () => {
  assert.equal(extractEbayItemId('https://www.ebay.com/itm/x?hash=item5ed3d0b37a:g:abc'), String(0x5ed3d0b37a));
  assert.equal(extractEbayItemId('https://www.ebay.com/itm/Charizard/407295968974?x=1'), '407295968974');
});

test('grades: any PSA/BGS/CGC/SGC grade is read, and eBay "Graded" falls back to the title', () => {
  assert.equal(detectCondition('Charizard PSA 8 Base Set'), 'PSA 8');
  assert.equal(detectCondition('Umbreon CGC 9.5'), 'CGC 9.5');
  assert.equal(detectCondition('Lugia SGC 10'), 'SGC 10');
  assert.equal(detectCondition('Card BGS 9.5'), 'BGS 9.5');
  assert.equal(detectCondition('Pikachu PSA 100 lot'), null);
  assert.equal(conditionFromEbay('Graded', 'Umbreon VMAX 215/203 CGC 9.5'), 'CGC 9.5'); // used to become CGC 10 / NM
  assert.equal(conditionFromEbay('Lightly Played (Excellent)', 'Pikachu'), 'LP');
  assert.equal(conditionFromEbay('Ungraded', 'Pikachu'), 'NM');
});

test('bulk scanner reads the asking price, not the card number', () => {
  assert.equal(extractAskPrice('Charizard 020/189 $45').price, 45);
  assert.equal(extractAskPrice('Charizard 020/189 45').price, 45);
  assert.equal(extractAskPrice('Umbreon PSA 10 - 1,250').price, 1250);
  assert.equal(extractAskPrice('Charizard 4/102 shadowless 350, ships tomorrow').price, 350);
  assert.equal(extractAskPrice('Moonbreon $1,250.50 obo').price, 1250.5);
  assert.equal(extractAskPrice('Lugia V alt art 186/195 120.00').price, 120);
  assert.equal(extractAskPrice('Umbreon PSA 10'), null); // a grade alone is not a price
});

test('a $0 cost basis still sets a floor', () => {
  assert.equal(costForListing({ itemId: '5', title: 'x' }, [{ ebayItemId: '5', costBasis: '0' }]), 0);
});

test('the marketplace code never reaches Whatnot or eBay on its own: every call goes through an injected fetch', async () => {
  const { whatnot } = await import('../netlify/lib/marketplaces/whatnot.js');
  const { handleSales } = await import('../netlify/lib/sell-once.js');
  const { fakeDb } = await import('./fake-db.js');
  const real = globalThis.fetch;
  let reached = null;
  globalThis.fetch = async (u) => { reached = String(u); throw new Error('global fetch is off in tests'); };
  try {
    const injected = async () => new Response(JSON.stringify({ detail: 'nope' }), { status: 401 });
    await assert.rejects(whatnot.connect(null, 'u', { token: 'wn_pat_tk_x' }, { fetchImpl: injected, sleep: async () => {} }), /didn't accept/);
    const db = fakeDb({ marketplace_listings: [], marketplace_orders: [] });
    await handleSales({ db, userId: 'u', marketplace: 'whatnot', sales: [{ orderId: 'o', lineId: 'l', externalId: 'unknown', quantity: 1 }] });
    assert.equal(reached, null);
  } finally { globalThis.fetch = real; }
});
