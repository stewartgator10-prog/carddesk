// Snap to List phase 3: the CardDesk MCP connector. Real MCP protocol over the real SDK transport,
// with the database and eBay faked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp } from '../netlify/functions/mcp.js';
import protectedResource from '../netlify/functions/oauth-protected-resource.js';
import { approveCards, repriceCards, updateCards, publishCards, checkCards, profitReport } from '../netlify/lib/mcp-tools.js';
import { fakeDb } from './fake-db.js';

const U = 'u1';
const card = (id, over = {}) => ({ id, user_id: U, status: 'ready', game: 'pokemon', card_name: 'Fuecoco', catalog_set: 'Paldea Evolved', catalog_number: '035/193', finish: 'reverse_holo', condition: 'NM', price: 0.99, market_price: 4.74, title: 'Fuecoco 035/193 Paldea Evolved Reverse Holo', review_reasons: [], created_at: `2026-11-2${id.slice(-1)}T00:00:00Z`, ...over });
const db0 = () => fakeDb({
  snap_items: [card('c1'), card('c2', { status: 'needs_review', review_reasons: ['possible_misprint'], misprint_flag: true, misprint_notes: 'texture shift' }), card('c3', { status: 'listed', ebay_url: 'https://www.ebay.com/itm/1' }), card('x9', { user_id: 'someone-else' })],
  settings: [{ user_id: U, data: { snapMinPrice: 0.99, snapEnding: '0.89' } }], api_usage: [], ebay_accounts: [{ user_id: U, listing_templates: {} }],
  ebay_order_lines: [], ebay_orders: [], ebay_transactions: [],
});
const ctx = (db, over = {}) => ({ db, userId: U, origin: 'https://site.test', settings: { snapMinPrice: 0.99, snapEnding: '0.89' }, getToken: async () => 'tok', deps: {}, ...over });

const rpc = (body, auth = 'Bearer good') => new Request('https://site.test/mcp', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(auth ? { Authorization: auth } : {}) },
  body: JSON.stringify(body),
});
const authenticate = async (req, origin) => (req.headers.get('authorization') === 'Bearer good'
  ? { user: { id: U } }
  : { response: new Response('{}', { status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"` } }) });

test('no sign-in: 401 that tells Claude where to sign in; metadata names Supabase as the authorization server', async () => {
  const res = await handleMcp(rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, null), { authenticate, db: db0() });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'Bearer resource_metadata="https://site.test/.well-known/oauth-protected-resource"');
  process.env.SUPABASE_URL = 'https://proj.supabase.co';
  const meta = await (await protectedResource(new Request('https://site.test/.well-known/oauth-protected-resource'))).json();
  assert.equal(meta.resource, 'https://site.test/mcp');
  assert.deepEqual(meta.authorization_servers, ['https://proj.supabase.co/auth/v1']);
  assert.equal((await handleMcp(new Request('https://site.test/mcp'), { authenticate })).status, 405);
});

test('MCP protocol: initialize, list tools with safety hints, call a tool', async () => {
  const db = db0();
  const init = await (await handleMcp(rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } }), { authenticate, db })).json();
  assert.equal(init.result.serverInfo.name, 'carddesk');
  assert.match(init.result.instructions, /clear yes before publish_cards/);

  const list = await (await handleMcp(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }), { authenticate, db })).json();
  const byName = Object.fromEntries(list.result.tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['ai_fee_report', 'approve_cards', 'change_listing_prices', 'check_cards', 'collection_summary', 'discard_cards', 'list_cards', 'list_collection',
    'list_listings', 'profit_report', 'publish_cards', 'queue_summary', 'reprice_cards', 'send_collection_to_listing', 'set_best_offer', 'update_cards', 'update_collection']);
  for (const live of ['set_best_offer', 'change_listing_prices']) {
    assert.equal(byName[live].annotations.openWorldHint, true);
    assert.ok(byName[live].inputSchema.required.includes('user_confirmed'));
  }
  assert.equal(byName.list_collection.annotations.readOnlyHint, true);
  assert.equal(byName.list_cards.annotations.readOnlyHint, true);
  assert.equal(byName.discard_cards.annotations.destructiveHint, true);
  assert.equal(byName.publish_cards.annotations.openWorldHint, true);
  assert.ok(byName.publish_cards.inputSchema.required.includes('user_confirmed'));

  const call = await (await handleMcp(rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_cards', arguments: {} } }), { authenticate, db })).json();
  const out = JSON.parse(call.result.content[0].text);
  assert.deepEqual(out.cards.map((c) => c.id).sort(), ['c1', 'c2']); // not listed, not another user's
  assert.equal(out.cards.find((c) => c.id === 'c2').possible_misprint, 'texture shift');

  const summary = JSON.parse((await (await handleMcp(rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'queue_summary', arguments: {} } }), { authenticate, db })).json()).result.content[0].text);
  assert.deepEqual(summary.cards_by_status, { ready: 1, needs_review: 1, listed: 1 });
  assert.equal(summary.snap_photos_url, 'https://site.test/?tab=snap');

  const refused = await (await handleMcp(rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'publish_cards', arguments: { ids: ['c1'], user_confirmed: false } } }), { authenticate, db })).json();
  assert.equal(refused.result.isError, true);
  assert.match(refused.result.content[0].text, /ask for a clear yes/);
});

