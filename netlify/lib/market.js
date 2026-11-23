// netlify/lib/market.js
// Automatic comps for the seller's active listings:
//   1. read each title once with AI (cached; renamed listings are read again)
//   2. TCGplayer market price from the catalog (English Pokémon / Magic)
//   3. live eBay competition: cheapest comparable Buy It Now listings from other sellers
// Refreshed nightly and on demand; each run stops at a time limit and the next run continues.
import { lookupCard, splitNumber, normName } from './card-catalog.js';
import { CATALOG_GAMES } from './snap-logic.js';
import { browseSearch } from './ebay-browse.js';
import { parseTitles, TITLE_MODEL, TITLES_PER_CALL } from './title-parse.js';
import { usageRow, logUsage, checkBudget } from './ai-usage.js';

export const STALE_MS = 20 * 3600 * 1000;
const round2 = (n) => Math.round(n * 100) / 100;
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const STOP = new Set(['the', 'of', 'a', 'and', 'ex', 'v', 'gx', 'vmax', 'vstar', 'tcg', 'card', 'pokemon']);
async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }

// ---------- pure: what to search, what counts as the same card ----------
export function compQuery(p) {
  const parts = [p.card_name, p.collector_number];
  if (p.language && !/^english$/i.test(p.language)) parts.push(p.language);
  if (p.graded && p.grader) parts.push(`${p.grader} ${p.grade || ''}`.trim());
  return parts.filter(Boolean).join(' ').replace(/[,"]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function numberRegex(collectorNumber) {
  const n = splitNumber(collectorNumber);
  if (!n) return null;
  const raw = n.localRaw;
  if (/-/.test(raw)) return new RegExp(`(^|[^a-z0-9])${escRe(raw)}(?![0-9])`, 'i');           // OP07-118
  const m = raw.match(/^([A-Za-z]*)0*(\d+)([A-Za-z]*)$/);
  if (!m) return new RegExp(`(^|[^a-z0-9])${escRe(raw)}(?![0-9a-z])`, 'i');
  return new RegExp(`(^|[^a-z0-9])${escRe(m[1])}0*${m[2]}${escRe(m[3])}(?![0-9])`, 'i');   // 035/193, #35, TG05
}

const NON_ENGLISH = /japanese|\bjpn?\b|chinese|\bchn\b|korean|\bkor\b|simplified|traditional/i;
const GRADED = /\b(psa|bgs|cgc|sgc|tag|ace)\s*-?\s*\d/i;
const LOT = /\blot\b|\bbundle\b|\bplayset\b|\b\d+\s*x\b|\bx\s*\d+\b|\bset of\b/i;

export function filterCompetitors(items, parsed, ownSeller = null) {
  const name = normName(parsed.card_name).split(' ').filter((t) => t.length > 1 && !STOP.has(t));
  const numRe = numberRegex(parsed.collector_number);
  const lang = (parsed.language || 'English').toLowerCase();
  const out = [];
  for (const it of items) {
    const title = String(it.title || '');
    const norm = normName(title);
    if (ownSeller && String(it.seller?.username || '').toLowerCase() === String(ownSeller).toLowerCase()) continue;
    if (!(it.buyingOptions || []).includes('FIXED_PRICE')) continue;
    if (!name.every((t) => norm.split(' ').includes(t))) continue;
    if (numRe && !numRe.test(title)) continue;
    if (lang === 'english' ? NON_ENGLISH.test(title) : !new RegExp(lang === 'japanese' ? 'japanese|\\bjpn?\\b' : escRe(lang), 'i').test(title)) continue;
    if (parsed.graded) {
      if (!(parsed.grader && new RegExp(`\\b${escRe(parsed.grader)}\\s*-?\\s*${escRe(parsed.grade || '')}`, 'i').test(title))) continue;
    } else if (GRADED.test(title)) continue;
    if (parsed.game === 'pokemon') {
      if (parsed.finish === 'reverse_holo' ? !/reverse/i.test(title) : /reverse/i.test(title)) continue;
    }
    if (LOT.test(title)) continue;
    const price = Number(it.price?.value);
    if (!Number.isFinite(price) || price <= 0) continue;
    const ship = it.shippingOptions?.[0]?.shippingCost?.value;
    const shipping = ship != null && Number.isFinite(Number(ship)) ? Number(ship) : null;
    out.push({ title, price, shipping, total: round2(price + (shipping || 0)), url: it.itemWebUrl || null, seller: it.seller?.username || null, condition: it.condition || null });
  }
  return out.sort((a, b) => a.total - b.total);
}

export function summarizeComps(list) {
  if (!list.length) return { comp_low: null, comp_median: null, comp_count: 0, comp_items: [] };
  const totals = list.map((x) => x.total);
  const mid = Math.floor(totals.length / 2);
  return {
    comp_low: totals[0],
    comp_median: round2(totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2),
    comp_count: list.length,
    comp_items: list.slice(0, 5),
  };
}

// Middle price (with shipping) of other sellers' Buy It Now listings for the same raw card.
// Used when no catalog has a price: other games, other languages, printings the catalog is missing.
export async function ebayMedianFor(read, { ownSeller = null, deps = {} } = {}) {
  if (!read?.card_name) return null;
  const raw = { ...read, graded: false, grader: null, grade: null };
  const res = await (deps.browseSearch || browseSearch)({ q: compQuery(raw), limit: 50, fixedPriceOnly: true });
  return summarizeComps(filterCompetitors(res.items, raw, ownSeller)).comp_median ?? null;
}

const isStale = (row, listing, now) => !row || row.title_snapshot !== listing.title || !row.parsed
  || !row.comp_at || now - Date.parse(row.comp_at) > STALE_MS;

// ---------- refresh ----------
export async function refreshMarket({ db, userId, itemIds = null, force = false, maxListings = 15, deadlineMs = 25_000, deps = {} }) {
  const started = Date.now();
  const now = Date.now();
  let q = db.from('ebay_listings').select('item_id, title, price').eq('user_id', userId).eq('status', 'Active');
  if (itemIds?.length) q = q.in('item_id', itemIds.map(String));
  const listings = await must(q);
  const rows = await must(db.from('listing_market').select('*').eq('user_id', userId));
  const byId = new Map(rows.map((r) => [r.item_id, r]));
  // Oldest attempt first, so a listing that keeps failing moves to the back instead of blocking the rest.
  const due = listings.filter((l) => force || isStale(byId.get(l.item_id), l, now))
    .sort((a, b) => String(byId.get(a.item_id)?.updated_at || '').localeCompare(String(byId.get(b.item_id)?.updated_at || '')));
  const batch = due.slice(0, maxListings);
  const acct = await must(db.from('ebay_accounts').select('ebay_username').eq('user_id', userId).maybeSingle());
  const settingsRow = await must(db.from('settings').select('data').eq('user_id', userId).maybeSingle());

  // 1. Read titles that are new or renamed, 25 per AI call.
  const needRead = batch.filter((l) => { const r = byId.get(l.item_id); return !r?.parsed || r.title_snapshot !== l.title; });
  const reads = new Map();
  let aiCost = 0;
  let budgetNote = null;
  for (let i = 0; i < needRead.length; i += TITLES_PER_CALL) {
    const chunk = needRead.slice(i, i + TITLES_PER_CALL);
    const budget = await checkBudget(db, userId, settingsRow?.data || {});
    if (!budget.ok) { budgetNote = `Monthly AI budget reached ($${budget.spent.toFixed(2)} of $${budget.budget.toFixed(2)}); new titles weren't read.`; break; }
    try {
      const r = await (deps.parseTitles || parseTitles)({ titles: chunk.map((l, k) => ({ i: k, title: l.title })), model: TITLE_MODEL });
      const row = usageRow({ userId, model: TITLE_MODEL, purpose: 'title_parse', usage: r.usage, latencyMs: r.latencyMs, requestId: r.requestId });
      await logUsage(db, row);
      aiCost += row.cost_usd;
      chunk.forEach((l, k) => { if (r.reads.has(k)) reads.set(l.item_id, r.reads.get(k)); });
    } catch (err) {
      if (err.usage) await logUsage(db, usageRow({ userId, model: TITLE_MODEL, purpose: 'title_parse', usage: err.usage, ok: false, error: err.message }));
      if (err.code === 'NO_API_KEY') { budgetNote = err.message; break; }
      console.error('title parse', err.message);
    }
  }

  // 2 + 3. Catalog market price and eBay competition, until the time limit.
  let processed = 0;
  const errors = [];
  for (const l of batch) {
    if (Date.now() - started > deadlineMs) break;
    const prev = byId.get(l.item_id);
    const fresh = reads.get(l.item_id);
    const parsed = fresh || (prev?.title_snapshot === l.title ? prev?.parsed : null);
    const row = { user_id: userId, item_id: String(l.item_id), updated_at: new Date().toISOString(), error: null };
    if (fresh) Object.assign(row, { title_snapshot: l.title, parsed: fresh, parsed_at: new Date().toISOString(), parse_model: TITLE_MODEL });
    if (!parsed) {
      row.error = budgetNote || 'Title not read yet';
      await must(db.from('listing_market').upsert({ title_snapshot: prev?.title_snapshot ?? null, ...row }, { onConflict: 'user_id,item_id' }));
      processed++; continue;
    }
    if (!parsed.is_single_card) {
      Object.assign(row, { comp_at: new Date().toISOString(), comp_count: 0, comp_items: [], comp_low: null, comp_median: null, error: 'Not a single card' });
    } else {
      try {
        if (CATALOG_GAMES.includes(parsed.game) && /^english$/i.test(parsed.language || 'English')) {
          const cat = await (deps.lookupCard || lookupCard)(parsed);
          Object.assign(row, {
            catalog_source: cat?.source ?? null, catalog_id: cat?.id ?? null, catalog_name: cat?.name ?? null, catalog_set: cat?.setName ?? null,
            catalog_number: cat?.number ?? null, match_level: cat?.matchLevel ?? 'none',
            // A name-only match may be a different printing, so its price isn't used.
            market_price: cat && cat.matchLevel !== 'name' ? cat.marketPrice ?? null : null, market_price_key: cat?.priceKey ?? null, market_at: new Date().toISOString(),
          });
        }
        const query = compQuery(parsed);
        const res = await (deps.browseSearch || browseSearch)({ q: query, limit: 50, fixedPriceOnly: true });
        Object.assign(row, { comp_query: query, comp_at: new Date().toISOString(), ...summarizeComps(filterCompetitors(res.items, parsed, acct?.ebay_username)) });
      } catch (err) {
        row.error = String(err.message).slice(0, 200);
        errors.push(`${l.item_id}: ${row.error}`);
      }
    }
    await must(db.from('listing_market').upsert(row, { onConflict: 'user_id,item_id' }));
    processed++;
  }
  return { processed, remaining: Math.max(0, due.length - processed), titles_read: reads.size, ai_cost_usd: round2(aiCost * 10000) / 10000, errors: errors.slice(0, 5), note: budgetNote };
}
