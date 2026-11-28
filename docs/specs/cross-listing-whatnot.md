# Cross-listing foundation + List on Whatnot

Status: Specced (2026-11-28). Owner decisions are baked in; see "Open questions" for the rest.
Sources read: CLAUDE.md, docs/ROADMAP.md, docs/marketplaces/whatnot.md, docs/ebay-sales-sync.md,
supabase/migrations (core_tables, ebay_seller, ebay_orders_pnl, snap_to_list, snap_publish, cost_capture),
netlify/lib/ebay-listing.js, ebay-seller.js, seller-adapter.js, billing.js, plans.js, cron-signature.js,
netlify/functions/ebay-sync-orders.js, market-nightly.js, src/SnapTab.jsx, src/ListingsTab.jsx, src/CardDeskPro.jsx.
developers.whatnot.com and api.whatnot.com were not reachable from this session: every Whatnot request
shape below is from the research notes and must be confirmed (section 5, "Confirm against the live API").

## 1. Seller problem
"Half my buyers are on Whatnot, but listing a card there means typing it all in again, and then I have to
remember to pull it off eBay when it sells on Whatnot (or the other way round). I've sold the same card
twice and had to cancel and eat a defect." Anyone selling on more than one marketplace hits this on every
card, every day; a double sale costs a refund, an eBay defect and a bad buyer review. Shopify and TCGplayer
sellers will have the same problem next.

## 2. Scope
In:
- **Marketplace layer** (`netlify/lib/marketplaces/`): one adapter contract that eBay (existing code,
  wrapped), Whatnot (new) and later Shopify and TCGplayer implement; one place per seller to connect and
  disconnect; one table of where each card is listed; one stock count per card.
- **Whatnot connection** by a seller-pasted personal access token, stored encrypted, never returned to the
  browser. Code accepts an OAuth app token later without schema changes.
- **List on Whatnot** from an approved or live card (one at a time or in bulk): Buy It Now product in the
  seller's Whatnot shop with title, description, price, quantity, condition and photos.
- **Change price / change quantity / end on Whatnot** from Tyche Cards.
- **Sale check**: a scheduled job every 5 minutes reads Whatnot orders (and eBay orders, for sellers with
  a card listed in two places); a "Check for sales now" button does the same on demand.
- **Sell once**: when a card's stock reaches 0 on any marketplace, every other active listing of it is
  ended automatically and the card says so. Quantity above 0 is pushed to the other listings instead.
- **Encryption helper** (`netlify/lib/secret-box.js`) used for Whatnot tokens from day one.

Not now:
- Whatnot shows, auctions, show inventory, giveaways; Whatnot webhooks and OAuth app install (needs the
  partner app the owner is applying for; the poller is replaced by `orders.*` webhooks then).
- Shopify, TCGplayer, Mercari, CollX adapters (designed for below, not built).
- Whatnot sales in Real P&L / fees (sales are recorded in `marketplace_orders` so P&L can be added later).
- Repricer pushing to Whatnot (repricer stays eBay-only; Whatnot price is changed per card).
- Importing listings that already exist on Whatnot.
- MCP connector tools for Whatnot (add later with `user_confirmed=true`).
- Email/push alerts on a sale; re-encrypting existing eBay tokens (proposed as the next PR, see Open questions).

## 3. Experience (phone width first)
**Connect** (Listings & Prices → the view now labelled **Marketplaces**, was "eBay account"; view id stays
`listings`). The existing eBay panel stays on top; below it a new panel per marketplace (`src/MarketplacesPanel.jsx`).
- Whatnot, not connected:
  "**Whatnot** · Not connected. List your cards in your Whatnot shop and we'll take them down everywhere
  else when they sell."
  Steps: "1. Open Whatnot's token page" (link to `https://www.whatnot.com/dashboard/developer?tab=tokens`,
  new tab). "2. Create a token and tick: `read:inventory`, `write:inventory`, `read:orders`" (copy button
  for the list; final list per section 5). "3. Choose 90 days or No expiry. 4. Paste it here."
  Password-type field "Whatnot token" + **Connect Whatnot**.
  Errors: "That doesn't look like a Whatnot token. It starts with wn_pat_tk_." / "Whatnot didn't accept that
  token. Check you copied all of it." / "This token can't read your orders. Make a new one with read:orders ticked."
