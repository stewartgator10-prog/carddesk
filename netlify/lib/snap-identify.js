// netlify/lib/snap-identify.js
// One snap: photo -> Claude read -> catalog match -> price/title/review flags -> saved row,
// with every Claude call written to the API fee log. Dependencies are injectable for tests.
import { readCard, fetchImage, SNAP_MODELS } from './card-vision.js';
import { lookupCard } from './card-catalog.js';
import { applyIdentification, scoreTrial, titleNumber, SNAP_DEFAULTS } from './snap-logic.js';
import { usageRow, logUsage, checkBudget, costOf } from './ai-usage.js';

export async function loadSnapSettings(db, userId) {
  const { data } = await db.from('settings').select('data').eq('user_id', userId).maybeSingle();
  const s = { ...SNAP_DEFAULTS, ...(data?.data || {}) };
  if (!SNAP_MODELS.includes(s.snapModel)) s.snapModel = SNAP_DEFAULTS.snapModel;
  return s;
}

// An active eBay listing whose title has the same card name and number.
export async function findDuplicate(db, userId, read) {
  if (!read?.card_name || !read.is_trading_card) return null;
  const { data } = await db.from('ebay_listings').select('item_id, title')
    .eq('user_id', userId).eq('status', 'Active').ilike('title', `%${read.card_name.replace(/[%_]/g, '')}%`);
  const local = (s) => String(s || '').split('/')[0].toLowerCase().replace(/^([a-z]*)0*(\d)/, '$1$2');
  const want = read.collector_number ? local(read.collector_number) : null;
  const hit = (data || []).find((l) => {
    const n = titleNumber(l.title);
    return want ? (n ? local(n) === want : false) : true;
  });
  return hit?.item_id || null;
}

export class BudgetError extends Error {
  constructor(b) { super(`Monthly AI budget reached ($${b.spent.toFixed(2)} of $${b.budget.toFixed(2)}). Raise it in Snap settings to keep going.`); this.code = 'BUDGET'; this.budget = b; }
}

async function readAndLog({ db, userId, model, image, purpose, snapItemId, deps }) {
  try {
    const r = await (deps.readCard || readCard)({ model, image });
    const row = usageRow({ userId, model, purpose, usage: r.usage, latencyMs: r.latencyMs, requestId: r.requestId, snapItemId });
    await logUsage(db, row);
    return { ...r, cost: row.cost_usd };
  } catch (err) {
    // A response that came back unusable still cost tokens: log it so the tracker stays complete.
    if (err.usage) await logUsage(db, usageRow({ userId, model, purpose, usage: err.usage, latencyMs: err.latencyMs, requestId: err.requestId, snapItemId, ok: false, error: err.message }));
    throw err;
  }
}

export async function identifySnapItem({ db, userId, item, deps = {} }) {
  const settings = await loadSnapSettings(db, userId);
  const budget = await checkBudget(db, userId, settings);
  if (!budget.ok) throw new BudgetError(budget);
  const model = settings.snapModel;

  await db.from('snap_items').update({ status: 'identifying', error: null }).eq('id', item.id).eq('user_id', userId);
  try {
    const { data: blob, error } = await db.storage.from('snap-photos').download(item.photo_path);
    if (error || !blob) throw new Error(`Couldn't open the photo: ${error?.message || 'missing'}`);
    const image = { base64: Buffer.from(await blob.arrayBuffer()).toString('base64'), mediaType: blob.type || 'image/jpeg' };

    const r = await readAndLog({ db, userId, model, image, purpose: 'snap_identify', snapItemId: item.id, deps });
    const catalog = await (deps.lookupCard || lookupCard)(r.read).catch((e) => { console.error('catalog lookup', e.message); return null; });
    const duplicateItemId = await findDuplicate(db, userId, r.read).catch(() => null);
    const patch = { ...applyIdentification({ read: r.read, catalog, settings, duplicateItemId }), model, identified_at: new Date().toISOString() };
    const { error: upErr } = await db.from('snap_items').update(patch).eq('id', item.id).eq('user_id', userId);
    if (upErr) throw new Error(upErr.message);
    return { item: { ...item, ...patch }, cost: r.cost, budget };
  } catch (err) {
    await db.from('snap_items').update({ status: 'failed', error: String(err.message).slice(0, 300) }).eq('id', item.id).eq('user_id', userId);
    throw err;
  }
}

// ---------- model trial on the seller's own eBay listings ----------
const NOT_A_SINGLE = /\b(psa|bgs|cgc|sgc|sealed|booster|box|lot|bundle|book|plate|binder|sleeves?|pack)\b/i;
const MTG = /magic the gathering|\bmtg\b/i;

export const fullSizePhoto = (url) => String(url || '').replace(/\/s-l\d+\./, '/s-l1600.');

// A fixed, repeatable sample: about two thirds Pokémon (titles with a 035/193-style number), one third Magic.
export function pickTrialListings(listings, n = 30) {
  const ok = listings.filter((l) => l.image_url && l.title && !NOT_A_SINGLE.test(l.title));
  const mtg = ok.filter((l) => MTG.test(l.title));
  const pokemon = ok.filter((l) => !MTG.test(l.title) && titleNumber(l.title));
  const byId = (a, b) => String(a.item_id).localeCompare(String(b.item_id));
  mtg.sort(byId); pokemon.sort(byId);
  const nMtg = Math.min(mtg.length, Math.round(n / 3));
  const spread = (arr, k) => (k >= arr.length ? arr : Array.from({ length: k }, (_, i) => arr[Math.floor((i * arr.length) / k)]));
  return [...spread(pokemon, n - nMtg), ...spread(mtg, nMtg)].slice(0, n);
}

export async function runTrialCase({ db, userId, trialId, model, listing, deps = {} }) {
  const settings = await loadSnapSettings(db, userId);
  const budget = await checkBudget(db, userId, settings);
  if (!budget.ok) throw new BudgetError(budget);
  const imageUrl = fullSizePhoto(listing.image_url);
  const base = { user_id: userId, trial_id: trialId, model, item_id: String(listing.item_id), expected_title: listing.title, listed_price: listing.price ?? null, image_url: imageUrl };
  let row;
  try {
    const image = await (deps.fetchImage || fetchImage)(imageUrl);
    const r = await readAndLog({ db, userId, model, image, purpose: 'model_trial', snapItemId: null, deps });
    const catalog = await (deps.lookupCard || lookupCard)(r.read).catch(() => null);
    row = {
      ...base,
      extraction: r.read,
      catalog_source: catalog?.source ?? null, catalog_id: catalog?.id ?? null, catalog_name: catalog?.name ?? null,
      catalog_number: catalog?.number ?? null, market_price: catalog?.marketPrice ?? null,
      ...scoreTrial({ title: listing.title, read: r.read, catalog }),
      latency_ms: r.latencyMs, cost_usd: r.cost ?? costOf(model, r.usage) ?? 0,
      input_tokens: r.usage?.input_tokens ?? null, output_tokens: r.usage?.output_tokens ?? null,
      error: null,
    };
  } catch (err) {
    if (err.code === 'NO_API_KEY' || err.code === 'BUDGET') throw err;
    row = { ...base, error: String(err.message).slice(0, 300), cost_usd: err.usage ? costOf(model, err.usage) ?? 0 : 0 };
  }
  const { error } = await db.from('model_trial_results').upsert(row, { onConflict: 'user_id,trial_id,model,item_id' });
  if (error) throw new Error(error.message);
  return row;
}
