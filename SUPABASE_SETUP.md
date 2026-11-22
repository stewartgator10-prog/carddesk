# CardDesk v3: accounts + Supabase

CardDesk now keeps inventory, comps, watchlist and settings in Supabase instead of the browser.
You sign in with email and password, and the same data shows up on every device.
The two eBay functions (`/api/ebay-search`, `/api/parse-listing`) now refuse calls from anyone not signed in.

## One-time setup (about 10 minutes)

1. **Supabase project.** Create a project (or pick one) in the Supabase dashboard.
2. **Tables.** (Already applied to the JaxsPics project.) Open SQL Editor and run the files in `supabase/migrations/` in order
   (or `supabase db push` if you use the CLI). It creates `inventory`, `watchlist`, `comps`, `settings`
   with row-level security so each account only sees its own rows.
3. **Auth settings** (Authentication > URL Configuration): set Site URL to your Netlify URL and add it
   to Redirect URLs, so confirm and password-reset emails land on the app.
4. **Netlify env vars** (Site configuration > Environment variables), then redeploy:
   - `VITE_SUPABASE_URL` = Project URL (Settings > API)
   - `VITE_SUPABASE_ANON_KEY` = publishable / anon key (safe in the browser; RLS protects the data)
   - `ALLOWED_EMAILS` = your email (optional but recommended; blocks other accounts from the eBay functions)
5. **Create your account** on the site with "Create account", confirm the email, sign in.
6. **Lock sign-ups** once your account exists: Authentication > Providers > Email > turn off "Allow new users to sign up".

## Bringing your old data over

- If you open the new site in the **same browser** you used before, a yellow bar offers to copy that
  browser's saved data into your account. Click **Import them**.
- Or use **Import Backup** in the header with a JSON file from the old **Backup** button.
- Importing is safe to repeat: items already imported (matched by their old id) are skipped, not duplicated.
  Imported settings replace your current fee settings.
- **Backup** still downloads a JSON copy of everything in your account.

## Local development

Copy `.env.example` to `.env.local`, fill in the Supabase values, then `npm install && npm run dev`.
Use `netlify dev` instead if you need the eBay functions locally.
