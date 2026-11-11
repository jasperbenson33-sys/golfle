/* Dewsweeper 3D interface: world, camera, input, sound, flow. */
(function () {
  'use strict';
  const C = window.Core, T = C.T, PH = C.PHYS, clamp = C.clamp, THREE = window.THREE;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), glc = $('gl'), fxc = $('fx'), fx = fxc.getContext('2d'), mapc = $('mapc'), mctx = mapc.getContext('2d');
  const REDUCED = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const MINP = 0.07;

  let renderer = null;
  try { if (!THREE) throw new Error('no three'); renderer = new THREE.WebGLRenderer({ canvas: glc, antialias: true }); } catch (e) { renderer = null; }
  if (!renderer) {
    const d = document.createElement('div'); d.className = 'nogl';
    d.textContent = 'This version draws the course in 3D and needs WebGL, which this browser has switched off. The top-down version of Dewsweeper works without it.';
    stage.appendChild(d); $('title').hidden = true;
    return;
  }

  /* ---------- saved state (one viewer's conveniences only) ---------- */
  const STORE_KEY = 'dewsweeper3d.v1';
  let store = { days: {}, hints: {}, muted: false, progress: null };
  try { const raw = localStorage.getItem(STORE_KEY); if (raw) store = Object.assign(store, JSON.parse(raw)); } catch (e) { /* storage unavailable */ }
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ } }
  const z2 = (n) => String(n).padStart(2, '0');
  const dateKey = (d) => d.getFullYear() + '-' + z2(d.getMonth() + 1) + '-' + z2(d.getDate());
  const parseKey = (k) => { const p = k.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
  const EPOCH = new Date(2026, 10, 10);
  const dayNo = (k) => Math.round((parseKey(k) - EPOCH) / 86400000) + 1;
  let qs = null; try { qs = new URLSearchParams(location.search); } catch (e) { qs = null; }
  const TODAY = (qs && /^\d{4}-\d{2}-\d{2}$/.test(qs.get('date') || '')) ? qs.get('date') : dateKey(new Date());

  /* ---------- sound: everything is synthesised ---------- */
  const SndBuiltin = (function () {
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
      for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w; }
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
      for (let i = 0; i < n; i++) { const f = base * (0.9 + Math.random() * 0.3); tone(f, f * (Math.random() < 0.5 ? 1.25 : 0.8), (at || 0) + i * (0.075 + Math.random() * 0.05), 0.07, (loud || 1) * (0.014 + Math.random() * 0.016)); }
    }
    const safe = (fn) => function () { if (!ok()) return; try { fn.apply(null, arguments); } catch (e) { /* ignore */ } };
    return {
      init,
      setOn(v) { on = v; if (master) master.gain.value = on ? 0.9 : 0; },
      isOn: () => on,
      tick: safe(function (dt) { birdT -= dt; if (birdT <= 0) { chirp(0, 1); birdT = 1.6 + Math.random() * 5; } }),
      swing: safe(function (p) { burst(0.16 + p * 0.08, 0.1 + p * 0.22, 'bandpass', 700, 2600, 0.7); tone(1700, 600, 0.05, 0.035, 0.1 + p * 0.12, 'triangle'); }),
      putt: safe(function () { tone(560, 420, 0, 0.05, 0.13, 'triangle'); }),
      land: safe(function (lie) { tone(150, 70, 0, 0.09, lie === 0 ? 0.1 : 0.2); }),
      roll: function () {},
      sand: safe(function () { burst(0.22, 0.2, 'lowpass', 1400, 500); }),
      splash: safe(function () { burst(0.5, 0.3, 'bandpass', 1500, 600, 0.6); tone(420, 120, 0, 0.16, 0.14); }),
      tree: safe(function () { tone(250, 170, 0, 0.06, 0.2, 'triangle'); burst(0.3, 0.09, 'highpass', 3000); }),
      lip: safe(function () { tone(880, 700, 0, 0.03, 0.08, 'triangle'); }),
      cup: safe(function () { tone(640, 470, 0, 0.07, 0.2); tone(400, 290, 0.07, 0.12, 0.18); tone(110, 80, 0.07, 0.14, 0.14); }),
      chime: safe(function (diff) {
        const sets = { '-2': [523.25, 659.25, 783.99, 987.77, 1174.66, 1567.98], '-1': [587.33, 783.99, 987.77, 1174.66], '0': [392, 587.33], '1': [329.63], '2': [293.66] };
        sets[String(clamp(diff, -2, 2))].forEach(function (f, i) { tone(f, f, 0.35 + i * 0.14, 1.8, 0.1); tone(f * 2, f * 2, 0.35 + i * 0.14, 0.9, 0.025); });
        if (diff < 0) { chirp(0.9, 2.2); chirp(1.7, 1.8); if (diff < -1) chirp(2.4, 2); }
      })
    };
  })();
  /* a richer sound module can take over by defining window.DewAudio(opts) */
  const Snd = (function () {
    let ext = null;
    try { if (typeof window.DewAudio === 'function') ext = window.DewAudio({ muted: !!store.muted }); } catch (e) { ext = null; }
    if (!ext) return SndBuiltin;
    const o = {}; let on = !store.muted;
    ['init', 'setOn', 'tick', 'swing', 'putt', 'land', 'sand', 'splash', 'tree', 'lip', 'cup', 'chime', 'roll'].forEach(function (n) {
      o[n] = function () { try { if (typeof ext[n] === 'function') return ext[n].apply(ext, arguments); } catch (e) { /* sound must never break play */ } };
    });
    const setOn = o.setOn; o.setOn = function (v) { on = !!v; setOn(on); };
    o.isOn = function () { return on; };
    return o;
  })();
  const buzz = (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) { /* ignore */ } };

  /* ---------- game state ---------- */
  const G = {
    mode: 'title', round: null, practice: false, hi: 0, hole: null,
    ball: { x: 0, y: 0, z: 0 }, strokes: 0, scores: [], trails: ['', '', ''],
    club: 'driver', opt: null, base: 0, shot: null, acc: 0, evt: 0, settle: 0, aim: null, pend: null, follow: 0,
    time: 0, intro: 0, fdir: { x: 0, y: 1 }, fast: false, birds: [], moment: null, demo: false, orbit: 0, pv: null
  };
  let W = 0, H = 0;
  const PR = Math.min(window.devicePixelRatio || 1, 2);

  /* ---------- the world ---------- */
  const SUN_AZ = 0.92, SUN_EL = 0.26;            // low in the north-east
  const SUNH = { x: Math.sin(SUN_AZ), y: Math.cos(SUN_AZ) };
  const FOGC = 0xE3E6D3;
  renderer.setPixelRatio(PR);
  renderer.setClearColor(FOGC);
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(FOGC, 170, 1500);
  const camera = new THREE.PerspectiveCamera(62, 1, 0.25, 9000);
  scene.add(new THREE.HemisphereLight(0xE8F2FF, 0x7A9A66, 0.66));
  const sunLight = new THREE.DirectionalLight(0xFFF1D6, 0.58);
  sunLight.position.set(SUNH.x * 0.77, 0.64, -SUNH.y * 0.77);
  scene.add(sunLight);
  const P = (v, x, y, z) => v.set(x, z, -y);     // game (x east, y north, z up) -> three

  /* ---------- effect modules ----------
     Optional modules register on window.DewFX before this script runs. A module may replace a default
     piece of the world (see `replaces`) and is fed each new hole, every frame, and game events. */
  const QUALITY = (function () { const mem = navigator.deviceMemory || 4, cores = navigator.hardwareConcurrency || 4; return mem <= 2 || cores <= 2 ? 0 : mem >= 8 && cores >= 8 ? 2 : 1; })();
  const FX = (window.DewFX || []).filter((m) => m && typeof m === 'object');
  const fxHas = (n) => FX.some((m) => m.replaces && m.replaces.indexOf(n) >= 0);
  const ctx = {
    THREE, C, scene, camera, renderer, PR, P, quality: QUALITY, reduced: REDUCED,
    sunAz: SUN_AZ, sunEl: SUN_EL, sunH: SUNH, sunDir: null, lightDir: sunLight.position.clone().normalize(),
    fogColor: new THREE.Color(FOGC), fog: scene.fog,
    time: 0, dt: 0, mode: 'title', hole: null, holeGroup: null, ext: null, trees: [], meshH: null,
    wind: { x: 0, y: 1, mph: 0 },
    ball: { x: 0, y: 0, z: 0, h: 0, visible: false, moving: false, speed: 0 },
    club: { visible: false, id: 'driver', angle: 0, phi: 0, hands: new THREE.Vector3(), head: new THREE.Vector3() },
    camPos: null, camLook: null, viewW: 0, viewH: 0
  };
  function fxCall(hook, a, b) {
    for (const m of FX) {
      if (typeof m[hook] !== 'function') continue;
      try { m[hook](ctx, a, b); } catch (e) { if (!m['_err' + hook]) { m['_err' + hook] = 1; if (window.console) console.error('fx ' + (m.name || '?') + '.' + hook + ': ' + (e && e.stack ? e.stack : e)); } }
    }
  }
  const fxEvent = (type, data) => fxCall('onEvent', type, data || {});

  function canvasTex(size, draw) { const c = document.createElement('canvas'); c.width = c.height = size; draw(c.getContext('2d'), size); const t = new THREE.CanvasTexture(c); return t; }
  const dotTex = canvasTex(64, function (g, s) { g.fillStyle = '#fff'; g.beginPath(); g.arc(s / 2, s / 2, s * 0.42, 0, 6.283); g.fill(); });
  const sunTex = canvasTex(256, function (g, s) {
    const r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,252,235,1)'); r.addColorStop(0.07, 'rgba(255,246,210,0.95)'); r.addColorStop(0.2, 'rgba(255,226,150,0.42)'); r.addColorStop(0.5, 'rgba(255,214,130,0.12)'); r.addColorStop(1, 'rgba(255,214,130,0)');
    g.fillStyle = r; g.fillRect(0, 0, s, s);
  });
  const crossTex = canvasTex(64, function (g, s) { g.strokeStyle = '#FFD9CF'; g.lineWidth = 9; g.lineCap = 'round'; g.beginPath(); g.moveTo(14, 14); g.lineTo(50, 50); g.moveTo(50, 14); g.lineTo(14, 50); g.stroke(); });

  /* sky: pale at the horizon, blue overhead, warm toward the sun */
  (function () {
    const g = new THREE.SphereGeometry(7000, 32, 16), p = g.attributes.position, col = new Float32Array(p.count * 3);
    const zen = new THREE.Color(0x79AEDB), mid = new THREE.Color(0xBDD8E6), hor = new THREE.Color(FOGC), warm = new THREE.Color(0xFFD9A2), c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i), t = clamp(y / 7000, 0, 1), l = Math.hypot(x, z) || 1;
      const sd = clamp((x / l) * SUNH.x + (-z / l) * SUNH.y, 0, 1);
      if (t < 0.22) c.copy(hor).lerp(mid, Math.pow(t / 0.22, 0.75)); else c.copy(mid).lerp(zen, Math.pow((t - 0.22) / 0.78, 0.8));
      c.lerp(warm, Math.pow(sd, 3) * (1 - t) * (1 - t) * 0.8);
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    m.renderOrder = -10; m.frustumCulled = false; m.name = 'sky';
    scene.add(m);
  })();
  const sky = scene.getObjectByName('sky');
  const sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: sunTex, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }));
  sun.scale.set(2600, 2600, 1); scene.add(sun);
  const sunDir = new THREE.Vector3(SUNH.x * Math.cos(SUN_EL), Math.sin(SUN_EL), -SUNH.y * Math.cos(SUN_EL));

  /* far country: two hazy ridgelines and open ground out to the mist */
  const far = new THREE.Group(); scene.add(far);
  function ridge(R, base, amp, color, seed) {
    const N = 96, pos = [], idx = [], rng = C.makeRng(seed), ph = [rng() * 6, rng() * 6, rng() * 6];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * 6.2832, hg = base + amp * (0.5 + 0.5 * Math.sin(a * 3 + ph[0])) * (0.6 + 0.4 * Math.sin(a * 7 + ph[1])) + amp * 0.14 * Math.sin(a * 19 + ph[2]);
      pos.push(Math.cos(a) * R, -40, Math.sin(a) * R, Math.cos(a) * R, hg, Math.sin(a) * R);
    }
    for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, fog: false, side: THREE.DoubleSide })); m.frustumCulled = false;
    return m;
  }
  far.add(ridge(4300, 150, 470, 0xC9D6D0, 11)); far.add(ridge(3000, 60, 300, 0xAEC3B6, 23));
  { const g = new THREE.CircleGeometry(5200, 48); g.rotateX(-Math.PI / 2); const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: 0x55805A })); m.position.y = -2.05; m.name = 'farGround'; scene.add(m); }
  ctx.sunDir = sunDir;
  if (fxHas('sky')) { scene.remove(sky); scene.remove(sun); scene.remove(far); }

  /* ball, its shadow, the club in your hands */
  const ball = new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x666666, fog: false }));
  ball.add(new THREE.Mesh(new THREE.SphereGeometry(1.12, 14, 10), new THREE.MeshBasicMaterial({ color: 0x10261d, side: THREE.BackSide, transparent: true, opacity: 0.38, fog: false })));
  scene.add(ball);
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(1, 18).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x0c241c, transparent: true, opacity: 0.34, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  scene.add(shadow);
  const clubG = new THREE.Group(); scene.add(clubG);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.016, 1, 6), new THREE.MeshLambertMaterial({ color: 0xD5DBDD }));
  clubG.add(shaft);
  const steel = new THREE.MeshLambertMaterial({ color: 0xC3CCD0 });
  const heads = {
    driver: new THREE.Mesh(new THREE.SphereGeometry(0.135, 14, 10).scale(1.35, 0.62, 1.05), new THREE.MeshLambertMaterial({ color: 0x22303A })),
    iron: new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.13, 0.045), steel),
    wedge: new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.15, 0.05), steel),
    putter: new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.07, 0.09), new THREE.MeshLambertMaterial({ color: 0x9AA6AB }))
  };
  const headUp = { driver: 0.085, iron: 0.07, wedge: 0.08, putter: 0.04 }, headBack = { driver: 0.36, iron: 0.27, wedge: 0.29, putter: 0.17 }, headTilt = { driver: 0, iron: -0.3, wedge: -0.55, putter: 0 };
  for (const k in heads) { heads[k].rotation.order = 'YXZ'; clubG.add(heads[k]); }

  /* aiming aids */
  const ARCN = 140;
  const arcGeo = new THREE.BufferGeometry(); arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARCN * 3), 3));
  const dotGeo = new THREE.BufferGeometry(); dotGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARCN * 3), 3));
  const arc = new THREE.Points(dotGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 4.4 * PR, sizeAttenuation: false, map: dotTex, alphaTest: 0.5, transparent: true, depthTest: false, fog: false }));
  arc.frustumCulled = false; arc.renderOrder = 20; arc.visible = false; scene.add(arc);
  const arcLine = new THREE.Line(arcGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false, fog: false }));
  arcLine.frustumCulled = false; arcLine.renderOrder = 19; arcLine.visible = false; scene.add(arcLine);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.78, 1, 44).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthTest: false, fog: false, side: THREE.DoubleSide }));
  ring.renderOrder = 21; ring.visible = false; scene.add(ring);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 1, true).translate(0, 0.5, 0), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.42, depthWrite: false, fog: false, side: THREE.DoubleSide }));
  beam.visible = false; scene.add(beam);
  const runGeo = new THREE.BufferGeometry(); runGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12 * 3), 3));
  const runLine = new THREE.Line(runGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, depthTest: false, fog: false }));
  runLine.frustumCulled = false; runLine.renderOrder = 21; runLine.visible = false; scene.add(runLine);
  const runEnd = new THREE.Mesh(new THREE.RingGeometry(0.55, 1, 28).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, depthTest: false, fog: false, side: THREE.DoubleSide }));
  runEnd.renderOrder = 21; runEnd.visible = false; scene.add(runEnd);
  const cross = new THREE.Sprite(new THREE.SpriteMaterial({ map: crossTex, depthTest: false, fog: false, transparent: true, sizeAttenuation: false }));
  cross.scale.set(0.05, 0.05, 1); cross.renderOrder = 22; cross.visible = false; scene.add(cross);
  const TRN = 900;
  const trailGeo = new THREE.BufferGeometry(); trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRN * 3), 3)); trailGeo.setDrawRange(0, 0);
  const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, fog: false }));
  trail.frustumCulled = false; scene.add(trail);
  let trailN = 0;
  /* beads that drift downhill on the green */
  const BEADS = 70, beadPos = [];
  const beads = new THREE.InstancedMesh(new THREE.SphereGeometry(0.05, 6, 5), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, fog: false }), BEADS);
  beads.frustumCulled = false; beads.visible = false; scene.add(beads);
  /* small bursts: sand, water, leaves */
  const PMAX = 96, parts = [];
  const pGeo = new THREE.BufferGeometry(); pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PMAX * 3), 3)); pGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(PMAX * 3), 3)); pGeo.setDrawRange(0, 0);
  const pPts = new THREE.Points(pGeo, new THREE.PointsMaterial({ size: 0.3, vertexColors: true, map: dotTex, alphaTest: 0.4, transparent: true, fog: false }));
  pPts.frustumCulled = false; scene.add(pPts);
  function burst3(x, y, z, rgb, n, sp, up) {
    if (fxHas('particles')) return;
    for (let i = 0; i < n && parts.length < PMAX; i++) {
      const a = Math.random() * 6.283, v = sp * (0.3 + Math.random() * 0.8);
      parts.push({ x, y, z: z + 0.1, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vz: up * (0.5 + Math.random() * 0.7), t: 0, life: 0.5 + Math.random() * 0.5, c: rgb });
    }
  }

  /* ---------- building a hole ---------- */
  let holeG = null, pinG = null, flag = null, gridL = null, terrainTex = null;
  const MARGIN = 120;
  function meshH(h, x, y) { // real ground inside the hole, easing to a level plain far outside it
    const b = h.bounds, out = Math.max(b.x0 - x, x - b.x1, b.y0 - y, y - b.y1, 0);
    const z = C.heightAt(h, x, y);
    return out > 60 ? z + (-2 - z) * C.smooth(60, MARGIN - 6, out) : z;
  }
  function disposeTree(o) {
    o.traverse(function (m) { if (m.geometry) m.geometry.dispose(); if (m.material) { if (m.material.map && m.material.map !== dotTex) m.material.map.dispose(); m.material.dispose(); } });
  }
  const texCanvas = document.createElement('canvas');
  function paintTerrain(h, ext) {
    const lowMem = (navigator.deviceMemory && navigator.deviceMemory <= 4) || renderer.capabilities.maxTextureSize < 4096;
    const tall = (ext.y1 - ext.y0) / (ext.x1 - ext.x0) > 1.5;
    const cw = lowMem ? 1024 : 2048, ch = (tall ? 2 : 1) * cw;
    texCanvas.width = cw; texCanvas.height = ch;
    const g = texCanvas.getContext('2d'), sx = cw / (ext.x1 - ext.x0), sy = ch / (ext.y1 - ext.y0), b = h.bounds;
    const rng = C.makeRng(C.hashStr('paint|' + h.yards + '|' + h.trees.length));
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = '#4C7550'; g.fillRect(0, 0, cw, ch);
    g.setTransform(sx, 0, 0, -sy, -ext.x0 * sx, ext.y1 * sy);
    const circ = (list, pad) => { g.beginPath(); for (const c of list) { g.moveTo(c.x + c.r + pad, c.y); g.arc(c.x, c.y, c.r + pad, 0, 6.283); } };
    const stripes = (c1, c2, n) => { const t = document.createElement('canvas'); t.width = t.height = n * 2; const q = t.getContext('2d'); q.fillStyle = c1; q.fillRect(0, 0, n * 2, n * 2); q.fillStyle = c2; q.fillRect(0, 0, n, n * 2); return g.createPattern(t, 'repeat'); };
    const checks = (c1, c2, n) => { const t = document.createElement('canvas'); t.width = t.height = n * 2; const q = t.getContext('2d'); q.fillStyle = c1; q.fillRect(0, 0, n * 2, n * 2); q.fillStyle = c2; q.fillRect(0, 0, n, n); q.fillRect(n, n, n, n); return g.createPattern(t, 'repeat'); };
    /* woods floor mottling, then the mown rough */
    for (let i = 0; i < 260; i++) { g.fillStyle = rng.chance(0.5) ? 'rgba(30,60,40,0.10)' : 'rgba(110,140,80,0.08)'; g.beginPath(); g.arc(rng.range(ext.x0, ext.x1), rng.range(ext.y0, ext.y1), rng.range(8, 30), 0, 6.283); g.fill(); }
    g.fillStyle = '#6F9B62'; g.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
    g.save(); g.beginPath(); g.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.clip();
    for (let i = 0; i < 150; i++) { g.fillStyle = rng.chance(0.5) ? 'rgba(255,255,200,0.05)' : 'rgba(20,60,40,0.06)'; g.beginPath(); g.arc(rng.range(b.x0, b.x1), rng.range(b.y0, b.y1), rng.range(6, 34), 0, 6.283); g.fill(); }
    g.restore();
    /* fairway with mowing stripes */
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const f of h.fairways) {
      g.beginPath(); f.pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.strokeStyle = '#86B46D'; g.lineWidth = f.hw * 2 + 3; g.stroke();
      g.strokeStyle = stripes('#9BC878', '#A8D284', 8); g.lineWidth = f.hw * 2; g.stroke();
    }
    g.fillStyle = '#A6D083'; g.fillRect(h.tee.x - 6, h.tee.y - 6, 12, 12);
    circ(h.green, h.fringeW); g.fillStyle = '#A2CE80'; g.fill();
    for (const w of h.water) { circ(w, 2.2); g.fillStyle = '#7C9A6A'; g.fill(); }
    for (const w of h.water) { circ(w, 0.6); g.fillStyle = '#5E97B2'; g.fill(); }
    for (const k of h.bunkers) { circ(k, 1.1); g.fillStyle = '#7FAA6A'; g.fill(); }
    for (const k of h.bunkers) { circ(k, 0); g.fillStyle = '#EDE3BE'; g.fill(); }
    for (const k of h.bunkers) { circ(k, -2.2); g.fillStyle = 'rgba(255,250,225,0.5)'; g.fill(); }
    circ(h.green, 0); g.fillStyle = checks('#B4DE90', '#BDE59A', 3); g.fill();
    /* long morning shadows fall away from the sun */
    g.fillStyle = 'rgba(12,38,30,0.2)';
    for (const m of FX) if (typeof m.paintTerrain === 'function') { // modules may add ground detail, in world units, before shadows go on
      try { g.save(); m.paintTerrain(ctx, h, g, { ext, sx, sy, cw, ch, circ }); g.restore(); g.fillStyle = 'rgba(12,38,30,0.2)'; } catch (e) { g.restore(); if (window.console) console.error('fx paintTerrain: ' + e); }
    }
    g.setTransform(sx, 0, 0, -sy, -ext.x0 * sx, ext.y1 * sy);
    for (const t of h.trees) {
      const len = Math.min(34, t.H * 2.3), cx = t.x - SUNH.x * len * 0.5, cy = t.y - SUNH.y * len * 0.5;
      g.save(); g.translate(cx, cy); g.rotate(Math.atan2(-SUNH.y, -SUNH.x)); g.beginPath(); g.ellipse(0, 0, len * 0.5 + t.r * 0.5, t.r * 0.8, 0, 0, 6.283); g.fill(); g.restore();
    }
    const tex = new THREE.CanvasTexture(texCanvas);
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    return tex;
  }
  const dummy = new THREE.Object3D(), tmpC = new THREE.Color(), AUTUMN = [0xC98A32, 0xB5572C, 0xD8A63C, 0xA94A2B, 0xCF7A2E];
  function buildHole(h) {
    if (holeG) { scene.remove(holeG); disposeTree(holeG); }
    holeG = new THREE.Group(); scene.add(holeG);
    const b = h.bounds, ext = { x0: b.x0 - MARGIN, x1: b.x1 + MARGIN, y0: b.y0 - MARGIN, y1: b.y1 + MARGIN };
    h.ext = ext;
    far.position.set((b.x0 + b.x1) / 2, 0, -(b.y0 + b.y1) / 2);
    /* every tree: the ones in play, plus woods beyond the boundary */
    const rng = C.makeRng(C.hashStr('woods|' + h.yards + '|' + h.trees.length)), list = h.trees.map((t) => Object.assign({ play: true }, t));
    for (let i = 0; i < 520; i++) {
      const x = rng.range(ext.x0 + 8, ext.x1 - 8), y = rng.range(ext.y0 + 8, ext.y1 - 8);
      if (x > b.x0 - 7 && x < b.x1 + 7 && y > b.y0 - 7 && y < b.y1 + 7) continue;
      const r = rng.range(7, 12.5);
      list.push({ x, y, r, H: clamp(r * rng.range(1.5, 2.3), 11, 26), tone: rng(), kind: rng.chance(0.3) ? 1 : 0, z: meshH(h, x, y), play: false });
    }
    ctx.hole = h; ctx.holeGroup = holeG; ctx.ext = ext; ctx.trees = list; ctx.meshH = meshH;
    ctx.wind.x = h.wind.x; ctx.wind.y = h.wind.y; ctx.wind.mph = h.wind.mph;

    /* ground */
    terrainTex = paintTerrain(h, ext);
    const step = Math.max(2.5, Math.sqrt(((ext.x1 - ext.x0) * (ext.y1 - ext.y0)) / 62000)), nx = Math.ceil((ext.x1 - ext.x0) / step), ny = Math.ceil((ext.y1 - ext.y0) / step);
    const pos = new Float32Array((nx + 1) * (ny + 1) * 3), uv = new Float32Array((nx + 1) * (ny + 1) * 2), idx = new Uint32Array(nx * ny * 6);
    let k = 0, u = 0, q = 0;
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      const x = ext.x0 + ((ext.x1 - ext.x0) * i) / nx, y = ext.y0 + ((ext.y1 - ext.y0) * j) / ny;
      pos[k++] = x; pos[k++] = meshH(h, x, y); pos[k++] = -y; uv[u++] = i / nx; uv[u++] = j / ny;
    }
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = j * (nx + 1) + i, bb = a + 1, c = a + nx + 1, d = c + 1;
      idx[q++] = a; idx[q++] = bb; idx[q++] = c; idx[q++] = bb; idx[q++] = d; idx[q++] = c;
    }
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(pos, 3)); tg.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); tg.setIndex(new THREE.BufferAttribute(idx, 1));
    tg.computeVertexNormals();
    let tmat = null;
    for (const m of FX) if (!tmat && typeof m.terrainMaterial === 'function') { try { tmat = m.terrainMaterial(ctx, terrainTex, { h, ext }) || null; } catch (e) { tmat = null; if (window.console) console.error('fx terrainMaterial: ' + e); } }
    const terrain = new THREE.Mesh(tg, tmat || new THREE.MeshLambertMaterial({ map: terrainTex })); terrain.name = 'terrain'; holeG.add(terrain);

    /* water sits level in its basin and catches the light */
    if (!fxHas('water')) {
      const wm = new THREE.MeshPhongMaterial({ color: 0x6FA6C2, specular: 0xBFD5E0, shininess: 70 });
      h.water.forEach(function (pond, i) {
        for (const c of pond) { const m = new THREE.Mesh(new THREE.CircleGeometry(c.r + 0.5, 28).rotateX(-Math.PI / 2), wm); P(m.position, c.x, c.y, h.ter.wl[i]); holeG.add(m); }
      });
    }

    /* trees */
    if (!fxHas('trees')) {
    const broad = list.filter((t) => !t.kind), conif = list.filter((t) => t.kind);
    const leaf = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const bGeo = new THREE.IcosahedronGeometry(1, 1); bGeo.computeVertexNormals();
    const cGeo = new THREE.ConeGeometry(1, 1, 7).toNonIndexed(); cGeo.computeVertexNormals();
    const colorOf = (t) => {
      const f = (t.tone * 7.31) % 1;
      if (!t.kind && f < 0.24) tmpC.setHex(AUTUMN[Math.floor(f / 0.24 * AUTUMN.length) % AUTUMN.length]).multiplyScalar(0.92 + t.tone * 0.12);
      else tmpC.setHSL(0.34 + (t.tone - 0.5) * 0.07 + (t.kind ? 0.03 : 0), 0.36, (t.kind ? 0.22 : 0.27) + t.tone * 0.09);
      return tmpC;
    };
    const im1 = new THREE.InstancedMesh(bGeo, leaf, broad.length), im2 = new THREE.InstancedMesh(cGeo, leaf, conif.length);
    const tr = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 1, 1, 5), new THREE.MeshLambertMaterial({ color: 0x5A4A3B }), list.length);
    broad.forEach(function (t, i) {
      P(dummy.position, t.x, t.y, t.z + t.H * 0.66); dummy.scale.set(t.r, t.H * 0.34, t.r); dummy.rotation.set(0, t.tone * 6.283, 0); dummy.updateMatrix();
      im1.setMatrixAt(i, dummy.matrix); im1.setColorAt(i, colorOf(t));
    });
    conif.forEach(function (t, i) {
      P(dummy.position, t.x, t.y, t.z + t.H * 0.58); dummy.scale.set(t.r * 0.8, t.H * 0.84, t.r * 0.8); dummy.rotation.set(0, t.tone * 6.283, 0); dummy.updateMatrix();
      im2.setMatrixAt(i, dummy.matrix); im2.setColorAt(i, colorOf(t));
    });
    list.forEach(function (t, i) {
      P(dummy.position, t.x, t.y, t.z + t.H * 0.2 - 0.3); dummy.scale.set(t.r * 0.11, t.H * 0.42 + 0.6, t.r * 0.11); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
      tr.setMatrixAt(i, dummy.matrix);
    });
    for (const m of [im1, im2, tr]) { m.frustumCulled = false; holeG.add(m); }
    }

    /* pin and cup */
    pinG = new THREE.Group(); P(pinG.position, h.pin.x, h.pin.y, h.pin.z); holeG.add(pinG);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.5, 6), new THREE.MeshBasicMaterial({ color: 0xFAFAF2, fog: false })); pole.position.y = 1.25; pinG.add(pole);
    flag = new THREE.Mesh(new THREE.PlaneGeometry(0.95, 0.6).translate(0.475, 0, 0), new THREE.MeshBasicMaterial({ color: 0xD5432D, side: THREE.DoubleSide, fog: false }));
    flag.position.y = 2.18; pinG.add(flag);
    const cup = new THREE.Mesh(new THREE.CircleGeometry(PH.CUP_R * 1.02, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x15231B, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    P(cup.position, h.pin.x, h.pin.y, h.pin.z + 0.015); holeG.add(cup);
    /* tee markers */
    const a0 = h.legs[0].a, lx = -Math.cos(a0), ly = Math.sin(a0);
    for (const sgn of [-1, 1]) { const m = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), new THREE.MeshLambertMaterial({ color: 0xF4F1E4 })); P(m.position, h.tee.x + lx * sgn * 2.2, h.tee.y + ly * sgn * 2.2, h.tee.z + 0.12); holeG.add(m); }

    /* faint grid over the green so the tilt reads in perspective */
    const gp = [], gs = 2.5;
    let gx0 = 1e9, gx1 = -1e9, gy0 = 1e9, gy1 = -1e9;
    for (const c of h.green) { gx0 = Math.min(gx0, c.x - c.r); gx1 = Math.max(gx1, c.x + c.r); gy0 = Math.min(gy0, c.y - c.r); gy1 = Math.max(gy1, c.y + c.r); }
    h.gbox = { x0: gx0, x1: gx1, y0: gy0, y1: gy1 };
    const seg = (xa, ya, xb, yb) => { if (C.inCircles(h.green, xa, ya, 0) && C.inCircles(h.green, xb, yb, 0)) gp.push(xa, C.heightAt(h, xa, ya) + 0.04, -ya, xb, C.heightAt(h, xb, yb) + 0.04, -yb); };
    for (let x = Math.ceil(gx0 / gs) * gs; x <= gx1; x += gs) for (let y = gy0; y < gy1; y += 1.25) seg(x, y, x, y + 1.25);
    for (let y = Math.ceil(gy0 / gs) * gs; y <= gy1; y += gs) for (let x = gx0; x < gx1; x += 1.25) seg(x, y, x + 1.25, y);
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(gp, 3));
    gridL = new THREE.LineSegments(gg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.26, fog: false, depthWrite: false }));
    gridL.visible = false; holeG.add(gridL);
    beadPos.length = 0;
    const br = C.makeRng(7 + h.yards);
    while (beadPos.length < BEADS) { const x = br.range(gx0, gx1), y = br.range(gy0, gy1); if (C.inCircles(h.green, x, y, -0.3)) beadPos.push({ x, y }); }
    fxCall('onHole', h);
  }

  /* ---------- camera ---------- */
  const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), tPos = new THREE.Vector3(), tLook = new THREE.Vector3(), tmpV = new THREE.Vector3();
  let camYaw = 0;
  ctx.camPos = camPos; ctx.camLook = camLook;
  const reachOf = (club) => (club === 'putter' ? 60 : G.opt.clubs[club].max * 1.1 + 4);
  function setBase() {
    const h = G.hole;
    const p = G.club === 'putter' ? h.pin : C.aimPoint(h, G.ball, reachOf(G.club));
    G.base = Math.atan2(p.x - G.ball.x, p.y - G.ball.y);
  }
  function addressPose(hd, pw) {
    const h = G.hole, b = G.ball, dx = Math.sin(hd), dy = Math.cos(hd);
    if (G.club === 'putter') {
      const dd = C.dist(b, h.pin), back = clamp(2.6 + dd * 0.34, 3.2, 10), up = clamp(1.6 + dd * 0.26, 1.9, 7), la = clamp(dd * 0.62, 1.5, 16);
      P(tPos, b.x - dx * back + dy * 0.25, b.y - dy * back - dx * 0.25, b.z + up);
      P(tLook, b.x + dx * la, b.y + dy * la, C.heightAt(h, b.x + dx * la, b.y + dy * la));
    } else {
      const back = 4.3 + pw * 0.9, up = 1.8 + pw * 0.8, side = 0.6; // behind the ball, just right of the line, as if stood over it
      P(tPos, b.x - dx * back + dy * side, b.y - dy * back - dx * side, b.z + up);
      P(tLook, b.x + dx * 11 + dy * 0.15, b.y + dy * 11 - dx * 0.15, b.z - 0.1);
    }
  }
  function overviewPose() {
    const h = G.hole, a = h.legs[0].a, dx = Math.sin(a), dy = Math.cos(a), sw = REDUCED ? 0 : Math.sin(G.time * 0.17) * 7;
    P(tPos, h.tee.x - dx * 48 + dy * sw, h.tee.y - dy * 48 - dx * sw, h.tee.z + 20);
    P(tLook, h.tee.x + dx * 130, h.tee.y + dy * 130, h.tee.z - 8);
  }
  function snapCam() { camPos.copy(tPos); camLook.copy(tLook); }
  function updateCamera(dt) {
    const h = G.hole; let kP = 4, kL = 5;
    if (G.mode === 'title') { overviewPose(); kP = 1; kL = 1; }
    else if (G.mode === 'summary' || G.mode === 'holed') {
      const slow = G.mode === 'summary', R = slow ? 46 : 20, a = G.orbit + (REDUCED ? 0 : (G.time - G.orbitT) * (slow ? 0.05 : 0.16));
      P(tPos, h.pin.x + Math.cos(a) * R, h.pin.y + Math.sin(a) * R, h.pin.z + (slow ? 18 : 6.5));
      P(tLook, h.pin.x, h.pin.y, h.pin.z + 1.2); kP = slow ? 0.8 : 1.3; kL = 2;
    } else if (G.mode === 'aim' || G.mode === 'swing') {
      const src = G.aim || G.pend;
      addressPose(G.base + (src ? src.off * 0.8 : 0), src ? src.power : 0);
      if (G.intro > 0) { kP = 1.7; kL = 2.2; } else { kP = 4.5; kL = 4.5; }
    } else if (G.mode === 'flying' && G.shot) {
      const s = G.shot;
      if (s.club === 'putter') {
        addressPose(G.base, 0);
        tmpV.set(s.x, s.z, -s.y); tLook.lerp(tmpV, 0.6); kP = 3; kL = 4;
      } else {
        const hl = Math.hypot(s.vx, s.vy); if (hl > 0.6) { G.fdir.x = s.vx / hl; G.fdir.y = s.vy / hl; }
        const fd = G.fdir, air = s.phase === 'fly', gz = C.heightAt(h, s.x, s.y);
        const back = air ? 12 : 8.5, up = air ? 3.2 + s.h * 0.7 : 2.8;
        P(tPos, s.x - fd.x * back + fd.y * 2.2, s.y - fd.y * back - fd.x * 2.2, gz + up); // a touch to the side, so the arc reads
        P(tLook, s.x + fd.x * (air ? 6 : 2), s.y + fd.y * (air ? 6 : 2), s.z + s.h * (air ? -0.22 : 1) + 0.2);
        kP = air ? 2.6 : 3; kL = 9;
      }
    }
    camPos.lerp(tPos, 1 - Math.exp(-dt * kP)); camLook.lerp(tLook, 1 - Math.exp(-dt * kL));
    const gz = meshH(h, camPos.x, -camPos.z) + 0.9; if (camPos.y < gz) camPos.y = gz;
    if (G.free) { camPos.copy(G.free.pos); camLook.copy(G.free.look); }
    const tr = G.free ? null : C.treeAt(h, camPos.x, -camPos.z); // never sit inside a trunk
    if (tr) { const ddx = camPos.x - tr.x, ddy = -camPos.z - tr.y, dl = Math.hypot(ddx, ddy) || 1, rr = tr.r * 0.11 + 1.1; if (dl < rr) { camPos.x = tr.x + (ddx / dl) * rr; camPos.z = -(tr.y + (ddy / dl) * rr); } }
    camera.position.copy(camPos); camera.lookAt(camLook);
    camYaw = Math.atan2(camLook.x - camPos.x, -(camLook.z - camPos.z));
    sky.position.copy(camPos); sun.position.copy(camPos).addScaledVector(sunDir, 6000);
  }
  function project(x, y, z) {
    tmpV.set(x, z, -y).applyMatrix4(camera.matrixWorldInverse);
    if (tmpV.z > -0.3) return null;
    tmpV.applyMatrix4(camera.projectionMatrix);
    return { x: (tmpV.x * 0.5 + 0.5) * W, y: (-tmpV.y * 0.5 + 0.5) * H };
  }

  function resize() {
    const r = stage.getBoundingClientRect();
    W = Math.max(200, r.width); H = Math.max(300, r.height);
    renderer.setSize(W, H, false);
    camera.aspect = W / H; camera.fov = W / H > 0.75 ? 50 : 62; camera.updateProjectionMatrix();
    fxc.width = Math.round(W * PR); fxc.height = Math.round(H * PR); ctx.viewW = W; ctx.viewH = H;
    const mr = mapc.getBoundingClientRect(); mapc.width = Math.round((mr.width || 92) * PR); mapc.height = Math.round((mr.height || 150) * PR);
  }
  window.addEventListener('resize', resize);

  /* ---------- round flow ---------- */
  function newRound(key, practice) {
    G.round = C.makeRound(key); G.practice = !!practice;
    G.scores = []; G.trails = ['', '', '']; G.moment = null; G.birds = [];
  }
  function setClub(c) { G.club = c; setBase(); updateClubs(); updateHud(); }
  function prepShot() {
    const h = G.hole;
    G.ball.z = C.heightAt(h, G.ball.x, G.ball.y);
    G.opt = C.clubOptions(h, G.ball); G.club = G.opt.suggest; setBase();
    G.shot = null; G.aim = null; G.pend = null; G.pv = null; G.mode = 'aim'; G.fast = false;
    trailN = 0; trailGeo.setDrawRange(0, 0);
    updateClubs(); updateHud();
  }
  function loadHole(i, restore, quiet) {
    G.hi = i; G.hole = G.round.holes[i];
    const h = G.hole;
    buildHole(h);
    G.ball = restore ? { x: restore.ball.x, y: restore.ball.y, z: 0 } : { x: h.tee.x, y: h.tee.y, z: 0 };
    G.strokes = restore ? restore.strokes : 0;
    if (!restore) G.trails[i] = '';
    G.moment = null; parts.length = 0;
    prepShot();
    if (quiet || restore) { addressPose(G.base, 0); snapCam(); G.intro = 0; }
    else { overviewPose(); snapCam(); G.intro = 1.7; } // open on the whole hole, then settle behind the ball
    if (!quiet) { banner(); hints(); }
  }
  function enterAim() { prepShot(); hints(); progress(); }
  function progress() {
    if (G.practice) return;
    store.progress = { key: G.round.key, hi: G.hi, ball: { x: G.ball.x, y: G.ball.y }, strokes: G.strokes, scores: G.scores.slice(), trails: G.trails.slice() };
    save();
  }
  function fire(angle, power) {
    G.shot = C.createShot(G.hole, G.ball, G.club, angle, power, true);
    G.strokes++; G.mode = 'flying'; G.acc = 0; G.evt = 0; G.settle = -1; G.follow = 0.22;
    G.fdir.x = Math.sin(angle); G.fdir.y = Math.cos(angle);
    trailN = 0; trailGeo.setDrawRange(0, 0);
    if (G.club === 'putter') Snd.putt(power); else Snd.swing(power, G.club);
    buzz(8);
    if (!store.hints.pull) { store.hints.pull = 1; save(); }
    fxEvent('strike', { club: G.club, power, x: G.ball.x, y: G.ball.y, z: G.ball.z, lie: G.shot.lie, dir: { x: Math.sin(angle), y: Math.cos(angle) } });
    G.demo = false; hint(''); banner(false); updateHud();
    $('lie').textContent = G.club === 'putter' ? 'Rolling' : 'In the air \u00b7 tap to speed up';
  }
  function shotDone() {
    const h = G.hole, r = G.shot.result;
    fxEvent('rest', { x: r.x, y: r.y, z: r.z, lie: r.lie, kind: r.kind });
    if (r.kind === 'holed') { G.trails[G.hi] += 'H'; G.ball = { x: h.pin.x, y: h.pin.y, z: h.pin.z }; holeDone(G.strokes, false); return; }
    let msg = null;
    if (r.kind === 'water') { G.strokes++; G.trails[G.hi] += 'W'; msg = 'Water. One penalty stroke, and you play again from the same spot.'; }
    else {
      G.ball = { x: r.x, y: r.y, z: r.z };
      G.trails[G.hi] += r.tree ? 'T' : 'RFFFGSW'[r.lie];
      if (r.tree && !store.hints.tree) { store.hints.tree = 1; save(); msg = 'Trees knock the ball down. Go around them, or over them with a higher-flying club.'; }
    }
    if (G.strokes >= h.par + 3) { G.trails[G.hi] += 'X'; holeDone(h.par + 4, true); return; }
    enterAim();
    if (msg) hint(msg, 5600);
  }
  function holeDone(score, pickup) {
    const h = G.hole, diff = score - h.par;
    G.scores[G.hi] = score; G.mode = 'holed'; G.aim = null; G.pend = null;
    G.orbit = Math.atan2(-camPos.z - h.pin.y, camPos.x - h.pin.x); G.orbitT = G.time;
    const name = pickup ? 'Picked up' : C.scoreName(h.par, score);
    G.moment = { t: 0, diff, pickup, dur: diff < 0 ? 4.4 : 2.8 };
    $('m-name').textContent = name;
    $('m-sub').textContent = pickup ? 'Hole ' + (G.hi + 1) + ' · scored as ' + score : 'Hole ' + (G.hi + 1) + ' · ' + score + (score === 1 ? ' stroke' : ' strokes') + ' on a par ' + h.par;
    const m = $('moment'); m.className = 'moment ' + (diff < 0 ? 'under' : diff > 0 ? 'over' : 'level');
    void m.offsetWidth; m.classList.add('show');
    if (!pickup) Snd.chime(diff);
    fxEvent('score', { diff, name, pickup: !!pickup });
    if (diff < 0) spawnBirds(diff);
    hint('');
    if (!G.practice) {
      if (G.hi < 2) { const nt = G.round.holes[G.hi + 1].tee; store.progress = { key: G.round.key, hi: G.hi + 1, ball: { x: nt.x, y: nt.y }, strokes: 0, scores: G.scores.slice(), trails: G.trails.slice() }; }
      else { store.days[G.round.key] = { scores: G.scores.slice(), trails: G.trails.slice() }; store.progress = null; }
      save();
    }
    updateHud(); updateClubs();
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
    $('wind-txt').textContent = h.wind.mph > 0 ? h.wind.mph + ' mph' : 'Calm';
    $('wind-arrow').style.opacity = h.wind.mph > 0 ? 1 : 0.3;
    if (G.mode === 'flying' || G.mode === 'swing') return;
    if (G.mode === 'holed') { $('lie').textContent = 'In the cup'; return; }
    const o = G.opt; if (!o) return;
    const dz = Math.round((h.pin.z - G.ball.z) * 3);
    const lay = Math.abs(dz) >= 4 ? ', ' + Math.abs(dz) + ' ft ' + (dz > 0 ? 'uphill' : 'downhill') : '';
    $('lie').textContent = o.lie === T.GREEN ? 'Putt ' + (G.strokes + 1) + ' · ' + Math.max(1, Math.round(o.dist * 3)) + ' ft to the cup'
      : 'Shot ' + (G.strokes + 1) + ' · ' + C.LIE_NAME[o.lie] + ' · ' + Math.round(o.dist) + ' yd' + lay;
  }
  function updateClubs() {
    const o = G.opt, live = G.mode === 'aim';
    for (const c of C.CLUB_ORDER) {
      const el = $('club-' + c), ok = !!(o && o.clubs[c].ok);
      el.disabled = !ok || !live; el.setAttribute('aria-pressed', c === G.club && G.mode !== 'holed' ? 'true' : 'false');
      if (c !== 'putter') $('yd-' + c).textContent = c === 'driver' && o && !ok && o.lie !== T.GREEN ? 'Tee only' : Math.round(o ? (c === 'wedge' && o.clubs[c].full ? o.clubs[c].full : o.clubs[c].max) : C.CLUBS[c].max) + ' yd';
    }
  }
  for (const c of C.CLUB_ORDER) $('club-' + c).addEventListener('click', function () { if (G.mode === 'aim' && !G.aim && G.opt.clubs[c].ok) { setClub(c); buzz(5); } });
  let hintTimer = 0;
  function hint(text, ms) {
    const el = $('hint'); clearTimeout(hintTimer);
    if (!text) { el.classList.remove('show'); return; }
    el.textContent = text; el.classList.add('show');
    if (ms) hintTimer = setTimeout(function () { el.classList.remove('show'); }, ms);
  }
  function once(key, text) { if (store.hints[key]) return false; store.hints[key] = 1; save(); hint(text, 9000); return true; }
  function hints() {
    const h = G.hole, o = G.opt;
    if (!store.hints.pull) { G.demo = true; hint('Pull down anywhere for power, slide sideways to aim, then let go. The arc is the flight in still air, and the map shows where it comes down.'); return; }
    if (o.lie === T.GREEN) {
      if (once('putt', 'On the green. Pull back gently to putt. The dots show how far it rolls on flat ground, and the white beads drift downhill. Putts roll out slowly, so give them time.')) return;
      if (h.diff > 0 && once('slope', 'This green tilts more. Aim uphill of the cup and let the slope bring it back.')) return;
      return;
    }
    if (o.lie === T.SAND && once('sand', 'Sand. The wedge is the club here. Shots fly shorter and your aim sways, so let go when the arc swings onto your target.')) return;
    if (o.lie === T.ROUGH && once('rough', 'Rough. Shots fly shorter and your aim sways. Let go when the arc swings onto your target.')) return;
    if (once('club', 'The game picks a club for the distance. Tap another to change it: the iron runs on, the wedge flies high and stops. The driver is for the tee.')) return;
    if (h.wind.mph > 0 && once('wind', 'Wind is up. The arc shows a still-air flight, and the wind carries the ball from there. Aim into it.')) return;
    if (Math.abs(h.pin.z - G.ball.z) > 2.5 && once('hill', 'Hills matter. Downhill shots carry farther and uphill shots come up short. The arc already allows for the slope.')) return;
  }
  let bannerTimer = 0;
  function banner(show) {
    const el = $('banner'); clearTimeout(bannerTimer);
    if (show === false) { el.classList.remove('show'); return; }
    const h = G.hole;
    $('b-hole').textContent = 'Hole ' + (G.hi + 1);
    $('b-sub').textContent = 'Par ' + h.par + ' · ' + h.yards + ' yards' + (h.wind.mph ? ' · wind ' + h.wind.mph + ' mph' : ' · calm');
    el.classList.add('show');
    bannerTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }

  /* ---------- title and summary ---------- */
  const fmtDate = (k, long) => { try { return parseKey(k).toLocaleDateString(undefined, long ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' }); } catch (e) { return k; } };
  const roundTitle = () => (G.practice ? 'Dewsweeper practice' : 'Dewsweeper No. ' + dayNo(G.round.key));
  const playUI = (on) => { $('hud').hidden = !on; $('foot').hidden = !on; $('map').hidden = !on; if (on) resize(); };
  function showTitle() {
    G.mode = 'title';
    $('t-date').textContent = 'No. ' + dayNo(TODAY) + ' · ' + fmtDate(TODAY, true);
    $('play').textContent = store.progress && store.progress.key === TODAY ? 'Resume round' : 'Tee off';
    $('t-meta').textContent = 'Par ' + G.round.par + ' · about three minutes';
    $('title').hidden = false; $('summary').hidden = true; playUI(false);
  }
  function startPlay() { $('title').hidden = true; $('summary').hidden = true; playUI(true); }
  const WORDS = ['Even', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
  function streak() {
    let n = 0; const d = parseKey(TODAY);
    if (!store.days[dateKey(d)]) d.setDate(d.getDate() - 1);
    while (store.days[dateKey(d)]) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  let tickTimer = 0;
  function summary() {
    G.mode = 'summary'; G.orbit = Math.atan2(-camPos.z - G.hole.pin.y, camPos.x - G.hole.pin.x); G.orbitT = G.time;
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
      const now = new Date(), next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), s = Math.max(0, Math.floor((next - now) / 1000));
      $('s-next').textContent = 'Next course in ' + z2(Math.floor(s / 3600)) + ':' + z2(Math.floor(s / 60) % 60) + ':' + z2(s % 60);
    };
    tick(); tickTimer = setInterval(tick, 1000);
    $('summary').hidden = false; playUI(false); hint('');
  }
  $('play').addEventListener('click', function () {
    Snd.init(); startPlay();
    const p = store.progress;
    if (p && p.key === TODAY && !store.days[TODAY]) { G.scores = p.scores.slice(); G.trails = p.trails.slice(); loadHole(p.hi, p); banner(); hints(); }
    else loadHole(0);
  });
  $('practice').addEventListener('click', function () { Snd.init(); clearInterval(tickTimer); newRound('practice-' + Math.random().toString(36).slice(2, 8), true); startPlay(); loadHole(0); });
  $('replay').addEventListener('click', function () { Snd.init(); clearInterval(tickTimer); newRound(G.round.key, true); startPlay(); loadHole(0); });
  $('share').addEventListener('click', function () {
    const btn = $('share'), ta = $('share-text'), txt = C.shareText(roundTitle(), G.round, G.scores, G.trails);
    const done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy scorecard'; }, 1800); };
    const manual = function () { ta.hidden = false; ta.value = txt; ta.focus(); ta.select(); btn.textContent = 'Copy from the box below'; };
    try { navigator.clipboard.writeText(txt).then(done, manual); } catch (e) { manual(); }
  });
  function sndIcon() { const on = Snd.isOn(); $('snd-wave').style.display = on ? '' : 'none'; $('snd-off').style.display = on ? 'none' : ''; $('snd').setAttribute('aria-pressed', on ? 'true' : 'false'); }
  stage.addEventListener('click', function () { Snd.init(); }); // sound may only start from a tap
  $('snd').addEventListener('click', function () { Snd.init(); Snd.setOn(!Snd.isOn()); store.muted = !Snd.isOn(); save(); sndIcon(); });

  /* ---------- input: pull back anywhere, let go to swing ---------- */
  const dragMax = () => clamp(H * 0.33, 180, 290);
  /* Power comes from how far you pull down. Aim comes from sideways travel on a gentle curve:
     fine near the middle, quicker further out. Neither axis disturbs the other. */
  function rawAim(a, x, y) {
    const dx = a.sx - x, ad = Math.abs(dx), putt = G.club === 'putter';
    const deg = Math.min(170, putt ? 0.035 * ad + 0.0005 * ad * ad : 0.06 * ad + 0.001 * ad * ad);
    return { power: clamp((y - a.sy) / dragMax(), 0, 1), off: (dx < 0 ? -1 : 1) * deg * Math.PI / 180 };
  }
  function settledSample(a) { // where the finger was a moment ago, so the twitch of lifting off never counts
    const now = performance.now();
    for (let i = a.hist.length - 1; i >= 0; i--) if (now - a.hist[i].t >= 35) return a.hist[i];
    return a.hist[a.hist.length - 1];
  }
  const swayOf = (a) => (a && a.sway ? (a.sway * Math.PI / 180) * Math.sin(G.time * 2.4) : 0);
  glc.addEventListener('pointerdown', function (e) {
    if (G.mode === 'holed') { if (G.moment && G.moment.t > 0.9) advance(); return; }
    if (G.mode === 'flying') { G.fast = true; return; } // tap to hurry the ball along
    if (G.mode !== 'aim' || G.aim) return;
    try { glc.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    G.aim = { id: e.pointerId, sx: e.clientX, sy: e.clientY, power: 0, off: 0, sway: G.opt.clubs[G.club].sway, hist: [{ t: performance.now(), x: e.clientX, y: e.clientY }] };
    G.intro = 0; banner(false); updateClubs(); fxEvent('aim', { active: true });
    e.preventDefault();
  });
  glc.addEventListener('pointermove', function (e) {
    const a = G.aim; if (!a || a.id !== e.pointerId) return;
    a.hist.push({ t: performance.now(), x: e.clientX, y: e.clientY }); if (a.hist.length > 40) a.hist.shift();
  });
  function release(e, cancel) {
    const a = G.aim; if (!a || a.id !== e.pointerId) return;
    G.aim = null; fxEvent('aim', { active: false });
    if (cancel || G.mode !== 'aim') { updateClubs(); return; }
    const sm = settledSample(a), r = rawAim(a, sm.x, sm.y);
    a.power = r.power; a.off = r.off;
    if (a.power < MINP) { updateClubs(); return; }
    /* the club comes down, then the ball goes */
    G.pend = { off: a.off + swayOf(a), power: a.power, t: 0, dur: G.club === 'putter' ? 0.13 : 0.11 };
    G.mode = 'swing'; updateClubs();
  }
  glc.addEventListener('pointerup', function (e) { release(e, false); });
  glc.addEventListener('pointercancel', function (e) { release(e, true); });
  glc.addEventListener('lostpointercapture', function (e) { release(e, true); });
  glc.addEventListener('touchstart', function (e) { e.preventDefault(); }, { passive: false });

  function onEvent(ev, s) {
    const lie = C.terrainAt(G.hole, s.x, s.y), data = { x: s.x, y: s.y, z: s.z, lie, club: s.club, speed: Math.hypot(s.vx, s.vy) };
    if (ev === 'land') { Snd.land(lie, data.speed); burst3(s.x, s.y, s.z, [0.8, 0.95, 0.7], 6, 3, 3); }
    else if (ev === 'sand') { Snd.sand(); burst3(s.x, s.y, s.z, [0.93, 0.9, 0.76], 16, 5, 6); }
    else if (ev === 'splash') { Snd.splash(); burst3(s.x, s.y, s.z, [0.9, 0.97, 1], 22, 5, 9); buzz(20); }
    else if (ev === 'tree') { Snd.tree(); burst3(s.x, s.y, s.z, [0.75, 0.6, 0.25], 14, 6, 2); }
    else if (ev === 'lip') Snd.lip();
    else if (ev === 'holed') { Snd.cup(); buzz(14); }
    fxEvent(ev, data);
  }
  function spawnBirds(diff) {
    if (REDUCED) return;
    const n = diff <= -2 ? 3 : 1;
    for (let i = 0; i < n; i++) G.birds.push({ t: -0.5 - i * 0.4, y0: H * (0.13 + 0.045 * i), z: diff <= -2 && i === 0 ? 20 : 11 + i * 2, sp: (W + 140) / (3.6 + i * 0.3) });
  }

  /* ---------- per-frame world update ---------- */
  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vU = new THREE.Vector3(), vD = new THREE.Vector3(), vAx = new THREE.Vector3(), vT = new THREE.Vector3(), Y = new THREE.Vector3(0, 1, 0), qT = new THREE.Quaternion();
  function placeClub(angle, phi, show) {
    clubG.visible = show && !fxHas('club'); ctx.club.visible = show; ctx.club.id = G.club; ctx.club.angle = angle; ctx.club.phi = phi; if (!show) return;
    const b = G.ball, dx = Math.sin(angle), dy = Math.cos(angle), lx = -dy, ly = dx, k = G.club, putt = k === 'putter';
    P(vA, b.x + lx * (putt ? 0.5 : 0.8) - dx * 0.15, b.y + ly * (putt ? 0.5 : 0.8) - dy * 0.15, b.z + (putt ? 1.5 : 1.3));          // hands
    P(vB, b.x - dx * headBack[k], b.y - dy * headBack[k], b.z + headUp[k]);                                          // head at rest
    vU.copy(vB).sub(vA); const L = vU.length(); vU.normalize();
    P(vD, dx, dy, 0); vAx.copy(vD).cross(vU).normalize();
    vT.copy(vAx).cross(vU);                                              // points back along the target line
    vB.copy(vA).addScaledVector(vU, L * Math.cos(phi)).addScaledVector(vT, L * Math.sin(phi));
    vU.copy(vB).sub(vA).normalize();
    shaft.position.copy(vA).addScaledVector(vU, L / 2); shaft.scale.set(1, L, 1);
    shaft.quaternion.copy(qT.setFromUnitVectors(Y, vU.clone().negate()));
    for (const n in heads) heads[n].visible = n === k;
    heads[k].position.copy(vB); heads[k].rotation.set(headTilt[k], Math.PI - angle, 0);
    ctx.club.hands.copy(vA); ctx.club.head.copy(vB);
  }
  function aimAids() {
    const a = G.aim, h = G.hole;
    let show = false; G.pv = null;
    if (a && G.mode === 'aim' && a.power > 0.02) {
      const ang = G.base + a.off + swayOf(a), pv = C.previewShot(h, G.ball, G.club, ang, a.power), live = a.power >= MINP;
      G.pv = pv; pv.ang = ang; show = true;
      const pos = arcGeo.attributes.position, dpos = dotGeo.attributes.position, stepN = Math.max(1, Math.ceil(pv.pts.length / ARCN));
      let n = 0, dn = 0, lx = -99, ly = -99;
      for (let i = 0; i < pv.pts.length && n < ARCN - 1; i += stepN) {
        const p = pv.pts[i]; pos.setXYZ(n++, p.x, p.z + 0.06, -p.y);
        const sp = project(p.x, p.y, p.z);
        if (sp && Math.hypot(sp.x - lx, sp.y - ly) >= (pv.putt ? 9 : 13)) { dpos.setXYZ(dn++, p.x, p.z + 0.06, -p.y); lx = sp.x; ly = sp.y; }
      }
      { const p = pv.putt ? pv.end : pv.land; pos.setXYZ(n++, p.x, p.z + 0.06, -p.y); }
      pos.needsUpdate = true; arcGeo.setDrawRange(0, n); dpos.needsUpdate = true; dotGeo.setDrawRange(0, dn);
      arc.material.opacity = live ? 0.95 : 0.4; arcLine.material.opacity = live ? 0.5 : 0.2;
      const e = pv.putt ? pv.end : pv.land, cd = Math.hypot(e.x - camPos.x, e.y + camPos.z, e.z - camPos.y);
      const wet = !pv.putt && pv.landLie === T.WATER, snd = !pv.putt && pv.landLie === T.SAND;
      ring.visible = !pv.blocked; cross.visible = !!pv.blocked; beam.visible = !pv.putt && !pv.blocked;
      const rs = pv.putt ? clamp(cd * 0.02, 0.22, 0.6) : clamp(cd * 0.03, 1.6, 8);
      P(ring.position, e.x, e.y, e.z + 0.07); ring.scale.setScalar(rs);
      ring.material.color.setHex(wet ? 0xBFE9FA : snd ? 0xFFF0B8 : 0xffffff); ring.material.opacity = live ? 0.95 : 0.4;
      P(beam.position, e.x, e.y, e.z); beam.scale.set(rs * 0.2, rs * 2.6, rs * 0.2); beam.material.color.copy(ring.material.color);
      if (pv.blocked) P(cross.position, e.x, e.y, e.z);
      const run = !pv.putt && !pv.blocked && !wet && pv.roll > 1.5; // where it should run out to on level ground
      runLine.visible = run; runEnd.visible = run;
      if (run) {
        const rp = runGeo.attributes.position; let ex2 = e.x, ey2 = e.y, ez2 = e.z;
        for (let i = 0; i < 12; i++) { ex2 = e.x + pv.dir.x * pv.roll * (i / 11); ey2 = e.y + pv.dir.y * pv.roll * (i / 11); ez2 = C.heightAt(h, ex2, ey2); rp.setXYZ(i, ex2, ez2 + 0.07, -ey2); }
        rp.needsUpdate = true; P(runEnd.position, ex2, ey2, ez2 + 0.07); runEnd.scale.setScalar(rs * 0.38);
        runLine.material.opacity = live ? 0.75 : 0.3; runEnd.material.opacity = live ? 0.8 : 0.3;
      }
      const tag = $('aim-tag'), sp = project(e.x, e.y, e.z + (pv.putt ? 0.4 : rs * 2.7));
      if (sp && live) {
        tag.hidden = false;
        tag.textContent = pv.blocked ? 'Trees' : pv.putt ? Math.max(1, Math.round(pv.roll * 3)) + ' ft' : Math.round(pv.carry) + ' yd' + (wet ? ' · water' : snd ? ' · sand' : pv.roll > 1.5 ? ', runs to ' + Math.round(pv.carry + pv.roll) : '');
        tag.style.transform = 'translate(' + clamp(sp.x, 34, W - 34).toFixed(1) + 'px,' + Math.max(70, sp.y).toFixed(1) + 'px) translate(-50%,-110%)';
      } else tag.hidden = true;
    }
    if (!show) { ring.visible = false; beam.visible = false; cross.visible = false; runLine.visible = false; runEnd.visible = false; $('aim-tag').hidden = true; }
    arc.visible = show; arcLine.visible = show && !(G.pv && G.pv.putt);
  }
  function updateWorld(dt) {
    const h = G.hole, s = G.shot;
    /* ball */
    let bx = G.ball.x, by = G.ball.y, bz = G.ball.z, lift = 0, showBall = G.mode !== 'title' && G.mode !== 'summary' && !(G.mode === 'holed' && !(G.moment && G.moment.pickup));
    if (G.mode === 'flying' && s) { bx = s.x; by = s.y; bz = s.z + (s.phase === 'roll' ? s.h : 0); lift = s.h; if (s.done && s.result.kind !== 'rest') showBall = false; }
    const cd = Math.hypot(bx - camPos.x, by + camPos.z, bz - camPos.y), br = Math.max(0.09, cd * 0.0068);
    ball.visible = showBall; shadow.visible = showBall;
    { const cb = ctx.ball, mv = G.mode === 'flying' && s && !s.done; cb.x = bx; cb.y = by; cb.z = bz; cb.h = lift; cb.visible = showBall; cb.moving = !!mv; cb.speed = mv ? Math.hypot(s.vx, s.vy, s.phase === 'fly' ? s.vz : 0) : 0; cb.phase = mv ? s.phase : 'rest'; cb.club = G.club;
      if (mv && s.phase === 'roll') Snd.roll(Math.hypot(s.vx, s.vy), C.terrainAt(h, s.x, s.y)); else Snd.roll(0, 0); }
    P(ball.position, bx, by, bz + br * 0.9); ball.scale.setScalar(br);
    const gz = (G.mode === 'flying' && s) ? C.heightAt(h, bx, by) : G.ball.z;
    P(shadow.position, bx - SUNH.x * lift * 0.5, by - SUNH.y * lift * 0.5, gz + 0.02); shadow.scale.setScalar(br * (1.15 + Math.min(1.2, lift * 0.03)));
    shadow.material.opacity = 0.34 / (1 + lift * 0.05);
    /* club */
    if (G.mode === 'aim') { const a = G.aim; placeClub(G.base + (a ? a.off + swayOf(a) : 0), a ? a.power * (G.club === 'putter' ? 0.5 : 1.9) : 0, G.intro <= 0.6); }
    else if (G.mode === 'swing' && G.pend) { const p = G.pend, u = p.t / p.dur; placeClub(G.base + p.off, p.power * (G.club === 'putter' ? 0.5 : 1.9) * (1 - u * u), true); }
    else if (G.mode === 'flying' && G.follow > 0) { const u = 1 - G.follow / 0.22; placeClub(Math.atan2(G.fdir0x, G.fdir0y), -(G.clubWas === 'putter' ? 0.4 : 1.7) * Math.sin(u * Math.PI / 2), true); }
    else { clubG.visible = false; ctx.club.visible = false; }
    aimAids();
    /* pin: grows with distance so it can be found, and its flag flies with the wind */
    if (pinG) {
      const pd = Math.hypot(h.pin.x - camPos.x, h.pin.y + camPos.z);
      pinG.scale.setScalar(clamp(pd / 42, 1, 6.5));
      const wa = h.wind.mph > 0 ? Math.atan2(h.wind.x, h.wind.y) : camYaw + 1.57;
      flag.rotation.y = Math.PI / 2 - wa + Math.sin(G.time * (3 + h.wind.mph * 0.5)) * (h.wind.mph > 0 ? 0.22 : 0.06);
      pinG.visible = !(G.club === 'putter' && (G.mode === 'aim' || G.mode === 'swing' || G.mode === 'flying') && pd < 30) || G.mode === 'holed';
      const tag = $('pin-tag'), far2 = G.mode === 'aim' && !G.pv && G.intro <= 0.3 && G.club !== 'putter' && G.opt && G.opt.dist > 28;
      const sp = far2 ? project(h.pin.x, h.pin.y, h.pin.z + 2.9 * pinG.scale.x) : null;
      if (sp && sp.x > 20 && sp.x < W - 20 && sp.y > 60) { tag.hidden = false; tag.textContent = Math.round(G.opt.dist) + ' yd'; tag.style.transform = 'translate(' + sp.x.toFixed(1) + 'px,' + sp.y.toFixed(1) + 'px) translate(-50%,-120%)'; }
      else tag.hidden = true;
    }
    /* putting aids */
    const putting = G.club === 'putter' && (G.mode === 'aim' || G.mode === 'swing' || G.mode === 'flying');
    if (gridL) gridL.visible = putting;
    beads.visible = putting;
    if (putting) {
      const gb = h.gbox;
      for (let i = 0; i < BEADS; i++) {
        const p = beadPos[i];
        if (!REDUCED) { const g = C.gradAt(h, p.x, p.y); p.x -= g.x * 26 * dt; p.y -= g.y * 26 * dt; }
        if (!C.inCircles(h.green, p.x, p.y, -0.2)) { for (let t = 0; t < 12; t++) { p.x = gb.x0 + Math.random() * (gb.x1 - gb.x0); p.y = gb.y0 + Math.random() * (gb.y1 - gb.y0); if (C.inCircles(h.green, p.x, p.y, -0.4)) break; } }
        P(dummy.position, p.x, p.y, C.heightAt(h, p.x, p.y) + 0.07); dummy.scale.setScalar(1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix(); beads.setMatrixAt(i, dummy.matrix);
      }
      beads.instanceMatrix.needsUpdate = true;
    }
    /* bursts */
    const pp = pGeo.attributes.position, pc = pGeo.attributes.color;
    for (let i = parts.length - 1; i >= 0; i--) { const p = parts[i]; p.t += dt; p.vz -= 16 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; if (p.t > p.life) parts.splice(i, 1); }
    for (let i = 0; i < parts.length; i++) { const p = parts[i]; pp.setXYZ(i, p.x, p.z, -p.y); pc.setXYZ(i, p.c[0], p.c[1], p.c[2]); }
    pp.needsUpdate = true; pc.needsUpdate = true; pGeo.setDrawRange(0, parts.length);
    /* wind arrow turns with your view */
    if (h.wind.mph > 0) $('wind-arrow').style.transform = 'rotate(' + ((Math.atan2(h.wind.x, h.wind.y) - camYaw) * 180 / Math.PI).toFixed(1) + 'deg)';
    else $('wind-arrow').style.transform = 'none';
  }
  function update(dt) {
    G.time += dt;
    ctx.time = G.time; ctx.dt = dt; ctx.mode = G.mode;
    Snd.tick(dt, { windMph: G.hole ? G.hole.wind.mph : 0, mode: G.mode });
    if (G.intro > 0) G.intro -= dt;
    if (G.aim && G.mode === 'aim') { // ease toward the finger so the arc glides instead of twitching
      const a = G.aim, sm = settledSample(a), r = rawAim(a, sm.x, sm.y), k = 1 - Math.exp(-dt / 0.07);
      a.power += (r.power - a.power) * k; a.off += (r.off - a.off) * k;
    }
    if (G.mode === 'swing' && G.pend) {
      const p = G.pend; p.t += dt;
      if (p.t >= p.dur) { const ang = G.base + p.off; G.fdir0x = Math.sin(ang); G.fdir0y = Math.cos(ang); G.clubWas = G.club; fire(ang, p.power); }
    }
    if (G.mode === 'flying' && G.shot) {
      const s = G.shot;
      if (G.follow > 0) G.follow -= dt;
      if (!s.done) {
        G.acc += dt * (G.fast ? 2.6 : 1);
        while (G.acc >= PH.DT && !s.done) {
          C.stepShot(G.hole, s); G.acc -= PH.DT;
          while (G.evt < s.events.length) onEvent(s.events[G.evt++], s);
        }
        if (!fxHas('trail') && s.club !== 'putter' && trailN < TRN && (s.phase === 'fly' || s.phase === 'drop' || s.rollT < 0.9)) { trailGeo.attributes.position.setXYZ(trailN++, s.x, s.z + (s.phase === 'roll' ? s.h : 0) + 0.08, -s.y); trailGeo.attributes.position.needsUpdate = true; trailGeo.setDrawRange(0, trailN); }
        if (s.done) G.settle = s.result.kind === 'holed' ? 0.35 : 0.5;
      } else { G.settle -= dt; if (G.settle <= 0) shotDone(); }
    }
    if (G.moment) { G.moment.t += dt; if (G.moment.t >= G.moment.dur) advance(); }
    for (const b of G.birds) b.t += dt;
    updateCamera(dt);
    updateWorld(dt);
    fxCall('update', dt);
  }

  /* ---------- overhead map ---------- */
  const MC = { rough: '#6F9B62', fair: '#A2CC80', fringe: '#A9D48A', green: '#C2E8A2', sand: '#EDE3BE', water: '#6FA6C2', tree: '#2F5B45' };
  function drawMap() {
    const h = G.hole, cw = mapc.width, ch = mapc.height, g = mctx, b = G.ball;
    if (!h || !cw) return;
    const putt = G.club === 'putter', d = C.dist(b, h.pin);
    let pts = [b, h.pin], m = putt ? Math.max(3, d * 0.5) : Math.max(22, d * 0.22);
    if (!putt && d > 200) {
      pts = [b]; const Pp = h.path.slice(0, -1).concat([h.pin]);
      for (let i = 0; i < Pp.length - 1; i++) { const L = C.dist(Pp[i], Pp[i + 1]); for (let t = 0; t <= L; t += 20) { const p = { x: Pp[i].x + ((Pp[i + 1].x - Pp[i].x) * t) / L, y: Pp[i].y + ((Pp[i + 1].y - Pp[i].y) * t) / L }; if (p.y > b.y - 10 && C.dist(p, b) <= 300) pts.push(p); } }
      if (d <= 300) pts.push(h.pin); m = 34;
    }
    if (G.pv && !G.pv.putt) pts = pts.concat([G.pv.land]);
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const p of pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
    x0 -= m; x1 += m; y0 -= m; y1 += m;
    const s = Math.min(cw / (x1 - x0), ch / (y1 - y0)), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const X = (x) => cw / 2 + (x - cx) * s, Yy = (y) => ch / 2 - (y - cy) * s;
    const circ = (list, pad) => { g.beginPath(); for (const c of list) { const r = (c.r + pad) * s; g.moveTo(X(c.x) + r, Yy(c.y)); g.arc(X(c.x), Yy(c.y), r, 0, 6.283); } };
    g.setTransform(1, 0, 0, 1, 0, 0); g.fillStyle = MC.rough; g.fillRect(0, 0, cw, ch);
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (const f of h.fairways) { g.beginPath(); f.pts.forEach((p, i) => (i ? g.lineTo(X(p.x), Yy(p.y)) : g.moveTo(X(p.x), Yy(p.y)))); g.strokeStyle = MC.fair; g.lineWidth = f.hw * 2 * s; g.stroke(); }
    g.fillStyle = MC.fringe; g.fillRect(X(h.tee.x) - 6 * s, Yy(h.tee.y) - 6 * s, 12 * s, 12 * s);
    circ(h.green, h.fringeW); g.fillStyle = MC.fringe; g.fill();
    for (const w of h.water) { circ(w, 0); g.fillStyle = MC.water; g.fill(); }
    for (const k of h.bunkers) { circ(k, 0); g.fillStyle = MC.sand; g.fill(); }
    circ(h.green, 0); g.fillStyle = MC.green; g.fill();
    if (putt) { /* tilt arrows */
      g.strokeStyle = 'rgba(40,100,60,0.55)'; g.lineWidth = Math.max(1, PR * 0.9); g.beginPath();
      const gb = h.gbox, st = Math.max(2.2, 15 * PR / s);
      for (let x = gb.x0; x <= gb.x1; x += st) for (let y = gb.y0; y <= gb.y1; y += st) {
        if (!C.inCircles(h.green, x, y, -0.5)) continue;
        const gr = C.gradAt(h, x, y), gl = Math.hypot(gr.x, gr.y); if (gl < 0.004) continue;
        const ux = -gr.x / gl, uy = -gr.y / gl, L = st * 0.34, hx = X(x + ux * L), hy = Yy(y + uy * L), tx = X(x - ux * L), ty = Yy(y - uy * L), ax = hx - tx, ay = hy - ty, al = Math.hypot(ax, ay) || 1, w = 2.6 * PR;
        g.moveTo(tx, ty); g.lineTo(hx, hy); g.moveTo(hx - (ax / al) * w - (ay / al) * w, hy - (ay / al) * w + (ax / al) * w); g.lineTo(hx, hy); g.lineTo(hx - (ax / al) * w + (ay / al) * w, hy - (ay / al) * w - (ax / al) * w);
      }
      g.stroke();
    }
    g.fillStyle = MC.tree; g.beginPath();
    for (const t of h.trees) { const tx = X(t.x), ty = Yy(t.y), r = t.r * s; if (tx < -r || tx > cw + r || ty < -r || ty > ch + r) continue; g.moveTo(tx + r, ty); g.arc(tx, ty, r, 0, 6.283); }
    g.fill();
    /* aim */
    const pv = G.pv;
    if (pv) {
      const e = pv.putt ? pv.end : pv.land, ex = X(e.x), ey = Yy(e.y), bx = X(b.x), by = Yy(b.y);
      g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 1.4 * PR; g.setLineDash([3 * PR, 3 * PR]); g.beginPath(); g.moveTo(bx, by); g.lineTo(ex, ey); g.stroke(); g.setLineDash([]);
      if (pv.blocked) { g.strokeStyle = '#FFD9CF'; g.lineWidth = 2 * PR; g.beginPath(); g.moveTo(ex - 4 * PR, ey - 4 * PR); g.lineTo(ex + 4 * PR, ey + 4 * PR); g.moveTo(ex + 4 * PR, ey - 4 * PR); g.lineTo(ex - 4 * PR, ey + 4 * PR); g.stroke(); }
      else {
        g.lineWidth = 1.6 * PR; g.beginPath(); g.arc(ex, ey, (pv.putt ? 2.6 : 4.5) * PR, 0, 6.283); g.stroke();
        if (!pv.putt && pv.roll > 1) { const tx = X(e.x + pv.dir.x * pv.roll), ty = Yy(e.y + pv.dir.y * pv.roll); g.globalAlpha = 0.65; g.lineWidth = 1.2 * PR; g.beginPath(); g.moveTo(ex, ey); g.lineTo(tx, ty); g.stroke(); g.globalAlpha = 1; }
      }
    } else if (G.mode === 'aim') { /* which way you are facing */
      const bx = X(b.x), by = Yy(b.y), L = 26 * PR, a = G.base;
      g.strokeStyle = 'rgba(255,255,255,0.55)'; g.lineWidth = 1.2 * PR; g.setLineDash([2 * PR, 3 * PR]); g.beginPath(); g.moveTo(bx, by); g.lineTo(bx + Math.sin(a) * L, by - Math.cos(a) * L); g.stroke(); g.setLineDash([]);
    }
    /* pin and ball */
    const px = X(h.pin.x), py = Yy(h.pin.y);
    g.strokeStyle = '#fff'; g.lineWidth = 1.2 * PR; g.beginPath(); g.moveTo(px, py); g.lineTo(px, py - 9 * PR); g.stroke();
    g.fillStyle = '#D5432D'; g.beginPath(); g.moveTo(px, py - 9 * PR); g.lineTo(px + 6 * PR, py - 7 * PR); g.lineTo(px, py - 5 * PR); g.fill();
    g.fillStyle = '#15231B'; g.beginPath(); g.arc(px, py, 1.5 * PR, 0, 6.283); g.fill();
    let mx = b.x, my = b.y; if (G.mode === 'flying' && G.shot) { mx = G.shot.x; my = G.shot.y; }
    if (G.mode !== 'holed') { g.fillStyle = '#fff'; g.strokeStyle = 'rgba(20,45,35,0.7)'; g.lineWidth = PR; g.beginPath(); g.arc(X(mx), Yy(my), 3 * PR, 0, 6.283); g.fill(); g.stroke(); }
  }

  /* ---------- 2D layer above the world: sunlight on a good score, birds, the first-shot demo ---------- */
  function drawFx() {
    fx.setTransform(PR, 0, 0, PR, 0, 0); fx.clearRect(0, 0, W, H);
    const m = G.moment;
    if (m && m.diff < 0) {
      const e = Math.sin(Math.min(1, m.t / m.dur) * Math.PI), sx = W * 0.96, sy = -H * 0.04;
      const g = fx.createRadialGradient(sx, sy, 10, sx, sy, H * 1.15);
      g.addColorStop(0, 'rgba(255,226,140,' + (0.62 * e).toFixed(3) + ')'); g.addColorStop(0.5, 'rgba(255,214,120,' + (0.22 * e).toFixed(3) + ')'); g.addColorStop(1, 'rgba(255,214,120,0)');
      fx.fillStyle = g; fx.fillRect(0, 0, W, H);
      if (!REDUCED) {
        fx.fillStyle = 'rgba(255,238,180,' + (0.075 * e).toFixed(3) + ')';
        for (let i = 0; i < 4; i++) { const an = 1.72 + i * 0.3 + Math.sin(m.t * 0.5 + i * 1.7) * 0.04, wd = 0.045 + (i % 2) * 0.02, L = H * 1.6; fx.beginPath(); fx.moveTo(sx, sy); fx.lineTo(sx + Math.cos(an - wd) * L, sy + Math.sin(an - wd) * L); fx.lineTo(sx + Math.cos(an + wd) * L, sy + Math.sin(an + wd) * L); fx.fill(); }
      }
    }
    fx.strokeStyle = 'rgba(28,44,44,0.85)'; fx.lineCap = 'round';
    for (const bd of G.birds) {
      if (bd.t < 0) continue;
      const x = -60 + bd.sp * bd.t, y = bd.y0 + Math.sin(bd.t * 1.3) * 10 - bd.t * 7, z = bd.z, f = 0.25 + 0.75 * Math.sin(bd.t * (z > 16 ? 5 : 9));
      fx.lineWidth = z * 0.17; fx.beginPath(); fx.moveTo(x - z, y - z * 0.45 * f); fx.quadraticCurveTo(x - z * 0.45, y - z * 0.5 * f - z * 0.18, x, y); fx.quadraticCurveTo(x + z * 0.45, y - z * 0.5 * f - z * 0.18, x + z, y - z * 0.45 * f); fx.stroke();
    }
    if (G.demo && G.mode === 'aim' && !G.aim && !REDUCED && G.intro <= 0) {
      const t = (G.time % 2.4) / 2.4, e = t < 0.7 ? 1 - Math.pow(1 - t / 0.7, 3) : 1, al = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3, px = W / 2, py = H * 0.36, pull = e * 120;
      fx.strokeStyle = 'rgba(255,255,255,' + (0.55 * al).toFixed(3) + ')'; fx.lineWidth = 2; fx.setLineDash([4, 6]); fx.beginPath(); fx.moveTo(px, py); fx.lineTo(px, py + pull); fx.stroke(); fx.setLineDash([]);
      fx.fillStyle = 'rgba(255,255,255,' + (0.3 * al).toFixed(3) + ')'; fx.beginPath(); fx.arc(px, py + pull, 17, 0, 6.283); fx.fill();
      fx.strokeStyle = 'rgba(255,255,255,' + (0.85 * al).toFixed(3) + ')'; fx.lineWidth = 2; fx.stroke();
    }
    /* power: a short bar by your thumb while you pull */
    const a = G.aim;
    if (a && G.mode === 'aim') {
      const bw = 8, bh = 120, x = 14, y = Math.round(H * 0.3);
      fx.fillStyle = 'rgba(23,51,38,0.6)'; fx.fillRect(x, y, bw, bh);
      fx.fillStyle = a.power >= 0.995 ? '#F2C768' : '#fff'; fx.fillRect(x, y + bh * (1 - a.power), bw, bh * a.power);
      fx.font = '600 12px Barlow, sans-serif'; fx.textAlign = 'center'; fx.fillStyle = '#fff'; fx.strokeStyle = 'rgba(23,51,38,0.8)'; fx.lineWidth = 3;
      const tx = Math.round(a.power * 100) + '%'; fx.strokeText(tx, x + bw / 2, y - 6); fx.fillText(tx, x + bw / 2, y - 6);
    }
  }

  /* ---------- loop and boot ---------- */
  let last = 0;
  function loop(now) {
    const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now;
    try { update(dt); renderer.render(scene, camera); $('map').style.opacity = G.mode === 'holed' ? 0 : 1; if (!$('map').hidden && G.mode !== 'holed') drawMap(); drawFx(); } catch (e) { if (window.console) console.error(e); }
    requestAnimationFrame(loop);
  }
  function snapshot() {
    if (!G.round) return {};
    let mode = G.mode === 'title' ? 'title' : G.mode === 'summary' ? 'summary' : 'play', hi = G.hi, ballP = G.ball, strokes = G.strokes;
    if (G.mode === 'holed') { if (hi >= 2) mode = 'summary'; else { hi++; ballP = G.round.holes[hi].tee; strokes = 0; } }
    return { key: G.round.key, practice: G.practice, mode, hi, ball: { x: ballP.x, y: ballP.y }, strokes, scores: G.scores.slice(), trails: G.trails.slice() };
  }
  function start(data) {
    resize(); sndIcon(); fxCall('init');
    const done = store.days[TODAY];
    if (data && data.key && data.mode && data.mode !== 'title') {
      newRound(data.key, data.practice); G.scores = data.scores || []; G.trails = data.trails || ['', '', ''];
      startPlay();
      if (data.mode === 'summary') { loadHole(2, null, true); summary(); snapCamTo(); }
      else loadHole(data.hi || 0, { ball: data.ball, strokes: data.strokes || 0 });
    } else if (done) {
      newRound(TODAY, false); G.scores = done.scores.slice(); G.trails = done.trails.slice();
      loadHole(2, null, true); $('title').hidden = true; summary(); snapCamTo();
    } else {
      newRound(TODAY, false); loadHole(0, null, true); showTitle(); snapCamTo();
    }
    requestAnimationFrame(loop);
  }
  function snapCamTo() { updateCamera(0); snapCam(); }
  window.__dew = { G, C, camera, camPos, snapshot, renderer, ctx, FX,
    peek(key, i) { newRound(key, true); startPlay(); loadHole(i, null, true); },
    /* tooling: put the ball somewhere, take the camera anywhere (game coords), hide the interface */
    teleport(x, y) { G.ball = { x, y, z: 0 }; G.free = null; prepShot(); addressPose(G.base, 0); snapCam(); },
    freeCam(px, py, pz, lx, ly, lz) { G.free = { pos: new THREE.Vector3(px, pz, -py), look: new THREE.Vector3(lx, lz, -ly) }; },
    releaseCam() { G.free = null; },
    hud(on) { for (const id of ['hud', 'foot', 'map', 'hint3', 'banner', 'pin-tag', 'aim-tag']) { const el = $(id); if (el) el.style.visibility = on ? '' : 'hidden'; } },
    info() { const r = renderer.info; return { calls: r.render.calls, triangles: r.render.triangles, points: r.render.points, geometries: r.memory.geometries, textures: r.memory.textures }; } };
  const hot = window.claude && window.claude.hot;
  try { if (hot && hot.snapshot) hot.snapshot(snapshot); } catch (e) { /* ignore */ }
  if (hot && hot.ready) hot.ready(start); else start((hot && hot.data) || {});
})();