- Connected: "**Whatnot** · Connected as @shopname · last checked for sales 3 min ago ·
  N cards listed". Buttons: **Check for sales now**, **Disconnect** (icon, like eBay).
- Token stopped working (401 from Whatnot): amber "Whatnot stopped accepting your token, so we can't see
  Whatnot sales. Paste a new one." with the paste field shown again. The same line appears once at the top
  of Snap to List while any Whatnot listing is active.
- Disconnect with active Whatnot listings: `askChoice` "You have 4 cards up on Whatnot. If you disconnect,
  we stop watching them for sales, so a card could sell twice." Choices: **End them on Whatnot, then
  disconnect** / **Disconnect and leave them up** / Cancel. Then: "Also delete the token on Whatnot's token page."
- Free/Basic on Tyche: the panel shows "Whatnot listing is part of the Pro plan." with the existing upgrade link.

**List** (Snap to List card, statuses `approved` and `listed`):
- Each card gets a row of marketplace chips: "eBay · $12.50", "Whatnot · $12.50", greyed "Ended on Whatnot",
  green "Sold on Whatnot". Tapping a live Whatnot chip opens `askChoice`: **Change price**, **Change quantity**,
  **Open on Whatnot**, **End on Whatnot**.
- Button **List on Whatnot** (when connected and not already live there). `askValue` "Whatnot price" prefilled
  with the card price, then `askConfirm`: "List on Whatnot now? *Title* · $12.50 · Qty 1 · Near Mint · 3 photos.
  It goes live in your Whatnot shop as Buy It Now right away." confirm label **List on Whatnot**.
  Success: chip appears, "Listed on Whatnot." Failure: red line on the card, e.g. "Whatnot said: category is
  required" with **Try again**.
- Bulk: in the Approved and On eBay filters, **LIST N ON WHATNOT** for cards not yet on Whatnot; one
  confirm with count and total price; progress like the eBay publish loop; a summary of any that failed.
- New filter tab **On Whatnot (n)** when Whatnot is connected.
- **Quantity** field on the card (default 1, next to price). Changing it on a live card asks
  "Change stock to 3 on eBay and Whatnot?" and pushes it to every active listing.
- End on Whatnot: `askConfirm` "Take this card down from your Whatnot shop?" (danger style).

**Sold** (note on the card, top line, also in the Listed filters):
- Normal: "Sold on Whatnot Nov 28 for $14.00. Ended on eBay automatically."
- Could not end: red "Sold on Whatnot. Your eBay listing is still up: eBay said '…'. **End on eBay**"
  (button retries; sale check retries on its own each run).
- Sold twice before we could end it: red "Sold on both Whatnot and eBay. You only have 1. Cancel one of the
  orders on that marketplace." (links to both orders).
- Quantity left: "Sold 1 on Whatnot. 2 left, updated on eBay."

## 4. Plan placement
**Pro**, feature key `cross_list` ("Listing on more marketplaces"). Selling on two marketplaces is a
volume seller's need, the same buyers who pay for the repricer and Best Offer automation (Pro), and the
API calls cost us nothing per card. Card-limit impact: none; listing, updating and the sale check use no AI,
so no `requireCards()` call. The sale check and sell-once run for every connected seller **regardless of
plan** (a seller who drops to Basic must not get double sales on listings already up); only creating new
cross-listings and connecting are gated. Founder site: no limits (billing off), feature on.

## 5. Data and integrations
### Tables (one migration `supabase/migrations/20261129000000_marketplaces.sql`, additive)
`marketplace_accounts`: RLS on, **no policies** (service role only, like `ebay_accounts`).
`id uuid pk, user_id uuid fk auth.users on delete cascade, marketplace text check in ('whatnot','shopify','tcgplayer'),
auth_kind text check in ('personal_token','oauth'), access_token_enc text not null, refresh_token_enc text,
token_expires_at timestamptz, scopes text[], external_user_id text, external_username text,
status text not null default 'connected' check in ('connected','reconnect'), last_error text,
sales_checked_at timestamptz, settings jsonb not null default '{}' (e.g. shipping profile id),
created_at, updated_at; unique (user_id, marketplace)`.
eBay stays in `ebay_accounts` (not migrated); the eBay adapter reads it. Disconnect deletes the row.

