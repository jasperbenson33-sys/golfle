/* Plays a round of the 3D version through real pointer input and saves screenshots. */
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path');
const out = path.join(__dirname, '..', 'shots');
require('fs').mkdirSync(out, { recursive: true });
(async () => {
  const date = process.argv[2] || '2026-11-11', maxHoles = +(process.argv[3] || 3);
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
  await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ path: path.join(__dirname, '..', 'vendor', 'three.min.js'), contentType: 'application/javascript' }));
  await page.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await page.goto('file://' + path.join(__dirname, '..', 'dist', 'index.html') + '?date=' + date);
  await page.waitForTimeout(1500);
  const shot = (n) => page.screenshot({ path: path.join(out, n + '.png') });
  await shot('01-title');
  await page.click('#play');
  await page.waitForTimeout(700); await shot('02-intro');
  const state = () => page.evaluate(() => { const g = window.__dew.G; return { mode: g.mode, hi: g.hi, strokes: g.strokes, scores: g.scores.slice(), trails: g.trails.slice(), club: g.club, intro: g.intro, phase: g.shot ? g.shot.phase : '' }; });
  const plan = () => page.evaluate(() => {
    const { G, C } = window.__dew, h = G.hole; let best = null;
    const putt = G.club === 'putter', span = putt ? 0.4 : 0.5, st = putt ? 0.02 : 0.05;
    for (let da = -span; da <= span; da += st) for (let p = 0.12; p <= 1; p += 0.045) {
      const r = C.runShot(h, G.ball, G.club, G.base + da, p, true);
      const cost = r.kind === 'holed' ? -5 : r.kind === 'water' ? 400 : C.dist(r, h.pin) + (r.lie === 0 ? 12 : r.lie === 5 ? 25 : 0) + (r.tree ? 30 : 0);
      if (!best || cost < best.cost) best = { off: da, p, cost };
    }
    const H = document.getElementById('stage').getBoundingClientRect().height;
    return { off: best.off, p: best.p, dragMax: Math.min(290, Math.max(180, H * 0.33)), putt };
  });
  let n = 0; const snapped = {};
  for (let guard = 0; guard < 900; guard++) {
    const st = await state();
    if (st.mode === 'summary') break;
    if (st.mode === 'holed') {
      if (!snapped['m' + st.hi]) { await page.waitForTimeout(1600); await shot('06-moment-h' + (st.hi + 1)); snapped['m' + st.hi] = 1; if (st.hi + 1 >= maxHoles) break; }
      await page.mouse.click(195, 300); await page.waitForTimeout(500); continue;
    }
    if (st.mode !== 'aim' || st.intro > 0) { if (st.mode === 'flying' && st.phase === 'fly' && !snapped['f' + n]) { await shot('04-flight-' + n); snapped['f' + n] = 1; } await page.waitForTimeout(300); continue; }
    await page.waitForTimeout(900);
    if (!snapped['a' + st.hi + st.club]) { await shot('03-address-h' + (st.hi + 1) + '-' + st.club); }
    const pl = await plan(), sx = 195, sy = 250, deg = Math.abs(pl.off) * 180 / Math.PI;
    const c1 = pl.putt ? 0.035 : 0.06, c2 = pl.putt ? 0.0005 : 0.001, ad = (-c1 + Math.sqrt(c1 * c1 + 4 * c2 * deg)) / (2 * c2);
    await page.mouse.move(sx, sy); await page.mouse.down();
    await page.mouse.move(sx - Math.sign(pl.off) * ad, sy + pl.p * pl.dragMax, { steps: 8 });
    await page.waitForTimeout(1100);
    n++;
    if (!snapped['a' + st.hi + st.club]) { await shot('05-aim-h' + (st.hi + 1) + '-' + st.club); snapped['a' + st.hi + st.club] = 1; }
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1200);
  const fin = await state();
  if (fin.mode === 'summary') await shot('07-summary');
  console.log('final', JSON.stringify(fin));
  const fps = await page.evaluate(() => new Promise((res) => { let c = 0; const t0 = performance.now(); (function f() { c++; if (performance.now() - t0 > 1500) res(c / 1.5); else requestAnimationFrame(f); })(); }));
  console.log('software-rendered fps', fps.toFixed(1), '| draw calls', await page.evaluate(() => window.__dew.renderer.info.render.calls), 'triangles', await page.evaluate(() => window.__dew.renderer.info.render.triangles));
  console.log(errors.length ? 'ERRORS\n' + [...new Set(errors)].slice(0, 12).join('\n') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
