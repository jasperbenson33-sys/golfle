/* Dewsweeper interface: rendering, input, sound, flow. */
(function () {
  'use strict';
  const C = window.Core, T = C.T, PH = C.PHYS;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), canvas = $('view'), ctx = canvas.getContext('2d');
  const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const clamp = C.clamp;

  const COL = {
    woods: '#2B5541', rough: '#7DA279', fairway: '#A4C78C', fairwayEdge: '#8FB57F',
    fringe: '#ACCF93', green: '#C2E3A2', sand: '#EDE5C6', sandEdge: '#86AB7A',
    water: '#8DBFCD', waterEdge: '#6E9B86', tree: '#2F5B45', treeLight: '#3F7355',
    treeShadow: 'rgba(16,42,36,0.24)', cup: '#17261E', flag: '#D5432D'
  };
  const INSET = { top: 78, bottom: 96, side: 10 };
  const MINP = 0.07; // shorter pulls cancel the shot

  /* ---------- saved state (one viewer's conveniences only) ---------- */
  const STORE_KEY = 'dewsweeper.v1';
  let store = { days: {}, hints: {}, muted: false, progress: null };
  try { const raw = localStorage.getItem(STORE_KEY); if (raw) store = Object.assign(store, JSON.parse(raw)); } catch (e) { /* storage unavailable */ }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ } }

  const z2 = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => d.getFullYear() + '-' + z2(d.getMonth() + 1) + '-' + z2(d.getDate());
  const parseKey = (k) => { const p = k.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const EPOCH = new Date(2026, 10, 10); // No. 1
  const dayNo = (k) => Math.round((parseKey(k) - EPOCH) / 86400000) + 1;
  let qs = null; try { qs = new URLSearchParams(location.search); } catch (e) { qs = null; }
  const TODAY = (qs && /^\d{4}-\d{2}-\d{2}$/.test(qs.get('date') || '')) ? qs.get('date') : dateKey(new Date());

  /* ---------- sound: everything is synthesised ---------- */
  const Snd = (function () {
    let ac = null, master = null, on = !store.muted, birdT = 2;
    function init() {
      try {
        if (!ac) {
          const AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          ac = new AC();
          master = ac.createGain(); master.gain.value = on ? 0.9 : 0; master.connect(ac.destination);
          ambient();
        }
        if (ac.state === 'suspended') { const p = ac.resume(); if (p && p.catch) p.catch(function () {}); }
      } catch (e) { ac = null; }
    }
    const ok = () => ac && ac.state === 'running' && on;
    function noise(sec, brown) {
      const b = ac.createBuffer(1, Math.floor(ac.sampleRate * sec), ac.sampleRate), d = b.getChannelData(0);
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
      }
      return b;
    }
    function ambient() {
      const src = ac.createBufferSource(); src.buffer = noise(4, true); src.loop = true;
      const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 480;
      const g = ac.createGain(); g.gain.value = 0.05;
      src.connect(lp); lp.connect(g); g.connect(master); src.start();
      const lfo = ac.createOscillator(); lfo.frequency.value = 0.06;
      const lg = ac.createGain(); lg.gain.value = 0.022; lfo.connect(lg); lg.connect(g.gain); lfo.start();
    }
    function tone(f0, f1, at, dur, vol, type) {
      const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + at;
      o.type = type || 'sine'; o.frequency.setValueAtTime(f0, t);
      if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.012, dur * 0.3));
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.03);
    }
    function burst(dur, vol, type, f0, f1, q) {
      const src = ac.createBufferSource(); src.buffer = noise(dur + 0.05, false);
      const flt = ac.createBiquadFilter(); flt.type = type; flt.Q.value = q || 0.8;
      const t = ac.currentTime; flt.frequency.setValueAtTime(f0, t);
      if (f1) flt.frequency.exponentialRampToValueAtTime(f1, t + dur);
      const g = ac.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(flt); flt.connect(g); g.connect(master); src.start(t); src.stop(t + dur + 0.05);
    }
    function chirp(at, loud) {
      const n = 2 + Math.floor(Math.random() * 4), base = 2600 + Math.random() * 1700;
      for (let i = 0; i < n; i++) {
        const f = base * (0.9 + Math.random() * 0.3);
        tone(f, f * (Math.random() < 0.5 ? 1.25 : 0.8), (at || 0) + i * (0.075 + Math.random() * 0.05), 0.07, (loud || 1) * (0.014 + Math.random() * 0.016));
      }
    }
    const safe = (fn) => function () { if (!ok()) return; try { fn.apply(null, arguments); } catch (e) { /* ignore */ } };
    return {
      init,
      setOn(v) { on = v; if (master) master.gain.value = on ? 0.9 : 0; },
      isOn: () => on,
      tick: safe(function (dt) { birdT -= dt; if (birdT <= 0) { chirp(0, 1); birdT = 1.6 + Math.random() * 5; } }),
      swing: safe(function (p) { burst(0.16 + p * 0.08, 0.1 + p * 0.22, 'bandpass', 700, 2600, 0.7); tone(1700, 600, 0.05, 0.035, 0.1 + p * 0.12, 'triangle'); }),
      putt: safe(function () { tone(560, 420, 0, 0.05, 0.13, 'triangle'); }),
      land: safe(function (soft) { tone(150, 70, 0, 0.09, soft ? 0.1 : 0.2); }),
      sand: safe(function () { burst(0.22, 0.2, 'lowpass', 1400, 500); }),
      splash: safe(function () { burst(0.5, 0.3, 'bandpass', 1500, 600, 0.6); tone(420, 120, 0, 0.16, 0.14); }),
      tree: safe(function () { tone(250, 170, 0, 0.06, 0.2, 'triangle'); burst(0.3, 0.09, 'highpass', 3000); }),
      lip: safe(function () { tone(880, 700, 0, 0.03, 0.08, 'triangle'); }),
      cup: safe(function () { tone(640, 470, 0, 0.07, 0.2); tone(400, 290, 0.07, 0.12, 0.18); tone(110, 80, 0.07, 0.14, 0.14); }),
      chime: safe(function (diff) {
        const sets = { '-2': [523.25, 659.25, 783.99, 987.77, 1174.66, 1567.98], '-1': [587.33, 783.99, 987.77, 1174.66], '0': [392, 587.33], '1': [329.63], '2': [293.66] };
        const notes = sets[String(clamp(diff, -2, 2))];
        notes.forEach(function (f, i) { tone(f, f, 0.35 + i * 0.14, 1.8, 0.1); tone(f * 2, f * 2, 0.35 + i * 0.14, 0.9, 0.025); });
        if (diff < 0) { chirp(0.9, 2.2); chirp(1.7, 1.8); if (diff < -1) chirp(2.4, 2); }
      })
    };
  })();
  const buzz = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ } };

  /* ---------- game state ---------- */
  const G = {
    mode: 'title', round: null, practice: false, hi: 0, hole: null,
    ball: { x: 0, y: 0 }, strokes: 0, scores: [], trails: ['', '', ''],
    shot: null, acc: 0, evt: 0, settle: 0, aim: null, time: 0, intro: 0,
    fx: [], birds: [], trail: [], moment: null, demo: false
  };
  const cam = { x: 0, y: 0, s: 1 }, camT = { x: 0, y: 0, s: 1 };
  let W = 0, H = 0, DPR = 1;

  function resize() {
    const r = stage.getBoundingClientRect();
    W = Math.max(200, r.width); H = Math.max(300, r.height);
    DPR = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
    if (G.hole) { Object.assign(camT, G.mode === 'aim' ? shotFrame() : holeFrame(G.hole)); Object.assign(cam, camT); }
  }
  window.addEventListener('resize', resize);

  /* ---------- camera ---------- */
  function frame(pts, m) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    x0 -= m; x1 += m; y0 -= m; y1 += m;
    const uw = W - 2 * INSET.side, uh = H - INSET.top - INSET.bottom;
    return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, s: Math.min(uw / (x1 - x0), uh / (y1 - y0), 22) };
  }
  function greenPts(h) { const o = []; for (const g of h.green) o.push({ x: g.x - g.r, y: g.y - g.r }, { x: g.x + g.r, y: g.y + g.r }); return o; }
  function holeFrame(h) { return frame(h.path.concat(greenPts(h), [h.pin]), 32); }
  function shotFrame() {
    const h = G.hole, b = G.ball, info = C.shotInfo(h, b), d = info.dist;
    if (info.putt) return frame([b, h.pin], Math.max(3.4, d * 0.55));
    if (d > 185) { /* long shot: show what is in reach, not the whole hole */
      const pts = [b], P = h.path.slice(0, -1).concat([h.pin]);
      for (let i = 0; i < P.length - 1; i++) {
        const L = C.dist(P[i], P[i + 1]);
        for (let t = 0; t <= L; t += 20) { const p = { x: P[i].x + ((P[i + 1].x - P[i].x) * t) / L, y: P[i].y + ((P[i + 1].y - P[i].y) * t) / L }; if (p.y > b.y - 10 && C.dist(p, b) <= 310) pts.push(p); }
      }
      if (d <= 310) pts.push(h.pin, ...greenPts(h));
      return frame(pts, 38);
    }
    return frame([b, h.pin], Math.max(24, d * 0.3));
  }
  const CYs = () => INSET.top + (H - INSET.top - INSET.bottom) / 2;

  /* ---------- round flow ---------- */
  function newRound(key, practice) {
    G.round = C.makeRound(key); G.practice = !!practice;
    G.scores = []; G.trails = ['', '', '']; G.moment = null; G.birds = [];
  }
  function deco(h) {
    if (h.deco) return;
    const rng = C.makeRng(C.hashStr('deco|' + h.yards + '|' + h.index + '|' + h.trees.length));
    const b = h.bounds, patches = [], shim = [];
    for (let i = 0; i < 30; i++) patches.push({ x: rng.range(b.x0, b.x1), y: rng.range(b.y0, b.y1), r: rng.range(14, 42), c: rng.chance(0.5) ? 'rgba(255,255,215,0.055)' : 'rgba(18,58,48,0.06)' });
    for (const w of h.water) for (const c of w) if (c.r > 9) shim.push({ x: c.x + rng.range(-0.4, 0.4) * c.r, y: c.y + rng.range(-0.4, 0.4) * c.r, l: rng.range(3, 6), ph: rng.range(0, 6) });
    let gr = 0; for (const g of h.green) gr = Math.max(gr, Math.hypot(g.x - h.green[0].x, g.y - h.green[0].y) + g.r);
    h.deco = { patches, shim, gr };
  }
  function loadHole(i, restore, quiet) {
    G.hi = i; G.hole = G.round.holes[i]; deco(G.hole);
    const h = G.hole;
    G.ball = restore ? { x: restore.ball.x, y: restore.ball.y } : { x: h.tee.x, y: h.tee.y };
    G.strokes = restore ? restore.strokes : 0;
    if (!restore) G.trails[i] = '';
    G.shot = null; G.aim = null; G.trail = []; G.fx = []; G.moment = null;
    G.mode = 'aim';
    if (quiet || restore) { Object.assign(camT, shotFrame()); Object.assign(cam, camT); G.intro = 0; }
    else { Object.assign(camT, holeFrame(h)); Object.assign(cam, camT); G.intro = 1.5; } // open on the whole hole, then settle onto the tee shot
    updateHud();
    if (!quiet) { banner(); hints(); }
  }
  function enterAim() {
    G.mode = 'aim'; G.shot = null;
    Object.assign(camT, shotFrame());
    updateHud(); hints(); progress();
  }
  function progress() {
    if (G.practice) return;
    store.progress = { key: G.round.key, hi: G.hi, ball: G.ball, strokes: G.strokes, scores: G.scores.slice(), trails: G.trails.slice() };
    save();
  }
  function fire(angle, power) {
    G.shot = C.createShot(G.hole, G.ball, angle, power, true);
    G.strokes++; G.mode = 'flying'; G.acc = 0; G.evt = 0; G.settle = -1; G.trail = [];
    if (G.shot.info.putt) Snd.putt(); else Snd.swing(power);
    buzz(8);
    if (!store.hints.pull) { store.hints.pull = 1; save(); }
    G.demo = false; hint(''); banner(false); updateHud();
  }
  function shotDone() {
    const h = G.hole, r = G.shot.result;
    if (r.kind === 'holed') { G.trails[G.hi] += 'H'; G.ball = { x: h.pin.x, y: h.pin.y }; holeDone(G.strokes, false); return; }
    let msg = null;
    if (r.kind === 'water') {
      G.strokes++; G.trails[G.hi] += 'W';
      msg = 'Water. One penalty stroke, and you play again from the same spot.';
    } else {
      G.ball = { x: r.x, y: r.y };
      G.trails[G.hi] += r.tree ? 'T' : 'RFFFGSW'[r.lie];
      if (r.tree && !store.hints.tree) { store.hints.tree = 1; save(); msg = 'Trees stop the ball. Play around them.'; }
    }
    if (G.strokes >= h.par + 3) { G.trails[G.hi] += 'X'; holeDone(h.par + 4, true); return; }
    enterAim();
    if (msg) hint(msg, 5200);
  }
  function holeDone(score, pickup) {
    const h = G.hole, diff = score - h.par;
    G.scores[G.hi] = score; G.mode = 'holed'; G.aim = null;
    const name = pickup ? 'Picked up' : C.scoreName(h.par, score);
    G.moment = { t: 0, diff, pickup, dur: diff < 0 ? 4.2 : 2.6 };
    $('m-name').textContent = name;
    $('m-sub').textContent = pickup ? 'Hole ' + (G.hi + 1) + ' · scored as ' + score : 'Hole ' + (G.hi + 1) + ' · ' + score + (score === 1 ? ' stroke' : ' strokes') + ' on a par ' + h.par;
    const m = $('moment'); m.className = 'moment ' + (diff < 0 ? 'under' : diff > 0 ? 'over' : 'level');
    void m.offsetWidth; m.classList.add('show');
    if (!pickup) Snd.chime(diff);
    if (diff < 0) { spawnBirds(diff); Object.assign(camT, holeFrame(h)); }
    hint('');
    if (!G.practice) {
      if (G.hi < 2) store.progress = { key: G.round.key, hi: G.hi + 1, ball: G.round.holes[G.hi + 1].tee, strokes: 0, scores: G.scores.slice(), trails: G.trails.slice() };
      else { store.days[G.round.key] = { scores: G.scores.slice(), trails: G.trails.slice() }; store.progress = null; }
      save();
    }
    updateHud();
  }
  function advance() {
    $('moment').classList.remove('show'); G.moment = null; G.birds = [];
    if (G.hi < 2) loadHole(G.hi + 1); else summary();
  }

  /* ---------- HUD ---------- */
  const noteClass = (par, sc) => { const d = sc - par; return d <= -2 ? 'eagle' : d === -1 ? 'birdie' : d === 0 ? '' : d === 1 ? 'bogey' : 'double'; };
  function updateHud() {
    const h = G.hole; if (!h) return;
    $('hud-hole').textContent = 'Hole ' + (G.hi + 1) + ' of 3';
    $('hud-par').textContent = 'Par ' + h.par + ' · ' + h.yards + ' yd';
    let rel = 0;
    for (let i = 0; i < 3; i++) {
      const el = $('sc' + i), sc = G.scores[i], par = G.round.holes[i].par;
      if (sc != null) { el.textContent = sc; el.className = 'sc ' + noteClass(par, sc); rel += sc - par; }
      else if (i === G.hi && G.mode !== 'title') { el.textContent = G.strokes; el.className = 'sc live'; }
      else { el.textContent = '–'; el.className = 'sc todo'; }
    }
    $('hud-topar').textContent = C.toPar(rel);
    if (h.wind.mph > 0) {
      $('wind-arrow').style.transform = 'rotate(' + (Math.atan2(h.wind.x, h.wind.y) * 180 / Math.PI).toFixed(1) + 'deg)';
      $('wind-arrow').style.opacity = 1;
      $('wind-txt').textContent = h.wind.mph + ' mph';
    } else { $('wind-arrow').style.opacity = 0.3; $('wind-arrow').style.transform = 'none'; $('wind-txt').textContent = 'Calm'; }
    if (G.mode === 'flying') return;
    const info = C.shotInfo(h, G.ball);
    $('lie').textContent = G.mode === 'holed' ? 'In the cup'
      : info.putt ? 'Putt ' + (G.strokes + 1) + ' · ' + Math.max(1, Math.round(info.dist * 3)) + ' ft to the cup'
      : 'Shot ' + (G.strokes + 1) + ' · ' + C.LIE_NAME[info.lie] + ' · ' + Math.round(info.dist) + ' yd to the pin';
  }
  let hintTimer = 0;
  function hint(text, ms) {
    const el = $('hint'); clearTimeout(hintTimer);
    if (!text) { el.classList.remove('show'); return; }
    el.textContent = text; el.classList.add('show');
    if (ms) hintTimer = setTimeout(function () { el.classList.remove('show'); }, ms);
  }
  function once(key, text) { if (store.hints[key]) return false; store.hints[key] = 1; save(); hint(text, 9000); return true; }
  function hints() {
    const h = G.hole, info = C.shotInfo(h, G.ball);
    if (!store.hints.pull) { G.demo = true; hint('Pull back anywhere on the screen, then let go to swing. The ring shows where the ball lands.'); return; }
    if (info.putt) {
      if (once('putt', 'On the green. Pull back gently to putt. The line shows how far it rolls on flat ground, and the drifting marks show which way the green tilts.')) return;
      if (h.diff > 0 && once('slope', 'This green tilts more. Aim uphill of the cup and let the slope bring it back.')) return;
      return;
    }
    if (info.lie === T.SAND && once('sand', 'Sand. Shots fly shorter and your aim sways, so let go when the line swings onto your target.')) return;
    if (info.lie === T.ROUGH && once('rough', 'Rough. Shots fly a little shorter and your aim sways, so let go when the line swings onto your target.')) return;
    if (h.wind.mph > 0 && once('wind', 'Wind is up. The ring shows a still-air landing, and the wind carries the ball from there. Aim into it.')) return;
  }
  let bannerTimer = 0;
  function banner(show) {
    const el = $('banner'); clearTimeout(bannerTimer);
    if (show === false) { el.classList.remove('show'); return; }
    const h = G.hole;
    $('b-hole').textContent = 'Hole ' + (G.hi + 1);
    $('b-sub').textContent = 'Par ' + h.par + ' · ' + h.yards + ' yards' + (h.wind.mph ? ' · wind ' + h.wind.mph + ' mph' : ' · calm');
    el.classList.add('show');
    bannerTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  /* ---------- title and summary ---------- */
  const fmtDate = (k, long) => { try { return parseKey(k).toLocaleDateString(undefined, long ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) { return k; } };
  const roundTitle = () => (G.practice ? 'Dewsweeper practice' : 'Dewsweeper No. ' + dayNo(G.round.key));
  function showTitle() {
    G.mode = 'title';
    $('t-date').textContent = 'No. ' + dayNo(TODAY) + ' · ' + fmtDate(TODAY, true);
    const resume = store.progress && store.progress.key === TODAY;
    $('play').textContent = resume ? 'Resume round' : 'Tee off';
    $('t-meta').textContent = 'Par ' + G.round.par + ' · about two minutes';
    $('title').hidden = false; $('hud').hidden = true; $('foot').hidden = true; $('summary').hidden = true;
  }
  function startPlay() {
    $('title').hidden = true; $('summary').hidden = true; $('hud').hidden = false; $('foot').hidden = false;
  }
  const WORDS = ['Even', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
  function streak() {
    let n = 0; const d = parseKey(TODAY);
    if (!store.days[dateKey(d)]) d.setDate(d.getDate() - 1);
    while (store.days[dateKey(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  let tickTimer = 0;
  function summary() {
    G.mode = 'summary';
    const r = G.round, total = G.scores.reduce((a, b) => a + b, 0), d = total - r.par;
    $('s-eyebrow').textContent = (G.practice ? 'Practice round' : 'No. ' + dayNo(r.key) + ' · ' + fmtDate(r.key));
    const t = $('s-title');
    t.textContent = d === 0 ? 'Even par' : (WORDS[Math.abs(d)] || Math.abs(d)) + (d < 0 ? ' under' : ' over');
    t.className = d < 0 ? 'under' : '';
    $('s-sub').textContent = total + ' strokes on a par ' + r.par;
    const cell = (i) => '<td><span class="sc ' + noteClass(r.holes[i].par, G.scores[i]) + '">' + G.scores[i] + '</span></td>';
    $('s-table').innerHTML =
      '<thead><tr><th scope="row">Hole</th><th scope="col">1</th><th scope="col">2</th><th scope="col">3</th><th scope="col">Total</th></tr></thead><tbody>' +
      '<tr><th scope="row">Yards</th>' + r.holes.map((h) => '<td>' + h.yards + '</td>').join('') + '<td>' + r.holes.reduce((a, h) => a + h.yards, 0) + '</td></tr>' +
      '<tr><th scope="row">Par</th>' + r.holes.map((h) => '<td>' + h.par + '</td>').join('') + '<td>' + r.par + '</td></tr>' +
      '<tr class="you"><th scope="row">Score</th>' + cell(0) + cell(1) + cell(2) + '<td>' + total + '</td></tr></tbody>';
    $('s-trails').innerHTML = r.holes.map(function (h, i) {
      const tiles = (G.trails[i] || '').split('').map((c) => '<i class="tile ' + c + '"></i>').join('');
      return '<div class="trail"><span class="n">Hole ' + (i + 1) + '</span>' + tiles + '<span class="nm">' + C.scoreName(h.par, G.scores[i]) + '</span></div>';
    }).join('');
    const st = streak();
    $('s-streak').textContent = G.practice ? '' : (st > 1 ? st + ' mornings in a row' : '');
    $('share-text').hidden = true; $('share').textContent = 'Copy scorecard';
    $('replay').textContent = G.practice && G.round.key !== TODAY ? 'Replay this course' : "Replay today's course for practice";
    clearInterval(tickTimer);
    const tick = function () {
      const now = new Date(), next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const s = Math.max(0, Math.floor((next - now) / 1000));
      $('s-next').textContent = 'Next course in ' + z2(Math.floor(s / 3600)) + ':' + z2(Math.floor(s / 60) % 60) + ':' + z2(s % 60);
    };
    tick(); tickTimer = setInterval(tick, 1000);
    Object.assign(camT, holeFrame(G.hole));
    $('summary').hidden = false; $('hud').hidden = true; $('foot').hidden = true; hint('');
  }

  $('play').addEventListener('click', function () {
    Snd.init(); startPlay();
    const p = store.progress;
    if (p && p.key === TODAY && !store.days[TODAY]) { G.scores = p.scores.slice(); G.trails = p.trails.slice(); loadHole(p.hi, p); banner(); hints(); }
    else loadHole(0);
  });
  $('practice').addEventListener('click', function () {
    Snd.init(); clearInterval(tickTimer);
    newRound('practice-' + Math.random().toString(36).slice(2, 8), true); startPlay(); loadHole(0);
  });
  $('replay').addEventListener('click', function () {
    Snd.init(); clearInterval(tickTimer);
    newRound(G.round.key, true); startPlay(); loadHole(0);
  });
  $('share').addEventListener('click', function () {
    const btn = $('share'), ta = $('share-text');
    const txt = C.shareText(roundTitle(), G.round, G.scores, G.trails);
    const done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy scorecard'; }, 1800); };
    const manual = function () { ta.hidden = false; ta.value = txt; ta.focus(); ta.select(); btn.textContent = 'Copy from the box below'; };
    try { navigator.clipboard.writeText(txt).then(done, manual); } catch (e) { manual(); }
  });
  function sndIcon() {
    const on = Snd.isOn();
    $('snd-wave').style.display = on ? '' : 'none'; $('snd-off').style.display = on ? 'none' : '';
    $('snd').setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  stage.addEventListener('click', function () { Snd.init(); }); // sound may only start from a tap
  $('snd').addEventListener('click', function () { Snd.init(); Snd.setOn(!Snd.isOn()); store.muted = !Snd.isOn(); save(); sndIcon(); });

  /* ---------- input: pull back anywhere, let go to swing ---------- */
  const dragMax = () => clamp(H * 0.26, 140, 220);
  function aimFrom(a, x, y) {
    const dx = a.sx - x, dy = a.sy - y, len = Math.hypot(dx, dy);
    a.power = clamp(len / dragMax(), 0, 1);
    if (len > 4) a.angle = Math.atan2(dx, -dy);
  }
  const swayNow = () => { const sw = G.aim && G.aim.sway; return sw ? (sw * Math.PI / 180) * Math.sin(G.time * 3.3) : 0; };
  canvas.addEventListener('pointerdown', function (e) {
    if (G.mode === 'holed') { if (G.moment && G.moment.t > 0.9) advance(); return; }
    if (G.mode !== 'aim' || G.aim) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    const info = C.shotInfo(G.hole, G.ball);
    G.aim = { id: e.pointerId, sx: e.clientX, sy: e.clientY, power: 0, angle: Math.atan2(G.hole.pin.x - G.ball.x, G.hole.pin.y - G.ball.y), sway: info.sway, hist: [{ t: e.timeStamp, x: e.clientX, y: e.clientY }] };
    banner(false);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    const a = G.aim; if (!a || a.id !== e.pointerId) return;
    a.hist.push({ t: e.timeStamp, x: e.clientX, y: e.clientY }); if (a.hist.length > 16) a.hist.shift();
    aimFrom(a, e.clientX, e.clientY);
  });
  function release(e, cancel) {
    const a = G.aim; if (!a || a.id !== e.pointerId) return;
    G.aim = null;
    if (cancel || G.mode !== 'aim') return;
    /* fingers twitch as they lift: use where the finger was a moment before release */
    const lastS = a.hist[a.hist.length - 1];
    let s = lastS;
    for (let i = a.hist.length - 1; i >= 0; i--) { if (e.timeStamp - a.hist[i].t >= 45) { s = a.hist[i]; break; } }
    if (Math.hypot(s.x - lastS.x, s.y - lastS.y) > 14) s = lastS; // still moving on purpose: trust the final spot
    aimFrom(a, s.x, s.y);
    if (a.power < MINP) return;
    fire(a.angle + (a.sway ? (a.sway * Math.PI / 180) * Math.sin(G.time * 3.3) : 0), a.power);
  }
  canvas.addEventListener('pointerup', function (e) { release(e, false); });
  canvas.addEventListener('pointercancel', function (e) { release(e, true); });
  canvas.addEventListener('lostpointercapture', function (e) { release(e, true); });
  canvas.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });

  /* ---------- effects ---------- */
  function puff(x, y, col, n, sp, life) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, v = sp * (0.4 + Math.random() * 0.8);
      G.fx.push({ k: 'p', x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: life * (0.6 + Math.random() * 0.6), col, r: 1.2 + Math.random() * 1.8 });
    }
  }
  const ring = (x, y, col, life, grow) => G.fx.push({ k: 'r', x, y, t: 0, life, col, grow });
  function onEvent(ev, s) {
    if (ev === 'land') { const soft = C.terrainAt(G.hole, s.x, s.y) === T.ROUGH; Snd.land(soft); ring(s.x, s.y, '255,255,255', 0.45, 16); }
    else if (ev === 'sand') { Snd.sand(); puff(s.x, s.y, '237,229,198', 14, 9, 0.6); }
    else if (ev === 'splash') { Snd.splash(); puff(s.x, s.y, '225,243,248', 18, 11, 0.7); ring(s.x, s.y, '225,243,248', 0.9, 34); buzz(20); }
    else if (ev === 'tree') { Snd.tree(); puff(s.x, s.y, '110,160,110', 12, 10, 0.7); }
    else if (ev === 'lip') Snd.lip();
    else if (ev === 'holed') { Snd.cup(); ring(G.hole.pin.x, G.hole.pin.y, '255,255,255', 0.7, 26); buzz(14); }
  }
  function spawnBirds(diff) {
    if (REDUCED) return;
    const n = diff <= -2 ? 3 : 1;
    for (let i = 0; i < n; i++) G.birds.push({ t: -0.5 - i * 0.4, y0: H * (0.15 + 0.045 * i), z: diff <= -2 && i === 0 ? 20 : 11 + i * 2, sp: (W + 140) / (3.6 + i * 0.3) });
  }

  /* ---------- update ---------- */
  function update(dt) {
    G.time += dt;
    Snd.tick(dt);
    const k = 1 - Math.exp(-dt * (G.mode === 'holed' ? 1.5 : 5.5));
    cam.x += (camT.x - cam.x) * k; cam.y += (camT.y - cam.y) * k; cam.s += (camT.s - cam.s) * k;
    if (G.mode === 'flying' && G.shot) {
      const s = G.shot;
      if (!s.done) {
        G.acc += dt;
        while (G.acc >= PH.DT && !s.done) {
          C.stepShot(G.hole, s); G.acc -= PH.DT;
          while (G.evt < s.events.length) onEvent(s.events[G.evt++], s);
        }
        G.trail.push({ x: s.x, y: s.y, h: s.h }); if (G.trail.length > 34) G.trail.shift();
        /* keep the ball in view */
        const sx = W / 2 + (s.x - cam.x) * cam.s, sy = CYs() - (s.y - cam.y) * cam.s;
        if (sx < 24) camT.x -= (24 - sx) / cam.s; else if (sx > W - 24) camT.x += (sx - (W - 24)) / cam.s;
        if (sy < INSET.top) camT.y += (INSET.top - sy) / cam.s; else if (sy > H - INSET.bottom) camT.y -= (sy - (H - INSET.bottom)) / cam.s;
        if (s.done) G.settle = s.result.kind === 'holed' ? 0.3 : 0.42;
      } else {
        if (G.trail.length) G.trail.shift();
        G.settle -= dt;
        if (G.settle <= 0) shotDone();
      }
    }
    if (G.intro > 0) { G.intro -= dt; if (G.intro <= 0 && G.mode === 'aim' && !G.aim) Object.assign(camT, shotFrame()); }
    if (G.moment) { G.moment.t += dt; if (G.moment.t >= G.moment.dur) advance(); }
    for (const b of G.birds) b.t += dt;
    for (let i = G.fx.length - 1; i >= 0; i--) {
      const f = G.fx[i]; f.t += dt;
      if (f.k === 'p') { f.x += f.vx * dt; f.y += f.vy * dt; f.vx *= 0.94; f.vy *= 0.94; }
      if (f.t >= f.life) G.fx.splice(i, 1);
    }
  }

  /* ---------- draw ---------- */
  function label(text, x, y) {
    ctx.font = '600 13px Barlow, "Avenir Next", "Segoe UI", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    x = clamp(x, 40, W - 40); y = Math.max(INSET.top + 4, y);
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(23,51,38,0.75)'; ctx.lineJoin = 'round'; ctx.strokeText(text, x, y);
    ctx.fillStyle = '#fff'; ctx.fillText(text, x, y);
  }
  function dots(x0, y0, x1, y1, gap, r) {
    const L = Math.hypot(x1 - x0, y1 - y0), n = Math.floor(L / gap);
    ctx.beginPath();
    for (let i = 1; i <= n; i++) { const t = (i * gap) / L, x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t; ctx.moveTo(x + r, y); ctx.arc(x, y, r, 0, 6.283); }
    ctx.fill();
  }
  function draw() {
    const h = G.hole; if (!h) return;
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    const s = cam.s, CY = CYs();
    const X = (x) => W / 2 + (x - cam.x) * s, Y = (y) => CY - (y - cam.y) * s;
    const circ = (list, pad) => { ctx.beginPath(); for (const c of list) { const r = (c.r + pad) * s, cx = X(c.x), cy = Y(c.y); ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, 6.283); } };
    const b = h.bounds;

    ctx.fillStyle = COL.woods; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = COL.rough; ctx.fillRect(X(b.x0), Y(b.y1), (b.x1 - b.x0) * s, (b.y1 - b.y0) * s);
    ctx.save(); ctx.beginPath(); ctx.rect(X(b.x0), Y(b.y1), (b.x1 - b.x0) * s, (b.y1 - b.y0) * s); ctx.clip();
    for (const p of h.deco.patches) { ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), p.r * s, 0, 6.283); ctx.fill(); }
    ctx.restore();

    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const f of h.fairways) {
      ctx.beginPath(); f.pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.y)) : ctx.moveTo(X(p.x), Y(p.y))));
      ctx.strokeStyle = COL.fairwayEdge; ctx.lineWidth = (f.hw * 2 + 2.6) * s; ctx.stroke();
      ctx.strokeStyle = COL.fairway; ctx.lineWidth = f.hw * 2 * s; ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,220,0.07)'; ctx.lineWidth = f.hw * 1.1 * s; ctx.stroke();
    }
    /* tee box */
    { const r = 6 * s, tx = X(h.tee.x), ty = Y(h.tee.y); ctx.fillStyle = COL.fringe; ctx.beginPath(); ctx.rect(tx - r, ty - r, r * 2, r * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.8)'; const m = Math.max(1.2, 0.5 * s); ctx.beginPath(); ctx.arc(tx - r * 0.7, ty, m, 0, 6.283); ctx.arc(tx + r * 0.7, ty, m, 0, 6.283); ctx.fill(); }
    circ(h.green, h.fringeW); ctx.fillStyle = COL.fringe; ctx.fill();
    for (const w of h.water) { circ(w, 1.3); ctx.fillStyle = COL.waterEdge; ctx.fill(); }
    for (const w of h.water) { circ(w, 0); ctx.fillStyle = COL.water; ctx.fill(); }
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = Math.max(1, 0.35 * s);
    for (const m of h.deco.shim) { const a = 0.5 + 0.5 * Math.sin(G.time * 0.9 + m.ph); ctx.globalAlpha = a * 0.7; ctx.beginPath(); ctx.moveTo(X(m.x - m.l), Y(m.y)); ctx.lineTo(X(m.x + m.l), Y(m.y)); ctx.stroke(); }
    ctx.globalAlpha = 1;
    for (const k of h.bunkers) { circ(k, 1.0); ctx.fillStyle = COL.sandEdge; ctx.fill(); }
    for (const k of h.bunkers) { circ(k, 0); ctx.fillStyle = COL.sand; ctx.fill(); }
    circ(h.green, 0); ctx.fillStyle = COL.green; ctx.fill();

    /* slope: marks drift downhill */
    const mag = Math.hypot(h.slope.x, h.slope.y);
    if (mag > 0 && s > 2.6) {
      ctx.save(); circ(h.green, 0); ctx.clip();
      const ux = h.slope.x / mag, uy = h.slope.y / mag, sp = 3.4, R = h.deco.gr + sp, g0 = h.green[0];
      const ph = REDUCED ? 0 : (G.time * (0.7 + mag * 2.2)) % sp, len = 0.7 + mag * 0.9;
      ctx.strokeStyle = 'rgba(40,100,60,' + (0.42 * clamp((s - 2.6) / 3, 0.25, 1)).toFixed(3) + ')'; ctx.lineWidth = clamp(0.1 * s, 1, 2.2); ctx.beginPath();
      let row = 0;
      for (let v = -R; v <= R; v += sp, row++) for (let u = -R; u <= R; u += sp) {
        const uu = u + ph + (row % 2 ? sp / 2 : 0), wx = g0.x + ux * uu - uy * v, wy = g0.y + uy * uu + ux * v;
        const hx = X(wx), hy = Y(wy), tx = X(wx - ux * len), ty = Y(wy - uy * len);
        ctx.moveTo(tx, ty); ctx.lineTo(hx, hy);
        const ax = (hx - tx), ay = (hy - ty), al = Math.hypot(ax, ay) || 1, wv = clamp(0.22 * s, 1.5, 5);
        ctx.moveTo(hx - (ax / al) * wv - (ay / al) * wv, hy - (ay / al) * wv + (ax / al) * wv); ctx.lineTo(hx, hy);
        ctx.lineTo(hx - (ax / al) * wv + (ay / al) * wv, hy - (ay / al) * wv - (ax / al) * wv);
      }
      ctx.stroke(); ctx.restore();
    }

    /* cup and pin */
    const px = X(h.pin.x), py = Y(h.pin.y), info = C.shotInfo(h, G.ball);
    ctx.fillStyle = COL.cup; ctx.beginPath(); ctx.arc(px, py, Math.max(2.4, PH.CUP_R * s * 1.15), 0, 6.283); ctx.fill();
    { const fl = clamp(6.5 * s, 20, 46), fw = fl * 0.44, wd = h.wind.mph > 0 ? (h.wind.x >= 0 ? 1 : -1) : 1;
      const fl2 = Math.sin(G.time * (3 + h.wind.mph * 0.4)) * fw * (h.wind.mph > 0 ? 0.1 : 0.03);
      ctx.globalAlpha = info.putt && G.mode !== 'holed' ? 0.28 : 1;
      ctx.strokeStyle = '#F8F8F0'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - fl); ctx.stroke();
      ctx.fillStyle = COL.flag; ctx.beginPath(); ctx.moveTo(px, py - fl); ctx.lineTo(px + wd * fw, py - fl + fl * 0.15 + fl2); ctx.lineTo(px, py - fl + fl * 0.3); ctx.fill();
      ctx.globalAlpha = 1; }

    /* trees: long morning shadows fall away from the sun (top right) */
    const vis = (t) => { const tx = X(t.x), ty = Y(t.y), r = t.r * s * 1.7; return tx > -r && tx < W + r && ty > -r && ty < H + r; };
    ctx.fillStyle = COL.treeShadow; ctx.beginPath();
    for (const t of h.trees) if (vis(t)) { const cx = X(t.x - t.r * 0.62), cy = Y(t.y - t.r * 0.5), r = t.r * s * 1.04; ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, 6.283); }
    ctx.fill();
    ctx.fillStyle = COL.tree; ctx.beginPath();
    for (const t of h.trees) if (vis(t)) { const cx = X(t.x), cy = Y(t.y), r = t.r * s; ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, 6.283); }
    ctx.fill();
    ctx.fillStyle = COL.treeLight; ctx.beginPath();
    for (const t of h.trees) if (vis(t)) { const cx = X(t.x + t.r * 0.2), cy = Y(t.y + t.r * 0.2), r = t.r * s * 0.68; ctx.moveTo(cx + r, cy); ctx.arc(cx, cy, r, 0, 6.283); }
    ctx.fill();

    /* aim preview */
    const a = G.aim;
    const br = clamp(0.34 * s, 3.6, 6.5);
    if (a && G.mode === 'aim' && a.power > 0.02) {
      const ang = a.angle + swayNow(), pv = C.previewShot(h, G.ball, ang, a.power);
      const bx = X(G.ball.x), by = Y(G.ball.y), live = a.power >= MINP;
      ctx.save(); ctx.globalAlpha = live ? 1 : 0.35; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#fff';
      if (pv.putt) {
        const ex = X(pv.end.x), ey = Y(pv.end.y);
        dots(bx, by, ex, ey, 8, 1.6);
        ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(ex, ey, 4.5, 0, 6.283); ctx.stroke();
        if (live) label(Math.max(1, Math.round(pv.roll * 3)) + ' ft', ex + Math.sin(ang) * 24, ey - Math.cos(ang) * 24 + 5);
      } else {
        const end = pv.blocked || pv.land, ex = X(end.x), ey = Y(end.y);
        dots(bx, by, ex, ey, 10, 1.7);
        if (pv.blocked) {
          ctx.lineWidth = 2.5; ctx.strokeStyle = '#FFD9CF'; ctx.beginPath(); ctx.moveTo(ex - 6, ey - 6); ctx.lineTo(ex + 6, ey + 6); ctx.moveTo(ex + 6, ey - 6); ctx.lineTo(ex - 6, ey + 6); ctx.stroke();
          if (live) label('Trees', ex, ey - 13);
        } else {
          const rr = clamp(0.045 * pv.carry * s + 6, 8, 18), wet = pv.landLie === T.WATER, snd = pv.landLie === T.SAND;
          ctx.strokeStyle = wet ? '#CFEFFA' : snd ? '#FFF3C4' : '#fff'; ctx.lineWidth = 2.2;
          ctx.beginPath(); ctx.arc(ex, ey, rr, 0, 6.283); ctx.stroke();
          ctx.beginPath(); ctx.arc(ex, ey, 1.8, 0, 6.283); ctx.fill();
          if (pv.roll > 0.6) { /* expected run-out on flat ground */
            const tx = X(pv.land.x + pv.dir.x * pv.roll), ty = Y(pv.land.y + pv.dir.y * pv.roll), ux = Math.sin(ang), uy = -Math.cos(ang);
            if (Math.hypot(tx - ex, ty - ey) > rr + 3) { ctx.globalAlpha *= 0.6; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(ex + ux * rr, ey + uy * rr); ctx.lineTo(tx, ty); ctx.moveTo(tx - uy * 4, ty + ux * 4); ctx.lineTo(tx + uy * 4, ty - ux * 4); ctx.stroke(); ctx.globalAlpha = live ? 1 : 0.35; }
          }
          if (live) label(Math.round(pv.carry) + ' yd' + (wet ? ' · water' : snd ? ' · sand' : ''), ex, ey - rr - 8);
        }
      }
      /* the pull: a band drawn back from the ball */
      const ux = Math.sin(ang), uy = -Math.cos(ang), bl = 12 + a.power * 56;
      ctx.strokeStyle = a.power >= 0.995 ? '#F2C768' : '#fff'; ctx.lineWidth = 3; ctx.globalAlpha = live ? 0.9 : 0.35;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - ux * bl, by - uy * bl); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(bx - ux * bl, by - uy * bl, 4.5, 0, 6.283); ctx.fill();
      ctx.restore();
    }

    /* ball */
    let wx = G.ball.x, wy = G.ball.y, bh = 0, showBall = G.mode !== 'holed' || (G.moment && G.moment.pickup);
    if (G.mode === 'flying' && G.shot) { wx = G.shot.x; wy = G.shot.y; bh = G.shot.h; if (G.shot.done && G.shot.result.kind !== 'rest') showBall = false; }
    if (G.trail.length > 1) {
      ctx.lineCap = 'round';
      for (let i = 1; i < G.trail.length; i++) {
        const p0 = G.trail[i - 1], p1 = G.trail[i];
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.5 * i / G.trail.length).toFixed(3) + ')'; ctx.lineWidth = br * (0.4 + 0.9 * i / G.trail.length);
        ctx.beginPath(); ctx.moveTo(X(p0.x), Y(p0.y) - p0.h * s * 0.55); ctx.lineTo(X(p1.x), Y(p1.y) - p1.h * s * 0.55); ctx.stroke();
      }
    }
    if (showBall && G.mode !== 'title' && G.mode !== 'summary') {
      const bx = X(wx), by = Y(wy), lift = bh * s * 0.55, rr = br * (1 + bh / 55);
      if (G.mode === 'aim' && !G.aim) { const t = (G.time % 2.2) / 2.2; ctx.strokeStyle = 'rgba(255,255,255,' + (0.55 * (1 - t)).toFixed(3) + ')'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(bx, by, br + 3 + t * 16, 0, 6.283); ctx.stroke(); }
      ctx.fillStyle = 'rgba(12,36,30,0.32)'; ctx.beginPath(); ctx.ellipse(bx - 1.5 - lift * 0.25, by + 1.5 + lift * 0.1, br * 1.05, br * 0.8, 0, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(bx, by - lift, rr, 0, 6.283); ctx.fill();
      ctx.strokeStyle = 'rgba(20,45,35,0.35)'; ctx.lineWidth = 1; ctx.stroke();
    }

    /* effects */
    for (const f of G.fx) {
      const t = f.t / f.life;
      if (f.k === 'p') { ctx.fillStyle = 'rgba(' + f.col + ',' + (1 - t).toFixed(3) + ')'; ctx.beginPath(); ctx.arc(X(f.x), Y(f.y), f.r, 0, 6.283); ctx.fill(); }
      else { ctx.strokeStyle = 'rgba(' + f.col + ',' + (0.8 * (1 - t)).toFixed(3) + ')'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X(f.x), Y(f.y), 3 + f.grow * t, 0, 6.283); ctx.stroke(); }
    }

    /* first-shot demonstration: a ghost finger pulling back */
    if (G.demo && G.mode === 'aim' && !G.aim && !REDUCED) {
      const t = (G.time % 2.4) / 2.4, e = t < 0.7 ? 1 - Math.pow(1 - t / 0.7, 3) : 1, al = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      const fx = W / 2, fy = H * 0.52, pull = e * 120;
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.5 * al).toFixed(3) + ')'; ctx.lineWidth = 2; ctx.setLineDash([4, 6]);
      ctx.beginPath(); ctx.moveTo(fx, fy); ctx.lineTo(fx, fy + pull); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,' + (0.3 * al).toFixed(3) + ')'; ctx.beginPath(); ctx.arc(fx, fy + pull, 17, 0, 6.283); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,' + (0.85 * al).toFixed(3) + ')'; ctx.lineWidth = 2; ctx.stroke();
    }

    /* morning light: warm from the sun side, cool in the far corner */
    const lg = ctx.createLinearGradient(W, 0, 0, H);
    lg.addColorStop(0, 'rgba(255,224,150,0.22)'); lg.addColorStop(0.45, 'rgba(255,224,150,0)'); lg.addColorStop(1, 'rgba(38,78,96,0.16)');
    ctx.fillStyle = lg; ctx.fillRect(0, 0, W, H);

    /* the score moment: sunlight breaks over the hole and a bird crosses */
    const m = G.moment;
    if (m && m.diff < 0) {
      const e = Math.sin(Math.min(1, m.t / m.dur) * Math.PI), sx = W * 0.96, sy = -H * 0.04;
      const g = ctx.createRadialGradient(sx, sy, 10, sx, sy, H * 1.15);
      g.addColorStop(0, 'rgba(255,226,140,' + (0.66 * e).toFixed(3) + ')'); g.addColorStop(0.5, 'rgba(255,214,120,' + (0.24 * e).toFixed(3) + ')'); g.addColorStop(1, 'rgba(255,214,120,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      if (!REDUCED) {
        ctx.fillStyle = 'rgba(255,238,180,' + (0.075 * e).toFixed(3) + ')';
        for (let i = 0; i < 4; i++) {
          const an = 1.72 + i * 0.3 + Math.sin(m.t * 0.5 + i * 1.7) * 0.04, wd = 0.045 + (i % 2) * 0.02, L = H * 1.6;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(sx + Math.cos(an - wd) * L, sy + Math.sin(an - wd) * L); ctx.lineTo(sx + Math.cos(an + wd) * L, sy + Math.sin(an + wd) * L); ctx.fill();
        }
      }
    }
    ctx.strokeStyle = 'rgba(28,44,44,0.85)'; ctx.lineCap = 'round';
    for (const bd of G.birds) {
      if (bd.t < 0) continue;
      const x = -60 + bd.sp * bd.t, y = bd.y0 + Math.sin(bd.t * 1.3) * 10 - bd.t * 7, z = bd.z, f = 0.25 + 0.75 * Math.sin(bd.t * (z > 16 ? 5 : 9));
      ctx.lineWidth = z * 0.17; ctx.beginPath();
      ctx.moveTo(x - z, y - z * 0.45 * f); ctx.quadraticCurveTo(x - z * 0.45, y - z * 0.5 * f - z * 0.18, x, y);
      ctx.quadraticCurveTo(x + z * 0.45, y - z * 0.5 * f - z * 0.18, x + z, y - z * 0.45 * f); ctx.stroke();
    }
  }

  /* ---------- loop and boot ---------- */
  let last = 0;
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now;
    try { update(dt); draw(); } catch (e) { if (window.console) console.error(e); }
    requestAnimationFrame(loop);
  }
  function snapshot() {
    if (!G.round) return {};
    let mode = G.mode === 'title' ? 'title' : G.mode === 'summary' ? 'summary' : 'play', hi = G.hi, ball = G.ball, strokes = G.strokes;
    if (G.mode === 'holed') { if (hi >= 2) mode = 'summary'; else { hi++; ball = G.round.holes[hi].tee; strokes = 0; } }
    return { key: G.round.key, practice: G.practice, mode, hi, ball: { x: ball.x, y: ball.y }, strokes, scores: G.scores.slice(), trails: G.trails.slice() };
  }
  function start(data) {
    resize(); sndIcon();
    const done = store.days[TODAY];
    if (data && data.key && data.mode && data.mode !== 'title') {
      newRound(data.key, data.practice); G.scores = data.scores || []; G.trails = data.trails || ['', '', ''];
      startPlay();
      if (data.mode === 'summary') { loadHole(2, null, true); G.mode = 'summary'; summary(); }
      else loadHole(data.hi || 0, { ball: data.ball, strokes: data.strokes || 0 });
    } else if (done) {
      newRound(TODAY, false); G.scores = done.scores.slice(); G.trails = done.trails.slice();
      loadHole(2, null, true); Object.assign(camT, holeFrame(G.hole)); Object.assign(cam, camT);
      $('title').hidden = true; summary();
    } else {
      newRound(TODAY, false); loadHole(0, null, true);
      Object.assign(camT, holeFrame(G.hole)); Object.assign(cam, camT);
      showTitle();
    }
    requestAnimationFrame(loop);
  }
  window.__dew = { G, cam, camT, C, snapshot,
    peek(key, i) { newRound(key, true); startPlay(); loadHole(i, null, true); Object.assign(camT, shotFrame()); Object.assign(cam, camT); } };
  const hot = window.claude && window.claude.hot;
  try { if (hot && hot.snapshot) hot.snapshot(snapshot); } catch (e) { /* ignore */ }
  if (hot && hot.ready) hot.ready(start); else start((hot && hot.data) || {});
})();