`marketplace_listings`: RLS on, owner `select` policy only; writes via functions.
`id uuid pk, user_id, snap_item_id uuid fk snap_items on delete set null, inventory_id uuid fk inventory on delete set null,
marketplace text check in ('ebay','whatnot','shopify','tcgplayer'), external_id text (eBay ItemID / Whatnot product id),
external_variant_id text, external_listing_id text, url text, price numeric(12,2), currency text default 'USD',
quantity int, status text check in ('active','ending','ended','sold','failed'),
ended_reason text check in ('seller','sold_elsewhere','sold_out','not_found','disconnected'),
last_error text, listed_at, ended_at, sold_at, synced_at timestamptz, raw jsonb, created_at, updated_at`.
Indexes: unique `(user_id, marketplace, external_id)`; unique partial `(snap_item_id, marketplace) where status in ('active','ending')`
(one live listing per card per marketplace); `(user_id, status)`.
Backfill in the migration: one `ebay` row per `snap_items` with `ebay_item_id` and `status='listed'`,
status from `ebay_listings.status` ('Active'→active, else ended), joined to `inventory` by `ebay_item_id`.
eBay publish (`publishItem` in ebay-listing.js) also writes this row from now on.

`marketplace_orders`: RLS on, owner `select`. The sale ledger that makes sell-once idempotent.
`user_id, marketplace, external_order_id, external_line_id, listing_id uuid fk marketplace_listings on delete set null,
snap_item_id uuid, quantity int, item_price numeric, status text, ordered_at timestamptz, handled_at timestamptz,
raw jsonb; primary key (user_id, marketplace, external_order_id, external_line_id)`. eBay sales are also
recorded here (line id = eBay `line_item_id`) alongside `ebay_order_lines`.

`snap_items` columns: `quantity int not null default 1 check (quantity >= 0)`, `sold_out_at timestamptz`,
`sale_note jsonb` (`{ marketplace, at, price, ended:[{marketplace, ok, error}], double_sale: bool }`, the UI
writes the sentence from it). Status values unchanged (`listed` keeps meaning "on eBay").

### Token storage
`netlify/lib/secret-box.js`: AES-256-GCM, `seal(text)` → `v1.<iv>.<tag>.<ciphertext>` (base64url),
`open(sealed)`. Key from env `MARKETPLACE_TOKEN_KEY` (32 random bytes, base64), the **same value on both
Netlify sites** because they share the database. Missing key → connect returns 503 "Whatnot isn't set up
on this site yet" and nothing is stored. Tokens are decrypted only inside adapter calls; no endpoint,
log line or error message includes a token (tests assert this). eBay tokens are currently plain text in
`ebay_accounts`; see Open question 1.

