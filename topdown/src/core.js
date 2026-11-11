/* Dewsweeper core: seeded course generation, terrain, ball physics. No DOM. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const T = { ROUGH: 0, FAIRWAY: 1, FRINGE: 2, TEE: 3, GREEN: 4, SAND: 5, WATER: 6 };
  const LIE_NAME = ['Rough', 'Fairway', 'Fringe', 'Tee', 'Green', 'Sand', 'Water'];
  const PHYS = {
    DT: 1 / 120,
    MAX_CARRY: 225,
    //         rough fairway fringe tee green sand water
    FRICTION: [40, 18, 8, 18, 4.2, 70, 0],
    CUP_R: 0.25,
    CUP_V: 2.7,
    WIND_K: 2.4
  };

  /* ---------- seeded random ---------- */
  function hashStr(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function makeRng(seed) {
    let a = seed >>> 0;
    const f = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.range = (lo, hi) => lo + (hi - lo) * f();
    f.int = (lo, hi) => Math.floor(f.range(lo, hi + 1));
    f.sign = () => (f() < 0.5 ? -1 : 1);
    f.chance = (p) => f() < p;
    f.pick = (arr) => arr[Math.floor(f() * arr.length)];
    return f;
  }

  /* ---------- geometry ---------- */
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const adv = (p, a, d) => ({ x: p.x + Math.sin(a) * d, y: p.y + Math.cos(a) * d }); // heading a: clockwise from north
  const perpOf = (a) => ({ x: Math.cos(a), y: -Math.sin(a) }); // right-hand side of heading a
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function angDiff(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  }
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
  }
  function distToPolyline(pts, x, y) {
    let m = 1e9;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distToSeg(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
      if (d < m) m = d;
    }
    return m;
  }
  function inCircles(list, x, y, pad) {
    for (let i = 0; i < list.length; i++) {
      const c = list[i], dx = x - c.x, dy = y - c.y, r = c.r + pad;
      if (dx * dx + dy * dy < r * r) return true;
    }
    return false;
  }
  function roundCorners(pts, R) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p = pts[i], a = pts[i - 1], b = pts[i + 1];
      const la = dist(a, p), lb = dist(b, p);
      const ra = Math.min(R, la * 0.45), rb = Math.min(R, lb * 0.45);
      const A = { x: p.x + ((a.x - p.x) / la) * ra, y: p.y + ((a.y - p.y) / la) * ra };
      const B = { x: p.x + ((b.x - p.x) / lb) * rb, y: p.y + ((b.y - p.y) / lb) * rb };
      for (let k = 0; k <= 6; k++) {
        const t = k / 6, u = 1 - t;
        out.push({ x: u * u * A.x + 2 * u * t * p.x + t * t * B.x, y: u * u * A.y + 2 * u * t * p.y + t * t * B.y });
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  /* ---------- terrain queries ---------- */
  function terrainAt(h, x, y) {
    if (inCircles(h.green, x, y, 0)) return T.GREEN;
    for (let i = 0; i < h.bunkers.length; i++) if (inCircles(h.bunkers[i], x, y, 0)) return T.SAND;
    for (let i = 0; i < h.water.length; i++) if (inCircles(h.water[i], x, y, 0)) return T.WATER;
    if (inCircles(h.green, x, y, h.fringeW)) return T.FRINGE;
    const tx = x - h.tee.x, ty = y - h.tee.y;
    if (tx * tx + ty * ty < 49) return T.TEE;
    for (let i = 0; i < h.fairways.length; i++) {
      const f = h.fairways[i];
      if (distToPolyline(f.pts, x, y) <= f.hw) return T.FAIRWAY;
    }
    return T.ROUGH;
  }
  const TCS = 24;
  function buildTreeGrid(h) {
    const g = new Map();
    for (const t of h.trees) {
      for (let gx = Math.floor((t.x - t.r) / TCS); gx <= Math.floor((t.x + t.r) / TCS); gx++) {
        for (let gy = Math.floor((t.y - t.r) / TCS); gy <= Math.floor((t.y + t.r) / TCS); gy++) {
          const k = gx * 4096 + gy;
          let l = g.get(k);
          if (!l) { l = []; g.set(k, l); }
          l.push(t);
        }
      }
    }
    h._tg = g;
  }
  function treeAt(h, x, y) {
    const l = h._tg.get(Math.floor(x / TCS) * 4096 + Math.floor(y / TCS));
    if (!l) return null;
    for (let i = 0; i < l.length; i++) {
      const t = l[i], dx = x - t.x, dy = y - t.y;
      if (dx * dx + dy * dy < t.r * t.r) return t;
    }
    return null;
  }
  function blockedAt(h, x, y) {
    const b = h.bounds;
    return x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1 || !!treeAt(h, x, y);
  }

  /* ---------- course generation ---------- */
  function blob(rng, c, heading, n, spacing, rLo, rHi) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const p = adv(c, heading, (i - (n - 1) / 2) * spacing);
      out.push({ x: p.x + rng.range(-3, 3), y: p.y + rng.range(-3, 3), r: rng.range(rLo, rHi) });
    }
    return out;
  }
  function greenExtent(green, G, phi) {
    let d = 0;
    const cx = Math.cos(phi), cy = Math.sin(phi);
    while (d < 60 && inCircles(green, G.x + cx * d, G.y + cy * d, 0)) d += 0.5;
    return d;
  }

  function buildHole(rng, par, diff) {
    const h = {
      par, diff, tee: { x: 0, y: 0 }, fringeW: 2.6,
      fairways: [], bunkers: [], water: [], trees: [], green: [],
      wind: { mph: 0, x: 0, y: 1 }, slope: { x: 0, y: 0 }
    };
    const tee = h.tee;
    let path, legs, hw = 0;
    if (par === 3) {
      const L = diff === 0 ? rng.range(120, 150) : rng.range(128, 184);
      const a = rng.range(-0.2, 0.2);
      const G = adv(tee, a, L);
      path = [tee, G]; legs = [{ a, len: L }];
      h.fairways.push({ pts: [adv(G, a, -40), adv(G, a, -13)], hw: rng.range(11, 14) });
    } else if (par === 4) {
      const a1 = rng.range(-0.14, 0.14), d1 = rng.range(206, 230);
      const Z = adv(tee, a1, d1);
      const a2 = clamp(a1 + rng.sign() * rng.range(0.08, 0.72), -0.85, 0.85), d2 = rng.range(108, 158);
      const G = adv(Z, a2, d2);
      path = [tee, Z, G]; legs = [{ a: a1, len: d1 }, { a: a2, len: d2 }];
      hw = rng.range(22, 27);
      h.fairways.push({ pts: roundCorners([adv(tee, a1, 46), Z, adv(G, a2, -24)], 45), hw });
    } else {
      const a1 = rng.range(-0.18, 0.18), d1 = rng.range(208, 230);
      const Z1 = adv(tee, a1, d1);
      const s = rng.sign();
      const a2 = clamp(a1 + s * rng.range(0.18, 0.65), -0.9, 0.9), d2 = rng.range(212, 240);
      const Z2 = adv(Z1, a2, d2);
      const s2 = rng.chance(0.65) ? -s : s;
      const a3 = clamp(a2 + s2 * rng.range(0.15, 0.7), -1.0, 1.0), d3 = rng.range(105, 135);
      const G = adv(Z2, a3, d3);
      path = [tee, Z1, Z2, G]; legs = [{ a: a1, len: d1 }, { a: a2, len: d2 }, { a: a3, len: d3 }];
      hw = rng.range(22, 27);
      h.fairways.push({ pts: roundCorners([adv(tee, a1, 46), Z1, Z2, adv(G, a3, -24)], 45), hw });
    }
    h.path = path; h.legs = legs; h.hw = hw;
    const Gc = path[path.length - 1];
    const last = legs[legs.length - 1];

    /* green: two or three overlapping lobes */
    const gr = rng.range(12, 15);
    h.green.push({ x: Gc.x, y: Gc.y, r: gr });
    const ga = rng.range(0, Math.PI * 2), go = rng.range(6, 9);
    h.green.push({ x: Gc.x + Math.cos(ga) * go, y: Gc.y + Math.sin(ga) * go, r: gr * rng.range(0.72, 0.9) });
    if (rng.chance(0.5)) {
      const gb = ga + rng.range(1.8, 3.2), go2 = rng.range(6, 10);
      h.green.push({ x: Gc.x + Math.cos(gb) * go2, y: Gc.y + Math.sin(gb) * go2, r: gr * rng.range(0.6, 0.8) });
    }
    if (diff === 0) {
      const pa = rng.range(0, Math.PI * 2), po = rng.range(0, 3.5);
      h.pin = { x: Gc.x + Math.cos(pa) * po, y: Gc.y + Math.sin(pa) * po };
    } else {
      const lobe = rng.pick(h.green);
      const pa = rng.range(0, Math.PI * 2), po = rng.range(0, Math.max(0.5, lobe.r - 6.5));
      h.pin = { x: lobe.x + Math.cos(pa) * po, y: lobe.y + Math.sin(pa) * po };
    }
    const prev = path[path.length - 2];
    const appr = Math.atan2(prev.y - Gc.y, prev.x - Gc.x); // math angle, green -> player

    /* water (never on the opening hole) */
    if (diff > 0 && rng.chance(diff === 1 ? 0.55 : 0.8)) {
      let kind;
      if (par === 3) kind = rng.pick(['front', 'front', 'side']);
      else {
        const opts = ['corner', 'side'];
        if (last.len >= (par === 4 ? 115 : 100)) opts.push('creek');
        kind = rng.pick(opts);
      }
      if (kind === 'front') {
        const c = adv(tee, legs[0].a, legs[0].len * rng.range(0.42, 0.62));
        const p = perpOf(legs[0].a), off = rng.range(-20, 20);
        h.water.push(blob(rng, { x: c.x + p.x * off, y: c.y + p.y * off }, legs[0].a + Math.PI / 2, 3, 15, 13, 18));
      } else if (kind === 'side') {
        let phi = appr + Math.PI;
        for (let i = 0; i < 20; i++) { phi = rng.range(0, Math.PI * 2); if (angDiff(phi, appr) > 1.0) break; }
        const d = greenExtent(h.green, Gc, phi) + rng.range(13, 17);
        const c = { x: Gc.x + Math.cos(phi) * d, y: Gc.y + Math.sin(phi) * d };
        h.water.push(blob(rng, c, -phi, rng.int(2, 3), 13, 11, 15)); // heading -phi runs tangent to the green
      } else if (kind === 'corner') {
        const Z = path[1];
        const turn = legs[1].a - legs[0].a >= 0 ? 1 : -1;
        const n = perpOf(legs[0].a);
        const lat = hw + rng.range(15, 22), back = rng.range(5, 30);
        const base = adv(Z, legs[0].a, -back);
        h.water.push(blob(rng, { x: base.x + n.x * turn * lat, y: base.y + n.y * turn * lat }, legs[0].a, 3, 14, 13, 18));
      } else {
        const c = adv(Gc, last.a, -rng.range(40, 56));
        const p = perpOf(last.a), ph = rng.range(0, 6);
        const creek = [];
        for (let u = -(hw + 34); u <= hw + 34; u += 7.5) {
          const wob = Math.sin(u * 0.06 + ph) * 5;
          const q = adv(c, last.a, wob);
          creek.push({ x: q.x + p.x * u, y: q.y + p.y * u, r: rng.range(5.2, 6.6) });
        }
        h.water.push(creek);
      }
    }

    /* greenside bunkers */
    const nB = diff === 0 ? rng.int(1, 2) : rng.int(2, 3);
    const used = [];
    for (let tries = 0; tries < 40 && used.length < nB; tries++) {
      const phi = rng.range(0, Math.PI * 2);
      const front = angDiff(phi, appr);
      if (front < (diff === 0 ? 1.0 : 0.55) && !(diff > 0 && rng.chance(0.2))) continue;
      if (used.some((u) => angDiff(u, phi) < 0.95)) continue;
      const br = rng.range(5.5, 8);
      const d = greenExtent(h.green, Gc, phi) + br * 0.55 + rng.range(0.8, 3);
      const c0 = { x: Gc.x + Math.cos(phi) * d, y: Gc.y + Math.sin(phi) * d, r: br };
      if (terrainAt(h, c0.x, c0.y) === T.WATER) continue;
      const tx = -Math.sin(phi), ty = Math.cos(phi), k = rng.sign() * rng.range(4, 6.5);
      const b = [c0, { x: c0.x + tx * k, y: c0.y + ty * k, r: br * rng.range(0.72, 0.88) }];
      if (rng.chance(0.4)) b.push({ x: c0.x - tx * k * 0.9 + Math.cos(phi) * 1.5, y: c0.y - ty * k * 0.9 + Math.sin(phi) * 1.5, r: br * 0.7 });
      h.bunkers.push(b); used.push(phi);
    }

    /* fairway bunkers at the landing zones */
    for (let zi = 1; zi < path.length - 1; zi++) {
      if (!rng.chance(diff === 0 ? 0.45 : 0.8)) continue;
      const a = legs[zi - 1].a, pr = perpOf(a);
      const n = diff === 2 && rng.chance(0.4) ? 2 : 1;
      let side = rng.sign();
      for (let i = 0; i < n; i++, side = -side) {
        const base = adv(path[zi], a, -rng.range(-6, 30));
        const lat = hw + rng.range(-5, 3);
        const c0 = { x: base.x + pr.x * lat * side, y: base.y + pr.y * lat * side, r: rng.range(6, 8) };
        if (terrainAt(h, c0.x, c0.y) === T.WATER) continue;
        const c1 = adv(c0, a, rng.range(5, 8)); c1.r = c0.r * 0.8;
        h.bunkers.push([c0, c1]);
      }
    }

    /* bounds */
    let x0 = 1e9, x1 = -1e9, y1 = -1e9;
    const ext = (x, y, r) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
    path.forEach((p) => ext(p.x, p.y, 0));
    h.green.forEach((c) => ext(c.x, c.y, c.r));
    h.water.forEach((w) => w.forEach((c) => ext(c.x, c.y, c.r * 0.5)));
    h.bounds = { x0: Math.min(x0 - 60, -105), x1: Math.max(x1 + 60, 105), y0: -40, y1: y1 + 50 };
    const b = h.bounds;

    /* trees: a wooded border plus groves in the rough */
    const greenR = gr + 9;
    function tryTree(x, y, r) {
      if (Math.hypot(x - tee.x, y - tee.y) < r + 26) return;
      if (Math.hypot(x - Gc.x, y - Gc.y) < greenR + r + 15) return;
      for (const f of h.fairways) if (distToPolyline(f.pts, x, y) < f.hw + r + 6) return;
      if (distToPolyline(path, x, y) < r + 17) return;
      for (let k = 0; k < 8; k++) {
        const q = (k / 8) * Math.PI * 2;
        if (terrainAt(h, x + Math.cos(q) * (r + 2.5), y + Math.sin(q) * (r + 2.5)) !== T.ROUGH) return;
      }
      for (const t of h.trees) if (Math.hypot(x - t.x, y - t.y) < 0.55 * (r + t.r)) return;
      h.trees.push({ x, y, r });
    }
    const sides = [[b.x0, b.y0, b.x1, b.y0], [b.x1, b.y0, b.x1, b.y1], [b.x1, b.y1, b.x0, b.y1], [b.x0, b.y1, b.x0, b.y0]];
    for (const [ax, ay, bx, by] of sides) {
      const len = Math.hypot(bx - ax, by - ay);
      let d = 0;
      while (d < len) {
        const r = rng.range(8.5, 12.5), t = d / len;
        tryTree(ax + (bx - ax) * t + rng.range(-4, 4), ay + (by - ay) * t + rng.range(-4, 4), r);
        d += r * rng.range(1.1, 1.5);
      }
    }
    const p1 = rng.range(0, 6), p2 = rng.range(0, 6), p3 = rng.range(0, 6);
    const nT = 80 + 30 * diff + (par - 3) * 25;
    for (let i = 0; i < nT; i++) {
      const x = rng.range(b.x0 + 8, b.x1 - 8), y = rng.range(b.y0 + 8, b.y1 - 8), r = rng.range(6.5, 10);
      const n = Math.sin(x * 0.031 + p1) * Math.cos(y * 0.027 + p2) + 0.5 * Math.sin((x + y) * 0.05 + p3);
      if (n > 0.12) tryTree(x, y, r);
    }
    buildTreeGrid(h);

    /* conditions: the opener is calm with a gentle green; wind and slope build from there */
    {
      const sa = rng.range(0, Math.PI * 2);
      const mag = diff === 0 ? rng.range(0.25, 0.45) : diff === 1 ? rng.range(0.5, 0.85) : rng.range(0.8, 1.3);
      h.slope = { x: Math.cos(sa) * mag, y: Math.sin(sa) * mag };
    }
    if (diff > 0) {
      const wa = rng.range(0, Math.PI * 2);
      const mph = Math.round(diff === 1 ? rng.range(5, 9) : rng.range(8, 15));
      h.wind = { mph, x: Math.sin(wa), y: Math.cos(wa) };
    }
    let yards = 0;
    for (let i = 0; i < path.length - 1; i++) yards += dist(path[i], i === path.length - 2 ? h.pin : path[i + 1]);
    h.yards = Math.round(yards);
    return h;
  }

  function validate(h) {
    for (const p of h.path) if (Math.abs(p.x) > 115) return false;
    if (terrainAt(h, h.tee.x, h.tee.y) !== T.TEE) return false;
    if (terrainAt(h, h.pin.x, h.pin.y) !== T.GREEN) return false;
    for (let k = 0; k < 8; k++) {
      const q = (k / 8) * Math.PI * 2;
      if (terrainAt(h, h.pin.x + Math.cos(q) * 5, h.pin.y + Math.sin(q) * 5) !== T.GREEN) return false;
    }
    /* landing zones must be fairway */
    for (let zi = 1; zi < h.path.length - 1; zi++) {
      const a = h.legs[zi - 1].a;
      for (const off of [-10, 0, 8]) {
        const p = adv(h.path[zi], a, off);
        if (off <= 0 && terrainAt(h, p.x, p.y) !== T.FAIRWAY) return false;
      }
    }
    /* straight legs: no trees, and water only where a carry is fair */
    for (let i = 0; i < h.path.length - 1; i++) {
      const A = h.path[i], B = h.path[i + 1], L = dist(A, B);
      let wet = 0;
      for (let d = 0; d <= L; d += 3) {
        const x = A.x + ((B.x - A.x) * d) / L, y = A.y + ((B.y - A.y) * d) / L;
        if (treeAt(h, x, y)) return false;
        if (terrainAt(h, x, y) === T.WATER) {
          wet += 3;
          if (d < 40 && i === 0) return false;       // nothing wet right off the tee
          if (i > 0 && d < 28) return false;          // or just past a landing zone
          if (i < h.path.length - 2 && L - d < 28) return false; // or just short of one
        }
      }
      if (wet > 75) return false;
    }
    return true;
  }

  function genHole(key, idx, par, diff) {
    let h = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      h = buildHole(makeRng(hashStr(key + '|' + idx + '|' + attempt)), par, diff);
      if (validate(h)) break;
    }
    h.index = idx;
    return h;
  }

  function makeRound(key) {
    const rng = makeRng(hashStr('dew|' + key));
    const pars = rng.pick([[3, 4, 5], [4, 3, 5], [4, 5, 3], [3, 5, 4]]);
    const holes = pars.map((par, i) => genHole(key, i, par, i));
    return { key, holes, par: pars.reduce((a, b) => a + b, 0) };
  }

  /* ---------- shots ---------- */
  function shotInfo(h, ball) {
    const lie = terrainAt(h, ball.x, ball.y);
    const d = dist(ball, h.pin);
    if (lie === T.GREEN) return { putt: true, lie, dist: d, max: clamp(d * 1.55 + 3.5, 5, 70), sway: 0 };
    const lieMax = lie === T.SAND ? 130 : lie === T.ROUGH ? 185 : PHYS.MAX_CARRY;
    const max = Math.min(lieMax, Math.max(14, d * 1.25 + 6));
    const sway = lie === T.SAND ? 5 : lie === T.ROUGH ? 2.5 : 0; // degrees
    return { putt: false, lie, dist: d, max, sway };
  }
  function rollOut(ter, carry) {
    if (ter === T.GREEN) return 0.05 * carry + 1.5;
    if (ter === T.ROUGH) return 0.03 * carry + 0.5;
    if (ter === T.FRINGE) return 0.06 * carry + 1.0;
    if (ter === T.SAND || ter === T.WATER) return 0;
    return 0.11 * carry + 1.5;
  }

  function createShot(h, ball, angle, power, useWind) {
    const info = shotInfo(h, ball);
    const dir = { x: Math.sin(angle), y: Math.cos(angle) };
    const s = {
      x: ball.x, y: ball.y, h: 0, t: 0, vx: 0, vy: 0, phase: 'fly', done: false,
      start: { x: ball.x, y: ball.y }, dir, info, events: [], result: null, lipped: false, hitTree: false
    };
    if (info.putt) {
      const roll = Math.max(0.3, power * info.max);
      const v0 = Math.sqrt(2 * PHYS.FRICTION[T.GREEN] * roll);
      s.vx = dir.x * v0; s.vy = dir.y * v0; s.phase = 'roll';
    } else {
      const C = Math.max(2, power * info.max);
      s.C = C;
      s.T = 0.45 + 1.65 * Math.pow(C / 225, 0.7);
      s.H = 0.13 * C + 1;
      const k = useWind === false ? 0 : h.wind.mph * PHYS.WIND_K * Math.pow(C / 225, 0.85);
      s.drift = { x: h.wind.x * k, y: h.wind.y * k };
    }
    return s;
  }
  function finish(h, s, kind) {
    s.done = true; s.h = 0;
    let lie = terrainAt(h, s.x, s.y);
    if (kind !== 'holed' && lie === T.WATER) kind = 'water';
    s.result = { kind, x: s.x, y: s.y, lie, tree: s.hitTree };
  }
  function stepShot(h, s) {
    if (s.done) return;
    const dt = PHYS.DT;
    if (s.phase === 'fly') {
      s.t += dt;
      const u = Math.min(1, s.t / s.T);
      const nx = s.start.x + s.dir.x * s.C * u + s.drift.x * u * u;
      const ny = s.start.y + s.dir.y * s.C * u + s.drift.y * u * u;
      if (blockedAt(h, nx, ny)) { s.hitTree = true; s.events.push('tree'); finish(h, s, 'rest'); return; }
      s.x = nx; s.y = ny; s.h = 4 * s.H * u * (1 - u);
      if (u >= 1) {
        s.h = 0;
        const ter = terrainAt(h, s.x, s.y);
        if (ter === T.WATER) { s.events.push('splash'); finish(h, s, 'water'); return; }
        if (Math.hypot(h.pin.x - s.x, h.pin.y - s.y) < 0.2) { s.events.push('holed'); finish(h, s, 'holed'); return; }
        if (ter === T.SAND) { s.events.push('sand'); finish(h, s, 'rest'); return; }
        const v0 = Math.sqrt(2 * PHYS.FRICTION[ter] * rollOut(ter, s.C));
        let dx = s.dir.x * s.C + 2 * s.drift.x, dy = s.dir.y * s.C + 2 * s.drift.y;
        const l = Math.hypot(dx, dy) || 1;
        s.vx = (dx / l) * v0; s.vy = (dy / l) * v0;
        s.phase = 'roll'; s.events.push('land');
      }
      return;
    }
    /* rolling */
    const ter = terrainAt(h, s.x, s.y);
    if (ter === T.WATER) { s.events.push('splash'); finish(h, s, 'water'); return; }
    const sp = Math.hypot(s.vx, s.vy);
    const a = PHYS.FRICTION[ter];
    if (sp < a * dt * 1.01) { finish(h, s, 'rest'); return; }
    let ax = (-a * s.vx) / sp, ay = (-a * s.vy) / sp;
    if (ter === T.GREEN) { ax += h.slope.x; ay += h.slope.y; }
    let nvx = s.vx + ax * dt, nvy = s.vy + ay * dt;
    if (nvx * s.vx + nvy * s.vy <= 0) { finish(h, s, 'rest'); return; }
    const nx = s.x + nvx * dt, ny = s.y + nvy * dt;
    if (blockedAt(h, nx, ny)) { s.hitTree = true; s.events.push('tree'); finish(h, s, 'rest'); return; }
    s.x = nx; s.y = ny;
    const d = Math.hypot(h.pin.x - nx, h.pin.y - ny);
    if (d < PHYS.CUP_R) {
      const nsp = Math.hypot(nvx, nvy);
      if (nsp < PHYS.CUP_V || (d < PHYS.CUP_R * 0.5 && nsp < PHYS.CUP_V * 1.5)) {
        s.x = h.pin.x; s.y = h.pin.y; s.events.push('holed'); finish(h, s, 'holed'); return;
      }
      if (!s.lipped) {
        s.lipped = true; s.events.push('lip');
        const cross = nvx * (h.pin.y - ny) - nvy * (h.pin.x - nx);
        const rot = (cross >= 0 ? 1 : -1) * 0.32, c = Math.cos(rot), sn = Math.sin(rot);
        const rx = (nvx * c - nvy * sn) * 0.72, ry = (nvx * sn + nvy * c) * 0.72;
        nvx = rx; nvy = ry;
      }
    } else if (d > PHYS.CUP_R * 1.6) s.lipped = false;
    s.vx = nvx; s.vy = nvy;
  }
  function runShot(h, ball, angle, power, useWind) {
    const s = createShot(h, ball, angle, power, useWind);
    for (let i = 0; i < 6000 && !s.done; i++) stepShot(h, s);
    if (!s.done) finish(h, s, 'rest');
    return s.result;
  }
  /* what the player sees while aiming: still-air landing spot, no slope */
  function previewShot(h, ball, angle, power) {
    const info = shotInfo(h, ball);
    const dir = { x: Math.sin(angle), y: Math.cos(angle) };
    if (info.putt) {
      const roll = Math.max(0.3, power * info.max);
      return { putt: true, roll, end: { x: ball.x + dir.x * roll, y: ball.y + dir.y * roll }, info };
    }
    const C = Math.max(2, power * info.max);
    let blocked = null;
    for (let d = 1; d <= C; d += 1.5) {
      const x = ball.x + dir.x * d, y = ball.y + dir.y * d;
      if (blockedAt(h, x, y)) { blocked = { x, y, d }; break; }
    }
    const land = { x: ball.x + dir.x * C, y: ball.y + dir.y * C };
    const landLie = terrainAt(h, land.x, land.y);
    return { putt: false, carry: C, land, landLie, roll: rollOut(landLie, C), blocked, dir, info };
  }

  /* ---------- scoring and sharing ---------- */
  function scoreName(par, strokes) {
    if (strokes === 1) return 'Hole in one';
    const d = strokes - par;
    if (d <= -3) return 'Albatross';
    if (d === -2) return 'Eagle';
    if (d === -1) return 'Birdie';
    if (d === 0) return 'Par';
    if (d === 1) return 'Bogey';
    if (d === 2) return 'Double bogey';
    if (d === 3) return 'Triple bogey';
    return 'Picked up';
  }
  const toPar = (n) => (n === 0 ? 'E' : n > 0 ? '+' + n : '−' + -n);
  const TILE = { F: '🟩', R: '🟫', S: '🟨', W: '🟦', T: '🌲', G: '🟢', H: '⛳', X: '✋' };
  function shareText(title, round, scores, trails) {
    const total = scores.reduce((a, b) => a + b, 0);
    const lines = [title + '  ' + toPar(total - round.par) + ' (' + total + ')'];
    round.holes.forEach((h, i) => {
      const tiles = (trails[i] || '').split('').map((c) => TILE[c] || '').join('');
      lines.push('Par ' + h.par + ' ' + tiles + ' ' + scoreName(h.par, scores[i]).toLowerCase());
    });
    return lines.join('\n');
  }

  return {
    T, LIE_NAME, PHYS, hashStr, makeRng, clamp, dist, adv,
    terrainAt, treeAt, blockedAt, inCircles, distToPolyline,
    makeRound, genHole, validate,
    shotInfo, createShot, stepShot, runShot, previewShot, rollOut,
    scoreName, toPar, shareText
  };
});
