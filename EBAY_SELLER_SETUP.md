# eBay seller connection: setup

The **eBay Listings** tab signs in to your eBay seller account (OAuth) and pulls your
active listings into Supabase. It is read-only for now.

## 1. eBay developer portal (developer.ebay.com, Production keyset)

1. **Application Keys** → copy the Production **App ID (Client ID)** and **Cert ID (Client Secret)**.
2. **User Tokens** → *Get a Token from eBay via Your Application* → add an eBay Redirect URL (this creates your **RuName**):
   - Auth accepted URL: `https://<your-netlify-site>/api/ebay-callback`
   - Auth declined URL: `https://<your-netlify-site>/api/ebay-callback?declined=1`
   - Privacy policy URL: any page on your site
   - OAuth enabled: **yes**
   - Copy the **RuName** value (looks like `Your_Name-YourApp-PRD-abc123-defgh`). This is *not* a URL.

## 2. Supabase

Run `supabase/migrations/20261122000100_ebay_seller.sql` in the SQL editor
(after the core-tables/login migration, since it references `auth.users`).

## 3. Netlify → Site configuration → Environment variables

| Variable | Value | Secret? |
| --- | --- | --- |
| `EBAY_APP_ID` | Production App ID (already set for Live Search) | |
| `EBAY_CERT_ID` | Production Cert ID (already set) | yes |
| `EBAY_RU_NAME` | the RuName from step 1 | |
| `SUPABASE_URL` | Supabase → Project Settings → API → URL | |
| `SUPABASE_ANON_KEY` | Supabase anon/publishable key | |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role/secret key (server only, never prefix with `VITE_`) | yes |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | same URL + anon key, for the browser | |

Redeploy after adding them.

## How it works

- `POST /api/ebay-connect` → eBay consent page → `GET /api/ebay-callback` stores tokens in `ebay_accounts`.
- `POST /api/ebay-listings` syncs via the **Trading API** `GetMyeBaySelling`, which covers listings
  created on eBay.com (the Inventory API only sees listings created through it).
- Access tokens (2 h) auto-refresh from the refresh token (~18 months) in `netlify/lib/ebay-seller.js`.
- Listings that disappear from eBay are marked `Ended`, not deleted.
