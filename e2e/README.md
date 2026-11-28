# Browser tests (Playwright)

Each script serves a mock build on localhost, intercepts Supabase and `/api/*` with fixtures, drives the
page with in-page buttons only (native pop-ups count as a failure) and prints a log plus `ERRORS: none`.

```bash
bash e2e/build.sh
mkdir -p e2e/.shots
node e2e/tyche-site.cjs e2e/.dist-tyche e2e/.dist e2e/.shots        # homepage, plans, checkout intent, founder site unchanged
node e2e/photo-editor.cjs e2e/.dist e2e/.shots e2e/fixtures/card-photo.jpg
node e2e/listing-import.cjs e2e/.dist e2e/.shots e2e/fixtures/card-photo.jpg
node e2e/model-trial.cjs e2e/.dist e2e/.shots
node e2e/email-templates.cjs supabase/templates e2e/.shots
```

Rules for new scripts:
- Phone width (390x844) is the default viewport; check `document.documentElement.scrollWidth - innerWidth === 0`.
- Fail on `pageerror` and on any native `alert/confirm/prompt` (the app uses in-page dialogs so AI agents can click through).
- Mock `https://mockproj.supabase.co/**` and `**/api/**`; never call real eBay, Stripe, Whatnot or Anthropic.
- Screenshots go to `e2e/.shots` (ignored by git). Look at them before reporting UI work as done.
