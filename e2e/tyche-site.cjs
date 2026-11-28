const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const [DIST, DIST_CD, OUT] = process.argv.slice(2);
const serve = (dir, port) => http.createServer((req, res) => { let p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(dir, 'index.html'); const ext = path.extname(p); res.writeHead(200, { 'Content-Type': { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.json': 'application/json' }[ext] || 'text/html' }); fs.createReadStream(p).pipe(res); }).listen(port);
const s1 = serve(DIST, 4810), s2 = serve(DIST_CD, 4811);
const U = '11111111-1111-1111-1111-111111111111';
const log = [], errors = [], calls = [];
const auth = (page) => page.addInitScript(([u]) => { localStorage.setItem('sb-mockproj-auth-token', JSON.stringify({ access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: u, email: 't@example.com', aud: 'authenticated', role: 'authenticated' } })); localStorage.setItem('cdp:migratedToSupabase', '1'); }, [U]);
async function mocks(page, billing) {
  await page.route('https://mockproj.supabase.co/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/billing', (r) => { const req = r.request(); if (req.method() === 'POST') { calls.push('billing ' + req.postData()); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'http://localhost:4810/stripe-checkout-mock' }) }); } return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(billing) }); });
}
(async () => {
  const browser = await chromium.launch();
  // 1. Homepage, desktop and phone, signed out.
  for (const [name, vp] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    const page = await (await browser.newContext({ viewport: vp, deviceScaleFactor: 2 })).newPage();
    page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
    await mocks(page, { enabled: true });
    await page.goto('http://localhost:4810/');
    await page.getByRole('heading', { name: 'Fortune favors the listed.' }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/home-${name}.png` });
    log.push(`${name} overflow px: ` + await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
    await page.locator('.ty-founder').scrollIntoViewIfNeeded(); await page.waitForTimeout(400);
    await page.locator('.ty-founder').screenshot({ path: `${OUT}/home-founder-${name}.png` });
    log.push(name + ' images loaded: ' + await page.evaluate(() => [...document.images].map((i) => i.naturalWidth > 0).join(',')));
    if (name === 'desktop') {
      await page.locator('#pricing').scrollIntoViewIfNeeded();
      await page.getByRole('button', { name: /Yearly/ }).click();
      log.push('yearly pro price: ' + await page.locator('.ty-plan-pop .ty-price').innerText());
      log.push('pro button href: ' + await page.getByRole('link', { name: 'Choose Pro' }).getAttribute('href'));
      await page.locator('#pricing').screenshot({ path: `${OUT}/home-pricing.png` });
      await page.goto('http://localhost:4810/legal/terms');
      log.push('terms: ' + await page.getByRole('heading', { level: 1 }).innerText());
      await page.goto('http://localhost:4810/app?signup=1');
      log.push('signup screen: ' + (await page.getByText('create account').count() > 0) + ' brand: ' + await page.locator('h1.wordmark').innerText());
    }
  }
  // 2. App on Free: plan badge, locked section, a 402 opens the upgrade window, upgrade goes to checkout.
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('pageerror', (e) => errors.push('app pageerror: ' + e.message));
  page.on('dialog', (d) => { errors.push('NATIVE POP-UP'); d.dismiss(); });
  await auth(page);
  await mocks(page, { enabled: true, plan: 'free', used: 23, limit: 25, subscription: null });
  await page.goto('http://localhost:4810/app?tab=repricer');
  await page.getByText('23 of 25 cards').waitFor({ timeout: 15000 });
  log.push('locked repricer: ' + await page.getByRole('heading', { name: /The repricer is part of Pro/ }).count());
  await page.screenshot({ path: `${OUT}/app-locked.png` });
  await page.locator('header').first().screenshot({ path: `${OUT}/app-header.png` });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('tyche:upgrade', { detail: { code: 'UPGRADE', error: "You've used all 25 cards in your Free plan this month. Basic includes 300 a month." } })));
  await page.getByRole('dialog', { name: 'Plan & billing' }).waitFor(); await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/app-plans.png` });
  await page.getByRole('button', { name: 'Upgrade to Pro' }).click();
  await page.waitForURL(/stripe-checkout-mock/);
  log.push('checkout call: ' + calls.join(' | '));
  // 3. Homepage plan button -> sign in -> straight to checkout.
  calls.length = 0;
  const p2 = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  await auth(p2); await mocks(p2, { enabled: true, plan: 'free', used: 0, limit: 25, subscription: null });
  await p2.goto('http://localhost:4810/app?signup=1&plan=elite&interval=year');
  await p2.waitForURL(/stripe-checkout-mock/, { timeout: 15000 });
  log.push('plan intent call: ' + calls.join(' | '));
  // 4. Founder site (CardDesk build): / is the app, no plan badge, nothing locked.
  const p3 = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  p3.on('pageerror', (e) => errors.push('founder pageerror: ' + e.message));
  await auth(p3); await mocks(p3, { enabled: false, plan: 'elite', used: null, limit: null });
  await p3.goto('http://localhost:4811/?tab=repricer');
  await p3.locator('h1.wordmark').waitFor({ timeout: 15000 });
  log.push('founder brand: ' + await p3.locator('h1.wordmark').innerText() + ' · badge: ' + await p3.getByText(/cards$/).count() + ' · locked: ' + await p3.getByText(/is part of Pro/).count());
  await browser.close(); s1.close(); s2.close();
  console.log(log.join('\n')); console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
})().catch((e) => { console.error('FAILED', e.message.split('\n')[0]); console.log(log.join('\n')); console.log('ERRORS:', errors.join('\n')); process.exit(1); });
