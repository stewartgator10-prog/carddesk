// netlify/lib/ebay-listing.js
// Snap to List phase 2: turn an approved card into a live eBay listing.
//   learnTemplates   reads the seller's own listings once: category, condition codes, item specifics,
//                    location, business policies and Best Offer %, so new listings match old ones
//   checkSnapItem    uploads the photos and runs eBay's free VerifyAddFixedPriceItem (nothing goes live)
//   publishSnapItem  AddFixedPriceItem, only for an approved card whose exact listing passed the check;
//                    then records it as inventory (with its cost) and as an active listing
// Trading API calls take an injectable `call` so tests never reach eBay.
import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { tradingCall } from './trading-price.js';
import { titleNumber } from './snap-logic.js';

export const CCG_CATEGORY = '183454'; // CCG Individual Cards (Pokémon, Magic, ...)
export const UNGRADED_CONDITION = '4000';
export const CARD_CONDITION_DESCRIPTOR = '40001';
// Fallback only: the live values come from eBay's metadata API in learnTemplates().
export const FALLBACK_CONDITION_VALUES = { NM: '400010', LP: '400015', MP: '400016', HP: '400017', DMG: '400017' };
const CONDITION_LABELS = { NM: /near mint/i, LP: /lightly played|excellent/i, MP: /moderately played|very good/i, HP: /heavily played|poor/i };

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', parseTagValue: false,
  isArray: (name) => ['Errors', 'NameValueList', 'Value', 'ConditionDescriptor', 'Fee', 'PictureURL', 'Item'].includes(name),
});
export const parseXml = (text) => parser.parse(text);

