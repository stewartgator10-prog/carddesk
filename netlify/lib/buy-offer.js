// netlify/lib/buy-offer.js
// Buy-offer mode: value cards from photos (binder page or single), then on accept record the deal
// as a purchase and move the cards into the Snap to List queue, already identified and priced.
import crypto from 'node:crypto';
import { readCard, readPage } from './card-vision.js';
import { lookupCard } from './card-catalog.js';
import { ebayMedianFor } from './market.js';
import { usageRow, logUsage, checkBudget } from './ai-usage.js';
import { loadSnapSettings, BudgetError } from './snap-identify.js';
import { splitCost } from './cost-split.js';
import { applyIdentification, suggestPrice, buildTitle, buildDescription, CONFIDENCE_OK, CATALOG_GAMES } from './snap-logic.js';
import { tiersFrom, marketOf, offerTotals } from './offer-logic.js';

async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

// Market value for one read card: TCGplayer (catalog) for English cards of the catalog games, otherwise the
// median of comparable eBay Buy It Now listings. Returns the item fields to store.
export async function valueCard(read, { ownSeller = null, deps = {} } = {}) {
  const flags = [];
  if (!read.is_trading_card) flags.push('not_a_card');
  if (read.graded) flags.push('graded');
  if (!(read.confidence >= CONFIDENCE_OK)) flags.push('low_confidence');
  let catalog = null;
  let market = null;
  let source = null;
  if (read.is_trading_card && CATALOG_GAMES.includes(read.game) && /^english$/i.test(read.language || 'English')) {
    catalog = await (deps.lookupCard || lookupCard)(read).catch(() => null);
    if (catalog?.versions > 1) flags.push('multiple_versions');
    if (catalog?.matchLevel === 'name') flags.push('name_only_match');
    else if (catalog?.marketPrice != null) { market = catalog.marketPrice; source = 'tcgplayer'; }
  }
  // Slabs aren't priced from raw-card listings (the grade isn't known here); Jackson prices them by hand.
  if (market == null && read.is_trading_card && read.card_name && !read.graded) {
    const median = await ebayMedianFor(read, { ownSeller, deps }).catch(() => null); // no eBay data: left unpriced
    if (median != null) { market = median; source = 'ebay_median'; flags.push('ebay_median'); }
  }
  if (market == null) flags.push('no_price');
  return {
    extraction: read, confidence: read.confidence, game: read.game, card_name: read.card_name, set_name: read.set_name,
    collector_number: read.collector_number, language: read.language, finish: read.finish,
    condition: read.condition_guess && read.condition_guess !== 'unknown' ? read.condition_guess : 'NM', graded: !!read.graded,
    catalog_source: catalog?.source ?? null, catalog_id: catalog?.id ?? null, catalog_name: catalog?.name ?? null, catalog_set: catalog?.setName ?? null,
    catalog_number: catalog?.number ?? null, catalog_image_url: catalog?.imageUrl ?? null,
    market_price: market, market_source: source, flags,
  };
}

export async function identifyOfferPhoto({ db, userId, offerId, photoPath, kind, deps = {} }) {
  if (!['page', 'single'].includes(kind)) throw fail('kind must be page or single', 400);
  if (!String(photoPath || '').startsWith(`${userId}/`)) throw fail('That photo does not belong to you.', 403);
  const offer = await must(db.from('buy_offers').select('id, status').eq('user_id', userId).eq('id', offerId).maybeSingle());
  if (!offer) throw fail('Offer not found.', 404);
  if (offer.status !== 'draft') throw fail(`This offer is already ${offer.status}.`);
  const settings = await loadSnapSettings(db, userId);
  const budget = await checkBudget(db, userId, settings);
  if (!budget.ok) throw new BudgetError(budget);

  const { data: blob, error } = await db.storage.from('snap-photos').download(photoPath);
  if (error || !blob) throw fail(`Couldn't open the photo: ${error?.message || 'missing'}`, 502);
  const image = { base64: Buffer.from(await blob.arrayBuffer()).toString('base64'), mediaType: blob.type || 'image/jpeg' };
  const model = settings.snapModel;
  let r;
  try {
    r = kind === 'page'
      ? await (deps.readPage || readPage)({ model, image })
      : await (deps.readCard || readCard)({ model, image }).then((x) => ({ ...x, cards: [{ ...x.read, position: 1, box: null }] }));
  } catch (err) {
    if (err.usage) await logUsage(db, usageRow({ userId, model, purpose: 'buy_offer', usage: err.usage, latencyMs: err.latencyMs, requestId: err.requestId, ok: false, error: err.message }));
    throw err;
  }
  const fee = usageRow({ userId, model, purpose: 'buy_offer', usage: r.usage, latencyMs: r.latencyMs, requestId: r.requestId });
  await logUsage(db, fee);

  const acct = await must(db.from('ebay_accounts').select('ebay_username').eq('user_id', userId).maybeSingle());
  const existing = await must(db.from('buy_offer_items').select('position').eq('offer_id', offerId).eq('user_id', userId));
  const start = existing.reduce((m, x) => Math.max(m, x.position || 0), 0);
  const rows = [];
  for (const [i, card] of r.cards.entries()) {
    const { position, box, ...read } = card;
    rows.push({
      id: crypto.randomUUID(), offer_id: offerId, user_id: userId, photo_path: photoPath, source: kind,
      position: start + i + 1, box: kind === 'page' ? box : null,
      ...(await valueCard(read, { ownSeller: acct?.ebay_username, deps })),
    });
  }
  if (rows.length) await must(db.from('buy_offer_items').insert(rows));
  return { items: rows, cost: fee.cost_usd, cards_found: rows.length };
}

