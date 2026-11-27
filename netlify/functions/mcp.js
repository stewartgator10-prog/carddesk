// netlify/functions/mcp.js
// CardDesk as a remote MCP server (custom connector for the Claude app):  https://<site>/mcp
// Sign-in: Supabase Auth's OAuth 2.1 server. A request without a valid CardDesk token gets a 401
// pointing at /.well-known/oauth-protected-resource, which names Supabase as the authorization
// server; Claude then runs the "Sign in with CardDesk" flow (consent page: /oauth/consent).
// AI apps that can't run that flow (Muse, Grok...) can use a personal access key instead, created in
// Snap to List → Settings and sent as "Authorization: Bearer cdk_..." or an "X-API-Key" header.
// Stateless: a fresh server + transport per request, JSON responses only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, getSellerAccessToken } from '../lib/ebay-seller.js';
import { loadSnapSettings } from '../lib/snap-identify.js';
import * as tools from '../lib/mcp-tools.js';
import { userFromKey, looksLikeKey } from '../lib/access-keys.js';

const metadataUrl = (origin) => `${origin}/.well-known/oauth-protected-resource`;
const unauthorized = (origin, message = 'Sign in to CardDesk to use this connector.') => new Response(JSON.stringify({ error: message }), {
  status: 401,
  headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl(origin)}"` },
});

