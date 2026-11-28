// netlify/lib/sales-run.js
// Who the 5-minute sale check visits: sellers with a connected Whatnot account (any plan), and
// sellers with a card live on two or more marketplaces (their eBay orders are read too). Oldest
// check first, so a run that stops early starts with the rest next time.
async function must(p) { const { data, error } = await p; if (error) throw new Error(error.message); return data; }

export async function sellersToCheck(db) {
  const accounts = await must(db.from('marketplace_accounts').select('user_id, status, sales_checked_at'));
  const live = await must(db.from('marketplace_listings').select('user_id, snap_item_id, marketplace').in('status', ['active', 'ending']));
  const perCard = new Map();
  for (const l of live) if (l.snap_item_id) perCard.set(`${l.user_id}|${l.snap_item_id}`, new Set([...(perCard.get(`${l.user_id}|${l.snap_item_id}`) || []), l.marketplace]));
  const cross = new Set([...perCard.entries()].filter(([, s]) => s.size > 1).map(([k]) => k.split('|')[0]));
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
