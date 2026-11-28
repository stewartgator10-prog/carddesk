const { chromium } = require('playwright'); const fs = require('fs');
const [DIR, OUT] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch();
  for (const [f, w] of [['confirm-signup', 600], ['reauthentication', 600], ['confirm-signup', 375]]) {
    const p = await (await b.newContext({ viewport: { width: w, height: 800 } })).newPage();
    const html = fs.readFileSync(`${DIR}/${f}.html`, 'utf8').replaceAll('{{ .ConfirmationURL }}', 'https://pcykpqlbbmgbjyfsntyp.supabase.co/auth/v1/verify?token=abc123&type=signup&redirect_to=https://tychecards.netlify.app/app').replaceAll('{{ .Email }}', 'seller@example.com').replaceAll('{{ .Token }}', '482913');
    await p.setContent(html);
    await p.screenshot({ path: `${OUT}/email-${f}-${w}.png`, fullPage: true });
    console.log(f, w, 'overflow', await p.evaluate(() => document.documentElement.scrollWidth - innerWidth));
  }
  await b.close();
})();
