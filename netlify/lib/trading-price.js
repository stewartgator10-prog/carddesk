// eBay Trading API price revision helpers.
// ReviseInventoryStatus changes price/quantity on fixed-price listings, including ones created
// on eBay.com (which the Sell Inventory API can't see). It takes at most 4 items per call.

const TRADING_URL = 'https://api.ebay.com/ws/api.dll';
const COMPAT_LEVEL = '1355';
export const MAX_PER_CALL = 4;

const esc = s => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

export function chunk(arr, n = MAX_PER_CALL) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

// changes: [{ itemId, sku?, newPrice }]
export function buildReviseXml(changes) {
  const items = changes.map(c => [
    '<InventoryStatus>',
    `<ItemID>${esc(c.itemId)}</ItemID>`,
    c.sku ? `<SKU>${esc(c.sku)}</SKU>` : '',
    `<StartPrice>${Number(c.newPrice).toFixed(2)}</StartPrice>`,
    '</InventoryStatus>',
  ].join('')).join('');
  return `<?xml version="1.0" encoding="utf-8"?><ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>${items}</ReviseInventoryStatusRequest>`;
}

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? m[1].trim() : null;
};
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'g'))].map(m => m[1]);

// Map a ReviseInventoryStatus response onto the requested changes.
// Ack can be Success, Warning, PartialFailure or Failure. Errors don't always say which item they
// belong to, so: items echoed back in <InventoryStatus> succeeded; the rest failed with the errors.
export function parseReviseResponse(xml, changes) {
  const ack = tag(xml, 'Ack') || 'Failure';
  const echoed = new Map(tags(xml, 'InventoryStatus').map(b => [tag(b, 'ItemID'), parseFloat(tag(b, 'StartPrice'))]));
  const errors = [...new Set(tags(xml, 'Errors')
    .filter(e => tag(e, 'SeverityCode') === 'Error')
    .map(e => tag(e, 'LongMessage') || tag(e, 'ShortMessage') || 'Unknown eBay error'))];
  const warnings = tags(xml, 'Errors')
    .filter(e => tag(e, 'SeverityCode') === 'Warning')
    .map(e => tag(e, 'ShortMessage'));
  return changes.map(c => {
    const ok = echoed.has(String(c.itemId)) || (ack === 'Success' || ack === 'Warning');
    return {
      itemId: c.itemId,
      ok,
      price: ok ? (echoed.get(String(c.itemId)) ?? c.newPrice) : null,
      error: ok ? null : (errors.join(' | ') || `eBay returned ${ack}`),
      warnings: ok ? warnings.filter(Boolean) : [],
    };
  });
}