test('approve: flagged cards need the user\'s OK; other users\' cards are invisible', async () => {
  const db = db0();
  const r = await approveCards(ctx(db), { ids: ['c1', 'c2', 'x9'] });
  assert.equal(r.approved, 1);
  assert.match(r.results.find((x) => x.id === 'c2').error, /Possible misprint: check.*acknowledge_flags=true/);
  assert.deepEqual(r.missing, ['x9']);
  assert.equal(db.tables.snap_items.find((x) => x.id === 'x9').status, 'ready');
  assert.equal((await approveCards(ctx(db), { ids: ['c2'], acknowledge_flags: true })).approved, 1);
});

test('reprice from market and edits: limits enforced, title rebuilt, stale eBay check cleared', async () => {
  const db = db0();
  db.tables.snap_items[0].publish_state = 'checked';
  db.tables.snap_items[0].publish_check = { ok: true };
  const r = await repriceCards(ctx(db), { ids: ['c1', 'c3'], markup_pct: 10 });
  assert.equal(r.results.find((x) => x.id === 'c1').new_price, 5.89);   // 4.74 * 1.10 = 5.21 -> .89 ending
  assert.match(r.results.find((x) => x.id === 'c3').error, /listed/);
  assert.equal(db.tables.snap_items[0].publish_state, null);              // price changed: check no longer valid

  const u = await updateCards(ctx(db), { updates: [{ id: 'c1', condition: 'LP' }, { id: 'c2', price: 0.5 }, { id: 'c1', cost: 1.25 }] });
  assert.match(u.results[0].card.title, /^Fuecoco 035\/193 \| Pokemon TCG Paldea Evolved \| /);
  assert.doesNotMatch(u.results[0].card.title, /\bLP\b/);                         // no condition grade in titles
  assert.match(u.results[1].error, /between \$0.99/);
  assert.equal(db.tables.snap_items[0].cost_basis, 1.25);
  await assert.rejects(repriceCards(ctx(db), { ids: ['c1'], markup_pct: 5000 }), /between -90 and 1000/);
});

test('check and publish go through the same guarded eBay functions, with per-call caps', async () => {
  const db = db0();
  await assert.rejects(checkCards(ctx(db), { ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }), /at most 6/);
  await assert.rejects(publishCards(ctx(db), { ids: ['c1'] }), /user_confirmed=true/);
  const seen = [];
  const deps = {
    checkSnapItem: async ({ item, token }) => { seen.push(['check', item.id, token]); return { ...item, publish_check: { ok: item.id === 'c1', errors: item.id === 'c1' ? [] : ['Game missing'] } }; },
    publishSnapItem: async ({ item }) => { seen.push(['publish', item.id]); if (item.id !== 'c1') throw new Error('Run the eBay check on this card first.'); return { itemId: '9', url: 'https://www.ebay.com/itm/9' }; },
  };
  const c = await checkCards(ctx(db, { deps }), { ids: ['c1', 'c2'] });
  assert.equal(c.passed, 1);
  assert.deepEqual(c.results.find((x) => x.id === 'c2').errors, ['Game missing']);
  const p = await publishCards(ctx(db, { deps }), { ids: ['c1', 'c2'], user_confirmed: true });
  assert.equal(p.published, 1);
  assert.equal(p.results.find((x) => x.id === 'c1').ebay_url, 'https://www.ebay.com/itm/9');
  assert.match(p.results.find((x) => x.id === 'c2').error, /check on this card first/);
  assert.deepEqual(seen[0], ['check', 'c1', 'tok']);
});

