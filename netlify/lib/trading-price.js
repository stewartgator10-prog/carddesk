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
  const errors = tags(xml, 'Errors')
    .filter(e => tag(e, 'SeverityCode') === 'Error')
    .map(e => tag(e, 'LongMessage') || tag(e, 'ShortMessage') || 'Unknown eBay error');
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
  return results;
}