export async function tradingCall(token, callName, xmlBody) {
  const res = await fetch(TRADING_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml',
      'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': COMPAT_LEVEL,
      'X-EBAY-API-CALL-NAME': callName,
      'X-EBAY-API-IAF-TOKEN': token,
    },
    body: xmlBody,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Trading API ${callName} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

// ---------- Best Offer thresholds ----------
// A listing with Best Offer can have an auto-decline (MinimumBestOfferPrice) and an
// auto-accept (BestOfferAutoAcceptPrice) amount. eBay refuses a new price at or below
// either one, and ReviseInventoryStatus can't change them. When that happens we read
// both amounts with GetItem, scale them by the same % as the price change (so the
// seller's offer policy stays the same), and revise all three with ReviseFixedPriceItem.
export const BEST_OFFER_ERROR = /auto[\s-]?(decline|accept)|best offer/i;

const money2 = n => Number(n).toFixed(2);
const floorCents = n => Math.floor(n * 100 + 1e-6) / 100;
const amount = (xml, name) => { const v = tag(xml, name); const n = v == null ? NaN : parseFloat(v); return Number.isFinite(n) ? n : null; };

export function buildGetItemXml(itemId) {
  return `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>en_US</ErrorLanguage><ItemID>${esc(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel></GetItemRequest>`;
}

export function parseBestOffer(xml) {
  return {
    startPrice: amount(xml, 'StartPrice'),
    decline: amount(xml, 'MinimumBestOfferPrice'),
    accept: amount(xml, 'BestOfferAutoAcceptPrice'),
  };
}

// Keeps each threshold at the same fraction of the price, rounded down to the cent,
// always below the new price, and auto-accept above auto-decline.
export function scaleBestOffer({ oldPrice, newPrice, decline, accept }) {
  const ratio = oldPrice > 0 ? newPrice / oldPrice : 1;
  const fit = v => {
    if (v == null) return null;
    const s = Math.min(floorCents(v * ratio), floorCents(newPrice - 0.01));
    return s >= 0.01 ? s : null;
  };
  const d = fit(decline);
  let a = fit(accept);
  if (a != null && d != null && a <= d) a = null; // can't keep both; dropping auto-accept is the safe side
  return { decline: d, accept: a };
}

// The seller's offer rule: offers at (100 - pct)% of the price or more are accepted automatically,
// anything lower is declined automatically (1 cent under, since eBay needs decline < accept < price).
export function offerThresholds(price, pct = 10) {
  const p = Number(price);
  const cut = Number.isFinite(Number(pct)) && Number(pct) > 0 ? Number(pct) : 10;
  let accept = Math.min(floorCents(p * (1 - cut / 100)), floorCents(p - 0.01));
  const decline = floorCents(accept - 0.01);
  if (!(accept >= 0.02) || !(decline >= 0.01)) return { accept: null, decline: null };
  return { accept, decline };
}

// Turns Best Offer on (with the offer rule above) or off for one live listing.
export function buildBestOfferXml({ itemId, enabled, price, pct = 10 }) {
  const t = enabled ? offerThresholds(price, pct) : null;
  const listing = t?.accept != null
    ? `<ListingDetails><MinimumBestOfferPrice currencyID="USD">${money2(t.decline)}</MinimumBestOfferPrice><BestOfferAutoAcceptPrice currencyID="USD">${money2(t.accept)}</BestOfferAutoAcceptPrice></ListingDetails>`
    : '';
  const deleted = enabled ? '' : '<DeletedField>Item.ListingDetails.MinimumBestOfferPrice</DeletedField><DeletedField>Item.ListingDetails.BestOfferAutoAcceptPrice</DeletedField>';
  return `<?xml version="1.0" encoding="utf-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel><Item><ItemID>${esc(itemId)}</ItemID><BestOfferDetails><BestOfferEnabled>${enabled ? 'true' : 'false'}</BestOfferEnabled></BestOfferDetails>${listing}</Item>${deleted}</ReviseFixedPriceItemRequest>`;
}

export async function setBestOffer(token, { itemId, enabled, price, pct = 10 }, call = tradingCall) {
  const xml = await call(token, 'ReviseFixedPriceItem', buildBestOfferXml({ itemId, enabled, price, pct }));
  if (!ackOk(xml)) throw new Error(errorsOf(xml) || `eBay returned ${tag(xml, 'Ack') || 'Failure'}`);
  const t = enabled ? offerThresholds(price, pct) : null;
  return { itemId: String(itemId), enabled: !!enabled, accept: t?.accept ?? null, decline: t?.decline ?? null };
}

export function buildReviseFixedPriceXml({ itemId, newPrice, decline, accept }) {
  const details = [
    decline != null ? `<MinimumBestOfferPrice currencyID="USD">${money2(decline)}</MinimumBestOfferPrice>` : '',
    accept != null ? `<BestOfferAutoAcceptPrice currencyID="USD">${money2(accept)}</BestOfferAutoAcceptPrice>` : '',
  ].join('');
  return `<?xml version="1.0" encoding="utf-8"?><ReviseFixedPriceItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel><Item><ItemID>${esc(itemId)}</ItemID><StartPrice currencyID="USD">${money2(newPrice)}</StartPrice>${details ? `<ListingDetails>${details}</ListingDetails>` : ''}</Item></ReviseFixedPriceItemRequest>`;
}

const ackOk = xml => ['Success', 'Warning'].includes(tag(xml, 'Ack'));
const errorsOf = xml => [...new Set(tags(xml, 'Errors').filter(e => tag(e, 'SeverityCode') === 'Error')
  .map(e => tag(e, 'LongMessage') || tag(e, 'ShortMessage')))].filter(Boolean).join(' | ');

export async function reviseWithBestOffer(token, change, call = tradingCall) {
  const item = parseBestOffer(await call(token, 'GetItem', buildGetItemXml(change.itemId)));
  const oldPrice = item.startPrice ?? Number(change.oldPrice);
  const scaled = scaleBestOffer({ oldPrice, newPrice: change.newPrice, decline: item.decline, accept: item.accept });
  const xml = await call(token, 'ReviseFixedPriceItem', buildReviseFixedPriceXml({ itemId: change.itemId, newPrice: change.newPrice, ...scaled }));
  if (!ackOk(xml)) throw new Error(errorsOf(xml) || `eBay returned ${tag(xml, 'Ack') || 'Failure'}`);
  const warnings = [];
  if (item.decline != null) warnings.push(`Best Offer auto-decline ${money2(item.decline)} → ${scaled.decline != null ? money2(scaled.decline) : 'off'}`);
  if (item.accept != null) warnings.push(`Best Offer auto-accept ${money2(item.accept)} → ${scaled.accept != null ? money2(scaled.accept) : 'off'}`);
  return { itemId: change.itemId, ok: true, price: change.newPrice, error: null, warnings, bestOffer: true };
}

export async function revisePrices(token, changes, call = tradingCall) {
  const results = [];
  for (const batch of chunk(changes)) {
    try {
      const xml = await call(token, 'ReviseInventoryStatus', buildReviseXml(batch));
      results.push(...parseReviseResponse(xml, batch));
    } catch (err) {
      results.push(...batch.map(c => ({ itemId: c.itemId, ok: false, price: null, error: err.message, warnings: [] })));
    }
  }
  // Retry, one at a time, the items eBay refused because of their Best Offer settings.
  const byId = new Map(changes.map(c => [String(c.itemId), c]));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.ok || !BEST_OFFER_ERROR.test(r.error || '')) continue;
    try {
      results[i] = await reviseWithBestOffer(token, byId.get(String(r.itemId)), call);
    } catch (err) {
      results[i] = { ...r, error: `${r.error} (Best Offer retry failed: ${err.message})` };
    }
  }
  return results;
}