test('profit report counts only matched sales with a cost, and lists the rest', async () => {
  const now = new Date().toISOString();
  const db = fakeDb({
    ebay_order_lines: [
      { user_id: U, line_item_id: 'A', order_id: 'O1', title: 'Lugia V', sold_at: now, gross: 40, fees: 5, net_payout: 35, cost_basis: 12, profit: 23, match_status: 'confirmed' },
      { user_id: U, line_item_id: 'B', order_id: 'O2', title: 'Pikachu', sold_at: now, gross: 4, fees: 0.8, net_payout: 3.2, cost_basis: null, profit: null, match_status: 'unmatched' },
    ],
    ebay_orders: [{ user_id: U, order_id: 'O1' }, { user_id: U, order_id: 'O2' }],
    ebay_transactions: [{ user_id: U, transaction_type: 'NON_SALE_CHARGE', amount: -3, order_id: null, transaction_date: now }],
  });
  const r = await profitReport(ctx(db), { days: 30 });
  assert.equal(r.gross_sales, 44);
  assert.equal(r.profit_on_sales, 23);
  assert.equal(r.store_costs, -3);
  assert.equal(r.profit_after_store_costs, 20);
  assert.equal(r.sales_missing_cost, 1);
  assert.equal(r.best_sales[0].title, 'Lugia V');
});

test('access keys: shown once, stored only as a hash, accepted by the connector, revocable, and tied to the allowed list', async () => {
  const { createKey, listKeys, revokeKey, userFromKey } = await import('../netlify/lib/access-keys.js');
  const db = fakeDb({ access_keys: [] });
  const k = await createKey({ db, user: { id: U, email: 'jackson@example.com' }, name: 'Muse' });
  assert.match(k.key, /^cdk_[A-Za-z0-9_-]{32}$/);
  const row = db.tables.access_keys[0];
  assert.equal(row.key_hash.length, 64);
  assert.ok(!JSON.stringify(row).includes(k.key));                              // the key itself is never stored
  assert.deepEqual((await listKeys({ db, userId: U })).map((x) => [x.name, x.prefix]), [['Muse', k.key.slice(0, 10)]]);
  assert.equal((await listKeys({ db, userId: U }))[0].key, undefined);
  const who = await userFromKey({ db, key: k.key, allowedEmails: '' });
  assert.deepEqual([who.id, who.via], [U, 'access_key']);
  assert.ok(db.tables.access_keys[0].last_used_at);
  assert.equal(await userFromKey({ db, key: k.key, allowedEmails: 'someone@else.com' }), null);   // owner no longer allowed
  assert.equal(await userFromKey({ db, key: 'cdk_wrongwrongwrongwrongwrongwrongwrong', allowedEmails: '' }), null);
  await revokeKey({ db, userId: U, id: k.id });
  assert.equal(await userFromKey({ db, key: k.key, allowedEmails: '' }), null);
  await assert.rejects(revokeKey({ db, userId: 'other', id: k.id }), /not found/);
});

