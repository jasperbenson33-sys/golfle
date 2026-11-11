/* Dewsweeper 3D core: seeded course generation, hills, clubs, ball physics. No DOM. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const T = { ROUGH: 0, FAIRWAY: 1, FRINGE: 2, TEE: 3, GREEN: 4, SAND: 5, WATER: 6 };
  const LIE_NAME = ['Rough', 'Fairway', 'Fringe', 'Tee', 'Green', 'Sand', 'Water'];
  const PHYS = {
    DT: 1 / 120,
    G_FLY: 20,     // gravity for flight, tuned so a full drive hangs about three seconds
    G_ROLL: 4.5,   // how hard slopes pull a rolling ball
    //         rough fairway fringe tee green sand water
    FRICTION: [14, 5.2, 2.8, 5.2, 1.6, 70, 0],
    CUP_R: 0.25,
    CUP_V: 1.7,    // fastest a ball can cross the cup and still drop (about a yard past on flat ground)
    WIND_K: 0.42,
    BANK: 14
  };
  const CLUBS = {
    driver: { name: 'Driver', max: 225, loft: 24, wind: 1.0 },
    iron: { name: 'Iron', max: 165, loft: 32, wind: 0.85 },
    wedge: { name: 'Wedge', max: 95, loft: 48, wind: 0.6 },
    putter: { name: 'Putter', max: 0, loft: 0, wind: 0 }
  };
  const CLUB_ORDER = ['driver', 'iron', 'wedge', 'putter'];

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
  const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
  const adv = (p, a, d) => ({ x: p.x + Math.sin(a) * d, y: p.y + Math.cos(a) * d }); // heading a: clockwise from north
  const perpOf = (a) => ({ x: Math.cos(a), y: -Math.sin(a) });
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  function angDiff(a, b) {
    let d = (a - b) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  }
  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
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
  function sdCircles(list, x, y) { // signed distance to a union of circles (negative inside)
    let m = 1e9;
    for (let i = 0; i < list.length; i++) { const c = list[i], d = Math.hypot(x - c.x, y - c.y) - c.r; if (d < m) m = d; }
    return m;
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

  /* ---------- what is under the ball ---------- */
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
  const outside = (h, x, y) => { const b = h.bounds; return x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1; };
  const blockedAt = (h, x, y) => outside(h, x, y) || !!treeAt(h, x, y); // on the ground: tree footprints are solid

  /* ---------- hills ---------- */
  function baseH(h, x, y) {
    const t = h.ter;
    let z = 0;
    for (let i = 0; i < t.waves.length; i++) { const w = t.waves[i]; z += w.A * Math.sin(x * w.kx + y * w.ky + w.ph); }
    for (let i = 0; i < t.mounds.length; i++) { const m = t.mounds[i], mx = x - m.x, my = y - m.y, q = (mx * mx + my * my) * m.k; if (q < 6) z += m.A * Math.exp(-q); }
    const tx = x - h.tee.x, ty = y - h.tee.y;
    z += t.teeMound * Math.exp(-(tx * tx + ty * ty) / 2048);
    const gx = x - t.G.x, gy = y - t.G.y;
    z += t.greenMound * Math.exp(-(gx * gx + gy * gy) / 1800);
    return z;
  }
  function dryH(h, x, y, sdg) { // hills, with the green laid in as a tilted plane and the tee as a flat pad
    const t = h.ter;
    let z = baseH(h, x, y);
    if (sdg < 22) {
      const w = 1 - smooth(h.fringeW, 22, sdg);
      z += (t.zG + t.gx * (x - t.G.x) + t.gy * (y - t.G.y) - z) * w;
    }
    const dT = Math.hypot(x - h.tee.x, y - h.tee.y);
    if (dT < 18) z += (t.zT - z) * (1 - smooth(6, 18, dT));
    return z;
  }
  function heightAt(h, x, y) {
    const sdg = sdCircles(h.green, x, y);
    let z = dryH(h, x, y, sdg);
    for (let i = 0; i < h.water.length; i++) {
      const sd = Math.max(sdCircles(h.water[i], x, y), -sdg);
      if (sd < PHYS.BANK) {
        const L = h.ter.wl[i];
        if (sd <= 0) z = L - 0.08 - 1.2 * smooth(0, 6, -sd);
        else { const zb = L + 0.1; z = zb + (Math.max(z, zb) - zb) * smooth(0, PHYS.BANK, sd); }
      }
    }
    for (let i = 0; i < h.bunkers.length; i++) {
      const sd = sdCircles(h.bunkers[i], x, y);
      if (sd < 1.5 && sdg > 0) z -= 0.7 * (1 - smooth(-2.5, 1.5, sd)) * smooth(0, 2, sdg);
    }
    return z;
  }
  function gradAt(h, x, y) {
    const e = 0.6;
    return { x: (heightAt(h, x + e, y) - heightAt(h, x - e, y)) / (2 * e), y: (heightAt(h, x, y + e) - heightAt(h, x, y - e)) / (2 * e) };
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
      par, diff, tee: { x: 0, y: 0, z: 0 }, fringeW: 2.6,
      fairways: [], bunkers: [], water: [], trees: [], green: [],
      wind: { mph: 0, x: 0, y: 1 }, slope: { x: 0, y: 0 }
    };
    const tee = h.tee;
    let path, legs, hw = 0;
    const hwLo = diff === 2 ? 20 : diff === 1 ? 22 : 24; // the fairway narrows as the round goes on
    if (par === 3) {
      const L = diff === 0 ? rng.range(115, 145) : rng.range(125, 172); // always an iron or a wedge
      const a = rng.range(-0.2, 0.2);
      const G = adv(tee, a, L);
      path = [tee, G]; legs = [{ a, len: L }];
      h.fairways.push({ pts: [adv(G, a, -40), adv(G, a, -13)], hw: rng.range(11, 14) });
    } else if (par === 4) { // a drive, then an iron or wedge
      const a1 = rng.range(-0.14, 0.14), d1 = rng.range(238, 256);
      const Z = adv(tee, a1, d1);
      const a2 = clamp(a1 + rng.sign() * rng.range(0.08, 0.72), -0.85, 0.85), d2 = rng.range(95, 150);
      const G = adv(Z, a2, d2);
      path = [tee, Z, G]; legs = [{ a: a1, len: d1 }, { a: a2, len: d2 }];
      hw = rng.range(hwLo, hwLo + 4);
      h.fairways.push({ pts: roundCorners([adv(tee, a1, 46), Z, adv(G, a2, -24)], 45), hw });
    } else { // a drive, an iron, a wedge: three shots, never two drivers
      const a1 = rng.range(-0.18, 0.18), d1 = rng.range(238, 256);
      const Z1 = adv(tee, a1, d1);
      const s = rng.sign();
      const a2 = clamp(a1 + s * rng.range(0.18, 0.65), -0.9, 0.9), d2 = rng.range(160, 185);
      const Z2 = adv(Z1, a2, d2);
      const s2 = rng.chance(0.65) ? -s : s;
      const a3 = clamp(a2 + s2 * rng.range(0.15, 0.7), -1.0, 1.0), d3 = rng.range(75, 110);
      const G = adv(Z2, a3, d3);
      path = [tee, Z1, Z2, G]; legs = [{ a: a1, len: d1 }, { a: a2, len: d2 }, { a: a3, len: d3 }];
      hw = rng.range(hwLo, hwLo + 4);
      h.fairways.push({ pts: roundCorners([adv(tee, a1, 46), Z1, Z2, adv(G, a3, -24)], 45), hw });
    }
    h.path = path; h.legs = legs; h.hw = hw;
    const Gc = path[path.length - 1];
    const last = legs[legs.length - 1];

    const gr = diff === 2 ? rng.range(11.5, 14) : rng.range(12, 15);
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
    const appr = Math.atan2(prev.y - Gc.y, prev.x - Gc.x);

    if (diff > 0 && rng.chance(diff === 1 ? 0.6 : 0.88)) {
      let kind;
      if (par === 3) kind = rng.pick(['front', 'front', 'side']);
      else {
        const opts = ['corner', 'side'];
        if (last.len >= (par === 4 ? 115 : 98)) opts.push('creek');
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
        h.water.push(blob(rng, c, -phi, rng.int(2, 3), 13, 11, 15));
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
          const q = adv(c, last.a, Math.sin(u * 0.06 + ph) * 5);
          creek.push({ x: q.x + p.x * u, y: q.y + p.y * u, r: rng.range(5.2, 6.6) });
        }
        h.water.push(creek);
      }
      if (diff === 2 && par > 3 && kind === 'corner' && rng.chance(0.45)) { // the finisher: water at the corner and again by the green
        let phi = appr + Math.PI;
        for (let i = 0; i < 20; i++) { phi = rng.range(0, Math.PI * 2); if (angDiff(phi, appr) > 1.1) break; }
        const d = greenExtent(h.green, Gc, phi) + rng.range(13, 17);
        h.water.push(blob(rng, { x: Gc.x + Math.cos(phi) * d, y: Gc.y + Math.sin(phi) * d }, -phi, 2, 13, 11, 14));
      }
    }

    const nB = diff === 0 ? rng.int(1, 2) : diff === 1 ? rng.int(2, 3) : rng.int(3, 4);
    const used = [];
    for (let tries = 0; tries < 40 && used.length < nB; tries++) {
      const phi = rng.range(0, Math.PI * 2);
      const front = angDiff(phi, appr);
      if (front < (diff === 0 ? 1.0 : 0.55) && !(diff > 0 && rng.chance(0.2))) continue;
      if (used.some((u) => angDiff(u, phi) < (diff === 2 ? 0.8 : 0.95))) continue;
      const br = rng.range(5.5, 8);
      const d = greenExtent(h.green, Gc, phi) + br * 0.55 + rng.range(0.8, 3);
      const c0 = { x: Gc.x + Math.cos(phi) * d, y: Gc.y + Math.sin(phi) * d, r: br };
      if (terrainAt(h, c0.x, c0.y) === T.WATER) continue;
      const tx = -Math.sin(phi), ty = Math.cos(phi), k = rng.sign() * rng.range(4, 6.5);
      const b = [c0, { x: c0.x + tx * k, y: c0.y + ty * k, r: br * rng.range(0.72, 0.88) }];
      if (rng.chance(0.4)) b.push({ x: c0.x - tx * k * 0.9 + Math.cos(phi) * 1.5, y: c0.y - ty * k * 0.9 + Math.sin(phi) * 1.5, r: br * 0.7 });
      h.bunkers.push(b); used.push(phi);
    }
    for (let zi = 1; zi < path.length - 1; zi++) {
      if (!rng.chance(diff === 0 ? 0.4 : diff === 1 ? 0.8 : 1)) continue;
      const a = legs[zi - 1].a, pr = perpOf(a);
      const n = diff === 2 && rng.chance(0.7) ? 2 : 1;
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

    let x0 = 1e9, x1 = -1e9, y1 = -1e9;
    const ext = (x, y, r) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
    path.forEach((p) => ext(p.x, p.y, 0));
    h.green.forEach((c) => ext(c.x, c.y, c.r));
    h.water.forEach((w) => w.forEach((c) => ext(c.x, c.y, c.r * 0.5)));
    h.bounds = { x0: Math.min(x0 - 60, -105), x1: Math.max(x1 + 60, 105), y0: -40, y1: y1 + 50 };
    const b = h.bounds;

    const greenR = gr + 9;
    function tryTree(x, y, r) {
      if (Math.hypot(x - tee.x, y - tee.y) < r + 26) return;
      if (Math.hypot(x - Gc.x, y - Gc.y) < greenR + r + 15) return;
      for (const f of h.fairways) if (distToPolyline(f.pts, x, y) < f.hw + r + (diff === 2 ? 3 : 6)) return;
      if (distToPolyline(path, x, y) < r + 17) return;
      for (let k = 0; k < 8; k++) {
        const q = (k / 8) * Math.PI * 2;
        if (terrainAt(h, x + Math.cos(q) * (r + 2.5), y + Math.sin(q) * (r + 2.5)) !== T.ROUGH) return;
      }
      for (const t of h.trees) if (Math.hypot(x - t.x, y - t.y) < 0.55 * (r + t.r)) return;
      h.trees.push({ x, y, r, H: clamp(r * rng.range(1.5, 2.1), 10, 21), tone: rng(), kind: rng.chance(0.28) ? 1 : 0 });
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
    const nT = 80 + 55 * diff + (par - 3) * 25;
    for (let i = 0; i < nT; i++) {
      const x = rng.range(b.x0 + 8, b.x1 - 8), y = rng.range(b.y0 + 8, b.y1 - 8), r = rng.range(6.5, 10);
      const n = Math.sin(x * 0.031 + p1) * Math.cos(y * 0.027 + p2) + 0.5 * Math.sin((x + y) * 0.05 + p3);
      if (n > (diff === 2 ? -0.05 : 0.12)) tryTree(x, y, r);
    }
    buildTreeGrid(h);

    /* conditions: the opener is calm with a gentle green; wind and slope build from there */
    {
      const sa = rng.range(0, Math.PI * 2);
      const mag = diff === 0 ? rng.range(0.1, 0.17) : diff === 1 ? rng.range(0.19, 0.3) : rng.range(0.27, 0.43);
      h.slope = { x: Math.cos(sa) * mag, y: Math.sin(sa) * mag }; // downhill pull on the green, yd/s^2
    }
    if (diff > 0) {
      const wa = rng.range(0, Math.PI * 2);
      const mph = Math.round(diff === 1 ? rng.range(5, 9) : rng.range(8, 15));
      h.wind = { mph, x: Math.sin(wa), y: Math.cos(wa) };
    }

    /* hills: long swells that grow with the hole number, a raised tee, a raised green complex,
       and a few mounds and hollows beside the line of play */
    const waves = [], hilly = diff === 0 ? 0.8 : diff === 1 ? 1.15 : 1.55;
    const mk = (lam, A) => { const dir = rng.range(0, Math.PI * 2), k = (2 * Math.PI) / lam; waves.push({ kx: Math.cos(dir) * k, ky: Math.sin(dir) * k, ph: rng.range(0, 6.283), A: A * hilly }); };
    mk(rng.range(300, 420), rng.range(2.2, 3.5));
    mk(rng.range(160, 220), rng.range(0.7, 1.2));
    mk(rng.range(80, 110), rng.range(0.2, 0.35));
    const mounds = [];
    for (let i = 0, n = 2 + diff * 2 + (par - 3); i < n; i++) {
      const li = rng.int(0, legs.length - 1), A0 = path[li], t = rng.range(0.2, 0.85), side = rng.sign();
      const c = adv(A0, legs[li].a, legs[li].len * t), pr = perpOf(legs[li].a), lat = (par === 3 ? rng.range(14, 40) : hw + rng.range(-4, 22)) * side;
      const x = c.x + pr.x * lat, y = c.y + pr.y * lat;
      if (Math.hypot(x - Gc.x, y - Gc.y) < 42 || Math.hypot(x - tee.x, y - tee.y) < 45) continue;
      const sg = rng.range(16, 28);
      mounds.push({ x, y, A: (rng.chance(0.75) ? 1 : -0.7) * rng.range(1.4, 2.6) * (0.8 + 0.25 * diff), k: 1 / (2 * sg * sg) });
    }
    h.ter = {
      waves, mounds, G: { x: Gc.x, y: Gc.y }, teeMound: rng.range(3.5, 6.5) + diff * 0.8, greenMound: rng.range(1.2, 2.8),
      gx: -h.slope.x / PHYS.G_ROLL, gy: -h.slope.y / PHYS.G_ROLL, zT: 0, zG: 0, wl: []
    };
    h.ter.zT = baseH(h, tee.x, tee.y);
    h.ter.zG = baseH(h, Gc.x, Gc.y);
    h.ter.wl = h.water.map(function (pond) { // each pond sits level in the lowest ground around it
      let m = 1e9;
      for (const c of pond) for (let k = 0; k < 8; k++) for (const rr of [c.r, c.r + PHYS.BANK]) {
        const q = (k / 8) * Math.PI * 2, x = c.x + Math.cos(q) * rr, y = c.y + Math.sin(q) * rr;
        m = Math.min(m, dryH(h, x, y, sdCircles(h.green, x, y)));
      }
      return m - 0.3;
    });
    tee.z = heightAt(h, tee.x, tee.y);
    h.pin.z = heightAt(h, h.pin.x, h.pin.y);
    for (const t of h.trees) t.z = heightAt(h, t.x, t.y);

    let yards = 0;
    for (let i = 0; i < path.length - 1; i++) yards += dist(path[i], i === path.length - 2 ? h.pin : path[i + 1]);
    h.yards = Math.round(yards);
    h.drop = Math.round((tee.z - h.pin.z) * 3); // feet the hole falls from tee to cup
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
    for (let zi = 1; zi < h.path.length - 1; zi++) {
      const a = h.legs[zi - 1].a;
      for (const off of [-10, 0]) {
        const p = adv(h.path[zi], a, off);
        if (terrainAt(h, p.x, p.y) !== T.FAIRWAY) return false;
      }
    }
    for (let i = 0; i < h.path.length - 1; i++) {
      const A = h.path[i], B = h.path[i + 1], L = dist(A, B);
      let wet = 0;
      for (let d = 0; d <= L; d += 3) {
        const x = A.x + ((B.x - A.x) * d) / L, y = A.y + ((B.y - A.y) * d) / L;
        if (treeAt(h, x, y)) return false;
        if (terrainAt(h, x, y) === T.WATER) {
          wet += 3;
          if (d < 40 && i === 0) return false;
          if (i > 0 && d < 28) return false;
          if (i < h.path.length - 2 && L - d < 28) return false;
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

  /* ---------- clubs ---------- */
  function clubOptions(h, ball) {
    const lie = terrainAt(h, ball.x, ball.y), d = dist(ball, h.pin);
    const o = { lie, dist: d, clubs: {}, suggest: 'iron' };
    if (lie === T.GREEN) {
      o.clubs.putter = { ok: true, max: clamp(d * 1.55 + 3.5, 5, 70), sway: 0 };
      for (const k of ['driver', 'iron', 'wedge']) o.clubs[k] = { ok: false, max: CLUBS[k].max, sway: 0 };
      o.suggest = 'putter';
      return o;
    }
    const rough = lie === T.ROUGH, sand = lie === T.SAND;
    const im = sand ? 0.7 : rough ? 0.85 : 1, wm = sand ? 0.8 : rough ? 0.9 : 1, wfull = 95 * wm;
    o.clubs.putter = { ok: false, max: 0, sway: 0 };
    o.clubs.driver = { ok: lie === T.TEE, max: 225, sway: 0 }; // the driver is for the tee, so no hole ever asks for it twice
    o.clubs.iron = { ok: true, max: 165 * im, sway: sand ? 4.5 : rough ? 2 : 0 };
    o.clubs.wedge = { ok: true, max: Math.min(wfull, Math.max(22, d * 1.3 + 8)), full: wfull, sway: sand ? 2.8 : rough ? 1.6 : 0 };
    o.suggest = d <= wfull * 1.02 ? 'wedge' : d <= o.clubs.iron.max * 1.05 ? 'iron' : o.clubs.driver.ok ? 'driver' : 'iron'; // each club's carry plus its run-out
    return o;
  }
  function rollOut(club, ter, C) { // how far the ball runs after it lands, on level ground
    if (ter === T.SAND || ter === T.WATER) return 0;
    if (club === 'driver') return ter === T.ROUGH ? 0.06 * C + 1.2 : ter === T.GREEN ? 0.16 * C + 3.5 : ter === T.FRINGE ? 0.15 * C + 3 : 0.18 * C + 3.5;
    if (club === 'iron') return ter === T.ROUGH ? 0.045 * C + 1 : ter === T.GREEN ? 0.065 * C + 2.5 : ter === T.FRINGE ? 0.08 * C + 2.5 : 0.105 * C + 2.5;
    const chip = 0.25 * C * Math.exp(-C / 18); // short pitches release more for their length
    return ter === T.ROUGH ? 0.035 * C + 0.6 : ter === T.GREEN ? 0.048 * C + 1.5 + chip : ter === T.FRINGE ? 0.052 * C + 1.5 + chip : 0.065 * C + 1.8 + chip;
  }
  function launch(club, carry) {
    const th = (CLUBS[club].loft * Math.PI) / 180;
    const v = Math.sqrt((carry * PHYS.G_FLY) / Math.sin(2 * th));
    return { vh: v * Math.cos(th), vz: v * Math.sin(th) };
  }

  /* ---------- shots ---------- */
  function createShot(h, ball, club, angle, power, useWind) {
    const opt = clubOptions(h, ball), c = opt.clubs[club];
    const dir = { x: Math.sin(angle), y: Math.cos(angle) };
    const z0 = heightAt(h, ball.x, ball.y);
    const s = {
      x: ball.x, y: ball.y, z: z0, h: 0, t: 0, vx: 0, vy: 0, vz: 0, phase: 'fly', done: false, club,
      start: { x: ball.x, y: ball.y, z: z0 }, dir, lie: opt.lie, events: [], result: null, lipped: false, hitTree: false,
      rollT: 0, hop: 0, wax: 0, way: 0, carry: 0
    };
    if (club === 'putter') {
      const roll = Math.max(0.3, power * c.max);
      const v0 = Math.sqrt(2 * PHYS.FRICTION[T.GREEN] * roll);
      s.vx = dir.x * v0; s.vy = dir.y * v0; s.phase = 'roll'; s.rollT = 9;
    } else {
      const C = Math.max(2, power * c.max), L = launch(club, C);
      s.C = C; s.vx = dir.x * L.vh; s.vy = dir.y * L.vh; s.vz = L.vz;
      if (useWind !== false) { const k = h.wind.mph * PHYS.WIND_K * CLUBS[club].wind; s.wax = h.wind.x * k; s.way = h.wind.y * k; }
    }
    return s;
  }
  function finish(h, s, kind) {
    s.done = true; s.h = 0; s.z = heightAt(h, s.x, s.y);
    const lie = terrainAt(h, s.x, s.y);
    if (kind !== 'holed' && lie === T.WATER) kind = 'water';
    s.result = { kind, x: s.x, y: s.y, z: s.z, lie, tree: s.hitTree };
  }
  function stepShot(h, s) {
    if (s.done) return;
    const dt = PHYS.DT;
    if (s.phase === 'fly') {
      s.t += dt;
      s.vx += s.wax * dt; s.vy += s.way * dt; s.vz -= PHYS.G_FLY * dt;
      const nx = s.x + s.vx * dt, ny = s.y + s.vy * dt, nz = s.z + s.vz * dt;
      const tr = outside(h, nx, ny) ? { z: -99, H: 999 } : treeAt(h, nx, ny);
      if (tr && nz - tr.z < tr.H) { // knocked down: it falls just short of the tree, back along its own line
        s.hitTree = true; s.events.push('tree');
        const l = Math.hypot(s.vx, s.vy) || 1, ux = s.vx / l, uy = s.vy / l;
        let bx = s.x, by = s.y, n = 0;
        while (blockedAt(h, bx, by) && n++ < 80) { bx -= ux; by -= uy; }
        if (blockedAt(h, bx, by)) { bx = s.start.x; by = s.start.y; }
        s.x = bx; s.y = by; s.phase = 'drop'; s.vx = 0; s.vy = 0; s.vz = Math.min(s.vz, 0) * 0.2;
        return;
      }
      const gz = heightAt(h, nx, ny);
      if (nz <= gz && s.t > 0.06) {
        s.x = nx; s.y = ny; s.z = gz; s.h = 0;
        s.carry = Math.hypot(nx - s.start.x, ny - s.start.y);
        const ter = terrainAt(h, nx, ny);
        if (ter === T.WATER) { s.events.push('splash'); finish(h, s, 'water'); return; }
        if (Math.hypot(h.pin.x - nx, h.pin.y - ny) < 0.2) { s.events.push('holed'); finish(h, s, 'holed'); return; }
        if (ter === T.SAND) { s.events.push('sand'); finish(h, s, 'rest'); return; }
        const v0 = Math.sqrt(2 * PHYS.FRICTION[ter] * rollOut(s.club, ter, s.carry));
        const l = Math.hypot(s.vx, s.vy) || 1;
        s.hop = clamp(Math.abs(s.vz) * 0.045, 0, 2.2);
        s.vx = (s.vx / l) * v0; s.vy = (s.vy / l) * v0; s.vz = 0;
        s.phase = 'roll'; s.rollT = 0; s.events.push('land');
        return;
      }
      s.x = nx; s.y = ny; s.z = nz; s.h = nz - gz;
      return;
    }
    if (s.phase === 'drop') { // knocked down by a tree: fall where it was stopped
      s.vz -= PHYS.G_FLY * dt; s.z += s.vz * dt;
      const gz = heightAt(h, s.x, s.y);
      s.h = s.z - gz;
      if (s.z <= gz) finish(h, s, 'rest');
      return;
    }
    /* rolling: friction by surface, plus the pull of the slope */
    const ter = terrainAt(h, s.x, s.y);
    if (ter === T.WATER) { s.events.push('splash'); finish(h, s, 'water'); return; }
    const sp = Math.hypot(s.vx, s.vy), a = PHYS.FRICTION[ter];
    if (sp < a * dt * 1.01) { finish(h, s, 'rest'); return; }
    const g = gradAt(h, s.x, s.y);
    const ax = (-a * s.vx) / sp - PHYS.G_ROLL * g.x, ay = (-a * s.vy) / sp - PHYS.G_ROLL * g.y;
    let nvx = s.vx + ax * dt, nvy = s.vy + ay * dt;
    if (nvx * s.vx + nvy * s.vy <= 0) { finish(h, s, 'rest'); return; }
    const nx = s.x + nvx * dt, ny = s.y + nvy * dt;
    if (blockedAt(h, nx, ny)) { s.hitTree = true; s.events.push('tree'); finish(h, s, 'rest'); return; }
    s.x = nx; s.y = ny; s.z = heightAt(h, nx, ny);
    s.rollT += dt;
    s.h = s.rollT < 1.5 ? s.hop * Math.abs(Math.sin((Math.PI * s.rollT) / 0.44)) * Math.exp(-s.rollT * 2.9) : 0;
    const d = Math.hypot(h.pin.x - nx, h.pin.y - ny);
    if (d < PHYS.CUP_R && s.h < 0.1) {
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
  function runShot(h, ball, club, angle, power, useWind) {
    const s = createShot(h, ball, club, angle, power, useWind);
    for (let i = 0; i < 8000 && !s.done; i++) stepShot(h, s);
    if (!s.done) finish(h, s, 'rest');
    return s.result;
  }
  /* what the player sees while aiming: the still-air flight, where it comes down, and the flat-ground run-out */
  function previewShot(h, ball, club, angle, power) {
    const opt = clubOptions(h, ball), c = opt.clubs[club];
    const dir = { x: Math.sin(angle), y: Math.cos(angle) };
    const z0 = heightAt(h, ball.x, ball.y);
    if (club === 'putter') {
      const roll = Math.max(0.3, power * c.max), pts = [];
      for (let d = 0; d <= roll; d += Math.max(0.25, roll / 40)) { const x = ball.x + dir.x * d, y = ball.y + dir.y * d; pts.push({ x, y, z: heightAt(h, x, y) }); }
      const ex = ball.x + dir.x * roll, ey = ball.y + dir.y * roll;
      return { putt: true, roll, pts, end: { x: ex, y: ey, z: heightAt(h, ex, ey) }, dir };
    }
    const C = Math.max(2, power * c.max), L = launch(club, C), dt = 1 / 60;
    let x = ball.x, y = ball.y, z = z0, vz = L.vz, blocked = null;
    const pts = [{ x, y, z }];
    for (let i = 0; i < 600; i++) {
      vz -= PHYS.G_FLY * dt;
      x += dir.x * L.vh * dt; y += dir.y * L.vh * dt; z += vz * dt;
      const tr = outside(h, x, y) ? { z: -99, H: 999 } : treeAt(h, x, y);
      if (tr && z - tr.z < tr.H) { blocked = { x, y, z }; break; }
      const gz = heightAt(h, x, y);
      if (z <= gz && i > 3) { z = gz; pts.push({ x, y, z }); break; }
      if (i % 2 === 1) pts.push({ x, y, z });
    }
    const land = blocked || { x, y, z };
    const landLie = terrainAt(h, land.x, land.y), carry = Math.hypot(land.x - ball.x, land.y - ball.y);
    return { putt: false, pts, land, landLie, carry, flat: C, roll: blocked ? 0 : rollOut(club, landLie, carry), blocked, dir };
  }
  /* a sensible direction to face: the pin if it is in reach, otherwise the farthest clear spot down the hole */
  function aimPoint(h, ball, reach) {
    if (dist(ball, h.pin) <= reach) return h.pin;
    const P = h.path.slice(0, -1).concat([h.pin]), seg = [];
    let best = 1e9, s0 = 0, acc = 0;
    for (let i = 0; i < P.length - 1; i++) {
      const dx = P[i + 1].x - P[i].x, dy = P[i + 1].y - P[i].y, L = Math.hypot(dx, dy);
      let t = ((ball.x - P[i].x) * dx + (ball.y - P[i].y) * dy) / (L * L); t = clamp(t, 0, 1);
      const d = Math.hypot(ball.x - (P[i].x + dx * t), ball.y - (P[i].y + dy * t));
      if (d < best) { best = d; s0 = acc + L * t; }
      seg.push({ a: P[i], dx, dy, L, s: acc }); acc += L;
    }
    const at = (s) => { for (const g of seg) if (s <= g.s + g.L) { const t = (s - g.s) / g.L; return { x: g.a.x + g.dx * t, y: g.a.y + g.dy * t }; } return h.pin; };
    for (let s = Math.min(acc, s0 + reach); s > s0 + 50; s -= 10) {
      const p = at(s), d = dist(ball, p);
      if (d > reach) continue;
      let ok = terrainAt(h, p.x, p.y) !== T.WATER;
      for (let u = 4; ok && u < d; u += 4) if (blockedAt(h, ball.x + ((p.x - ball.x) * u) / d, ball.y + ((p.y - ball.y) * u) / d)) ok = false;
      if (ok) return p;
    }
    return h.pin;
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
    T, LIE_NAME, PHYS, CLUBS, CLUB_ORDER, hashStr, makeRng, clamp, smooth, dist, adv,
    terrainAt, treeAt, blockedAt, outside, inCircles, sdCircles, distToPolyline, heightAt, gradAt,
    makeRound, genHole, validate,
    clubOptions, rollOut, launch, createShot, stepShot, runShot, previewShot, aimPoint,
    scoreName, toPar, shareText
  };
});
