/* Plays a full round through real pointer input in a phone-sized browser and saves screenshots. */
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path');
const out = path.join(__dirname, '..', 'shots');
require('fs').mkdirSync(out, { recursive: true });

(async () => {
  const date = process.argv[2] || '2026-11-10';
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, hasTouch: false });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto('file://' + path.join(__dirname, '..', 'dist', 'index.html') + '?date=' + date);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, '01-title.png') });
  await page.click('#play');
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(out, '02-hole1.png') });

  const state = () => page.evaluate(() => { const g = window.__dew.G; return { mode: g.mode, hi: g.hi, strokes: g.strokes, scores: g.scores.slice(), trails: g.trails.slice() }; });
  const plan = () => page.evaluate(() => {
    const { G, C } = window.__dew, h = G.hole, info = C.shotInfo(h, G.ball);
    const base = Math.atan2(h.pin.x - G.ball.x, h.pin.y - G.ball.y);
    let best = null;
    const span = info.putt ? 0.4 : 1.2, stepA = info.putt ? 0.02 : 0.06;
    for (let da = -span; da <= span; da += stepA) for (let p = 0.12; p <= 1; p += 0.04) {
      const r = C.runShot(h, G.ball, base + da, p, true);
      let cost = r.kind === 'holed' ? -5 : r.kind === 'water' ? 400 : C.dist(r, h.pin) + (r.lie === 0 ? 12 : r.lie === 5 ? 25 : 0) + (r.tree ? 30 : 0);
      if (!best || cost < best.cost) best = { a: base + da, p, cost };
    }
    const H = document.getElementById('stage').getBoundingClientRect().height;
    return { a: best.a, p: best.p, dragMax: Math.min(220, Math.max(140, H * 0.26)), putt: info.putt, lie: info.lie };
  });
  let shotNo = 0, snapped = {};
  for (let guard = 0; guard < 500; guard++) {
    const st = await state();
    if (st.mode === 'summary') break;
    if (st.mode === 'holed') {
      if (!snapped['m' + st.hi]) { await page.waitForTimeout(1500); await page.screenshot({ path: path.join(out, '05-moment-h' + (st.hi + 1) + '.png') }); snapped['m' + st.hi] = 1; }
      await page.mouse.click(195, 400); await page.waitForTimeout(700); continue;
    }
    if (st.mode !== 'aim') { await page.waitForTimeout(250); continue; }
    await page.waitForTimeout(st.strokes === 0 ? 2300 : 650);
    const pl = await plan();
    const sx = 195, sy = 330, len = pl.p * pl.dragMax;
    const ex = sx - Math.sin(pl.a) * len, ey = sy + Math.cos(pl.a) * len;
    await page.mouse.move(sx, sy); await page.mouse.down();
    await page.mouse.move(ex, ey, { steps: 8 });
    await page.waitForTimeout(140);
    shotNo++;
    if (!snapped['t' + st.hi] || (pl.putt && !snapped.putt)) { snapped['t' + st.hi] = 1;
      await page.screenshot({ path: path.join(out, '03-aim-' + String(shotNo).padStart(2, '0') + (pl.putt ? '-putt' : '') + '.png') });
      if (pl.putt) snapped.putt = 1; if (st.hi === 2) snapped.h3 = 1;
    }
    await page.mouse.up();
    await page.waitForTimeout(shotNo === 1 ? 900 : 300);
    if (shotNo === 1) await page.screenshot({ path: path.join(out, '04-flight.png') });
  }
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(out, '06-summary.png') });
  const fin = await state();
  console.log('final', JSON.stringify(fin));
  const share = await page.evaluate(() => { const { G, C } = window.__dew; return C.shareText('Dewsweeper No. 1', G.round, G.scores, G.trails); });
  console.log(share);
  console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
