// netlify/functions/mcp.js
// CardDesk as a remote MCP server (custom connector for the Claude app):  https://<site>/mcp
// Sign-in: Supabase Auth's OAuth 2.1 server. A request without a valid CardDesk token gets a 401
// pointing at /.well-known/oauth-protected-resource, which names Supabase as the authorization
// server; Claude then runs the "Sign in with CardDesk" flow (consent page: /oauth/consent).
// Stateless: a fresh server + transport per request, JSON responses only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { z } from 'zod';
import { requireUser } from '../lib/auth.js';
import { getSupabaseAdmin, getSellerAccessToken } from '../lib/ebay-seller.js';
import { loadSnapSettings } from '../lib/snap-identify.js';
import * as tools from '../lib/mcp-tools.js';

const metadataUrl = (origin) => `${origin}/.well-known/oauth-protected-resource`;
const unauthorized = (origin, message = 'Sign in to CardDesk to use this connector.') => new Response(JSON.stringify({ error: message }), {
  status: 401,
  headers: { 'Content-Type': 'application/json', 'WWW-Authenticate': `Bearer resource_metadata="${metadataUrl(origin)}"` },
});

async function defaultAuthenticate(req, origin) {
  if (!/^Bearer\s+\S+/i.test(req.headers.get('authorization') || '')) return { response: unauthorized(origin) };
  const auth = await requireUser(req);
  if (auth instanceof Response) return { response: auth.status === 401 ? unauthorized(origin, 'Your CardDesk sign-in expired. Reconnect the connector.') : auth };
  return { user: auth.user };
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const EDIT = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function buildServer(ctx) {
  const server = new McpServer({ name: 'carddesk', version: '1.0.0' }, {
    instructions: 'CardDesk is a trading card seller\'s workspace. Cards are photographed in the CardDesk Snap tab on a phone, identified by AI, then reviewed, approved, checked with eBay and published. Prices are USD. Always show the user what you are about to change on eBay and get a clear yes before publish_cards.',
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

  server.registerTool('ai_fee_report', {
    title: 'AI fee report',
    description: 'This month\'s estimated Claude API spend for card identification, by model and by use. Read-only.',
    inputSchema: {}, annotations: READ,
  }, run('ai_fee_report', (c) => tools.feeReport(c)));

  return server;
}

export async function handleMcp(req, { authenticate = defaultAuthenticate, db = null, deps = {} } = {}) {
  const origin = new URL(req.url).origin;
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  const auth = await authenticate(req, origin);
  if (auth.response) return auth.response;
  const admin = db || getSupabaseAdmin();
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
