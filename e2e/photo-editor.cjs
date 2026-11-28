// Photo strip + straighten & crop editor + live eBay photo update. In-page buttons only.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const [DIST, OUT, PHOTO] = process.argv.slice(2);
const srv = http.createServer((req, res) => { let p = path.join(DIST, decodeURIComponent(new URL(req.url, 'http://x').pathname)); if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, 'index.html'); res.writeHead(200, { 'Content-Type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.woff2') ? 'font/woff2' : p.endsWith('.svg') ? 'image/svg+xml' : 'text/html' }); fs.createReadStream(p).pipe(res); }).listen(4806);
const U = '11111111-1111-1111-1111-111111111111';
const base = { user_id: U, game: 'pokemon', confidence: 0.97, model: 'claude-opus-5-5', finish: 'holo', condition: 'NM', catalog_source: 'tcgdex', review_reasons: [], market_price: 4.2, photo_edits: {} };
const db = { settings: [], api_usage: [], snap_items: [
  { ...base, id: 'a1', status: 'ready', photo_path: `${U}/b/a1.jpg`, extra_photo_paths: [`${U}/b/a1-x-1.jpg`], card_name: 'Pidgeot ex', catalog_number: '164/165', catalog_set: '151', price: 4.89, title: 'Pidgeot ex 164/165 | Pokemon 151 | Holo', extraction: { card_corners: { tl: { x: 0.2, y: 0.1 }, tr: { x: 0.8, y: 0.1 }, br: { x: 0.8, y: 0.9 }, bl: { x: 0.2, y: 0.9 } } } },
  { ...base, id: 'a2', status: 'listed', photo_path: `${U}/b/a2-edit-aa.jpg`, extra_photo_paths: [], photo_edits: { [`${U}/b/a2-edit-aa.jpg`]: { original: `${U}/b/a2.jpg`, by: 'ai' } }, ebay_picture_urls: null, ebay_item_id: '4071', ebay_url: 'https://www.ebay.com/itm/4071', card_name: 'Pidgey', title: 'Pidgey 016/165 | Pokemon 151', price: 0.99, listed_at: new Date().toISOString() },
] };
const log = [], errors = [], calls = [];
(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => { errors.push('NATIVE POP-UP'); d.dismiss(); });
  await page.route('https://mockproj.supabase.co/**', (route) => {
    const req = route.request(); const u = new URL(req.url());
    if (u.pathname.startsWith('/storage/v1/object/sign/') && req.method() === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      if (body.paths) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body.paths.map((p) => ({ path: p, signedURL: `/object/sign/snap-photos/${p}?t=1`, error: null }))) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ signedURL: `/object/sign/snap-photos/${u.pathname.split('/snap-photos/')[1]}?t=1` }) });
    }
    if (u.pathname.includes('/storage/v1/object/')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: fs.readFileSync(PHOTO) });
    const table = u.pathname.split('/rest/v1/')[1];
    if (table && req.method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(db[table] || []) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/api/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/snap-photos', (route) => {
    const b = JSON.parse(route.request().postData()); calls.push(b.action + (b.corners ? ' corners ' + ['tl', 'br'].map((k) => `${b.corners[k].x.toFixed(2)},${b.corners[k].y.toFixed(2)}`).join(' ') : '') + (b.paths ? ' ' + b.paths.map((p) => p.split('/').pop()).join('|') : ''));
    const row = db.snap_items.find((r) => r.id === b.id);
    const all = [row.photo_path, ...row.extra_photo_paths];
    if (b.action === 'crop' || b.action === 'autocrop') {
      const np = b.path.replace('.jpg', '-edit-bb.jpg'); const o = all.map((p) => (p === b.path ? np : p));
      Object.assign(row, { photo_path: o[0], extra_photo_paths: o.slice(1), photo_edits: { ...row.photo_edits, [np]: { original: b.path, corners: b.corners, by: b.action === 'crop' ? 'manual' : 'ai' } } });
    } else if (b.action === 'undo') {
      const orig = row.photo_edits[b.path].original; const o = all.map((p) => (p === b.path ? orig : p)); const e = { ...row.photo_edits }; delete e[b.path];
      Object.assign(row, { photo_path: o[0], extra_photo_paths: o.slice(1), photo_edits: e });
    } else if (b.action === 'order') Object.assign(row, { photo_path: b.paths[0], extra_photo_paths: b.paths.slice(1) });
    else if (b.action === 'update_ebay') Object.assign(row, { ebay_picture_urls: ['https://i.ebayimg.com/1.jpg'] });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ item: { ...row } }) });
  });
  await page.addInitScript(([u]) => { localStorage.setItem('sb-mockproj-auth-token', JSON.stringify({ access_token: 'x.y.z', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: u, email: 't@example.com', aud: 'authenticated', role: 'authenticated' } })); localStorage.setItem('cdp:migratedToSupabase', '1'); }, [U]);
  await page.route('**/version.json*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"build":"newer"}' }));
  await page.goto('http://localhost:4806/?tab=snap');
  const strip = page.getByRole('group', { name: 'Listing photos' }).first();
  await strip.getByRole('button', { name: 'Main photo' }).waitFor({ timeout: 15000 });
  log.push('strip buttons: ' + (await strip.getByRole('button').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim() || '[thumb]').join(' / '));
  await page.screenshot({ path: OUT + '/strip.png' });

  // One tap: auto-fix every photo not edited yet
  await strip.getByRole('button', { name: 'Auto-fix all 2' }).click();
  await page.getByText(/Straightened 2 photos/).waitFor();
  log.push('auto-fix all done; button gone: ' + ((await strip.getByRole('button', { name: /Auto-fix/ }).count()) === 0));
  log.push('update banner: ' + await page.getByRole('status').filter({ hasText: 'CardDesk has been updated' }).innerText());
  await strip.getByRole('button', { name: /^Main photo/ }).click();
  await page.getByRole('button', { name: 'Undo edit' }).click();
  await page.waitForTimeout(300);
  await strip.getByRole('button', { name: /^Photo 2/ }).click();
  await page.getByRole('button', { name: 'Undo edit' }).click();
  await page.waitForTimeout(300);
  calls.length = 0;
  // Photo 2 -> make main
  await strip.getByRole('button', { name: 'Photo 2' }).click();
  await page.getByRole('button', { name: 'Make main' }).click();
  await page.waitForTimeout(300);
  // Main photo -> straighten & crop, drag the top-left dot
  await strip.getByRole('button', { name: /^Main photo/ }).click();
  await page.getByRole('button', { name: 'Straighten & crop' }).click();
  const dlg = page.getByRole('dialog', { name: 'Straighten & crop' });
  await dlg.getByRole('img', { name: 'Original photo' }).waitFor();
  const tl = dlg.getByRole('button', { name: "Card's top-left corner" });
  const bb = await tl.boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2); await page.mouse.down();
  await page.mouse.move(bb.x + 30, bb.y + 40, { steps: 5 }); await page.mouse.up();
  await tl.focus(); await page.keyboard.press('ArrowRight');
  await page.screenshot({ path: OUT + '/editor.png' });
  await dlg.getByRole('button', { name: 'Apply' }).click();
  await dlg.waitFor({ state: 'detached' });
  log.push('after apply: ' + await strip.getByRole('button', { name: /^Main photo/ }).getAttribute('aria-label'));
  await strip.getByRole('button', { name: /^Main photo/ }).click();
  await page.getByRole('button', { name: 'Undo edit' }).click();
  await page.waitForTimeout(300);
  await strip.getByRole('button', { name: /^Photo 2/ }).click();
  await page.getByRole('button', { name: 'Auto-fix', exact: true }).click();
  await page.waitForTimeout(300);
  await page.getByRole('button', { name: /^Photo 2/ }).first().click();
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.waitForTimeout(300);

  // Listed card: update photos on eBay through the in-page confirm
  await page.getByRole('button', { name: /^On eBay/ }).click();
  await page.getByRole('button', { name: 'Update photos on eBay' }).click();
  const ad = page.getByRole('alertdialog');
  log.push('confirm: ' + (await ad.innerText()).replace(/\s+/g, ' ').slice(0, 160));
  await ad.getByRole('button', { name: 'Update photos on eBay' }).click();
  await page.getByText(/Photos updated on eBay listing #4071/).waitFor();
  log.push('banner gone: ' + ((await page.getByText("These photos aren't on eBay yet").count()) === 0));
  log.push('calls: ' + calls.join(' ; '));
  log.push('overflow px: ' + await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth));
  await browser.close(); srv.close();
  console.log(log.join('\n')); console.log('ERRORS:', errors.length ? errors.join('\n') : 'none');
})().catch(async (e) => { console.error('FAILED', e.message.split('\n')[0]); console.log(log.join('\n')); console.log('calls', calls.join(' ; ')); console.log('ERRORS:', errors.join('\n')); process.exit(1); });
