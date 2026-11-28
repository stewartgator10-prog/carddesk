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

**Still to confirm from the API reference** (openapi at developers.whatnot.com/whatnot-seller-api/openapi.json):
the exact `POST /products` body (title, description, category id, condition, price fields, media:
URL vs upload), merchandising sale formats (Buy It Now / auction / show-only), and order item fields.

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
