/* Wild shots: exercises trees, water, sand, pickups, resume, practice, copy fallback, hot-restore. */
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const path = require('path');
const out = path.join(__dirname, '..', 'shots');
const url = 'file://' + path.join(__dirname, '..', 'dist', 'index.html') + '?date=2026-11-12';
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const state = () => page.evaluate(() => { const g = window.__dew.G; return { mode: g.mode, hi: g.hi, strokes: g.strokes, scores: g.scores.slice(), trails: g.trails.slice(), hint: document.getElementById('hint').textContent, practice: g.practice }; });
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  async function wild(maxShots, untilSummary) {
    let n = 0, seen = new Set();
    for (let guard = 0; guard < 900; guard++) {
      const st = await state();
      if (st.mode === 'summary') return st;
      if (st.mode === 'holed') { await page.waitForTimeout(1000); await page.mouse.click(180, 300); await page.waitForTimeout(400); continue; }
      if (st.mode !== 'aim') { await page.waitForTimeout(200); continue; }
      if (!untilSummary && n >= maxShots) return st;
      await page.waitForTimeout(250);
      const ang = (rnd() - 0.5) * 2.4, len = 40 + rnd() * 160;
      await page.mouse.move(180, 260); await page.mouse.down();
      await page.mouse.move(180 - Math.sin(ang) * len, 260 + Math.cos(ang) * len, { steps: 5 });
      await page.waitForTimeout(90);
      await page.mouse.up(); n++;
      const key = st.hint.slice(0, 12); if (st.hint && !seen.has(key)) { seen.add(key); }
    }
    return state();
  }
  await page.goto(url); await page.waitForTimeout(500);
  await page.click('#play'); await page.waitForTimeout(400);
  let st = await wild(5, false);
  console.log('after 5 wild shots', JSON.stringify(st));
  await page.screenshot({ path: path.join(out, '10-wild-small-screen.png') });
  await page.reload(); await page.waitForTimeout(500);
  console.log('after reload: play button says', await page.textContent('#play'));
  await page.click('#play'); await page.waitForTimeout(400);
  const res = await state(); console.log('resumed', JSON.stringify({ hi: res.hi, strokes: res.strokes, trails: res.trails }));
  st = await wild(0, true);
  console.log('round done', JSON.stringify(st));
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, '11-wild-summary.png') });
  await page.click('#share'); await page.waitForTimeout(300);
  console.log('share button:', await page.textContent('#share'), '| textarea hidden:', await page.evaluate(() => document.getElementById('share-text').hidden));
  await page.reload(); await page.waitForTimeout(600);
  console.log('reload after finishing: summary visible', await page.isVisible('#summary'), 'title visible', await page.isVisible('#title'));
  await page.click('#practice'); await page.waitForTimeout(500);
  st = await wild(3, false); console.log('practice', JSON.stringify({ mode: st.mode, practice: st.practice, hi: st.hi }));
  const snap = await page.evaluate(() => window.__dew.snapshot());
  console.log('snapshot', JSON.stringify(snap).slice(0, 160));
  /* hot restore */
  const page2 = await ctx.newPage();
  page2.on('pageerror', (e) => errors.push('pageerror2: ' + e.message));
  await page2.addInitScript((d) => { window.claude = { hot: { data: d, ready: (fn) => fn(d), snapshot: () => {} } }; }, { key: '2026-11-12', practice: false, mode: 'play', hi: 1, ball: { x: 5, y: 120 }, strokes: 1, scores: [4], trails: ['FGGH', 'F', ''] });
  await page2.goto(url); await page2.waitForTimeout(600);
  const st2 = await page2.evaluate(() => { const g = window.__dew.G; return { mode: g.mode, hi: g.hi, strokes: g.strokes, scores: g.scores, title: !document.getElementById('title').hidden, hud: !document.getElementById('hud').hidden }; });
  console.log('hot restore', JSON.stringify(st2));
  await page2.screenshot({ path: path.join(out, '12-hot-restore.png') });
  console.log(errors.length ? 'ERRORS\n' + errors.join('\n') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
