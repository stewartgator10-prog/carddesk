# CardDesk / Tyche Cards

A selling desk for trading card sellers: snap a card, the AI identifies and prices it, the photo is
cleaned up, and it's listed on eBay; then repricing, Best Offer, collection tracking, buy offers and
profit per card. Built by TechBox Solutions.

## Two sites, one codebase
| | Founder / test site | Public product |
|---|---|---|
| Address | jaxspic.netlify.app (Netlify site `f1aa096b-…`) | tychecards.netlify.app (`71c07cec-…`) |
| Name in the UI | CardDesk | Tyche Cards (`VITE_BRAND=tyche`) |
| Plans and limits | none (`BILLING_ENABLED` unset) | Free / Basic / Pro / Elite (`BILLING_ENABLED=true`) |
| `/` | the app | homepage; app at `/app` |
| Nightly refresh | runs it for everyone | `NIGHTLY_REFRESH=off` |

Both sites share one Supabase project (JaxsPics, `pcykpqlbbmgbjyfsntyp`) and deploy from `main` for now.
Jackson (the founding seller) uses jaxspic; new features are tried there first. **A change must never
alter the founder site unless that is the point of it**: anything Tyche-only checks `IS_TYCHE`
(src/brand.jsx) or `billingEnabled()` (netlify/lib/billing.js).

## Stack and layout
- React 18 + Vite (`src/`). Big tabs are lazy-loaded. Theme tokens in `src/theme.css`; the public site
  styles live in `src/home.css` (`.ty-*`).
- Netlify Functions, ESM, one per endpoint with `export const config = { path: '/api/…' }`
  (`netlify/functions/`), shared logic in `netlify/lib/` (browser-safe modules such as
  `snap-logic.js` and `plans.js` are imported by the app too).
- Supabase with row-level security; functions use the service role via `getSupabaseAdmin()` and always
  filter by `user_id`. Migrations live in `supabase/migrations/` and are applied with the Supabase MCP
  `apply_migration` (additive; never drop data without the user's say-so).
- AI: Anthropic SDK in `netlify/lib/card-vision.js`. Snaps read with Haiku first and escalate to Opus
  for hard cards (`readCardRouted` in `netlify/lib/snap-identify.js`). Every call is logged to `api_usage`.
- eBay: Trading API + Media API (`netlify/lib/ebay-listing.js`, `ebay-seller.js`, `trading-price.js`).
- Stripe billing: plain REST in `netlify/lib/billing.js`; prices by lookup key `tyche_<plan>_<month|year>`.
- AI app connector (MCP) at `/mcp` (`netlify/functions/mcp.js`, tools in `netlify/lib/mcp-tools.js`).

## Commands
```bash
npm test                 # node --test tests/*.test.js (all must pass)
npm run build            # founder build; VITE_BRAND=tyche npm run build for the product build
bash e2e/build.sh        # mock builds for the browser tests, then see e2e/README.md
```

## Rules that keep coming up
- **Plans**: a new paid feature gets an entry in `FEATURE_PLAN` (netlify/lib/plans.js), a
  `requireFeature()` check on its endpoint, and (if it has a view) an entry in `VIEW_FEATURE`
  (src/CardDeskPro.jsx). Anything the AI reads counts toward the card limit via `requireCards()`.
- **No native pop-ups**: use `askConfirm/askValue/askChoice` (src/lib/dialog.jsx). AI agents drive this app.
- **Live marketplace changes need a yes**: in the UI an in-page confirm; in MCP tools `user_confirmed=true`.
- **Phone first**: every screen works at 390 px wide with no sideways scroll.
- **Copy**: plain words from the seller's side ("listing", "card", "price"), no jargon, no apologies.
- **Secrets** live only in Netlify environment variables. Never ask for one in chat; use the
  request-credential flow or tell the user where to paste it.
- **Stripe is live mode** (TechBox Solutions account, shared with other products). Never create charges
  or change other products; Tyche Cards objects carry `metadata.app = tyche_cards`.
- **Outside services** (Gmail, Resend, Stripe, eBay, Whatnot): read freely; anything that sends,
  publishes, charges or emails a person needs the user's go-ahead in this conversation.
- Commits and PRs follow the attribution lines the session gives; no model names in commits or PRs.

## Shipping
1. Work on the session's branch; `npm test` and the relevant `e2e/` scripts pass.
2. PR to `main` with a Why / What / Tests body, then merge (expected head SHA).
3. Re-sync the branch with `main`, then confirm the new Netlify deploy is `ready` for both sites.
4. Database migrations: apply to JaxsPics with the Supabase MCP and commit the SQL in the same PR.

## The agent team
Defined in `.claude/agents/`. The saved workflow `.claude/workflows/feature.js` runs them in order
for a feature: Product lead → Builder → Critic + Inspector (in parallel) → fix loop → Marketer.
Deploying stays with the main session because merges and migrations touch production.

| Agent | Job |
|---|---|
| `product-lead` | Turns a request into a scoped spec with acceptance criteria; keeps `docs/ROADMAP.md`. |
| `builder` | Implements the spec with tests, following the rules above. |
| `critic` | Reviews the diff for bugs, security, plan gating, founder-site safety, simplicity. Read-only. |
| `inspector` | Runs tests and browser checks at phone and desktop width; judges clarity and ease of use. |
| `marketer` | Release notes, homepage and email copy, seller-facing guides. Drafts only. |
| `deployer` | PR, merge, migrations, deploy checks, promotion to Tyche. Only when the user asks. |

Research notes for integrations live in `docs/marketplaces/`.
