# Whatnot: research notes

Source: developers.whatnot.com (read November 2026). The Seller API is **beta**: fields may change.

## API
- REST, JSON. Base URL `https://api.whatnot.com/seller-api/rest/v2`.
- Auth header `Authorization: Bearer <token>`.
  - **Personal access tokens** (`wn_pat_tk_…`): the seller creates one in their Whatnot developer
    dashboard (www.whatnot.com/dashboard/developer?tab=tokens), picks scopes and an expiry
    (7/30/60/90 days, custom, or none). Only the account owner can create them. Self-serve.
  - **App tokens via OAuth** (`wn_access_tk_…`): issued to a registered app the seller installs. The
    public docs don't describe how to register an app; this likely needs Whatnot partner approval.
- Scopes, e.g. `read:inventory`, `write:inventory`, `write:orders`, `read:customers`; write includes read.
- Rate limit: **10 requests/second per seller per app**; 429 with `Retry-After` and `RateLimit-*` headers.

## Endpoints we need
| Purpose | Call |
|---|---|
| Who is connected | `GET /users/me` |
| Create a product (listing) | `POST /products` (variants, pricing, media) |
| Read / update / delete | `GET/PATCH/DELETE /products/{product_id}`, `PATCH /products/{product_id}/variants` |
| Quantity | `POST /inventory/set`, `POST /inventory/adjust` |
| Sale format and where it shows (shop, shows) | `POST /merchandising/products/{product_id}` |
| Sold items | `GET /orders`, `GET /orders/{id}/items` |
| Shipping profiles | `GET /shipping/dimension_profiles` |
| Disconnect | `POST /users/disconnect` |

Inventory model: Product → ProductVariant → Listing (price, quantity); a variant has at most one listing.
Category: Whatnot's product taxonomy, published at github.com/Whatnot-Inc/product-taxonomy
(`data/taxonomy.json`: id, type, label, parent_id, allows_inventory). Trading cards map to its
TCG/sports-card categories; confirm the exact ids from the file.

## Confirmed from the live API spec (Nov 28, 2026)
Full specs saved in `docs/marketplaces/whatnot-api/` (`openapi.json`, `webhooks-openapi.json`,
`oauth-metadata.json`). Use them as the source of truth.

**Listing a card is four calls** (price is NOT on the product):
1. `POST /products` (scope `write:inventory`) → 201 `Product` with `id`, `url`, `media`. Body:
   - `title` (required), `description`, `external_id` (set it to our card id so sales can be matched),
   - `category: { id }` (required; a Whatnot taxonomy id, see below), `attributes: [{ id, value }]`,
   - `media: [{ url, alt }]` (Whatnot ingests public image URLs, so pass signed or public photo URLs),
   - `dimension_profile` (required): `{ id }` of a seller profile from `GET /shipping/dimension_profiles`,
     or inline `{ weight: { value, unit: ounce }, dimensions: { length, width, height, unit: inch } }`,
   - `hazardous_material: not_hazardous`.
2. `GET /products/{id}/variants` → the product's default variant id; then
   `PATCH /products/{id}/variants` with `{ variants: [{ id, price: { amount: "4.89", currency: "USD" }, sku, external_id }] }`.
3. `POST /inventory/set` with `{ items: [{ variant_id, quantity: 1, idempotency_key }] }`.
4. `POST /merchandising/products/{id}` (scope `write:merchandising`) with `{ transaction_type: "buy_it_now" }`
   (`auction` also exists; `shows: { strategy: ADD|REMOVE|REPLACE, show_ids }` for live shows).

**Change price**: `PATCH /products/{id}/variants` (price). **Change title/description/photos**: `PATCH /products/{id}`.
**End a listing**: `POST /inventory/set` quantity 0 (keeps history) or `DELETE /products/{id}`.
**Money** is `{ amount: string, currency: string }`.

**Sales**: `GET /orders?limit&cursor&reverse` (cursor paging), then `GET /orders/{id}/items` →
`OrderItem { id, order_id, product_id, variant_id, product_external_id, variant_external_id, quantity,
unit_price: Money, shipment_id }`. Match sold cards by `product_external_id`.

**Scopes needed for a seller token**: `read:inventory write:inventory read:merchandising
write:merchandising read:orders` (plus `read:shipments` later for shipping).

**OAuth** (`oauth-metadata.json`): authorization code + PKCE (S256) + refresh tokens at
`https://api.whatnot.com/seller-api/rest/oauth/authorize` and `/token`, revoke at `/revoke`. There is no
dynamic client registration endpoint, so Tyche Cards needs a client id from Whatnot (partner app) before
one-click connect is possible. Personal access tokens work today.

**Category ids and card details** come from Whatnot's taxonomy (`whatnot-api/taxonomy.json`, version
1.2.3, from github.com/Whatnot-Inc/product-taxonomy). `scripts/whatnot-taxonomy.mjs` turns it into
`netlify/lib/marketplaces/whatnot-taxonomy.js` (the TCG categories under "Trading Card Games" (149) and
the card details each takes); `whatnot-details.js` picks the category and fills the details.
- pokemon 2, mtg 9, yugioh 8, one_piece 567, lorcana 2013. Game "other" is matched by the typed game
  name (Dragon Ball 12, Digimon 94, Flesh & Blood 154, Weiß Schwarz 93, UniVersus 92, Union Arena 1471,
  Gundam 2014, Sorcery 1405, MetaZoo 58, Naruto 311, Riftbound 2015, ...), else 138 "Kickstarter &
  Other Cards". Sports cards: none (not offered).