### Adapter contract (`netlify/lib/marketplaces/registry.js`)
```
{ id, label, authKinds: ['personal_token'|'oauth'],
  connect(db, userId, { token }) -> { externalUserId, username, scopes }   // validates, never stores
  createListing(ctx, card, { price, quantity }) -> { externalId, variantId, listingId, url, price, quantity }
  updateListing(ctx, listing, { price?, quantity? }) -> { price, quantity }
  endListing(ctx, listing) -> { ok }                    // idempotent: "already gone" is ok
  fetchSales(ctx, { since }) -> [{ orderId, lineId, externalId, quantity, price, at, status }] }
```
`ctx = { db, userId, account, fetchImpl }`. Errors are thrown as `MarketplaceError(code, sellerMessage)` with
codes `reconnect` (401/expired), `missing_scope` (403), `rate_limited`, `not_found`, `rejected` (400/422 with
Whatnot's message), `unavailable` (5xx/timeout). Shopify/TCGplayer add a file each and a registry line.
- `marketplaces/ebay.js`: wraps existing code. `createListing` = current `publishItem` (unchanged flow);
  `endListing` = **new** Trading `EndFixedPriceItem` (`ItemID`, `EndingReason=NotAvailable`) in
  ebay-listing.js; `updateListing` quantity = Trading `ReviseInventoryStatus` (price stays with
  trading-price.js); `fetchSales` = the existing `ebay-sync-orders` import + `recompute`.
  eBay publish uses `snap_items.quantity` instead of the hard-coded `<Quantity>1</Quantity>`.
- `marketplaces/whatnot.js` + `whatnot-client.js`.

### Whatnot calls (base `https://api.whatnot.com/seller-api/rest/v2`, `Authorization: Bearer <token>`)
| Step | Call |
|---|---|
| Connect: who is it | `GET /users/me` → id, username; then `GET /orders?limit=1` to prove `read:orders` |
| Shipping profile (once, at connect) | `GET /shipping/dimension_profiles` → store first card-sized one in `settings.shipping_profile_id`; seller can change it in the panel |
| Create | `POST /products` { title, description, category id, condition, variants:[{ sku: snapSku, price, quantity }], media:[{url}] } |
| Put in shop as Buy It Now | `POST /merchandising/products/{product_id}` { format: Buy It Now, shop: true, shows: none } |
| Price | `PATCH /products/{product_id}/variants` { price } |
| Quantity | `POST /inventory/set` { variant id, quantity } |
| End | remove from shop via merchandising + `POST /inventory/set` quantity 0; `DELETE /products/{id}` only if it never sold. 404 = already gone (ok) |
| Sales | `GET /orders?updated_after=<sales_checked_at − 30 min>` (paged) then `GET /orders/{id}/items` |
| Disconnect | delete our row; `POST /users/disconnect` only for `oauth` accounts |
Photos: use `snap_items.ebay_picture_urls` when present (public, permanent); otherwise 1-hour Supabase
signed URLs (`photoLink` pattern) from `photo_path` + `extra_photo_paths`, max per Whatnot's limit.
Condition map: NM→Near Mint, LP→Lightly Played, MP→Moderately Played, HP→Heavily Played, DMG→Damaged;
graded cards → "Graded" if Whatnot has it. Category: TCG singles id per game (Pokémon, MTG, Lorcana,
One Piece, other) from Whatnot-Inc/product-taxonomy `data/taxonomy.json`, kept as a constant map in
whatnot.js with a test.
Idempotency: `sku = snapSku(card.id)`; before `POST /products` on a retry, look the sku up (`GET /products?sku=`)
and adopt an existing product instead of creating a second one.
Rate limit: 10 req/s per seller; client keeps ≤ 8 req/s per seller, on 429 waits `Retry-After` (max 10 s)
and retries up to 2 times, then `rate_limited` ("Whatnot is busy, try again in a minute").
Timeouts: 10 s per request.

**Confirm against the live API before go-live** (builder writes these as `// CONFIRM:` comments and
the fixtures in tests/fixtures/whatnot/ are marked as guesses):
1. Exact scope names, and whether `GET /users/me` returns the token's scopes and expiry.
2. `POST /products` body: field names for title, description, category id, condition (enum values),
   variant sku, price (cents integer vs decimal string vs `{amount,currency}`), quantity, media
   (URL accepted? or upload endpoint? max photos, size limits; does Whatnot copy the URL at create time?).
3. Whether shipping profile / weight is required on a product, and the `dimension_profiles` response shape.
4. `POST /products` response: product id, variant id, listing id, public product URL (or how to build it).
5. Merchandising body for "Buy It Now in shop only", and whether a product is visible before this call.
6. `PATCH /products/{id}/variants` body shape; `POST /inventory/set` body (variant id vs listing id).
7. How to end: merchandising removal vs quantity 0 vs DELETE, and what DELETE does to a sold product.
8. `GET /products` filter by sku exists.
9. `GET /orders`: filter param name (`updated_after`/`created_after`), pagination (cursor field), order
   status values incl. cancelled/refunded, timestamps, and on `/orders/{id}/items`: line id, product id,
   variant id, sku, quantity, unit price, currency.
10. Error body format (where the human message is) for 400/403/422; 401 vs 403 for expired token.
11. `RateLimit-*` header names; whether limits are per token or per app.
12. Product taxonomy ids for each card game; whether graded slabs are a separate category or condition.

### Endpoints (Netlify Functions, `requireUser`, all filter by `user_id`)
- `GET /api/marketplaces` → `[{ marketplace, connected, username, status, salesCheckedAt, activeCount, settings }]`
  (eBay from `ebay_accounts`, others from `marketplace_accounts`; never any token field).
  `POST { action:'connect', marketplace:'whatnot', token }` (`requireFeature('cross_list')`),
  `POST { action:'settings', marketplace, shippingProfileId }`, `DELETE { marketplace, endListings: bool }`.
- `POST /api/marketplace-listings { action:'create'|'update'|'end', marketplace, snapItemId | listingId, price?, quantity? }`.
  `create` needs `requireFeature('cross_list')` and card status `approved` or `listed`; `update`/`end` are allowed on
  any plan (so a downgraded seller can still take things down). Returns the listing row (no raw).
- `POST /api/marketplace-sales` → runs the sale check for the signed-in seller now; returns
  `{ checked: ['whatnot','ebay'], newSales, ended, problems }`. Max once per 30 s per seller (429 otherwise).
- Scheduled `netlify/functions/marketplace-sales-cron.js`, `schedule: '*/5 * * * *'`: skips when
  `SALES_CHECK=off` (set on the Tyche site, like `NIGHTLY_REFRESH`, since the database is shared), then calls
  `marketplace-sales-run-background.js` with a signed request (generalise `cron-signature.js` with a purpose
  string, keep `market-refresh` signatures valid). The background run loops sellers who have a connected
  Whatnot account **or** a card active on two or more marketplaces, oldest `sales_checked_at` first, stops
  starting new sellers after 12 minutes. eBay orders are checked only for those cross-listed sellers.

### Sell once (`netlify/lib/sell-once.js`, pure decisions + a thin runner)
For each new sale line (insert into `marketplace_orders` with `on conflict do nothing`; only newly inserted
lines are handled, so double runs and both sites are safe):
1. Find the listing by `(marketplace, external_id)`; none → record only (not our card).
2. Mark that listing `sold` (or reduce its quantity), set `snap_items.quantity = max(0, quantity − sold)`,
   mark the matching `inventory` row Sold with `sale_channel` ('Whatnot'), price and date (eBay sales keep
   going through the existing `recompute`/`markInventorySold`; sell-once is called after it).
3. Quantity now 0 → `endListing` on every other `active` listing of the card; each result goes to
   `sale_note.ended`; failures leave the listing `active` with `last_error` and are retried each run.
   Quantity > 0 → `updateListing({quantity})` on the others.
4. Another listing of the same card already sold for the last unit → `double_sale: true`.
5. A cancelled order (Whatnot status / eBay `cancel_state`) before we ended anything puts the quantity back;
   after listings were ended it only adds a note ("The Whatnot order was cancelled. Relist on eBay?"), no auto-relist.

## 6. Acceptance criteria
1. A Pro seller (and any seller on jaxspic) can paste a valid token, press Connect Whatnot, and see
   "Connected as @name"; the token is stored only in `marketplace_accounts.access_token_enc`, sealed.
2. No API response, log line or error message ever contains a token or its sealed value (test greps
   responses of every endpoint with a known token).
3. A bad prefix, a token Whatnot rejects, and a token without order access each show their own message
   from section 3 and store nothing.
4. Free and Basic sellers on Tyche see the Pro message and `POST connect`/`create` return 402 with the
   upgrade body; `update`, `end`, disconnect and the sale check still work for them.
5. From an approved or listed card, List on Whatnot shows the price prompt then the confirm with title,
   price, quantity, condition and photo count; nothing is sent to Whatnot before the confirm.
6. The create request carries the card's title, description, mapped condition, category id, price,
   quantity, sku `SNAP-…` and photo URLs, then the Buy It Now/shop merchandising call (mocked-fetch test).
7. Retrying a create after a lost response adopts the existing product with the same sku; there is never
   more than one live Whatnot listing per card (partial unique index).
8. Change price, change quantity and End on Whatnot each confirm first, update Whatnot, and update the chip.
9. A Whatnot sale found by the 5-minute check or by Check for sales now, for a card also live on eBay with
   quantity 1, ends the eBay listing (`EndFixedPriceItem`) and the card reads "Sold on Whatnot … Ended on
   eBay automatically." within one check.
10. An eBay sale (found by the existing sync or the scheduled check) for a card live on Whatnot ends the
    Whatnot listing the same way.
11. Running the same sale check twice, or from both sites, ends things once and records the sale once.
12. If ending fails, the card shows the red note with an End on eBay / End on Whatnot button, and the next
    check retries.
13. Quantity 3 card: one sale leaves 2 and pushes quantity 2 to the other marketplaces; it does not end them.
14. Two sales of a last unit on two marketplaces show the "Sold on both" note on the card.
15. A 401 from Whatnot marks the account `reconnect` and shows the paste-a-new-token message in the panel
    and on Snap to List; the scheduled check skips that seller without erroring for others.
16. A 429 is retried after `Retry-After`; a seller's bulk listing of 50 cards stays under 10 requests/second.
17. Disconnect with active Whatnot listings offers end-then-disconnect / leave up / cancel; the row (and token) is deleted either way.
18. Every screen above works at 390 px with no sideways scroll; chips wrap; confirms use the in-page dialog.
19. Founder site: same feature, no plan messages; nothing on jaxspic changes for a seller who never connects Whatnot
    (eBay publish, sync and the Snap filters behave as today; the only visible change is the "Marketplaces" label).
20. Tests and agents never reach api.whatnot.com or eBay write APIs: all Whatnot/eBay calls in tests go
    through an injected `fetchImpl`, and a test fails if global `fetch` is called.
21. `npm test` passes; existing publish, recompute and pnl tests still pass with the new `marketplace_listings` writes.

## 7. Build plan
1. `netlify/lib/secret-box.js` + `tests/secret-box.test.js` (round trip, tamper fails, missing key throws).
2. Migration `supabase/migrations/20261129000000_marketplaces.sql` (tables, indexes, RLS, snap_items columns,
   eBay backfill). Extend `tests/fake-db.js` if it needs the new tables.
3. `netlify/lib/plans.js`: `FEATURE_PLAN.cross_list = 'pro'`, label "Listing on more marketplaces".
4. `netlify/lib/marketplaces/registry.js`, `errors.js` (MarketplaceError), `whatnot-client.js` (auth header,
   10 s timeout, throttle, 429 retry, error mapping), `whatnot.js` (adapter, condition/category maps, CONFIRM comments).
   Tests: `tests/whatnot.test.js` with fixtures in `tests/fixtures/whatnot/` (request bodies, 401/403/404/422/429, sku adoption, pagination).
5. `netlify/lib/marketplaces/ebay.js`; add `endFixedPriceItem` and `reviseQuantity` to ebay-listing.js /
   trading-price.js; `publishItem` uses `snap_items.quantity` and writes `marketplace_listings`.
   Tests: extend `tests/publish.test.js`; `tests/marketplaces.test.js` checks every adapter implements the contract.
6. `netlify/lib/sell-once.js` + `tests/sell-once.test.js` (qty 1 / qty 3 / double sale / cancel / end failure retry / idempotent rerun).
   Hook into `ebay-sync-orders.js` `recompute` after `markInventorySold` (record in `marketplace_orders`, call sell-once).
7. Functions: `marketplaces.js`, `marketplace-listings.js`, `marketplace-sales.js`, `marketplace-sales-cron.js`,
   `marketplace-sales-run-background.js`; generalise `cron-signature.js` (tests for both purposes).
   Token-leak test across endpoints; no-global-fetch guard in `tests/agent-safety.test.js`.
8. UI: `src/MarketplacesPanel.jsx` rendered under the eBay panel in `src/ListingsTab.jsx`; rename the view label
   in `src/CardDeskPro.jsx`; in `src/SnapTab.jsx` add chips, List on Whatnot (single + bulk), Quantity field,
   On Whatnot filter, sale notes, reconnect banner. Load listings with one select on `marketplace_listings`.
9. e2e: mock build fixtures for a connected Whatnot account and a sold-elsewhere card; screenshot the panel,
   a card with chips and the sale notes at 390 px and desktop (`e2e/cross-listing.cjs`).
10. Docs: `docs/marketplaces/whatnot.md` (what was built, the confirm list), env vars `MARKETPLACE_TOKEN_KEY`
    (both sites, same value) and `SALES_CHECK=off` (Tyche) in the deploy notes.

## 8. Open questions (owner)
1. **Encrypt eBay tokens too?** They are plain text in `ebay_accounts` today. Default: yes, as the next small
   PR right after this one: add `*_enc` columns, write both, backfill, switch reads, then clear the plain
   columns only after you say so.
2. **Whatnot price** default: the same as the card's eBay price, editable per card. Alternative: a standing
   markup/markdown (e.g. +5% for Whatnot fees). Default: same price, no rule.
3. **Which site runs the 5-minute check**: default jaxspic (mirrors the nightly refresh), `SALES_CHECK=off` on Tyche.
4. **Plan**: Pro as the roadmap says. Alternative: Basic to win more Whatnot sellers early. Default: Pro.
5. **Going live before the API is confirmed**: default: ship behind the Pro gate on jaxspic first, list one
   real card on your own Whatnot shop with your go-ahead, fix the confirm list, then promote to Tyche.