export async function acceptOffer({ db, userId, offerId, finalOffer = null }) {
  const offer = await must(db.from('buy_offers').select('*').eq('user_id', userId).eq('id', offerId).maybeSingle());
  if (!offer) throw fail('Offer not found.', 404);
  if (offer.status !== 'draft') throw fail(`This offer is already ${offer.status}.`);
  const settings = await loadSnapSettings(db, userId);
  const tiers = tiersFrom(settings);
  const all = await must(db.from('buy_offer_items').select('*').eq('user_id', userId).eq('offer_id', offerId));
  const items = all.filter((i) => i.included !== false);
  if (!items.length) throw fail('There are no cards in this offer.');
  const totals = offerTotals(items, tiers);
  const paid = finalOffer == null || finalOffer === '' ? totals.offer : Math.round(Number(finalOffer) * 100) / 100;
  if (!(paid >= 0 && paid <= 1_000_000)) throw fail('The amount paid must be 0 or more.', 400);

  const purchaseId = crypto.randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  await must(db.from('purchases').insert({ id: purchaseId, user_id: userId, purchased_at: today, total_paid: paid, split_method: 'market', source: `Buy offer: ${offer.name || today}` }));
  const costs = splitCost(paid, items.map((i) => ({ id: i.id, weight: marketOf(i) })));
  const batch = `offer-${String(offerId).slice(0, 8)}`;

  for (const it of items) {
    const read = { ...(it.extraction || {}), card_name: it.card_name, set_name: it.set_name, collector_number: it.collector_number, finish: it.finish, condition_guess: it.condition, graded: it.graded, confidence: it.confidence ?? it.extraction?.confidence ?? 0 };
    const market = marketOf(it);
    const catalog = it.catalog_source ? { versions: (it.flags || []).includes('multiple_versions') ? 2 : 1, source: it.catalog_source, id: it.catalog_id, name: it.catalog_name, setName: it.catalog_set, number: it.catalog_number, imageUrl: it.catalog_image_url, marketPrice: market, matchLevel: (it.flags || []).includes('name_only_match') ? 'name' : 'exact' } : null;
    const snap = applyIdentification({ read, catalog, settings });
    if (!catalog && market != null) {
      // Priced from eBay listings (e.g. Japanese cards) or by hand: carry that value into the listing price.
      Object.assign(snap, { market_price: market, price_source: it.market_source === 'ebay_median' ? 'eBay listings median' : 'entered', suggested_price: suggestPrice(market, settings), price: suggestPrice(market, settings) });
      snap.review_reasons = snap.review_reasons.filter((r) => r !== 'no_price');
    }
    if (it.source === 'page') snap.review_reasons = [...snap.review_reasons, 'page_photo'];
    snap.status = snap.review_reasons.length ? 'needs_review' : 'ready';
    snap.title = buildTitle({ ...snap, misprint_confirmed: false });
    snap.description = buildDescription({ ...snap, misprint_confirmed: false });
    const snapId = crypto.randomUUID();
    await must(db.from('snap_items').insert({
      ...snap, id: snapId, user_id: userId, batch_id: batch, photo_path: it.photo_path, photo_crop: it.source === 'page' ? it.box : null,
      model: settings.snapModel, identified_at: new Date().toISOString(),
      cost_basis: costs.get(it.id) ?? null, cost_source: 'purchase', purchase_id: purchaseId,
    }));
    await must(db.from('buy_offer_items').update({ snap_item_id: snapId }).eq('user_id', userId).eq('id', it.id));
  }
  await must(db.from('buy_offers').update({
    status: 'accepted', final_offer: paid, total_market: totals.market, total_offer: totals.offer, tiers, purchase_id: purchaseId, accepted_at: new Date().toISOString(),
  }).eq('user_id', userId).eq('id', offerId));
  return { purchase_id: purchaseId, paid, cards: items.length, totals };
}
