#!/usr/bin/env node
/* Screenshot tool for Dewsweeper 3D. Renders a built page in headless Chrome (software WebGL2) and saves PNGs.

   node tools/view.js --html dist/dev-water.html --date 2026-11-12 --hole 2 --scene address --out shots/water/address.png

   --html   built page (default dist/index.html)
   --date   course date key, e.g. 2026-11-12 (default)      --hole  hole index 0..2 (default 0)
   --scene  title | address | aim | flight | green | free | moment   (default address)
              title   : the title screen
              address : standing behind the ball before a shot
              aim     : address, then pull back and hold (see --power, --side)
              flight  : aim, release, capture during the shot (see --times)
              green   : ball placed on the green (see --putt), putter in hand; add --power to hold a putt, --times to release it
              free    : free camera (see --cam), interface hidden unless --hud
              moment  : holes out from next to the cup and captures the score moment (see --times, default "1.5,3")
   --ball   "x,y" put the ball here first (game coords, yards: x east, y north)
   --club   driver | iron | wedge | putter (tap this club before aiming)
   --power  0..1 pull strength for aim/flight (default 0.8)     --side  sideways finger travel in px (+ = finger right, aims left)
   --times  comma list of seconds after the strike to capture, in game time (default "0.4,1.4,2.6")
   --putt   yards from the cup for --scene green (default 7)
   --cam    "px,py,pz,lx,ly,lz" camera position and look-at point for --scene free (game coords, z up)
   --wait   extra ms to wait before the first capture (default 1200)   --frames n  capture n frames  --every ms  spacing (default 500)
   --size   WxH viewport in CSS px (default 390x780)   --dpr  device pixel ratio (default 1)
   --hud / --nohud  show or hide the interface         --eval "js"  run this in the page before capturing
   --quiet  only print errors

   Notes: software rendering is slow (roughly 5-12 fps), so game time runs slower than wall time. Captures are keyed
   to game time, not wall time. The cdnjs three.js URL is served from vendor/three.min.js; Google Fonts are blocked. */
