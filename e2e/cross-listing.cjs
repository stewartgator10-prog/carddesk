// Cross-listing on Whatnot: connect in Marketplaces, chips and sale notes on Snap cards, List on
// Whatnot with its price prompt and confirm, the chip menu, the Pro message on Tyche Cards.
// In-page buttons only; Whatnot and eBay are never called (every /api/* is mocked).
//   node e2e/cross-listing.cjs e2e/.dist e2e/.dist-tyche e2e/.shots e2e/fixtures/card-photo.jpg
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const [DIST, DIST_TYCHE, OUT, PHOTO] = process.argv.slice(2);
const serve = (dir, port) => http.createServer((req, res) => { let p = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(dir, 'index.html'); res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.woff2') ? 'font/woff2' : p.endsWith('.svg') ? 'image/svg+xml' : p.endsWith('.json') ? 'application/json' : 'text/html' }); fs.createReadStream(p).pipe(res); }).listen(port);
const srv = serve(DIST, 4821), srvT = serve(DIST_TYCHE, 4822);
const U = '11111111-1111-1111-1111-111111111111';
const TOKEN = 'wn_pat_tk_E2E_SECRET_123';
const mk = (id, title, over = {}) => ({ id, user_id: U, status: 'listed', publish_state: 'listed', game: 'pokemon', condition: 'NM', review_reasons: [], photo_edits: {}, photo_path: `${U}/b/${id}.jpg`, extra_photo_paths: [], title, price: 12.5, quantity: 1, description: 'Pack fresh.', ebay_live: { title, description: 'Pack fresh.' }, ebay_picture_urls: ['https://i.ebayimg.com/x.jpg'], ebay_item_id: '40' + id, ebay_url: 'https://www.ebay.com/itm/40' + id, listed_at: '2026-11-01', created_at: '2026-11-27T22:00:00Z', ...over });
const L = (id, card, marketplace, over = {}) => ({ id, user_id: U, snap_item_id: card, marketplace, external_id: marketplace + id, external_variant_id: 'V' + id, url: marketplace === 'ebay' ? `https://www.ebay.com/itm/${id}` : `https://www.whatnot.com/listing/${id}`, price: 12.5, quantity: 1, status: 'active', listed_at: '2026-11-20T00:00:00Z', created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z', ...over });
const db = {
  settings: [], api_usage: [],
  snap_items: [
    mk('1', 'Charizard ex 199/165 Pokemon 151 Special Illustration Rare', { quantity: 3 }),
    mk('2', 'Mew ex 151/165 Pokemon 151 Holo', { quantity: 0, sold_out_at: '2026-11-28T14:56:00Z', sale_note: { marketplace: 'whatnot', at: '2026-11-28T14:55:00Z', price: 14, quantity: 1, quantity_left: 0, ended: [{ marketplace: 'ebay', ok: true }], updated: [], double_sale: false, orders: [] } }),
    mk('3', 'Pikachu 025/165 Pokemon 151', { quantity: 0, sold_out_at: '2026-11-28T14:56:00Z', sale_note: { marketplace: 'whatnot', at: '2026-11-28T14:55:00Z', price: 9, quantity: 1, quantity_left: 0, ended: [{ marketplace: 'ebay', ok: false, error: 'eBay said: Internal error to the application.' }], updated: [], double_sale: false, orders: [] } }),
    mk('4', 'Bulbasaur 001/165 Pokemon 151', { quantity: 0, sale_note: { marketplace: 'whatnot', at: '2026-11-28T14:55:00Z', price: 5, quantity: 1, quantity_left: 0, ended: [], updated: [], double_sale: true, orders: [{ marketplace: 'ebay', url: 'https://www.ebay.com/sh/ord/1' }, { marketplace: 'whatnot', url: 'https://www.whatnot.com/order/2' }] } }),
    mk('5', 'Squirtle 007/165 Pokemon 151 Common', { status: 'approved', publish_state: null, ebay_item_id: null, ebay_url: null, ebay_live: null, ebay_picture_urls: null, price: 4.5 }),
  ],
  marketplace_listings: [
    L('e1', '1', 'ebay', { quantity: 3 }), L('w1', '1', 'whatnot', { quantity: 3, price: 13 }),
    L('e2', '2', 'ebay', { status: 'ended', ended_reason: 'sold_elsewhere' }), L('w2', '2', 'whatnot', { status: 'sold' }),
    L('e3', '3', 'ebay', { last_error: 'eBay said: Internal error to the application.' }), L('w3', '3', 'whatnot', { status: 'sold' }),
    L('e4', '4', 'ebay', { status: 'sold' }), L('w4', '4', 'whatnot', { status: 'sold' }),
  ],
};
let whatnot = { marketplace: 'whatnot', connected: false, activeCount: 0 };
const log = [], errors = [], calls = [];
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function setup(page, { billing = { enabled: false } } = {}) {
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { errors.push('NATIVE POP-UP'); d.dismiss(); });
  page.on('request', (r) => { if (/whatnot\.com|ebay\.com\/ws|api\.ebay\.com/.test(r.url()) && !/i\.ebayimg/.test(r.url())) errors.push('REAL MARKETPLACE CALL ' + r.url()); });
  await page.route('https://mockproj.supabase.co/**', (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (u.pathname.startsWith('/storage/v1/object/sign/') && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify((body.paths || []).map((p) => ({ path: p, signedURL: `/object/sign/snap-photos/${p}?t=1`, error: null }))) });
    }
    if (u.pathname.includes('/storage/v1/object/')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: fs.readFileSync(PHOTO) });
    const table = u.pathname.split('/rest/v1/')[1];
    if (table && req.method() === 'PATCH') { const patch = JSON.parse(req.postData()); const id = (u.searchParams.get('id') || '').replace('eq.', ''); const row = (db[table] || []).find((r) => r.id === id); if (row) Object.assign(row, patch); calls.push(`patch ${table} ${Object.keys(patch).join(',')}`); }
    if (table && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(db[table] || []) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/listing-import', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: 4, inCardDesk: 4, pending: [], needsFullSize: [] }) }));
  await page.route('**/api/billing', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(billing) }));
  await page.route('**/api/ebay-listings', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ account: { ebay_username: 'jaxcards', last_synced_at: new Date().toISOString() }, listings: [] }) }));
  await page.route('**/api/marketplaces', async (route) => {
    const req = route.request();
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    if (body) calls.push(`marketplaces ${req.method()} ${body.action || ''}${body.token ? ' token-sent' : ''}${body.endListings != null ? ' end=' + body.endListings : ''}`);
    if (req.method() === 'POST' && body.action === 'connect') {
      if (body.token !== TOKEN) return route.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: "Whatnot didn't accept that token. Check you copied all of it.", code: 'rejected' }) });
      whatnot = { marketplace: 'whatnot', connected: true, username: 'jaxcards', status: 'connected', salesCheckedAt: new Date(Date.now() - 3 * 60000).toISOString(), activeCount: 4, settings: { shippingProfileId: '501', shippingProfiles: [{ id: '501', name: 'Bubble mailer' }, { id: '502', name: 'Box' }] } };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ marketplace: whatnot }) });
    }
    const all = [{ marketplace: 'ebay', connected: true, username: 'jaxcards', status: 'connected', activeCount: 3 }, whatnot];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ marketplaces: all }) });
  });
  await page.route('**/api/marketplace-sales', (r) => { calls.push('sales check'); r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ checked: ['whatnot', 'ebay'], newSales: 1, ended: 1, problems: [] }) }); });
  await page.route('**/api/marketplace-listings', (route) => {
    const b = JSON.parse(route.request().postData()); calls.push(`listings ${b.action}${b.price ? ' $' + b.price : ''}${b.quantity ? ' q' + b.quantity : ''}`);
    if (b.action === 'create') { const l = L('w5', b.snapItemId, 'whatnot', { price: b.price }); db.marketplace_listings.push(l); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ listing: l }) }); }
    if (b.action === 'end') { const l = db.marketplace_listings.find((x) => x.id === b.listingId); Object.assign(l, { status: 'ended', ended_reason: 'sold_elsewhere', last_error: null }); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ listing: l }) }); }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.addInitScript(([u]) => { localStorage.setItem('sb-mockproj-auth-token', JSON.stringify({ access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: u, email: 't@example.com', aud: 'authenticated', role: 'authenticated' } })); localStorage.setItem('cdp:migratedToSupabase', '1'); }, [U]);
}

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await setup(page);

  // ---- Marketplaces: connect Whatnot ----
  await page.goto('http://localhost:4821/?tab=listings');
  const panel = page.getByRole('region', { name: 'Whatnot' });
  await panel.getByText('Not connected').waitFor({ timeout: 15000 });
  log.push('nav label: ' + ((await page.getByText('Marketplaces', { exact: true }).count()) > 0));
  log.push('panel: ' + (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 260));
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: OUT + '/xl-panel-empty.png', fullPage: true });
  await panel.getByRole('textbox', { name: 'Whatnot token' }).fill('abc123');
  await panel.getByRole('button', { name: 'Connect Whatnot' }).click();
  log.push('bad prefix: ' + await panel.getByRole('alert').innerText());
  await panel.getByRole('textbox', { name: 'Whatnot token' }).fill('wn_pat_tk_wrong');
  await panel.getByRole('button', { name: 'Connect Whatnot' }).click();
  await panel.getByText(/didn't accept that token/).waitFor();
  log.push('refused: ' + await panel.getByRole('alert').innerText());
  await panel.getByRole('textbox', { name: 'Whatnot token' }).fill(TOKEN);
  await panel.getByRole('button', { name: 'Connect Whatnot' }).click();
  await panel.getByText(/Connected as/).waitFor();
  log.push('connected: ' + (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 200));
  log.push('token cleared from field: ' + ((await page.locator('input[aria-label="Whatnot token"]').count()) === 0));
  await panel.getByRole('button', { name: 'Check for sales now' }).click();
  await panel.getByText(/new sale/).waitFor();
  log.push('check now: ' + await panel.getByRole('status').innerText());
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: OUT + '/xl-panel-connected.png', fullPage: true });
  await panel.getByRole('button', { name: 'Disconnect Whatnot' }).click();
  const choose = page.getByRole('dialog', { name: 'Disconnect Whatnot' });
  log.push('disconnect asks: ' + (await choose.innerText()).replace(/\s+/g, ' ').slice(0, 220));
  await page.screenshot({ path: OUT + '/xl-disconnect.png' });
  await choose.getByRole('button', { name: 'Cancel' }).click();
  log.push('panel overflow px: ' + await overflow(page));

  // ---- Snap to List: chips, notes, List on Whatnot ----
  await page.goto('http://localhost:4821/?tab=snap');
  await page.getByRole('button', { name: /^On eBay \(4\)/ }).click();
  await page.getByText(/Ended on eBay automatically/).waitFor({ timeout: 15000 });
  for (const t of await page.getByRole('status').filter({ hasText: /Sold/ }).allInnerTexts()) log.push('note: ' + t.replace(/\s+/g, ' '));
  log.push('chips: ' + (await page.locator('button', { hasText: /^(eBay|Whatnot) · |^(Sold|Ended) on / }).allInnerTexts()).join(' | '));
  log.push('tabs: ' + (await page.getByRole('button', { name: /^On Whatnot/ }).innerText()));
  await page.screenshot({ path: OUT + '/xl-snap-listed.png', fullPage: true });
  log.push('snap overflow px: ' + await overflow(page));
  // End on eBay from the red note
  await page.getByRole('button', { name: 'End on eBay' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'End on eBay' }).click();
  await page.getByText('Ended on eBay.').waitFor();
  log.push('after End on eBay: ' + ((await page.getByText(/listing is still up/).count()) === 0 ? 'note is normal again' : 'still red'));
  // Whatnot chip menu
  await page.getByRole('button', { name: /^Whatnot · \$13\.00 · 3 left: change or end/ }).click();
  log.push('chip menu: ' + (await page.getByRole('dialog', { name: 'Whatnot listing' }).innerText()).replace(/\s+/g, ' ').slice(0, 200));
  await page.screenshot({ path: OUT + '/xl-chip-menu.png' });
  await page.getByRole('dialog', { name: 'Whatnot listing' }).getByRole('button', { name: 'Cancel' }).click();
  // Approved card: List on Whatnot
  await page.getByRole('button', { name: /^Approved \(1\)/ }).click();
  log.push('bulk button: ' + await page.getByRole('button', { name: /^LIST \d+ ON WHATNOT/ }).innerText());
  await page.getByRole('button', { name: 'List on Whatnot' }).click();
  const ask = page.getByRole('dialog', { name: 'Whatnot price' });
  log.push('price prompt: ' + (await ask.innerText()).replace(/\s+/g, ' ').slice(0, 80) + ' | prefilled ' + await ask.getByRole('textbox').inputValue());
  log.push('sent before confirm: ' + calls.filter((c) => c.startsWith('listings create')).length);
  await ask.getByRole('textbox').fill('5.00');
  await ask.getByRole('button', { name: 'Next' }).click();
  const conf = page.getByRole('alertdialog');
  await conf.getByText(/List on Whatnot now/).waitFor();
  log.push('confirm: ' + (await conf.innerText()).replace(/\s+/g, ' ').slice(0, 220));
  log.push('sent before confirm: ' + calls.filter((c) => c.startsWith('listings create')).length);
  await page.screenshot({ path: OUT + '/xl-confirm.png' });
  await conf.getByRole('button', { name: 'List on Whatnot' }).click();
  await page.getByText('Listed on Whatnot.').waitFor();
  log.push('chip after: ' + (await page.locator('button', { hasText: /^Whatnot · \$5\.00/ }).count()));
  log.push('qty field: ' + (await page.getByRole('spinbutton', { name: 'Quantity' }).count()));
  await page.screenshot({ path: OUT + '/xl-listed-whatnot.png', fullPage: true });
  log.push('overflow px: ' + await overflow(page));

  // ---- desktop ----
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: /^On eBay \(4\)/ }).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/xl-snap-desktop.png', fullPage: true });

  // ---- Tyche Cards, Free plan: the Pro message ----
  const p2 = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  whatnot = { marketplace: 'whatnot', connected: false, activeCount: 0 };
  await setup(p2, { billing: { enabled: true, plan: 'free', used: 3, limit: 25, subscription: null } });
  await p2.goto('http://localhost:4822/app?tab=listings');
  const tp = p2.getByRole('region', { name: 'Whatnot' });
  await tp.getByText(/part of the Pro plan/).waitFor({ timeout: 15000 });
  log.push('tyche free: ' + (await tp.innerText()).replace(/\s+/g, ' '));
  log.push('tyche paste field shown: ' + await tp.getByRole('textbox', { name: 'Whatnot token' }).count());
  await tp.scrollIntoViewIfNeeded();
  await p2.screenshot({ path: OUT + '/xl-tyche-free.png', fullPage: true });
  log.push('tyche overflow px: ' + await overflow(p2));

  log.push('calls: ' + calls.join(' ; '));
  log.push('token in any call log: ' + calls.some((c) => c.includes(TOKEN)));
  await browser.close(); srv.close(); srvT.close();
  console.log(log.join('\n')); console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
})().catch((e) => { console.error('FAILED', e.message.split('\n')[0]); console.log(log.join('\n')); console.log('calls', calls.join(' ; ')); console.log('ERRORS:', errors.join('\n')); process.exit(1); });
