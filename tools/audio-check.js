#!/usr/bin/env node
/* tools/audio-check.js -- render every Dewsweeper sound offline and measure it.
 *   node tools/audio-check.js [fx/audio.js]
 * Loads the module into headless Chrome, builds DewAudio.Engine on an OfflineAudioContext per sound, renders,
 * and prints: active duration (to -60 dBFS), peak, RMS over the active part, tail level (last 20 ms), and the
 * share of energy below 200 Hz / above 2 kHz (same render, seeded, through 4th-order filters).
 * Also exercises the live api (before init, after init, muted) to make sure nothing throws.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = (function () { try { return require('/opt/npm-tools/node_modules/playwright'); } catch (e) { return require('playwright'); } })();
const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'fx', 'audio.js'));

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setContent('<html><body></body></html>');
  await page.addScriptTag({ content: fs.readFileSync(file, 'utf8') });

  const res = await page.evaluate(async () => {
    const SR = 44100;
    let seed = 1;
    const realRandom = Math.random;
    function seedRandom(s) { seed = s; Math.random = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
    const CASES = {
      'driver p1': [0.5, (E) => E.swing(0.05, 1, 'driver')],
      'driver p0.4': [0.5, (E) => E.swing(0.05, 0.4, 'driver')],
      'iron p0.8': [0.5, (E) => E.swing(0.05, 0.8, 'iron')],
      'wedge p0.6': [0.5, (E) => E.swing(0.05, 0.6, 'wedge')],
      'putt p0.3': [0.4, (E) => E.putt(0.05, 0.3)],
      'putt p1': [0.4, (E) => E.putt(0.05, 1)],
      'land rough 20': [0.6, (E) => E.land(0.05, 0, 20)],
      'land fairway 30': [0.6, (E) => E.land(0.05, 1, 30)],
      'land green 8': [0.6, (E) => E.land(0.05, 4, 8)],
      'sand': [0.8, (E) => E.sand(0.05)],
      'splash': [2.2, (E) => E.splash(0.05)],
      'tree': [1.4, (E) => E.tree(0.05)],
      'lip': [0.5, (E) => E.lip(0.05)],
      'cup': [1.0, (E) => E.cup(0.05)],
      'chime -3': [4.5, (E) => E.chime(0.05, -3)],
      'chime -1': [4.5, (E) => E.chime(0.05, -1)],
      'chime 0': [3.5, (E) => E.chime(0.05, 0)],
      'chime +2': [3.5, (E) => E.chime(0.05, 2)],
      'bird two': [1.4, (E) => E.bird({ kind: 'two', f: 3800, pan: -0.5, far: 0.15 }, 0.05)],
      'bird trill': [1.6, (E) => E.bird({ kind: 'trill', f: 4700, pan: 0.5, far: 0.45 }, 0.05)],
      'bird desc': [1.6, (E) => E.bird({ kind: 'desc', f: 4000, pan: 0, far: 0.1 }, 0.05)],
      'bird crow (far)': [2.2, (E) => E.bird({ kind: 'crow', pan: 0.6, far: 0.85 }, 0.05)],
      'bird pecker (far)': [1.6, (E) => E.bird({ kind: 'pecker', pan: -0.6, far: 0.85 }, 0.05)],
      'roll green 6yd/s': [1.5, (E) => { E.roll(6, 4); }],
      'roll fairway 15yd/s': [1.5, (E) => { E.roll(15, 1); }],
      'BED calm title': [6, (E) => E.bed(0, 'title', true)],
      'BED 7mph aim': [6, (E) => E.bed(7, 'aim', true)],
      'BED 12mph title': [6, (E) => E.bed(12, 'title', true)],
      'BED 15mph flying': [6, (E) => E.bed(15, 'flying', true)],
      'BED 12mph title+birds': [6, (E) => { E.bed(12, 'title', true); E.bird({ kind: 'two', f: 3800, pan: -0.5, far: 0.15 }, 0.5); E.bird({ kind: 'desc', f: 4000, pan: 0.2, far: 0.1 }, 2.4); E.bird({ kind: 'trill', f: 4700, pan: 0.6, far: 0.45 }, 4); }],
      'STACK worst': [4.5, (E) => {
        E.bed(15, 'title', true);
        E.swing(0.05, 1, 'driver'); E.land(0.12, 4, 35); E.cup(0.15); E.splash(0.1); E.tree(0.11);
        E.bird({ kind: 'two', f: 3800, pan: 0, far: 0 }, 0.05); E.bird({ kind: 'desc', f: 4000, pan: 0, far: 0 }, 0.08);
        E.chime(0.0, -3); E.chime(0.0, -1); E.roll(30, 4);
      }]
    };
    async function render(name, filter) {
      const [len, fn] = CASES[name];
      seedRandom(12345);
      const L = /^BED|^STACK|^roll/.test(name) ? len : len + 1.4;   // room for the reverb tail
      const ctx = new OfflineAudioContext(2, Math.floor(SR * L), SR);
      let dest = ctx.destination;
      if (filter) {
        const a = ctx.createBiquadFilter(), b = ctx.createBiquadFilter();
        a.type = b.type = filter[0]; a.frequency.value = b.frequency.value = filter[1];
        a.connect(b); b.connect(ctx.destination); dest = a;
      }
      const E = DewAudio.Engine(ctx, dest, { on: true });
      fn(E);
      const buf = await ctx.startRendering();
      Math.random = realRandom;
      return [buf.getChannelData(0), buf.getChannelData(1)];
    }
    function energy(ch) { let s = 0; for (const c of ch) for (let i = 0; i < c.length; i++) s += c[i] * c[i]; return s; }
    const out = [];
    for (const name of Object.keys(CASES)) {
      const ch = await render(name);
      const n = ch[0].length;
      let peak = 0, first = -1, last = -1;
      for (let i = 0; i < n; i++) {
        const a = Math.max(Math.abs(ch[0][i]), Math.abs(ch[1][i]));
        if (a > peak) peak = a;
        if (a > 0.001) { if (first < 0) first = i; last = i; }
      }
      let s = 0, cnt = 0;
      for (let i = Math.max(first, 0); i <= last; i++) { s += ch[0][i] * ch[0][i] + ch[1][i] * ch[1][i]; cnt += 2; }
      const rms = cnt ? Math.sqrt(s / cnt) : 0;
      let ts = 0; const tn = Math.floor(0.02 * SR);
      for (let i = n - tn; i < n; i++) ts += ch[0][i] * ch[0][i] + ch[1][i] * ch[1][i];
      const tail = Math.sqrt(ts / (2 * tn));
      const row = { name, dur: first < 0 ? 0 : (last - first) / SR, peak, rms, tail };
      if (!/^BED|^STACK|^roll/.test(name)) {
        const tot = energy(ch) + 1e-20;
        row.low = energy(await render(name, ['lowpass', 200])) / tot;
        row.high = energy(await render(name, ['highpass', 2000])) / tot;
      }
      out.push(row);
    }
    // live api: must never throw, before init, after init, muted
    const live = [];
    try {
      const api = DewAudio({ muted: false });
      const all = (tag) => { ['tick', 'swing', 'putt', 'land', 'sand', 'splash', 'tree', 'lip', 'cup', 'roll', 'chime'].forEach((m) => { api[m](0.016, { windMph: 9, mode: 'aim' }); }); live.push(tag + ' ok'); };
      all('before init');
      api.init(); api.init();
      await new Promise((r) => setTimeout(r, 300));
      for (let i = 0; i < 30; i++) api.tick(0.05, { windMph: 9, mode: 'title' });
      api.swing(1, 'driver'); api.putt(0.5); api.land(1, 20); api.roll(10, 4); api.chime(-2);
      all('running');
      api.setOn(false); all('muted'); api.setOn(true);
      const m = DewAudio({ muted: true }); m.init(); m.swing(1, 'driver'); live.push('muted-start ok');
    } catch (e) { live.push('THREW: ' + e.message); }
    return { out, live };
  });

  const f = (x, d = 3) => x.toFixed(d).padStart(7);
  const db = (x) => (x > 0 ? (10 * Math.log10(x)).toFixed(1) : '-inf').padStart(7);
  console.log('sound                       dur(s)    peak     rms  tail(dBFS)  <200Hz  >2kHz (energy share, dB)');
  let fail = [];
  for (const r of res.out) {
    const tailDb = r.tail > 0 ? (20 * Math.log10(r.tail)).toFixed(0) : '-inf';
    console.log(r.name.padEnd(26) + f(r.dur, 2) + ' ' + f(r.peak) + ' ' + f(r.rms, 4) + '   ' + String(tailDb).padStart(6) + '   ' +
      (r.low != null ? db(r.low) + db(r.high) : ''));
    if (r.peak > 0.9) fail.push(r.name + ' peak > 0.9');
    if (!/^BED|^STACK|^roll/.test(r.name)) {
      if (r.peak < 0.05 && !/far/.test(r.name)) fail.push(r.name + ' too quiet');
      if (r.tail > 1e-4) fail.push(r.name + ' does not end at silence');
    }
  }
  const drv = res.out.find((r) => r.name === 'driver p1'), pt = res.out.find((r) => r.name === 'putt p1');
  if (!(drv.low > 0.05 && drv.high > 0.05)) fail.push('driver lacks low/high energy');
  if (!(pt.low < 0.02 && pt.high < 0.05)) fail.push('putter has low/high energy');
  console.log('\nlive api: ' + res.live.join(', '));
  console.log(errors.length ? 'page errors: ' + errors.join(' | ') : 'no page errors');
  console.log(fail.length ? 'CHECK FAILED: ' + fail.join('; ') : 'all checks pass');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
