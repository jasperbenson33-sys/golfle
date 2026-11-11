const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path');
const out = path.join(__dirname, '..', 'shots');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 300, height: 560 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  await page.goto('file://' + path.join(__dirname, '..', 'dist', 'index.html'));
  await page.waitForTimeout(400);
  const dates = process.argv.slice(2);
  let n = 0;
  for (const d of dates) for (let i = 0; i < 3; i++) {
    await page.evaluate(([d, i]) => window.__dew.peek(d, i), [d, i]);
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(out, 'sheet-' + String(n++).padStart(2, '0') + '.png') });
  }
  await browser.close();
})();
