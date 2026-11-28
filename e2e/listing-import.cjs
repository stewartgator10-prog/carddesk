// On eBay: bring in older listings, search, edit title/description on a live card, update eBay. In-page buttons only.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const [DIST, OUT, PHOTO] = process.argv.slice(2);
const srv = http.createServer((req, res) => { let p = path.join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, 'index.html'); res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.woff2') ? 'font/woff2' : p.endsWith('.svg') ? 'image/svg+xml' : p.endsWith('.json') ? 'application/json' : 'text/html' }); fs.createReadStream(p).pipe(res); }).listen(4807);
const U = '11111111-1111-1111-1111-111111111111';
const mk = (id, title, over = {}) => ({ id, user_id: U, status: 'listed', publish_state: 'listed', game: 'pokemon', condition: 'NM', review_reasons: [], photo_edits: {}, photo_path: `${U}/ebay-import/${id}-p1.jpg`, extra_photo_paths: [], title, price: 9.99, description: 'Pack fresh.', ebay_live: { title, description: 'Pack fresh.' }, ebay_picture_urls: ['https://i.ebayimg.com/x.jpg'], ebay_item_id: '40' + id, ebay_url: 'https://www.ebay.com/itm/40' + id, listed_at: '2026-03-01', imported_from_ebay_at: '2026-11-27T22:00:00Z', created_at: '2026-11-27T22:00:00Z', ...over });
const db = { settings: [], api_usage: [], snap_items: [mk('0', 'Snorlax 143/165 Pokemon 151', { imported_from_ebay_at: null })] };
const pending = Array.from({ length: 10 }, (_, i) => String(500 + i));
const log = [], errors = [], calls = [];
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { errors.push('NATIVE POP-UP'); d.dismiss(); });
  await page.route('https://mockproj.supabase.co/**', (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (u.pathname.startsWith('/storage/v1/object/sign/') && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}'); calls.push('sign ' + (body.paths || []).length);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify((body.paths || []).map((p) => ({ path: p, signedURL: `/object/sign/snap-photos/${p}?t=1`, error: null }))) });
    }
    if (u.pathname.includes('/storage/v1/object/')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: fs.readFileSync(PHOTO) });
    const table = u.pathname.split('/rest/v1/')[1];
    if (table && req.method() === 'PATCH') { const patch = JSON.parse(req.postData()); const id = (u.searchParams.get('id') || '').replace('eq.', ''); const row = db.snap_items.find((r) => r.id === id); if (row) Object.assign(row, patch); calls.push('patch ' + Object.keys(patch).join(',')); }
    if (table && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(db[table] || []) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/listing-import', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') { const left = pending.filter((id) => !db.snap_items.some((s) => s.ebay_item_id === id)); return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: 11, inCardDesk: 11 - left.length, pending: left, needsFullSize: db._fixed ? [] : ['a', 'b', 'c', 'd', 'e', 'f'] }) }); }
    const body = JSON.parse(req.postData());
    if (body.action === 'full_size') { calls.push('full_size ' + body.ids.length); db._fixed = true; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results: body.ids.map((id) => ({ id, ok: id !== 'f', error: id === 'f' ? 'eBay returned no listing' : undefined })) }) }); }
    const { item_ids } = body; calls.push('import ' + item_ids.length);
    await new Promise((r) => setTimeout(r, 150));
    const results = item_ids.map((id) => { if (id === '507') return { item_id: id, ok: false, error: 'the listing has no photos' }; db.snap_items.push(mk('i' + id, `Pidgey ${id} Pokemon 151 Common`, { ebay_item_id: id })); return { item_id: id, ok: true }; });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
  });
  await page.route('**/api/snap-photos', (route) => {
    const b = JSON.parse(route.request().postData()); calls.push('snap-photos ' + b.action);
    const row = db.snap_items.find((r) => r.id === b.id); row.ebay_live = { title: row.title, description: row.description };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: { ...row } }) });
  });
  await page.addInitScript(([u]) => { localStorage.setItem('sb-mockproj-auth-token', JSON.stringify({ access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: u, email: 't@example.com', aud: 'authenticated', role: 'authenticated' } })); localStorage.setItem('cdp:migratedToSupabase', '1'); }, [U]);
  await page.goto('http://localhost:4807/?tab=snap');
  await page.getByRole('button', { name: /^On eBay \(1\)/ }).click();
  await page.getByText(/Full-size photos ready for 5 listings/).waitFor({ timeout: 15000 });
  log.push('full size: ' + (await page.getByRole('status').filter({ hasText: 'Full-size' }).innerText()).replace(/\s+/g, ' '));
  await page.getByRole('button', { name: 'Bring in 10 listings' }).click();
  await page.getByText(/Brought in 9 listings/).waitFor({ timeout: 15000 });
  log.push('after import: ' + (await page.getByRole('status').filter({ hasText: 'Brought in' }).innerText()).replace(/\s+/g, ' '));
  log.push('tab: ' + await page.getByRole('button', { name: /^On eBay/ }).innerText());
  await page.screenshot({ path: OUT + '/import.png' });
  await page.getByRole('searchbox', { name: 'Search cards' }).fill('snorlax');
  log.push('search shows: ' + (await page.getByRole('textbox', { name: 'eBay title' }).count()) + ' card');
  const title = page.getByRole('textbox', { name: 'eBay title' }).first();
  await title.fill('Snorlax 143/165 | Pokemon 151 | Holo Rare');
  await page.getByRole('textbox', { name: 'eBay description' }).first().click();
  await page.getByText(/Not on eBay yet: title/).waitFor();
  log.push('changed tab: ' + await page.getByRole('button', { name: /^Not on eBay yet/ }).innerText());
  await page.getByRole('button', { name: 'Update on eBay' }).click();
  const ad = page.getByRole('alertdialog');
  log.push('confirm: ' + (await ad.innerText()).replace(/\s+/g, ' ').slice(0, 170));
  await ad.getByRole('button', { name: 'Update on eBay' }).click();
  await page.getByText(/updated: title/).waitFor();
  log.push('banner gone: ' + ((await page.getByText(/Not on eBay yet: title/).count()) === 0));
  log.push('calls: ' + calls.join(' ; '));
  log.push('overflow px: ' + await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
  await page.screenshot({ path: OUT + '/import-edit.png' });
  await browser.close(); srv.close();
  console.log(log.join('\n')); console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
})().catch((e) => { console.error('FAILED', e.message.split('\n')[0]); console.log(log.join('\n')); console.log('calls', calls.join(' ; ')); console.log('ERRORS:', errors.join('\n')); process.exit(1); });