- Details (all optional in every TCG category): condition (84 `tcg.condition`: Near Mint, Light Played,
  Moderately Played, Heavily Played, Damaged, Graded), set, card number, language, rarity, product type
  (the single-card choice), graded / grading service / grade / cert. A fixed-list (ENUM) value is sent
  only when it is in the list; free-text details take our text.
- `WHATNOT_CATEGORY_IDS` (JSON) still overrides a game's category; for "other" it is only the fallback.
- Regenerate after a taxonomy update: save the new `taxonomy.json`, run `node scripts/whatnot-taxonomy.mjs`,
  run `npm test` (a test checks the table against the file).

**Errors**: only 422 has a documented body (`HTTPValidationError { detail: [{ loc, msg, type }] }`);
401/403/404/409 have none. Whatnot's HTTP status is never passed to the browser: our endpoints answer
with their own status per error code.

**Spec oddity**: the Products guide text says `pricing.buy_it_now.price`, but `ProductVariantPatch`
(additionalProperties false) has `price: Money`. We follow the schema.

## Webhooks
Standard Webhooks (HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{body}`, secret prefix `wn_wh_`,
5-minute tolerance). Topics include `orders.created`, `orders.updated`, `products.created/updated/deleted`,
`merchandising.products.added_to_show/removed_from_show`, `shows.*`, `shipments.*`. Webhooks are
delivered to a **registered app** ("your app and the seller's installation must both hold the scope"),
so with personal tokens we poll `GET /orders` instead.

## MCP
Hosted MCP server `https://mcp.whatnot.com` (OAuth, public client id
`bb1bf1ca-0452-4737-ad8f-81175f1601b8`). Useful for the owner's own Claude Code to explore or manage a
Whatnot store; the product integration itself calls the REST API from Netlify Functions.

## Network
This repo's cloud environment needs `developers.whatnot.com`, `api.whatnot.com` and `mcp.whatnot.com`
on its allowed hosts to read docs, call the API or connect the MCP server.

## What is built (Nov 29, 2026; spec docs/specs/cross-listing-whatnot.md)
- `netlify/lib/marketplaces/` adapter contract (`registry.js`), `whatnot.js` + `whatnot-client.js`
  (8 req/s per seller, 429 retry with Retry-After max 10 s, 10 s timeout), `ebay.js` (wraps existing code,
  adds `EndFixedPriceItem` and quantity revise), `service.js` (what the endpoints do).
- Token sealed with `netlify/lib/secret-box.js` (AES-256-GCM) in `marketplace_accounts.access_token_enc`.
- `netlify/lib/sell-once.js`: sale ledger in `marketplace_orders`, ends/re-counts the other listings.
- Endpoints `/api/marketplaces`, `/api/marketplace-listings`, `/api/marketplace-sales`; schedule
  `marketplace-sales-cron` (every 5 min) -> `/api/marketplace-sales-run` (background, signed).
- UI: Whatnot panel under eBay in Listings & Prices -> Marketplaces; chips, List on Whatnot, Quantity,
  On Whatnot filter, sale notes and reconnect banner in Snap to List.

## Deploy notes
- Apply `supabase/migrations/20261129000000_marketplaces.sql` **before** the code reaches either site (eBay publish now writes `marketplace_listings`; a missing table is only logged, but sell once needs it). It adds `marketplace_listings.status = 'creating'` (the claim a Whatnot create takes) and `marketplace_orders.claimed_at`.
- `MARKETPLACE_TOKEN_KEY` on BOTH sites, the same value: `openssl rand -base64 32`. Without it, connect
  answers "Whatnot isn't set up on this site yet" and stores nothing.
- `SALES_CHECK=off` on Tyche Cards (jaxspic runs the 5-minute check for everyone, like the nightly refresh).
- `WHATNOT_CATEGORY_IDS` is no longer needed: categories come from Whatnot's taxonomy. It still overrides a game if set.
- Also apply `supabase/migrations/20261130000000_marketplace_sale_locks.sql` (one sale check per seller at a time).

## Still to check on a live shop (`// CONFIRM:` in the code)
Resolved from the saved spec (Nov 30, 2026): scope names; `/users/me` has no scopes or expiry;
`POST /products` body; dimension profile by id or inline; `Product.url` is the seller's dashboard page;
merchandising `{ transaction_type: 'buy_it_now', reserve_for_live: false }` publishes to the profile
shop; variant price and `/inventory/set` bodies; DELETE answers 204/404/409; `GET /products` and
`GET /orders` take only limit/cursor/reverse; order statuses; error bodies; category ids and condition.

Still open (the spec doesn't say):
1. Whether Whatnot copies media URLs at create time (we send 1-hour signed links or eBay picture links), and its photo limit.
2. Whether a quantity-0 product still shows in the profile shop as sold out.
3. Whether a cancelled order puts the stock back on Whatnot by itself.
4. The value format for BOOLEAN attributes (we send `"true"`).
5. Rate limit headers (`RateLimit-*`), and whether the 10/s limit is per token or per app (from the docs, not the spec).
6. Whether "Publishing needs ... an image" is met by product media alone, or the variant needs its own image.