test('connector tools: collection, Best Offer and prices; live eBay changes need the user\'s yes', async () => {
  const tools = await import('../netlify/lib/mcp-tools.js');
  const db = fakeDb({
    settings: [{ user_id: U, data: { collectionAlertPct: 25 } }], snap_items: [], collection_prices: [], price_changes: [], listing_market: [{ user_id: U, item_id: '1', market_price: 2.5, comp_low: 2.1 }],
    collection_items: [
      { id: 'c1', user_id: U, status: 'held', alert_state: 'none', card_name: 'Charizard ex', game: 'pokemon', market_price: 120, value_at_add: 100, quantity: 1, flags: [], condition: 'NM' },
      { id: 'c2', user_id: U, status: 'held', alert_state: 'active', alert_reason: 'Up 40%', card_name: 'Pidgeot ex', game: 'pokemon', market_price: 14, value_at_add: 10, cost: 9, quantity: 2, flags: [], condition: 'NM' },
    ],
    ebay_listings: [
      { user_id: U, item_id: '1', title: 'Fuecoco 035/193 | Pokemon', price: 1.89, status: 'Active', listing_type: 'FixedPriceItem', best_offer: true },
      { user_id: U, item_id: '2', title: 'Auction card', price: 5, status: 'Active', listing_type: 'Chinese' },
    ],
  });
  const ctx = { db, userId: U, settings: { snapBestOfferPct: 10 }, getToken: async () => 'tok', deps: {} };

  const sum = await tools.collectionSummary(ctx);
  assert.deepEqual([sum.cards_held, sum.value, sum.paid, sum.ready_to_review.map((r) => r.name)], [3, 148, 18, ['Pidgeot ex']]);
  assert.equal((await tools.listCollection(ctx, { filter: 'alerts' })).items[0].change_pct, 55.56);   // from cost 9 to 14
  const up = await tools.updateCollection(ctx, { updates: [{ id: 'c1', target_price: 110 }, { id: 'c2', dismiss_alert: true }, { id: 'nope', cost: 1 }] });
  assert.deepEqual([up.updated, up.ready_to_review_now], [2, 1]);                                   // Charizard now over its target; Pidgeot dismissed
  await assert.rejects(tools.updateCollection(ctx, { updates: [{ id: 'c1', quantity: 0 }] }).then((r) => { if (!r.results[0].ok) throw new Error(r.results[0].error); }), /quantity/);

  const listed = await tools.listListings(ctx, {});
  assert.deepEqual(listed.listings.map((l) => [l.item_id, l.best_offer, l.tcgplayer_market]), [['2', 'unknown', null], ['1', true, 2.5]]);

  await assert.rejects(tools.setListingsBestOffer(ctx, { item_ids: ['1'], enabled: false }), /get a clear yes/);
  const sent = [];
  const bo = await tools.setListingsBestOffer({ ...ctx, deps: { setBestOffer: async (_t, x) => { sent.push(x); return { accept: null }; } } }, { item_ids: ['1', '2', 'x'], enabled: false, user_confirmed: true });
  assert.deepEqual(bo.results.map((r) => [r.item_id, r.ok]), [['1', true], ['2', false], ['x', false]]);
  assert.deepEqual(sent, [{ itemId: '1', enabled: false, price: 1.89, pct: 10 }]);
  assert.equal(db.tables.ebay_listings[0].best_offer, false);

  await assert.rejects(tools.changeListingPrices(ctx, { changes: [{ item_id: '1', new_price: 1.79 }] }), /get a clear yes/);
  await assert.rejects(tools.changeListingPrices(ctx, { changes: [{ item_id: '1', new_price: 0.5 }], user_confirmed: true }), /between \$0\.99/);
  await assert.rejects(tools.changeListingPrices(ctx, { changes: [{ item_id: '1', new_price: 5 }], user_confirmed: true }), /50% or more.*confirm_large_changes=true/);
  const pr = await tools.changeListingPrices({ ...ctx, deps: { revisePrices: async (_t, list) => list.map((c) => ({ itemId: c.itemId, ok: true, price: c.newPrice, error: null, warnings: [] })) } },
    { changes: [{ item_id: '1', new_price: 1.79 }], user_confirmed: true });
  assert.deepEqual([pr.changed, db.tables.ebay_listings[0].price, db.tables.price_changes[0].new_price], [1, 1.79, 1.79]);
});

test('the connector accepts an access key in Authorization or X-API-Key, and refuses a revoked one', async () => {
  const { createKey, revokeKey } = await import('../netlify/lib/access-keys.js');
  const db = fakeDb({ access_keys: [], snap_items: [], settings: [], api_usage: [], ebay_accounts: [], collection_items: [] });
  const k = await createKey({ db, user: { id: U, email: 'jackson@example.com' }, name: 'Muse' });
  const call = (headers) => handleMcp(new Request('https://site.test/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'collection_summary', arguments: {} } }) }), { db });
  const viaBearer = await (await call({ authorization: `Bearer ${k.key}` })).json();
  assert.match(viaBearer.result.content[0].text, /"cards_held": 0/);
  const viaHeader = await call({ 'x-api-key': k.key });
  assert.equal(viaHeader.status, 200);
  await revokeKey({ db, userId: U, id: k.id });
  const refused = await call({ authorization: `Bearer ${k.key}` });
  assert.equal(refused.status, 401);
  assert.match((await refused.json()).error, /not valid or was revoked/);
});

test('opening the connector address in a browser shows an explanation; an event-stream GET still gets 405', async () => {
  const page = await handleMcp(new Request('https://site.test/mcp', { headers: { accept: 'text/html,application/xhtml+xml' } }));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /CardDesk AI connector/);
  assert.match(html, /https:\/\/site\.test\/mcp/);
  assert.equal((await handleMcp(new Request('https://site.test/mcp', { headers: { accept: 'text/event-stream' } }))).status, 405);
});
