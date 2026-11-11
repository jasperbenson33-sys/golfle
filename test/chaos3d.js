/* Wild shots in the 3D version: trees, water, sand, pickups, resume, summary, practice, copy, hot-restore, touch. */
const { chromium } = (function () { try { return require('/opt/npm-tools/node_modules/playwright'); } catch (e) { return require('playwright'); } })();
const path = require('path');
const out = path.join(__dirname, '..', 'shots');
const url = 'file://' + path.join(__dirname, '..', 'dist', 'index.html') + '?date=2026-11-14';
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 1, hasTouch: true });
  const errors = [];
  const wire = async (page, tag) => {
    page.on('pageerror', (e) => errors.push(tag + ' pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/ERR_FAILED/.test(m.text())) errors.push(tag + ' console: ' + m.text().slice(0, 300)); });
    await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ path: path.join(__dirname, '..', 'vendor', 'three.min.js'), contentType: 'application/javascript' }));
    await page.route('https://fonts.googleapis.com/**', (r) => r.abort());
  };
  const page = await ctx.newPage(); await wire(page, 'p1');
  const state = () => page.evaluate(() => { const g = window.__dew.G; return { mode: g.mode, hi: g.hi, strokes: g.strokes, scores: g.scores.slice(), trails: g.trails.slice(), practice: g.practice, club: g.club, intro: g.intro }; });
  let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const lies = new Set();
  async function wild(maxShots, untilSummary) {
    let n = 0;
    for (let guard = 0; guard < 1500; guard++) {
      const st = await state();
      if (st.mode === 'summary') return st;
      if (st.mode === 'holed') { await page.waitForTimeout(1300); await page.mouse.click(180, 260); await page.waitForTimeout(500); continue; }
      if (st.mode === 'flying') { await page.mouse.click(180, 260); await page.waitForTimeout(250); continue; }
      if (st.mode !== 'aim' || st.intro > 0) { await page.waitForTimeout(200); continue; }
      if (!untilSummary && n >= maxShots) return st;
      lies.add(await page.evaluate(() => window.__dew.C.LIE_NAME[window.__dew.G.opt.lie] + '/' + window.__dew.G.club));
      if (n % 4 === 2) { const ids = ['driver', 'iron', 'wedge']; await page.evaluate((id) => document.getElementById('club-' + id).click(), ids[n % 3]); }
      const ang = (rnd() - 0.5) * 1.6, len = 30 + rnd() * 150;
      await page.mouse.move(180, 220); await page.mouse.down();
      await page.mouse.move(180 - Math.sin(ang) * len, 220 + Math.cos(ang) * len, { steps: 4 });
      await page.waitForTimeout(160);
      await page.mouse.up(); n++;
      await page.waitForTimeout(300);
    }
    return state();
  }
  await page.goto(url); await page.waitForTimeout(1200);
  await page.click('#play'); await page.waitForTimeout(400);
  let st = await wild(4, false);
  console.log('after 4 wild shots', JSON.stringify(st));
  await page.screenshot({ path: path.join(out, '10-wild.png') });
  await page.reload(); await page.waitForTimeout(1200);
  console.log('after reload: play button says', await page.textContent('#play'));
  await page.click('#play'); await page.waitForTimeout(600);
  const res = await state(); console.log('resumed', JSON.stringify({ hi: res.hi, strokes: res.strokes, trails: res.trails }));
  st = await wild(0, true);
  console.log('round done', JSON.stringify(st));
  console.log('lies/clubs seen:', [...lies].join(', '));
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(out, '11-summary.png') });
  await page.click('#share'); await page.waitForTimeout(300);
  console.log('share button:', await page.textContent('#share'), '| textarea hidden:', await page.evaluate(() => document.getElementById('share-text').hidden));
  await page.reload(); await page.waitForTimeout(1300);
  console.log('reload after finishing: summary visible', await page.isVisible('#summary'), 'title visible', await page.isVisible('#title'));
  await page.click('#practice'); await page.waitForTimeout(600);
  st = await wild(2, false); console.log('practice', JSON.stringify({ mode: st.mode, practice: st.practice, hi: st.hi }));
  /* real touch drag */
  const cdp = await ctx.newCDPSession(page);
  const before = (await state()).strokes;
  const tp = (x, y) => [{ x, y, id: 1, radiusX: 8, radiusY: 8, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(180, 220) });
  for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(180 + i, 220 + i * 14) }); await page.waitForTimeout(30); }
  await page.waitForTimeout(200);
  const aimNow = await page.evaluate(() => { const a = window.__dew.G.aim; return a ? { power: +a.power.toFixed(2), off: +a.off.toFixed(3) } : null; });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(700);
  console.log('touch aim', JSON.stringify(aimNow), '-> strokes', before, '->', (await state()).strokes);
  /* hot restore */
  const page2 = await ctx.newPage(); await wire(page2, 'p2');
  await page2.addInitScript((d) => { window.claude = { hot: { data: d, ready: (fn) => fn(d), snapshot: () => {} } }; }, { key: '2026-11-14', practice: false, mode: 'play', hi: 1, ball: { x: 5, y: 120 }, strokes: 1, scores: [4], trails: ['FGGH', 'F', ''] });
  await page2.goto(url); await page2.waitForTimeout(1500);
  console.log('hot restore', JSON.stringify(await page2.evaluate(() => { const g = window.__dew.G; return { mode: g.mode, hi: g.hi, strokes: g.strokes, scores: g.scores, title: !document.getElementById('title').hidden, hud: !document.getElementById('hud').hidden }; })));
  await page2.screenshot({ path: path.join(out, '12-hot-restore.png') });
  console.log(errors.length ? 'ERRORS\n' + [...new Set(errors)].slice(0, 12).join('\n') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
