// netlify/lib/sales-run.js
// Who the 5-minute sale check visits: sellers with a connected Whatnot account (any plan), and
// sellers with a card live on two or more marketplaces (their eBay orders are read too). Oldest
// check first, so a run that stops early starts with the rest next time.
import { allRows, chunks } from './db-pages.js';

const LIVE = ['active', 'ending'];
async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }

// Cards live on two or more marketplaces. Starts from the few non-eBay listings, then reads only
// the eBay rows of those cards, every query paged past Supabase's 1,000-row cap.
export async function crossListedCards(db, userId = null) {
  const scope = (q) => (userId ? q.eq('user_id', userId) : q);
  const others = await allRows(() => scope(db.from('marketplace_listings').select('id, user_id, snap_item_id, marketplace').in('status', LIVE).neq('marketplace', 'ebay')).order('id'));
  const ids = [...new Set(others.filter((l) => l.snap_item_id).map((l) => l.snap_item_id))];
  const ebay = [];
  for (const part of chunks(ids)) {
    ebay.push(...await allRows(() => scope(db.from('marketplace_listings').select('id, user_id, snap_item_id, marketplace').in('status', LIVE).eq('marketplace', 'ebay').in('snap_item_id', part)).order('id')));
  }
  const perCard = new Map();
  for (const l of [...others, ...ebay]) {
    if (!l.snap_item_id) continue;
    const k = `${l.user_id}|${l.snap_item_id}`;
    perCard.set(k, new Set([...(perCard.get(k) || []), l.marketplace]));
  }
  return [...perCard.entries()].filter(([, s]) => s.size > 1).map(([k]) => { const [u, c] = k.split('|'); return { userId: u, snapItemId: c }; });
}

export async function sellersToCheck(db) {
  const accounts = await allRows(() => db.from('marketplace_accounts').select('user_id, status, sales_checked_at').order('user_id'));
  const cross = new Set((await crossListedCards(db)).map((c) => c.userId));
  const by = new Map();
  for (const a of accounts) {
    if (a.status !== 'connected') continue;   // waiting for a new token: nothing to read
    const cur = by.get(a.user_id);
    const at = a.sales_checked_at || '';
    by.set(a.user_id, { userId: a.user_id, checkedAt: cur ? (cur.checkedAt < at ? cur.checkedAt : at) : at, crossListed: cross.has(a.user_id) });
  }
  for (const u of cross) if (!by.has(u)) by.set(u, { userId: u, checkedAt: '', crossListed: true });
  return [...by.values()].sort((a, b) => String(a.checkedAt).localeCompare(String(b.checkedAt)));
}
