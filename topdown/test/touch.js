const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 3, hasTouch: true, isMobile: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + path.join(__dirname, '..', 'dist', 'index.html') + '?date=2026-11-14');
  await page.waitForTimeout(500);
  await page.tap('#play'); await page.waitForTimeout(2200);
  const cdp = await ctx.newCDPSession(page);
  const tp = (x, y) => [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(200, 330) });
  for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(200 + i * 1.5, 330 + i * 16) }); await page.waitForTimeout(16); }
  await page.waitForTimeout(120);
  const mid = await page.evaluate(() => { const a = window.__dew.G.aim; return a ? { power: +a.power.toFixed(2), angle: +a.angle.toFixed(3) } : null; });
  await page.screenshot({ path: path.join(__dirname, '..', 'shots', '20-touch-aim.png') });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => { const g = window.__dew.G; return { mode: g.mode, strokes: g.strokes }; });
  console.log('touch aim', JSON.stringify(mid), '-> after release', JSON.stringify(after), errors.length ? 'ERRORS ' + errors.join('; ') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