async function defaultAuthenticate(req, origin, db = null) {
  const bearer = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  const key = looksLikeKey(bearer) ? bearer : (req.headers.get('x-api-key') || '').trim();
  if (looksLikeKey(key)) {
    const user = await userFromKey({ db: db || getSupabaseAdmin(), key });
    return user ? { user } : { response: unauthorized(origin, 'That CardDesk access key is not valid or was revoked. Create a new one in Snap to List → Settings.') };
  }
  if (!/^Bearer\s+\S+/i.test(req.headers.get('authorization') || '')) return { response: unauthorized(origin) };
  const auth = await requireUser(req);
  if (auth instanceof Response) return { response: auth.status === 401 ? unauthorized(origin, 'Your CardDesk sign-in expired. Reconnect the connector.') : auth };
  return { user: auth.user };
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function buildServer(ctx) {
  const server = new McpServer({ name: 'carddesk', version: '1.0.0' }, {
    instructions: 'CardDesk is a trading card seller\'s workspace. Cards are photographed in the CardDesk Snap tab on a phone, identified by AI, then reviewed, approved, checked with eBay and published. Prices are USD. Always show the user what you are about to change on eBay and get a clear yes before publish_cards. The seller also keeps a personal collection (collection_summary, list_collection, update_collection): cards held, valued nightly, with alerts when a card is ready to review for listing; send_collection_to_listing moves them into the Snap queue. Live eBay listings: list_listings, set_best_offer and change_listing_prices change real listings and need the user\'s explicit yes (user_confirmed=true), like publish_cards. Photos: edit_card_photos straightens and crops a card\'s photos so the card fills them, reorders or removes them, and (with the user\'s yes) sends them to a card already live on eBay.',
  });
  const run = (name, fn) => async (args) => {
    console.info('mcp tool', name, ctx.userId);
    try {
      const out = await fn(ctx, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] };
    } catch (err) {
      console.error('mcp tool failed', name, err.message);
      return { content: [{ type: 'text', text: err.toolError ? err.message : `CardDesk error: ${err.message}` }], isError: true };
    }
  };
  const ids = z.array(z.string()).min(1).max(100).describe('Card ids from list_cards');

  server.registerTool('queue_summary', {
    title: 'Snap queue summary',
    description: 'Counts of snapped cards by status, how many approved cards are checked and ready to publish, this month\'s AI spend vs budget, and whether eBay is connected. Start here.',
    inputSchema: {}, annotations: READ,
  }, run('queue_summary', (c) => tools.queueSummary(c)));

  server.registerTool('list_cards', {
    title: 'List snapped cards',
    description: 'Cards in the Snap to List queue with identification, price, market price, cost, review flags, possible misprints and eBay check results. status: "open" (default: everything not yet listed or discarded), or one of uploaded, identifying, ready, needs_review, failed, approved, listed, discarded.',
    inputSchema: {
      status: z.enum(['open', 'uploaded', 'identifying', 'ready', 'needs_review', 'failed', 'approved', 'listed', 'discarded']).optional(),
      limit: z.number().int().min(1).max(100).optional().describe('Default 25'),
      flagged_only: z.boolean().optional().describe('Only cards with review flags or a possible misprint'),
    }, annotations: READ,
  }, run('list_cards', (c, a) => tools.listCards(c, a)));

  server.registerTool('update_cards', {
    title: 'Edit cards',
    description: 'Fix card details before listing: price (USD, 0.99 to 100000), title (max 80 chars), card_name, set, number, finish, condition (NM/LP/MP/HP/DMG), cost (what the seller paid, null to clear), misprint_confirmed (only when the seller says it is a real misprint). Changing name/set/number/finish/condition rebuilds the title unless a title is given. Editing a checked card clears its eBay check. Does not touch eBay.',
    inputSchema: {
      updates: z.array(z.object({
        id: z.string(),
        price: z.number().optional(), title: z.string().optional(), card_name: z.string().optional(), set: z.string().optional(), number: z.string().optional(),
        finish: z.enum(['normal', 'holo', 'reverse_holo', 'foil', 'unknown']).optional(), condition: z.enum(['NM', 'LP', 'MP', 'HP', 'DMG']).optional(),
        cost: z.number().nullable().optional(), misprint_confirmed: z.boolean().optional(), rebuild_title: z.boolean().optional(),
      })).min(1).max(100),
    }, annotations: EDIT,
  }, run('update_cards', (c, a) => tools.updateCards(c, a)));

  server.registerTool('reprice_cards', {
    title: 'Price cards from market',
    description: 'Set each card\'s price to its TCGplayer market price plus markup_pct (e.g. 10 for +10%, -5 for -5%), then the seller\'s minimum price and usual price ending. Cards without a market price are skipped. Does not touch eBay.',
    inputSchema: { ids, markup_pct: z.number().describe('Percent over (or under, if negative) market price') }, annotations: EDIT,
  }, run('reprice_cards', (c, a) => tools.repriceCards(c, a)));

  server.registerTool('approve_cards', {
    title: 'Approve cards',
    description: 'Approve cards for listing (needs a title and a price). Cards with review flags (AI unsure, possible misprint, not in catalog, looks already listed...) are refused unless acknowledge_flags=true, which you may only send after showing the user the flags and getting their OK.',
    inputSchema: { ids, acknowledge_flags: z.boolean().optional() }, annotations: EDIT,
  }, run('approve_cards', (c, a) => tools.approveCards(c, a)));

  server.registerTool('discard_cards', {
    title: 'Discard cards',
    description: 'Remove cards from the queue (not listed cards). Use only when the user asks.',
    inputSchema: { ids }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, run('discard_cards', (c, a) => tools.discardCards(c, a)));

  server.registerTool('check_cards', {
    title: 'Check cards with eBay',
    description: `Run eBay's free listing check on approved cards: uploads their photos and asks eBay whether the listing would be accepted, with fees. Nothing is listed. At most ${tools.MAX_CHECK_PER_CALL} cards per call.`,
    inputSchema: { ids: z.array(z.string()).min(1).max(tools.MAX_CHECK_PER_CALL) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, run('check_cards', (c, a) => tools.checkCards(c, a)));

  server.registerTool('publish_cards', {
    title: 'Publish cards to eBay',
    description: `Create LIVE eBay listings (Buy It Now, Good 'Til Cancelled) for approved cards that passed check_cards. Before calling: list each card's title and price for the user and get an explicit yes; then pass user_confirmed=true. At most ${tools.MAX_PUBLISH_PER_CALL} cards per call. A card edited after its check is refused until checked again.`,
    inputSchema: { ids: z.array(z.string()).min(1).max(tools.MAX_PUBLISH_PER_CALL), user_confirmed: z.boolean().describe('true only after the user explicitly approved these exact listings') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, run('publish_cards', (c, a) => tools.publishCards(c, a)));

  server.registerTool('profit_report', {
    title: 'Sales and profit report',
    description: 'eBay sales over the last N days (default 30): gross, eBay fees, shipping labels, ads, refunds, net payout, card cost, profit, store costs, plus best and worst sales. Sales without a recorded cost are counted separately. Read-only.',
    inputSchema: { days: z.number().int().min(1).max(3650).optional() }, annotations: READ,
  }, run('profit_report', (c, a) => tools.profitReport(c, a)));

  server.registerTool('collection_summary', {
    title: 'Collection summary',
    description: 'The seller\'s personal collection (cards held, not for sale): total value, value when added, what was paid, the default alert %, and every card that is ready to review for listing because it hit its target price or growth %. Read-only.',
    inputSchema: {}, annotations: READ,
  }, run('collection_summary', (c) => tools.collectionSummary(c)));

  server.registerTool('list_collection', {
    title: 'List collection cards',
    description: 'Collection cards with value per card, source, value when added, cost, change %, targets and any alert. filter: "held" (default), "alerts" (ready to review), "listing" (sent to Snap to List), "all". Sorted by total value. Read-only.',
    inputSchema: {
      filter: z.enum(['held', 'alerts', 'listing', 'all']).optional(), search: z.string().optional().describe('Matches name, set or number'),
      limit: z.number().int().min(1).max(200).optional().describe('Default 50'),
    }, annotations: READ,
  }, run('list_collection', (c, a) => tools.listCollection(c, a)));

  server.registerTool('update_collection', {
    title: 'Edit collection cards',
    description: 'Per card: cost (what was paid, each; null clears), target_price (alert at or above, each; null clears), target_pct (growth % alert; null uses the default), quantity, dismiss_alert. Alerts are re-checked afterwards. Nothing on eBay changes.',
    inputSchema: {
      updates: z.array(z.object({
        id: z.string(), cost: z.number().nullable().optional(), target_price: z.number().nullable().optional(),
        target_pct: z.number().nullable().optional(), quantity: z.number().int().optional(), dismiss_alert: z.boolean().optional(),
      })).min(1).max(100),
    }, annotations: EDIT,
  }, run('update_collection', (c, a) => tools.updateCollection(c, a)));

  server.registerTool('send_collection_to_listing', {
    title: 'Send collection cards to Snap to List',
    description: 'Moves collection cards into the Snap to List queue, identified and priced, with their cost, so they can be approved, checked and published. Nothing is listed on eBay by this. Use when the user wants to sell them (often cards that are ready to review). At most 25 per call.',
    inputSchema: { ids: z.array(z.string()).min(1).max(25) }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, run('send_collection_to_listing', (c, a) => tools.sendCollectionToListing(c, a)));

  server.registerTool('list_listings', {
    title: 'List live eBay listings',
    description: 'The seller\'s active eBay listings: item_id, title, price, Buy It Now or auction, Best Offer on/off/unknown, TCGplayer market price and the cheapest competing eBay listing when known. Read-only.',
    inputSchema: { search: z.string().optional().describe('Matches the title'), limit: z.number().int().min(1).max(200).optional().describe('Default 50') }, annotations: READ,
  }, run('list_listings', (c, a) => tools.listListings(c, a)));

  server.registerTool('set_best_offer', {
    title: 'Turn Best Offer on or off',
    description: 'Changes LIVE eBay listings. enabled=false removes Best Offer (and its auto-accept/decline amounts) so any price can be set; enabled=true turns it on, auto-accepting offers at 90% of the price and up (the seller\'s setting) and declining lower ones. Before calling: tell the user which listings change and get an explicit yes; then pass user_confirmed=true. At most 25 per call.',
    inputSchema: { item_ids: z.array(z.string()).min(1).max(25), enabled: z.boolean(), user_confirmed: z.boolean().describe('true only after the user explicitly approved this change') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, run('set_best_offer', (c, a) => tools.setListingsBestOffer(c, a)));

  server.registerTool('change_listing_prices', {
    title: 'Change prices on live eBay listings',
    description: 'Changes LIVE eBay prices (0.99 to 100000 USD). Before calling: show the user each listing with its old and new price and get an explicit yes; then pass user_confirmed=true. A change of 50% or more is refused unless the user confirmed those specifically (confirm_large_changes=true). If eBay refuses a price because of Best Offer, turn Best Offer off first (set_best_offer). At most 25 per call.',
    inputSchema: {
      changes: z.array(z.object({ item_id: z.string(), new_price: z.number() })).min(1).max(25),
      user_confirmed: z.boolean().describe('true only after the user explicitly approved these prices'),
      confirm_large_changes: z.boolean().optional(),
    }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, run('change_listing_prices', (c, a) => tools.changeListingPrices(c, a)));

  server.registerTool('edit_card_photos', {
    title: 'Edit a card\'s listing photos',
    description: 'A snapped card\'s eBay photos (photo_number is 1-based, 1 = main photo). auto_fix: the AI straightens and crops the photo (or every unedited photo when photo_number is left out) so the card fills it with white outside its corners, about a cent each; the card itself is never retouched and the original is kept. undo: put photo_number\'s original back. set_order: order = photo numbers in the new order, main first; photos left out are removed. update_ebay: for a card already live on eBay, replace the listing\'s photos with the current ones; changes the LIVE listing, so tell the user and get an explicit yes first, then pass user_confirmed=true.',
    inputSchema: {
      id: z.string().describe('Card id from list_cards'),
      action: z.enum(['auto_fix', 'undo', 'set_order', 'update_ebay']),
      photo_number: z.number().int().min(1).max(12).optional(),
      order: z.array(z.number().int().min(1).max(12)).max(12).optional(),
      user_confirmed: z.boolean().optional().describe('update_ebay only: true after the user explicitly approved'),
    }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, run('edit_card_photos', (c, a) => tools.editPhotos(c, a)));

  server.registerTool('ai_fee_report', {
    title: 'AI fee report',
    description: 'This month\'s estimated Claude API spend for card identification, by model and by use. Read-only.',
    inputSchema: {}, annotations: READ,
  }, run('ai_fee_report', (c) => tools.feeReport(c)));

  return server;
}

const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export function infoPage(origin) {
  const url = esc(`${origin}/mcp`);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CardDesk connector</title>
<style>body{font-family:system-ui,sans-serif;background:#f1f5e2;color:#23372c;margin:0;padding:24px;line-height:1.5}main{max-width:560px;margin:0 auto;background:#fffdf5;border:2px solid #c9d0d6;border-radius:16px;padding:22px}code{background:#ecead6;padding:2px 6px;border-radius:6px;word-break:break-all}h1{margin:0 0 8px;font-size:1.4rem}li{margin-bottom:6px}</style></head>
<body><main><h1>CardDesk AI connector</h1>
<p>This address is for AI apps (Claude, Muse, Grok), not for a browser. Seeing this page means it's working.</p>
<p>Connector address: <code>${url}</code></p>
<ol><li>In CardDesk, open <b>Snap to List → Settings → AI app connector</b> and create an access key.</li>
<li>In your AI app, add a custom connector (MCP server) with this address.</li>
<li>Paste the key where the app asks for an API key or token. It's sent as <code>Authorization: Bearer &lt;key&gt;</code> or as an <code>X-API-Key</code> header.</li></ol>
<p><a href="${esc(origin)}/">Back to CardDesk</a></p></main></body></html>`;
}

export async function handleMcp(req, { authenticate = defaultAuthenticate, db = null, deps = {} } = {}) {
  const origin = new URL(req.url).origin;
  // A person opening the address in a browser gets a short explanation instead of "Method not allowed".
  // AI apps asking for an event stream (GET with Accept: text/event-stream) still get the standard 405.
  if (req.method === 'GET' && /text\/html/i.test(req.headers.get('accept') || '')) {
    return new Response(infoPage(origin), { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const admin = db || getSupabaseAdmin();
  const auth = await authenticate(req, origin, admin);
  if (auth.response) return auth.response;
  const userId = auth.user.id;
  const ctx = {
    db: admin, userId, origin, deps,
    settings: await loadSnapSettings(admin, userId),
    getToken: deps.getToken || (() => getSellerAccessToken(admin, userId)),
  };
  const server = buildServer(ctx);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(req);
}

export default (req) => handleMcp(req);

export const config = {
  path: '/mcp',
  rateLimit: { windowSize: 60, windowLimit: 120, aggregateBy: ['ip', 'domain'] },
};