const esc = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
const cdata = (s) => `<![CDATA[${String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const money = (n) => Number(n).toFixed(2);
const floorCents = (n) => Math.floor(n * 100 + 1e-6) / 100;
const text = (v) => (v == null ? null : typeof v === 'object' ? (v['#text'] ?? null) : String(v));

export function responseOf(xmlText, callName) {
  const r = parseXml(xmlText)?.[`${callName}Response`];
  if (!r) throw new Error(`eBay ${callName}: unreadable response`);
  const all = r.Errors || [];
  const msg = (e) => `${e.LongMessage || e.ShortMessage || 'eBay error'}${e.ErrorCode ? ` (${e.ErrorCode})` : ''}`;
  return {
    r,
    ack: r.Ack,
    errors: all.filter((e) => e.SeverityCode === 'Error').map(msg),
    warnings: all.filter((e) => e.SeverityCode === 'Warning').map(msg),
  };
}

// ---------- learning the seller's listing setup ----------
const MTG = /magic the gathering|\bmtg\b/i;
const NOT_A_SINGLE = /\b(psa|bgs|cgc|sgc|sealed|booster|box|lot|bundle|book|plate|binder|pack)\b/i;

export function pickTemplateListings(listings) {
  const singles = listings.filter((l) => l.status === 'Active' && l.listing_type === 'FixedPriceItem' && !NOT_A_SINGLE.test(l.title || ''));
  const newest = (xs) => xs.sort((a, b) => String(b.start_time || '').localeCompare(String(a.start_time || '')))[0] || null;
  return {
    pokemon: newest(singles.filter((l) => !MTG.test(l.title) && titleNumber(l.title))),
    mtg: newest(singles.filter((l) => MTG.test(l.title))),
  };
}

// Most-used business policies across the seller's active listings.
export function pickPolicies(listings) {
  const count = (get) => {
    const m = new Map();
    for (const l of listings) {
      const p = get(l.raw?.SellerProfiles || {});
      if (p?.id) m.set(p.id, { ...p, n: (m.get(p.id)?.n || 0) + 1 });
    }
    return [...m.values()].sort((a, b) => b.n - a.n);
  };
  const ship = count((s) => s.SellerShippingProfile && { id: text(s.SellerShippingProfile.ShippingProfileID), name: text(s.SellerShippingProfile.ShippingProfileName) });
  return {
    envelope: ship.find((p) => /envelope/i.test(p.name)) || null,
    parcel: ship.find((p) => /parcel|ground|priority/i.test(p.name)) || null,
    returnProfile: count((s) => s.SellerReturnProfile && { id: text(s.SellerReturnProfile.ReturnProfileID), name: text(s.SellerReturnProfile.ReturnProfileName) })[0] || null,
    paymentProfile: count((s) => s.SellerPaymentProfile && { id: text(s.SellerPaymentProfile.PaymentProfileID), name: text(s.SellerPaymentProfile.PaymentProfileName) })[0] || null,
  };
}

export function templateFromItem(item) {
  const price = Number(text(item.StartPrice) ?? text(item.SellingStatus?.CurrentPrice));
  const decline = Number(text(item.ListingDetails?.MinimumBestOfferPrice));
  const accept = Number(text(item.ListingDetails?.BestOfferAutoAcceptPrice));
  return {
    sourceItemId: text(item.ItemID),
    categoryId: text(item.PrimaryCategory?.CategoryID),
    conditionId: text(item.ConditionID),
    conditionDescriptors: (item.ConditionDescriptors?.ConditionDescriptor || []).map((d) => ({ name: text(d.Name), value: [].concat(d.Value || []).map(text)[0] ?? null })),
    itemSpecifics: (item.ItemSpecifics?.NameValueList || []).map((nv) => ({ name: text(nv.Name), values: (nv.Value || []).map(text) })),
    location: text(item.Location), postalCode: text(item.PostalCode), country: text(item.Country) || 'US',
    currency: text(item.Currency) || 'USD', dispatchTimeMax: text(item.DispatchTimeMax),
    bestOffer: {
      enabled: String(text(item.BestOfferDetails?.BestOfferEnabled)) === 'true',
      declinePct: price > 0 && decline > 0 ? Math.round((decline / price) * 10000) / 100 : null,
      acceptPct: price > 0 && accept > 0 ? Math.round((accept / price) * 10000) / 100 : null,
    },
  };
}

// eBay's own list of valid card-condition values for the category, matched by label.
export function conditionValuesFromPolicy(policyJson, categoryId = CCG_CATEGORY) {
  const policy = (policyJson?.itemConditionPolicies || []).find((p) => String(p.categoryId) === String(categoryId));
  const ungraded = (policy?.itemConditions || []).find((c) => String(c.conditionId) === UNGRADED_CONDITION);
  const desc = (ungraded?.conditionDescriptors || []).find((d) => String(d.conditionDescriptorId) === CARD_CONDITION_DESCRIPTOR);
  const values = desc?.conditionDescriptorValues || [];
  const out = {};
  for (const [code, re] of Object.entries(CONDITION_LABELS)) {
    const hit = values.find((v) => re.test(v.conditionDescriptorValueName || ''));
    if (hit) out[code] = String(hit.conditionDescriptorValueId);
  }
  if (out.HP) out.DMG = out.HP;
  return Object.keys(out).length >= 4 ? { values: out, source: 'ebay' } : { values: { ...FALLBACK_CONDITION_VALUES }, source: 'fallback' };
}

export async function learnTemplates({ db, userId, token, call = tradingCall, fetchImpl = fetch }) {
  const { data: listings, error } = await db.from('ebay_listings')
    .select('item_id, title, status, listing_type, start_time, raw').eq('user_id', userId).eq('status', 'Active');
  if (error) throw new Error(error.message);
  const picks = pickTemplateListings(listings || []);
  const out = { learnedAt: new Date().toISOString(), policies: pickPolicies(listings || []) };
  for (const game of ['pokemon', 'mtg']) {
    const l = picks[game];
    if (!l) { out[game] = null; continue; }
    const xml = await call(token, 'GetItem', `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>en_US</ErrorLanguage><ItemID>${esc(l.item_id)}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`);
    const { r, errors } = responseOf(xml, 'GetItem');
    if (errors.length || !r.Item?.[0]) throw new Error(`Couldn't read listing ${l.item_id}: ${errors.join('; ') || 'no item'}`);
    out[game] = { ...templateFromItem(r.Item[0]), sourceTitle: l.title };
  }
  if (!out.pokemon && !out.mtg) throw Object.assign(new Error('No Pokémon or Magic single listing to learn from. List one card on eBay first, sync, then try again.'), { status: 409 });
  try {
    const res = await fetchImpl(`https://api.ebay.com/sell/metadata/v1/marketplace/EBAY_US/get_item_condition_policies?filter=${encodeURIComponent(`categoryIds:{${CCG_CATEGORY}}`)}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    out.conditions = conditionValuesFromPolicy(res.ok ? await res.json() : null);
  } catch {
    out.conditions = { values: { ...FALLBACK_CONDITION_VALUES }, source: 'fallback' };
  }
  const { error: upErr } = await db.from('ebay_accounts').update({ listing_templates: out }).eq('user_id', userId);
  if (upErr) throw new Error(upErr.message);
  return out;
}

// ---------- building the listing ----------
const STATIC_SPECIFICS = /^(game|manufacturer|card size|country\/region of manufacture|country of manufacture|original\/licensed reprint|material|autographed|graded|vintage)$/i;
const FINISH = { reverse_holo: 'Reverse Holo', holo: 'Holo', foil: 'Foil', normal: 'Regular' };
const GAME_NAME = { pokemon: 'Pokémon TCG', mtg: 'Magic: The Gathering' };

export function buildSpecifics(item, tpl) {
  const want = new Map();
  for (const s of tpl?.itemSpecifics || []) if (STATIC_SPECIFICS.test(s.name) && s.values.length) want.set(s.name, s.values);
  const names = new Set((tpl?.itemSpecifics || []).map((s) => s.name.toLowerCase()));
  const setIf = (name, value, always = false) => { if (value && (always || names.has(name.toLowerCase()))) want.set(name, [String(value)]); };
  if (![...want.keys()].some((k) => /^game$/i.test(k))) want.set('Game', [GAME_NAME[item.game] || 'Pokémon TCG']);
  setIf('Card Name', item.card_name, true);
  setIf('Set', item.catalog_set || item.set_name, true);
  setIf('Card Number', item.catalog_number || item.collector_number, true);
  setIf('Language', item.language || 'English', true);
  setIf('Finish', FINISH[item.finish]);
  setIf('Rarity', item.extraction?.rarity || item.rarity);
  if (item.game === 'pokemon') setIf('Character', item.card_name);
  return [...want.entries()].map(([name, values]) => ({ name, values }));
}

export function buildDescription(item, footer = '') {
  const rows = [
    ['Card', item.card_name], ['Set', item.catalog_set || item.set_name], ['Number', item.catalog_number || item.collector_number],
    ['Finish', FINISH[item.finish]], ['Condition', { NM: 'Near Mint', LP: 'Lightly Played', MP: 'Moderately Played', HP: 'Heavily Played', DMG: 'Damaged' }[item.condition] || item.condition],
    ['Language', item.language],
  ].filter(([, v]) => v);
  const misprint = item.misprint_confirmed && item.misprint_notes ? `<p><b>Misprint:</b> ${esc(item.misprint_notes)}</p>` : '';
  const foot = String(footer || '').trim().split(/\n{2,}/).filter(Boolean).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<h3>${esc(item.title)}</h3><ul>${rows.map(([k, v]) => `<li><b>${esc(k)}:</b> ${esc(v)}</li>`).join('')}</ul>${misprint}<p>The photos show the actual card you will receive.</p>${foot}`;
}

export function bestOfferPrices(price, bo) {
  if (!bo?.enabled) return null;
  const under = (pct) => (pct > 0 ? Math.min(floorCents((price * pct) / 100), floorCents(price - 0.01)) : null);
  const decline = under(bo.declinePct);
  let accept = under(bo.acceptPct);
  if (accept != null && decline != null && accept <= decline) accept = null;
  return { decline: decline >= 0.01 ? decline : null, accept: accept >= 0.01 ? accept : null };
}

export function shippingProfileFor(price, templates, settings = {}) {
  const cutoff = Number(settings.snapShipCutoff ?? 20);
  const p = templates?.policies || {};
  return (price < cutoff ? p.envelope : p.parcel) || p.envelope || p.parcel || null;
}

export const listingUuid = (snapId) => String(snapId).replace(/-/g, '').toUpperCase().slice(0, 32);
export const snapSku = (snapId) => `SNAP-${String(snapId).replace(/-/g, '').slice(0, 10).toUpperCase()}`;

// What the check approved; publishing refuses if any of this changed since.
export function listingSignature(item) {
  return crypto.createHash('sha256').update(JSON.stringify([item.title, Number(item.price), item.condition, item.finish, item.card_name,
    item.catalog_set || item.set_name, item.catalog_number || item.collector_number, item.misprint_confirmed, item.ebay_picture_urls || []])).digest('hex').slice(0, 16);
}

export function buildItemXml({ item, templates, settings = {}, pictureUrls }) {
  const tpl = templates?.[item.game] || templates?.pokemon || templates?.mtg;
  if (!tpl) throw new Error('No listing setup learned yet.');
  const price = Number(item.price);
  const cond = templates.conditions?.values || FALLBACK_CONDITION_VALUES;
  const ship = shippingProfileFor(price, templates, settings);
  const ret = templates.policies?.returnProfile;
  const pay = templates.policies?.paymentProfile;
  const bo = bestOfferPrices(price, tpl.bestOffer);
  const specifics = buildSpecifics(item, tpl);
  return [
    '<Item>',
    `<Title>${esc(String(item.title).slice(0, 80))}</Title>`,
    `<Description>${cdata(buildDescription(item, settings.snapDescriptionFooter))}</Description>`,
    `<PrimaryCategory><CategoryID>${esc(tpl.categoryId || CCG_CATEGORY)}</CategoryID></PrimaryCategory>`,
    `<StartPrice currencyID="USD">${money(price)}</StartPrice>`,
    `<ConditionID>${UNGRADED_CONDITION}</ConditionID>`,
    `<ConditionDescriptors><ConditionDescriptor><Name>${CARD_CONDITION_DESCRIPTOR}</Name><Value>${esc(cond[item.condition] || cond.NM)}</Value></ConditionDescriptor></ConditionDescriptors>`,
    `<Country>${esc(tpl.country || 'US')}</Country><Currency>USD</Currency>`,
    tpl.location ? `<Location>${esc(tpl.location)}</Location>` : '',
    tpl.postalCode ? `<PostalCode>${esc(tpl.postalCode)}</PostalCode>` : '',
    tpl.dispatchTimeMax ? `<DispatchTimeMax>${esc(tpl.dispatchTimeMax)}</DispatchTimeMax>` : '',
    '<ListingDuration>GTC</ListingDuration><ListingType>FixedPriceItem</ListingType><Quantity>1</Quantity>',
    `<SKU>${esc(item.sku || snapSku(item.id))}</SKU>`,
    `<UUID>${listingUuid(item.id)}</UUID>`,
    `<PictureDetails>${pictureUrls.map((u) => `<PictureURL>${esc(u)}</PictureURL>`).join('')}</PictureDetails>`,
    `<ItemSpecifics>${specifics.map((s) => `<NameValueList><Name>${esc(s.name)}</Name>${s.values.map((v) => `<Value>${esc(v)}</Value>`).join('')}</NameValueList>`).join('')}</ItemSpecifics>`,
    '<SellerProfiles>',
    ship ? `<SellerShippingProfile><ShippingProfileID>${esc(ship.id)}</ShippingProfileID></SellerShippingProfile>` : '',
    ret ? `<SellerReturnProfile><ReturnProfileID>${esc(ret.id)}</ReturnProfileID></SellerReturnProfile>` : '',
    pay ? `<SellerPaymentProfile><PaymentProfileID>${esc(pay.id)}</PaymentProfileID></SellerPaymentProfile>` : '',
    '</SellerProfiles>',
    bo ? '<BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>' : '',
    bo && (bo.decline || bo.accept) ? `<ListingDetails>${bo.decline ? `<MinimumBestOfferPrice currencyID="USD">${money(bo.decline)}</MinimumBestOfferPrice>` : ''}${bo.accept ? `<BestOfferAutoAcceptPrice currencyID="USD">${money(bo.accept)}</BestOfferAutoAcceptPrice>` : ''}</ListingDetails>` : '',
    '</Item>',
  ].join('');
}

const wrap = (callName, inner) => `<?xml version="1.0" encoding="utf-8"?><${callName}Request xmlns="urn:ebay:apis:eBLBaseComponents"><ErrorLanguage>en_US</ErrorLanguage><WarningLevel>High</WarningLevel>${inner}</${callName}Request>`;

export function feesOf(r) {
  const fees = (r.Fees?.Fee || []).map((f) => ({ name: text(f.Name), amount: Number(text(f.Fee)) || 0 })).filter((f) => f.amount > 0);
  const listing = fees.find((f) => f.name === 'ListingFee');
  return { total: listing ? listing.amount : fees.reduce((s, f) => s + f.amount, 0), items: fees.filter((f) => f.name !== 'ListingFee') };
}

// ---------- photos ----------
// UploadSiteHostedPictures takes a multipart body: the XML request part, then the image bytes.
export function pictureUploadBody(imageBytes, name, boundary = `----cd${crypto.randomBytes(12).toString('hex')}`) {
  const xml = wrap('UploadSiteHostedPictures', `<PictureName>${esc(name)}</PictureName><PictureSet>Supersize</PictureSet>`);
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="XML Payload"\r\nContent-Type: text/xml;charset=utf-8\r\n\r\n${xml}\r\n`
    + `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}.jpg"\r\nContent-Type: image/jpeg\r\nContent-Transfer-Encoding: binary\r\n\r\n`, 'utf8');
  return { body: Buffer.concat([head, Buffer.from(imageBytes), Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')]), boundary };
}

export async function uploadPicture({ token, imageBytes, name, fetchImpl = fetch }) {
  const { body, boundary } = pictureUploadBody(imageBytes, name);
  const res = await fetchImpl('https://api.ebay.com/ws/api.dll', {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'X-EBAY-API-CALL-NAME': 'UploadSiteHostedPictures', 'X-EBAY-API-SITEID': '0',
      'X-EBAY-API-COMPATIBILITY-LEVEL': '1355', 'X-EBAY-API-IAF-TOKEN': token,
    },
    body,
  });
  const xmlText = await res.text();
  if (!res.ok) throw new Error(`Photo upload failed (HTTP ${res.status})`);
  const { r, errors } = responseOf(xmlText, 'UploadSiteHostedPictures');
  const url = text(r.SiteHostedPictureDetails?.FullURL);
  if (errors.length || !url) throw new Error(`Photo upload failed: ${errors.join('; ') || 'no URL returned'}`);
  return url;
}

// ---------- check and publish ----------
async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }

async function photoBytes(db, path) {
  const { data, error } = await db.storage.from('snap-photos').download(path);
  if (error || !data) throw new Error(`Couldn't open photo ${path}: ${error?.message || 'missing'}`);
  return Buffer.from(await data.arrayBuffer());
}

export async function loadTemplates(db, userId) {
  const acct = await must(db.from('ebay_accounts').select('id, listing_templates').eq('user_id', userId).maybeSingle());
  if (!acct) throw Object.assign(new Error('Connect your eBay account first.'), { status: 409 });
  if (!acct.listing_templates) throw Object.assign(new Error('Learn your listing setup first (Snap settings).'), { status: 409 });
  return { accountId: acct.id, templates: acct.listing_templates };
}

export async function checkSnapItem({ db, userId, token, item, settings, call = tradingCall, fetchImpl = fetch }) {
  if (item.status !== 'approved') throw Object.assign(new Error('Approve the card first.'), { status: 409 });
  if (!['pokemon', 'mtg'].includes(item.game)) throw Object.assign(new Error('Only Pokémon and Magic cards can be listed in this version.'), { status: 409 });
  if (!(Number(item.price) >= 0.99) || !item.title) throw Object.assign(new Error('The card needs a title and a price of at least $0.99.'), { status: 409 });
  const { templates } = await loadTemplates(db, userId);
  await must(db.from('snap_items').update({ publish_state: 'checking', publish_error: null }).eq('id', item.id).eq('user_id', userId));
  try {
    let urls = item.ebay_picture_urls || [];
    const paths = [item.photo_path, item.back_photo_path].filter(Boolean);
    if (urls.length !== paths.length) {
      urls = [];
      for (const [i, p] of paths.entries()) urls.push(await uploadPicture({ token, imageBytes: await photoBytes(db, p), name: `${snapSku(item.id)}-${i + 1}`, fetchImpl }));
    }
    const sku = item.sku || snapSku(item.id);
    const full = { ...item, sku, ebay_picture_urls: urls };
    const xml = await call(token, 'VerifyAddFixedPriceItem', wrap('VerifyAddFixedPriceItem', buildItemXml({ item: full, templates, settings, pictureUrls: urls })));
    const { r, errors, warnings } = responseOf(xml, 'VerifyAddFixedPriceItem');
    const check = { ok: errors.length === 0, errors, warnings, fees: feesOf(r), signature: listingSignature(full), checkedAt: new Date().toISOString(),
      shippingProfile: shippingProfileFor(Number(item.price), templates, settings)?.name || null };
    const patch = { sku, ebay_picture_urls: urls, publish_check: check, publish_state: check.ok ? 'checked' : 'check_failed' };
    await must(db.from('snap_items').update(patch).eq('id', item.id).eq('user_id', userId));
    return { ...item, ...patch };
  } catch (err) {
    await db.from('snap_items').update({ publish_state: 'check_failed', publish_error: String(err.message).slice(0, 300) }).eq('id', item.id).eq('user_id', userId);
    throw err;
  }
}

export async function publishSnapItem({ db, userId, token, item, settings, call = tradingCall }) {
  if (item.status !== 'approved') throw Object.assign(new Error('Only approved cards can be published.'), { status: 409 });
  const check = item.publish_check;
  if (item.publish_state !== 'checked' || !check?.ok) throw Object.assign(new Error('Run the eBay check on this card first.'), { status: 409 });
  if (check.signature !== listingSignature(item)) throw Object.assign(new Error('The card changed after it was checked. Check it again before publishing.'), { status: 409 });
  const { accountId, templates } = await loadTemplates(db, userId);

  // Claim the card so a double click can't list it twice (eBay's UUID is the second guard).
  const claimed = await must(db.from('snap_items').update({ publish_state: 'publishing' }).eq('id', item.id).eq('user_id', userId).eq('publish_state', 'checked').select('id'));
  if (!claimed?.length) throw Object.assign(new Error('This card is already being published.'), { status: 409 });

  let itemId, fees;
  try {
    const xml = await call(token, 'AddFixedPriceItem', wrap('AddFixedPriceItem', buildItemXml({ item, templates, settings, pictureUrls: item.ebay_picture_urls || [] })));
    const { r, errors } = responseOf(xml, 'AddFixedPriceItem');
    itemId = text(r.ItemID) || text(r.DuplicateInvocationDetails?.InvocationTrackingID);
    // A retry after a lost response comes back as "duplicate UUID" carrying the listing that already exists.
    if (!itemId || (errors.length && !r.DuplicateInvocationDetails)) throw new Error(errors.join('; ') || 'eBay did not return an item number');
    fees = feesOf(r);
  } catch (err) {
    await db.from('snap_items').update({ publish_state: 'failed', publish_error: String(err.message).slice(0, 300) }).eq('id', item.id).eq('user_id', userId);
    throw err;
  }

  const now = new Date().toISOString();
  const url = `https://www.ebay.com/itm/${itemId}`;
  await must(db.from('snap_items').update({ status: 'listed', publish_state: 'listed', ebay_item_id: itemId, ebay_url: url, listed_at: now, publish_error: null,
    publish_check: { ...check, listingFees: fees } }).eq('id', item.id).eq('user_id', userId));
  // The card is now stock with its cost, tied to the listing so its sale matches automatically.
  await must(db.from('inventory').insert({
    id: crypto.randomUUID(), user_id: userId, card_name: item.title, game: item.game === 'mtg' ? 'MTG' : 'Pokémon',
    set_name: item.catalog_set || item.set_name || null, condition: item.condition || 'NM', status: 'In Stock',
    current_fmv: Number(item.price), ebay_item_id: itemId, sku: item.sku, acquired_at: now.slice(0, 10),
    cost_basis: item.cost_basis ?? null, cost_source: item.cost_basis != null ? (item.cost_source || 'entered') : null, purchase_id: item.purchase_id || null,
  }));
  await must(db.from('ebay_listings').upsert({
    account_id: accountId, user_id: userId, item_id: itemId, title: item.title, sku: item.sku, price: Number(item.price), currency: 'USD',
    quantity: 1, quantity_available: 1, quantity_sold: 0, listing_type: 'FixedPriceItem', start_time: now, view_url: url,
    image_url: (item.ebay_picture_urls || [])[0] || null, status: 'Active', synced_at: now,
  }, { onConflict: 'account_id,item_id' }));
  return { itemId, url, fees };
}
