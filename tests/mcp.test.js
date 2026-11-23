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
  assert.deepEqual(Object.keys(byName).sort(), ['ai_fee_report', 'approve_cards', 'check_cards', 'discard_cards', 'list_cards', 'profit_report', 'publish_cards', 'queue_summary', 'reprice_cards', 'update_cards']);
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
  assert.equal(u.results[0].card.title, 'Fuecoco 035/193 Paldea Evolved Reverse Holo LP');
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
