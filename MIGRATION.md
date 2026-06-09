# CardDesk v2 — Migration & Deployment Guide

You're upgrading from v1 (static, no API) to v2 (with live eBay search and URL paste). This guide walks you through every step.

**Total time:** ~20–30 minutes start to finish.

---

## What's new in v2

- **Paste URL** field in the Deal Analyzer — paste any eBay item URL or TCGplayer URL, fields auto-fill
- **Live eBay Search** tab — search active eBay listings in real time with sharpness scoring
- All v1 features unchanged

---

## Before you start

You need:
- Your eBay App ID and Cert ID (already have these — keep them in a text file ready to paste)
- The `carddesk-v2.zip` file you downloaded with this guide
- Your existing Netlify site URL (where v1 is currently deployed)
- About 30 minutes

---

## Step 1: Back up your v1 data

**Do this first.** Your v1 site has watchlist/comps/inventory data that needs to come along.

1. Open your current CardDesk v1 site in your browser.
2. Click **Backup** in the top right.
3. A JSON file downloads to your Downloads folder. Save it somewhere safe (Desktop is fine).

You'll restore this data after v2 is live.

---

## Step 2: Set up the v2 project locally

1. Find `carddesk-v2.zip`. Right-click → Extract All → Desktop.
2. You should now have a `carddesk-v2` folder on your Desktop. Open it. You should see: `package.json`, `index.html`, `netlify.toml`, `src` folder, `netlify` folder, `public` folder.
3. Open Command Prompt inside this folder:
   - Click the address bar in File Explorer
   - Type `cmd` and hit Enter
4. Run the build commands (each one, hit Enter, wait for it to finish):
   ```
   npm install
   npm run build
   ```
5. After build completes, you should have a new `dist` folder.

**Important:** Unlike v1, you cannot just drag the `dist` folder to Netlify Drop anymore. v2 has a backend (Netlify Functions) that requires a proper deployment, not just static files. Follow the rest of these steps.

---

## Step 3: Deploy v2 to Netlify (replaces v1)

You have two options. Pick the easier one for you.

### Option A: Replace via Netlify CLI (recommended, ~5 min)

1. In the same Command Prompt window (still inside `carddesk-v2`), run:
   ```
   npm install -g netlify-cli
   ```
2. Then:
   ```
   netlify login
   ```
   A browser tab opens. Log in to Netlify and authorize.
3. Link this folder to your existing CardDesk site:
   ```
   netlify link
   ```
   It'll ask you to select your site. Pick your existing CardDesk site from the list.
4. Deploy:
   ```
   netlify deploy --prod
   ```
   When asked for "Publish directory," type `dist` and hit Enter.
5. Wait ~60 seconds. You'll get a confirmation that v2 is now live at your existing URL.

### Option B: Create a new Netlify site via GitHub (alternative)

If you'd rather start fresh: push the `carddesk-v2` folder to a new GitHub repo, then import it on Netlify the same way you did v1. Netlify will auto-detect the `netlify.toml` file and configure Functions correctly.

---

## Step 4: Add your eBay API keys as environment variables

**This is the critical step that makes Live Search and URL Paste actually work.** Without it, you'll get "Missing credentials" errors.

1. Go to https://app.netlify.com and open your CardDesk site.
2. Click **Site configuration** (or **Site settings**) in the left sidebar.
3. Click **Environment variables**.
4. Click **Add a variable** → **Add a single variable**.
5. Add the first variable:
   - **Key:** `EBAY_APP_ID`
   - **Value:** paste your eBay App ID (the Client ID, looks like `YourName-AppName-PRD-...`)
   - **Scopes:** leave all checked
   - Click **Create variable**
6. Add the second variable:
   - **Key:** `EBAY_CERT_ID`
   - **Value:** paste your eBay Cert ID (the Client Secret)
   - Click **Create variable**
7. **Trigger a redeploy** so the new variables take effect:
   - Go to **Deploys** tab in your Netlify site
   - Click the **Trigger deploy** dropdown → **Deploy site**
   - Wait ~60 seconds

---

## Step 5: Restore your v1 data

1. Open your CardDesk site (same URL as before).
2. You should now see a "v2.0 · LIVE" label in the header and new tabs (Live eBay Search).
3. Click **Restore** in the top right.
4. Select the backup JSON file you saved in Step 1.
5. Your watchlist, comps, and inventory should reappear.

---

## Step 6: Test Live Search

1. Click the **Live eBay Search** tab.
2. Type a card name in the search field — e.g. "Charizard VMAX Darkness Ablaze"
3. Optionally, type an FMV in the FMV field (e.g. 45) to get auto-scoring.
4. Click **▶ SEARCH**.
5. You should see a list of live eBay listings within 2–3 seconds. Each shows price, condition, seller, and (if FMV provided) a sharpness badge.

**If you see results: it works. You're done.**

**If you see an error:** check the "Troubleshooting" section below.

---

## Step 7: Test URL Paste

1. Go to eBay.com and find any active card listing.
2. Copy the URL from your browser's address bar.
3. In CardDesk, go to the **Deal Analyzer** tab.
4. Paste the URL into the "Paste Listing URL" field at the top.
5. Click **FETCH**.
6. Card name, price, shipping, and condition should auto-fill within 2–3 seconds.
7. Enter the FMV manually using the lookup link buttons.
8. The verdict appears instantly.

---

## Troubleshooting

**"Server error" or "Missing credentials" when searching**
- Your environment variables aren't set or the deploy didn't pick them up.
- Go back to Step 4, double-check both `EBAY_APP_ID` and `EBAY_CERT_ID` are saved.
- Trigger another deploy from the Deploys tab.

**"eBay OAuth failed: 401"**
- Your App ID or Cert ID is wrong, or your eBay developer keyset isn't fully activated yet.
- Confirm at https://developer.ebay.com/my/keys that your Production keyset shows no warnings.
- Re-copy both values carefully (no extra spaces).

**Live Search works but returns no results**
- Try simpler search terms. eBay's API can be picky — "Charizard VMAX" returns more than "Charizard VMAX 020/189 Darkness Ablaze BGS 9.5".

**URL Paste fails on TCGplayer**
- Expected for some URLs. TCGplayer pages load data via JavaScript that's harder to parse. Try the eBay URL paste instead, or enter the TCGplayer card manually.

**Functions returning 404**
- Make sure `netlify.toml` is in the project root and was included in your deploy.
- In Netlify dashboard, go to **Functions** tab and confirm `ebay-search` and `parse-listing` are listed.

---

## What it costs

Netlify Functions free tier: 125,000 requests/month and 100 GB-hours of function runtime. You will not approach these limits with personal use.

eBay API free tier: 5,000 calls/day with the standard application token. Massive headroom for manual research workflow.

**Bottom line: $0/month as long as you stay under those limits, which you will.**

---

## Security reminders

- Your eBay keys live ONLY in Netlify environment variables. They are never in code, never in GitHub, never visible to anyone visiting your site.
- The `.gitignore` file is configured to exclude `.env` files so even if you create one locally, it won't accidentally get pushed.
- If you ever suspect your keys are compromised, regenerate them on the eBay developer portal and update the environment variables in Netlify.