const { chromium } = (function () { try { return require('/opt/npm-tools/node_modules/playwright'); } catch (e) { return require('playwright'); } })();
const path = require('path'), fs = require('fs');
const root = path.join(__dirname, '..');
const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; opt[k] = v; } }
const num = (s) => String(s).split(',').map(Number);
(async () => {
  const html = path.resolve(root, opt.html || 'dist/index.html'), date = opt.date || '2026-11-12', hole = +(opt.hole || 0), scene = opt.scene || 'address';
  const out = path.resolve(root, opt.out || 'shots/view.png'); fs.mkdirSync(path.dirname(out), { recursive: true });
  const [vw, vh] = (opt.size || '390x780').split('x').map(Number);
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await (await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: +(opt.dpr || 1) })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warning') && !/ERR_FAILED|net::|GPU stall|ReadPixels|GL Driver Message/.test(m.text())) errors.push(m.type() + ': ' + m.text().slice(0, 600)); });
  await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ path: path.join(root, 'vendor', 'three.min.js'), contentType: 'application/javascript' }));
  await page.route('https://fonts.googleapis.com/**', (r) => r.abort());
  await page.goto('file://' + html + '?date=' + date);
  await page.waitForTimeout(900);
  if (!(await page.evaluate(() => !!window.__dew))) { console.log('PAGE FAILED TO START\n' + errors.join('\n')); await browser.close(); process.exit(1); }
  const name = (i, n) => (n > 1 ? out.replace(/\.png$/, '-' + i + '.png') : out);
  const saved = [];
  const snap = async (file) => { await page.screenshot({ path: file }); saved.push(path.relative(root, file)); };
  const gameTime = () => page.evaluate(() => window.__dew.ctx.time);
  const waitGame = async (t) => { for (let i = 0; i < 400; i++) { if ((await gameTime()) >= t) return; await page.waitForTimeout(120); } };
  if (scene !== 'title') {
    await page.evaluate(([d, i]) => window.__dew.peek(d, i), [date, hole]);
    await page.waitForTimeout(400);
    if (opt.ball) { const [x, y] = num(opt.ball); await page.evaluate(([x, y]) => window.__dew.teleport(x, y), [x, y]); }
    if (scene === 'green' || scene === 'moment') {
      await page.evaluate((d) => { const { G, C } = window.__dew, h = G.hole; let best = null; for (let a = 0; a < 6.283; a += 0.2) { const x = h.pin.x + Math.cos(a - 1.57) * d, y = h.pin.y + Math.sin(a - 1.57) * d; if (C.terrainAt(h, x, y) === C.T.GREEN) { best = { x, y }; break; } } if (!best) best = { x: h.pin.x, y: h.pin.y - 1 }; window.__dew.teleport(best.x, best.y); }, scene === 'moment' ? 0.6 : +(opt.putt || 7));
    }
    if (opt.club) await page.evaluate((c) => { const el = document.getElementById('club-' + c); if (el && !el.disabled) el.click(); }, opt.club);
  }
  if (opt.nohud || (scene === 'free' && !opt.hud)) await page.evaluate(() => window.__dew.hud(false));
  if (scene === 'free' && opt.cam) { const c = num(opt.cam); await page.evaluate((c) => window.__dew.freeCam(c[0], c[1], c[2], c[3], c[4], c[5]), c); }
  if (opt.eval) await page.evaluate(opt.eval);
  await page.waitForTimeout(+(opt.wait || 1200));
  const dragMax = Math.min(290, Math.max(180, vh * 0.33)), sx = vw / 2, sy = vh * 0.3;
  const wantsAim = scene === 'aim' || scene === 'flight' || scene === 'moment' || (scene === 'green' && opt.power);
  if (wantsAim) {
    let power = +(opt.power || 0.8), side = +(opt.side || 0);
    if (scene === 'moment') { power = await page.evaluate(() => { const { G, C } = window.__dew; let best = 0.4, bd = 9; for (let p = 0.1; p <= 1; p += 0.02) { const r = C.runShot(G.hole, G.ball, 'putter', G.base, p, true); if (r.kind === 'holed') { return p; } const d = C.dist(r, G.hole.pin); if (d < bd) { bd = d; best = p; } } return best; }); }
    await page.mouse.move(sx, sy); await page.mouse.down();
    await page.mouse.move(sx + side, sy + power * dragMax, { steps: 6 });
    await page.waitForTimeout(1300);
    if (scene === 'aim' || (scene === 'green' && !opt.times)) { await snap(out); }
    else {
      await page.mouse.up();
      for (let i = 0; i < 100; i++) { if (await page.evaluate(() => window.__dew.G.mode !== 'aim' && window.__dew.G.mode !== 'swing')) break; await page.waitForTimeout(60); }
      const t0 = await gameTime(), times = num(opt.times || (scene === 'moment' ? '1.5,3' : '0.4,1.4,2.6'));
      for (let i = 0; i < times.length; i++) { await waitGame(t0 + times[i]); await snap(name(i, times.length)); }
    }
  } else {
    const n = +(opt.frames || 1);
    for (let i = 0; i < n; i++) { if (i) await page.waitForTimeout(+(opt.every || 500)); await snap(name(i, n)); }
  }
  const info = await page.evaluate(() => Object.assign(window.__dew.info(), { mode: window.__dew.G.mode, modules: window.__dew.FX.map((m) => m.name) }));
  const fps = await page.evaluate(() => new Promise((res) => { let c = 0; const t0 = performance.now(); (function f() { c++; if (performance.now() - t0 > 1200) res(c / 1.2); else requestAnimationFrame(f); })(); }));
  if (!opt.quiet) console.log('saved ' + saved.join(', ') + '\ninfo ' + JSON.stringify(info) + ' software fps ' + fps.toFixed(1));
  console.log(errors.length ? 'ERRORS (' + errors.length + ')\n' + [...new Set(errors)].slice(0, 10).join('\n') : 'no page errors');
  await browser.close();
})().catch((e) => { console.error('view.js failed: ' + e.message); process.exit(1); });
