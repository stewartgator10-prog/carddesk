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

**Category ids** come from github.com/Whatnot-Inc/product-taxonomy (`data/taxonomy.json`); not reachable
from this cloud session yet. Until confirmed, keep the category id per game in one config map.

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
- `WHATNOT_CATEGORY_IDS` (JSON, e.g. `{"pokemon":"123","mtg":"456","other":"789"}`) until the taxonomy
  ids are confirmed and written into `CATEGORY_IDS` in whatnot.js. A game with no id can't be listed yet.

## Confirm against the live API before go-live (`// CONFIRM:` in the code)
1. Scope names; whether `/users/me` says the token's scopes or expiry (it doesn't in the spec).
2. `POST /products` with our body; whether Whatnot copies media URLs at create time (we send 1-hour
   signed links or eBay picture links); max photos; condition attribute id (`CONDITION_ATTRIBUTE_ID`).
3. Dimension profile id alone accepted; `dimension_profiles` shape.
4. `Product.url` is the public product page.
5. Merchandising `{ transaction_type: 'buy_it_now', reserve_for_live: false }` = shop only.
6. `PATCH /products/{id}/variants` and `/inventory/set` bodies as sent.
7. Ending: quantity 0 hides it from the shop? DELETE on a sold product (409?).
8. `GET /products` has no filter: we page the newest 200 products for our `external_id` to adopt a lost create.
9. `GET /orders` has no date filter: we page newest first back 72 h; order status values; whether a
   cancelled order puts the stock back on Whatnot.
10. Error body format for 400/403/409/422 (we read `detail` / `message`).
11. `RateLimit-*` headers; per token or per app.
12. Taxonomy ids per game; graded slabs.
