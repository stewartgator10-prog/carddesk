# eBay sales sync and real P&L

**What it does:** the "eBay Sales · Real P&L" tab pulls your eBay orders (Sell Fulfillment API) and payouts/fees (Sell Finances API) into Supabase, marks the matching inventory card as sold, and shows profit per sale using real fees.

## Pieces
- `supabase/migrations/20261122300000_ebay_orders_pnl.sql`: `ebay_orders`, `ebay_order_lines` (with match + P&L columns), `ebay_transactions`; adds `inventory.ebay_order_line_id` and `ebay_accounts.orders_synced_at`. Runs after the core tables and `ebay_accounts` migrations.
- `netlify/functions/ebay-sync-orders.js` (`POST /api/ebay-sync-orders`): first sync looks back 90 days (or `{days}` up to 730), later syncs start 72h before the last one so late fees and refunds are picked up.
- `netlify/functions/ebay-order-match.js` (`POST /api/ebay-order-match`): confirm / ignore / unlink a sale's inventory match.
- `netlify/lib/pnl.js`: pure P&L and matching logic, tested in `test/`.

## How profit is figured, per sale line
`net payout = item + shipping charged − eBay fees − shipping label − promoted listing fees − refunds ± other adjustments`, then `profit = net payout − inventory cost basis`. Sales tax is left out because eBay collects and remits it.

- Fees come from the payout record when it has posted (**ACTUAL**), otherwise from the fee eBay shows on the order (**ORDER**), otherwise your fee settings (**EST**).
- Labels, ad fees and refunds are tied to an order, not a line, so they are split across the order's lines by sale amount.
- Store costs not tied to an order (subscription, etc.) are shown as overhead in the headline profit.

## Matching sales to inventory
1. eBay item ID on the inventory row → auto mark sold.
2. SKU → auto mark sold.
3. Title similarity ≥ 60% → **suggested only**; you confirm in the "Match to inventory" box.
Cancelled orders are never matched. Unlinking a match puts the card back in stock.

## Env vars (Netlify)
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `EBAY_APP_ID`, `EBAY_CERT_ID`. The seller consent must include `sell.fulfillment` and `sell.finances` scopes.
