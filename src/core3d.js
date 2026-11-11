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
    const bb = h._bb, wb = h._wb;
    for (let i = 0; i < h.bunkers.length; i++) if ((!bb || near(bb[i], x, y, 0)) && inCircles(h.bunkers[i], x, y, 0)) return T.SAND;
    for (let i = 0; i < h.water.length; i++) if ((!wb || near(wb[i], x, y, 0)) && inCircles(h.water[i], x, y, 0)) return T.WATER;
    if (inCircles(h.green, x, y, h.fringeW)) return T.FRINGE;
    const tx = x - h.tee.x, ty = y - h.tee.y;
    if (tx * tx + ty * ty < 49) return T.TEE;
    for (let i = 0; i < h.fairways.length; i++) {
      const f = h.fairways[i];
      if (distToPolyline(f.pts, x, y) <= f.hw) return T.FAIRWAY;
    }
    return T.ROUGH;
  }
  /* a circle round each pond and bunker, so most height and lie lookups can skip most of them */
  function boundOf(list) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, R = 0;
    for (const c of list) { x0 = Math.min(x0, c.x - c.r); x1 = Math.max(x1, c.x + c.r); y0 = Math.min(y0, c.y - c.r); y1 = Math.max(y1, c.y + c.r); }
    const x = (x0 + x1) / 2, y = (y0 + y1) / 2;
    for (const c of list) R = Math.max(R, Math.hypot(c.x - x, c.y - y) + c.r);
    return { x, y, R };
  }
  function prepHole(h) { h._wb = h.water.map(boundOf); h._bb = h.bunkers.map(boundOf); }
  function near(q, x, y, pad) { const dx = x - q.x, dy = y - q.y, r = q.R + pad; return dx * dx + dy * dy < r * r; }
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
    z += t.tilt.x * x + t.tilt.y * y; // the whole property climbs or falls from tee to green
    for (let i = 0; i < t.bumps.length; i++) { const m = t.bumps[i], mx = x - m.x, my = y - m.y, d2 = mx * mx + my * my, s2 = m.s * m.s; if (d2 < 9 * s2) z += m.h * Math.exp(-d2 / (2 * s2)); }
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
    const wb = h._wb, bb = h._bb;
    for (let i = 0; i < h.water.length; i++) {
      if (wb && !near(wb[i], x, y, PHYS.BANK)) continue;
      const sd = Math.max(sdCircles(h.water[i], x, y), -sdg);
      if (sd < PHYS.BANK) {
        const L = h.ter.wl[i];
        if (sd <= 0) z = L - 0.08 - 1.2 * smooth(0, 6, -sd);
        else { const zb = L + 0.1; z = zb + (Math.max(z, zb) - zb) * smooth(0, PHYS.BANK, sd); }
      }
    }
    if (sdg > 0) for (let i = 0; i < h.bunkers.length; i++) {
      if (bb && !near(bb[i], x, y, 1.5)) continue;
      const sd = sdCircles(h.bunkers[i], x, y);
      if (sd < 1.5 && sdg > 0) z -= 0.7 * (1 - smooth(-2.5, 1.5, sd)) * smooth(0, 2, sdg);
    }
    return z;
  }
  function gradAt(h, x, y) {
    const e = 0.6;
    return { x: (heightAt(h, x + e, y) - heightAt(h, x - e, y)) / (2 * e), y: (heightAt(h, x, y + e) - heightAt(h, x, y - e)) / (2 * e) };
  }

  /* ---------- course generation ----------
     A hole is built from a plan: how many full shots it takes, and which features ask the questions.
     Length never does the asking. The driver is a tee-only club and no hole needs it twice:
       par 3  one shot to the green (wedge or iron)
       par 4  a drive, then an iron or wedge
       par 5  a drive, an iron to a second landing zone, a wedge in
     Later holes in a round add water, sand, trees, tilt and climb instead of yards. */
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
  /* The feature that leads each kind of hole. Dated rounds take turns through these lists (see dayEnv),
     so every kind comes round and no kind is starved because it is harder to build. */
  const PLAN_KINDS = {
    30: ['open'], 31: ['front', 'side', 'drop', 'sand'], 32: ['wrap', 'plateau', 'front', 'drop'],
    40: ['open', 'through'], 41: ['corner', 'creek', 'lake', 'cross'], 42: ['creek', 'side', 'corner', 'lake'],
    50: ['lake', 'corner'], 51: ['split', 'layup', 'corner', 'lake'], 52: ['split', 'layup', 'layup', 'split']
  };
  const PLAN_NAME = {
    open: 'Open ground', through: 'Gentle dogleg', cross: 'Cross bunkers', drop: 'Drop shot', sand: 'Ring of sand', plateau: 'Plateau green',
    front: 'Pond carry', side: 'Water beside the green', wrap: 'Peninsula green', corner: 'Water on the corner',
    creek: 'Creek before the green', lake: 'Lakeside', split: 'Creek across the fairway', layup: 'Pond before the green'
  };
  function choosePlan(rng, par, diff, turn) {
    const kinds = PLAN_KINDS[par * 10 + diff], n = kinds.length;
    const i = turn == null ? rng.int(0, n - 1) : ((turn % n) + n) % n, k = kinds[i];
    const p = { kind: k, water: [], cross: false, through: false, pot: false, sand: 0, teeUp: 0, greenUp: 0, climb: 0, name: PLAN_NAME[k] };
    let lean = 0; // a drop shot falls and a plateau climbs; everything else may go either way
    if (par === 3) {
      if (k === 'drop') { p.teeUp = diff === 2 ? rng.range(5, 7) : rng.range(4, 6); lean = -1; if (diff === 2) { p.water.push('side'); p.pot = true; } }
      else if (k === 'sand') { p.pot = true; p.sand = 2; }
      else if (k === 'plateau') { p.greenUp = rng.range(3, 4.5); p.pot = true; lean = 1; }
      else if (k !== 'open') { p.water.push(k); if (k === 'front' && diff === 2) p.water.push('side'); }
    } else if (par === 4) {
      if (k === 'through') p.through = true;
      else if (k === 'cross') { p.cross = true; p.through = rng.chance(0.4); }
      else if (k !== 'open') {
        p.water.push(k);
        if (diff === 2) { p[rng.pick(['cross', 'through', 'pot'])] = true; if (k !== 'side' && rng.chance(0.4)) p.greenUp = rng.range(2, 3.5); }
        else p.through = rng.chance(0.4);
      }
    } else {
      p.water.push(k);
      if (diff === 2) { p.water.push(i % 2 === 0 ? 'corner' : 'lake'); p.cross = rng.chance(0.6); p.pot = rng.chance(0.4); }
      else p.through = rng.chance(0.5);
    }
    const c = 0.004 + 0.008 * diff; // overall rise per yard from tee to green
    p.climb = lean ? lean * rng.range(0.3, 1) * c : rng.range(-1, 1) * c;
    return p;
  }
  const GEN = { fail: {} };
  const YARDS = { 3: [110.5, 167.4], 4: [310.5, 394.4], 5: [445.5, 529.4] };

  function buildHole(rng, par, diff, env, plan, force) {
    const has = (k) => plan.water.indexOf(k) >= 0;
    const fail = (why) => { GEN.fail[why] = (GEN.fail[why] || 0) + 1; return null; };
    const h = {
      par, diff, name: plan.name, tee: { x: 0, y: 0, z: 0 }, fringeW: 2.6,
      fairways: [], bunkers: [], water: [], trees: [], green: [],
      wind: { mph: 0, x: 0, y: 1 }, slope: { x: 0, y: 0 }
    };
    const tee = h.tee;
    const turnLo = [0.05, 0.25, 0.35][diff], turnHi = [0.3, 0.6, 0.78][diff];
    const hwR = [[26, 30], [23, 27], [20.5, 24.5]][diff];
    let path = null, legs = null, hw = 0;
    for (let n = 0; n < 24 && !path; n++) { // the line of play, redrawn until it fits the width of the property
      let P, Lg;
      if (par === 3) {
        const L = diff === 0 ? rng.range(113, 140) : plan.greenUp ? rng.range(120, 150) : rng.range(122, 160);
        const a = rng.range(-0.2, 0.2);
        P = [tee, adv(tee, a, L)]; Lg = [{ a, len: L }];
      } else if (par === 4) {
        const a1 = rng.range(-0.14, 0.14), d1 = rng.range(236, 258);
        const lo = plan.through ? Math.max(turnLo, 0.2) : turnLo, hi = Math.max(turnHi, lo + 0.12);
        const Z = adv(tee, a1, d1);
        const a2 = clamp(a1 + rng.sign() * rng.range(lo, hi), -0.85, 0.85);
        const d2 = rng.range(Math.max(has('creek') ? 108 : 75, 318 - d1), Math.min(has('creek') ? 135 : 132, 388 - d1));
        P = [tee, Z, adv(Z, a2, d2)]; Lg = [{ a: a1, len: d1 }, { a: a2, len: d2 }];
      } else {
        const a1 = rng.range(-0.18, 0.18), d1 = rng.range(236, 258);
        const Z1 = adv(tee, a1, d1);
        const s = rng.sign();
        const a2 = clamp(a1 + s * rng.range(0.2, 0.65), -0.9, 0.9), d2 = rng.range(162, 176);
        const Z2 = adv(Z1, a2, d2);
        const s2 = rng.chance(0.6) ? -s : s;
        const a3 = clamp(a2 + s2 * rng.range(0.2, 0.7), -1.0, 1.0);
        const d3 = rng.range(Math.max(has('layup') ? 84 : 74, 466 - d1 - d2), Math.min(92, 522 - d1 - d2));
        P = [tee, Z1, Z2, adv(Z2, a3, d3)]; Lg = [{ a: a1, len: d1 }, { a: a2, len: d2 }, { a: a3, len: d3 }];
        if (!force && dist(adv(tee, a1, d1 + 45), P[3]) < 212) continue; // a drive that runs on past the corner must still leave more than an iron
      }
      if (force || P.every((p) => Math.abs(p.x) <= 114)) { path = P; legs = Lg; }
    }
    if (!path) return fail('width');
    const Gc = path[path.length - 1], last = legs[legs.length - 1], prev = path[path.length - 2];
    if (par === 3) h.fairways.push({ pts: [adv(Gc, last.a, -40), adv(Gc, last.a, -13)], hw: rng.range(11, 14) });
    else {
      hw = rng.range(hwR[0], hwR[1]);
      const pts = [adv(tee, legs[0].a, 46)].concat(path.slice(1, -1), [adv(Gc, last.a, -24)]);
      h.fairways.push({ pts: roundCorners(pts, 45), hw });
    }
    h.path = path; h.legs = legs; h.hw = hw;

    /* green: two or three overlapping lobes, smaller as the round goes on */
    const gr = diff === 0 ? rng.range(13, 15.5) : diff === 1 ? rng.range(12, 14.5) : rng.range(11.2, 13.6);
    h.green.push({ x: Gc.x, y: Gc.y, r: gr });
    const ga = rng.range(0, Math.PI * 2), go = rng.range(6, 9);
    h.green.push({ x: Gc.x + Math.cos(ga) * go, y: Gc.y + Math.sin(ga) * go, r: gr * rng.range(0.72, 0.9) });
    if (rng.chance(0.5)) {
      const gb = ga + rng.range(1.8, 3.2), go2 = rng.range(6, 10);
      h.green.push({ x: Gc.x + Math.cos(gb) * go2, y: Gc.y + Math.sin(gb) * go2, r: gr * rng.range(0.6, 0.8) });
    }
    let lead = 0;
    for (let i = 0; i < legs.length - 1; i++) lead += legs[i].len;
    h.pin = null;
    for (let n = 0; n < 12 && !h.pin; n++) { // the cup: central on the opener, anywhere on a lobe later, and never outside the hole's yardage band
      const lobe = diff === 0 ? h.green[0] : rng.pick(h.green);
      const pa = rng.range(0, Math.PI * 2), po = diff === 0 ? rng.range(0, 3.5) : rng.range(0, Math.max(0.5, lobe.r - 6.5));
      const c = { x: lobe.x + Math.cos(pa) * po, y: lobe.y + Math.sin(pa) * po }, y = lead + dist(prev, c);
      if (force || (y >= YARDS[par][0] && y <= YARDS[par][1])) h.pin = c;
    }
    if (!h.pin) return fail('yards');
    const appr = Math.atan2(prev.y - Gc.y, prev.x - Gc.x); // math angle, green -> player
    const sidePond = (phi, n, rLo, rHi) => {
      const d = greenExtent(h.green, Gc, phi) + rng.range(12.5, 16);
      h.water.push(blob(rng, { x: Gc.x + Math.cos(phi) * d, y: Gc.y + Math.sin(phi) * d }, -phi, n, 13, rLo, rHi));
    };
    const creekAcross = (c, a) => {
      const p = perpOf(a), ph = rng.range(0, 6), creek = [], span = Math.max(hw, 14) + 34;
      for (let u = -span; u <= span; u += 7.5) {
        const q = adv(c, a, Math.sin(u * 0.06 + ph) * 5);
        creek.push({ x: q.x + p.x * u, y: q.y + p.y * u, r: rng.range(5.2, 6.6) });
      }
      h.water.push(creek);
    };

    /* water */
    for (const kind of plan.water) {
      if (kind === 'front') { // a pond on the line: carry it
        const L = legs[0].len, c = adv(tee, legs[0].a, clamp(L * rng.range(0.45, 0.62), 62, L - 46));
        const p = perpOf(legs[0].a), off = rng.range(-12, 12);
        h.water.push(blob(rng, { x: c.x + p.x * off, y: c.y + p.y * off }, legs[0].a + Math.PI / 2, 3, 15, 12.5, 16.5));
      } else if (kind === 'side') {
        let phi = appr + Math.PI;
        for (let i = 0; i < 20; i++) { phi = rng.range(0, Math.PI * 2); if (angDiff(phi, appr) > 1.0) break; }
        sidePond(phi, rng.int(2, 3), 11, 15);
      } else if (kind === 'wrap') { // water round the front corner and one side: a peninsula
        const s1 = rng.sign(), phi1 = appr + s1 * rng.range(0.6, 0.9);
        sidePond(phi1, 2, 11, 14); sidePond(phi1 + s1 * rng.range(1.0, 1.4), 2, 11, 14);
      } else if (kind === 'corner') { // inside the dogleg: cut the corner at your peril
        const Z = path[1], turn = legs[1].a - legs[0].a >= 0 ? 1 : -1, n = perpOf(legs[0].a);
        const lat = hw + rng.range(16, 22), base = adv(Z, legs[0].a, -rng.range(8, 32));
        h.water.push(blob(rng, { x: base.x + n.x * turn * lat, y: base.y + n.y * turn * lat }, legs[0].a, 3, 14, 13, 17.5));
      } else if (kind === 'creek') {
        creekAcross(adv(Gc, last.a, -rng.range(40, 56)), last.a);
      } else if (kind === 'split') { // the fairway is cut in two: the second shot must carry
        creekAcross(adv(path[1], legs[1].a, legs[1].len * rng.range(0.42, 0.58)), legs[1].a);
      } else if (kind === 'layup') { // a pond across the front of the green: lay up, then wedge over
        h.water.push(blob(rng, adv(Gc, last.a, -rng.range(35, 40)), last.a + Math.PI / 2, 3, 15, 11, 14));
      } else if (kind === 'lake') { // a long lake down one side
        const li = par === 5 && rng.chance(0.5) ? 1 : 0, leg = legs[li], n = perpOf(leg.a), side = rng.sign();
        const from = li === 0 ? rng.range(105, 130) : rng.range(35, 55), lake = [];
        for (let k = 0; k < 4; k++) {
          const r = rng.range(13, 18), q = adv(path[li], leg.a, from + k * 22);
          lake.push({ x: q.x + n.x * side * (hw + r * 0.72 + 2), y: q.y + n.y * side * (hw + r * 0.72 + 2), r });
        }
        h.water.push(lake);
      }
    }

    /* greenside bunkers */
    const nB = (diff === 0 ? rng.int(1, 2) : diff === 1 ? rng.int(2, 3) : rng.int(3, 4)) + plan.sand;
    const used = [];
    for (let tries = 0; tries < 50 && used.length < nB; tries++) {
      const phi = rng.range(0, Math.PI * 2);
      const front = angDiff(phi, appr);
      if (front < (diff === 0 ? 1.0 : 0.55) && !(diff > 0 && rng.chance(diff === 2 ? 0.35 : 0.2))) continue;
      if (used.some((u) => angDiff(u, phi) < (nB > 4 ? 0.75 : 0.9))) continue;
      const br = rng.range(5.5, 8);
      const d = greenExtent(h.green, Gc, phi) + br * 0.55 + rng.range(0.8, 3);
      const c0 = { x: Gc.x + Math.cos(phi) * d, y: Gc.y + Math.sin(phi) * d, r: br };
      if (terrainAt(h, c0.x, c0.y) === T.WATER) continue;
      const tx = -Math.sin(phi), ty = Math.cos(phi), k = rng.sign() * rng.range(4, 6.5);
      const b = [c0, { x: c0.x + tx * k, y: c0.y + ty * k, r: br * rng.range(0.72, 0.88) }];
      if (rng.chance(0.4)) b.push({ x: c0.x - tx * k * 0.9 + Math.cos(phi) * 1.5, y: c0.y - ty * k * 0.9 + Math.sin(phi) * 1.5, r: br * 0.7 });
      h.bunkers.push(b); used.push(phi);
    }
    const dry = (c) => { const t = terrainAt(h, c.x, c.y); return t !== T.WATER && t !== T.GREEN && t !== T.SAND; };
    /* sand beside the landing zones */
    for (let zi = 1; zi < path.length - 1; zi++) {
      if (!rng.chance([0.4, 0.7, 0.85][diff])) continue;
      const a = legs[zi - 1].a, pr = perpOf(a);
      const n = diff === 2 && rng.chance(0.4) ? 2 : 1;
      let side = rng.sign();
      for (let i = 0; i < n; i++, side = -side) {
        const base = adv(path[zi], a, -rng.range(-6, 30));
        const lat = hw + rng.range(-4, 3);
        const c0 = { x: base.x + pr.x * lat * side, y: base.y + pr.y * lat * side, r: rng.range(6, 8) };
        if (!dry(c0)) continue;
        const c1 = adv(c0, a, rng.range(5, 8)); c1.r = c0.r * 0.8;
        h.bunkers.push([c0, c1]);
      }
    }
    if (plan.through && path.length > 2) { // on the far edge of the corner, where a drive that runs straight on finishes
      const a0 = legs[0].a, a1 = legs[1].a, th = a1 - a0, out = th >= 0 ? -1 : 1, n1 = perpOf(a1);
      const over = clamp((hw - 2) / Math.max(0.05, Math.sin(Math.abs(th))), 14, 34) + rng.range(-3, 5);
      const along = over * Math.cos(th), lat = Math.max(over * Math.sin(Math.abs(th)), hw - rng.range(2, 6));
      const q = adv(path[1], a1, along), c0 = { x: q.x + n1.x * out * lat, y: q.y + n1.y * out * lat, r: rng.range(6.5, 8.5) };
      if (dry(c0)) { const c1 = adv(c0, a1, rng.range(5, 8)); c1.r = c0.r * 0.8; h.bunkers.push([c0, c1]); }
    }
    if (plan.cross && path.length > 2) { // sand across one half of the fairway short of the landing zone: carry it or go round
      const a = legs[0].a, pr = perpOf(a), side = rng.sign(), base = adv(tee, a, rng.range(186, 202));
      for (const lat of [hw - 5, hw - 18]) {
        const c0 = { x: base.x + pr.x * lat * side + rng.range(-2, 2), y: base.y + pr.y * lat * side + rng.range(-2, 2), r: rng.range(6, 7.5) };
        if (dry(c0)) { const c1 = adv(c0, a, rng.range(4, 6)); c1.r = c0.r * 0.78; h.bunkers.push([c0, c1]); }
      }
    }
    if (plan.pot) { // small deep bunkers short of the green
      const n = rng.int(2, 3), pr = perpOf(last.a), w = Math.max(11, hw * 0.8);
      for (let i = 0; i < n; i++) {
        const base = adv(Gc, last.a, -rng.range(gr + 9, gr + 30)), lat = rng.range(-1, 1) * w;
        const c = { x: base.x + pr.x * lat, y: base.y + pr.y * lat, r: rng.range(3.6, 4.8) };
        if (dry(c) && !h.bunkers.some((bk) => inCircles(bk, c.x, c.y, c.r + 2))) h.bunkers.push([c]);
      }
    }
    prepHole(h);
    if (!force && !layoutOK(h)) return fail('layout');

    /* conditions: the opener is calm with a gentle green; wind and tilt build from there */
    {
      const sa = rng.range(0, Math.PI * 2);
      const mag = diff === 0 ? rng.range(0.1, 0.17) : diff === 1 ? rng.range(0.19, 0.3) : rng.range(0.27, 0.44);
      h.slope = { x: Math.cos(sa) * mag, y: Math.sin(sa) * mag }; // downhill pull on the green, yd/s^2
    }
    if (diff > 0) {
      const wa = env.wind + rng.range(-0.35, 0.35);
      const mph = Math.round(diff === 1 ? rng.range(5, 9) : rng.range(8, 14));
      h.wind = { mph, x: Math.sin(wa), y: Math.cos(wa) };
    }

    /* the land: long swells, a steady climb or fall, a raised tee and green, mounds and hollows beside the line of play */
    const waves = [], amp = [0.75, 1.05, 1.4][diff];
    const mk = (lam, A) => { const dir = rng.range(0, Math.PI * 2), k = (2 * Math.PI) / lam; waves.push({ kx: Math.cos(dir) * k, ky: Math.sin(dir) * k, ph: rng.range(0, 6.283), A: A * amp }); };
    mk(rng.range(300, 420), rng.range(2.2, 3.5));
    mk(rng.range(160, 220), rng.range(0.7, 1.2));
    mk(rng.range(80, 110), rng.range(0.2, 0.35));
    const gdir = Math.atan2(Gc.x - tee.x, Gc.y - tee.y), bumps = [];
    for (let i = 0, n = par === 3 ? diff : 4 + 3 * diff; i < n; i++) {
      const li = rng.int(0, legs.length - 1), t = rng.range(0.22, 0.9), side = rng.sign(), pr = perpOf(legs[li].a);
      const c = adv(path[li], legs[li].a, legs[li].len * t), lat = (par === 3 ? rng.range(16, 40) : hw + rng.range(4, 20)) * side;
      const x = c.x + pr.x * lat, y = c.y + pr.y * lat;
      if (Math.hypot(x - Gc.x, y - Gc.y) < 44 || Math.hypot(x - tee.x, y - tee.y) < 45) continue;
      bumps.push({ x, y, s: rng.range(9, 15), h: rng.chance(0.25) ? -rng.range(0.6, 1.2) : rng.range(0.9, 2.0) * (0.85 + 0.2 * diff) });
    }
    for (let i = 0; i < 1 + diff; i++) {
      const phi = rng.range(0, Math.PI * 2), d = gr + rng.range(17, 27);
      bumps.push({ x: Gc.x + Math.cos(phi) * d, y: Gc.y + Math.sin(phi) * d, s: rng.range(8, 12), h: rng.range(0.8, 1.8) });
    }
    let nearWater = false; // a green beside water sits lower, so its edge does not fall away into the pond
    for (const w of h.water) if (sdCircles(w, Gc.x, Gc.y) < gr + 22) nearWater = true;
    h.ter = {
      waves, bumps, tilt: { x: Math.sin(gdir) * plan.climb, y: Math.cos(gdir) * plan.climb }, G: { x: Gc.x, y: Gc.y },
      teeMound: rng.range(3.5, 6.5) + plan.teeUp,
      greenMound: [rng.range(1, 2), rng.range(1.5, 3.2), rng.range(2.2, 4.2)][diff] * (nearWater ? 0.55 : 1) + plan.greenUp,
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
    if (!force && !landOK(h)) return fail('land');

    /* bounds */
    let x0 = 1e9, x1 = -1e9, y1 = -1e9;
    const ext = (x, y, r) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
    path.forEach((p) => ext(p.x, p.y, 0));
    h.green.forEach((c) => ext(c.x, c.y, c.r));
    h.water.forEach((w) => w.forEach((c) => ext(c.x, c.y, c.r * 0.6)));
    h.bounds = { x0: Math.min(x0 - 60, -105), x1: Math.max(x1 + 60, 105), y0: -40, y1: y1 + 50 };
    const b = h.bounds;

    /* trees: a wooded border, groves in the rough, and a guard on the inside of each corner */
    const greenR = gr + 9, treeGap = diff === 2 ? 4.5 : 6;
    function tryTree(x, y, r) {
      if (Math.hypot(x - tee.x, y - tee.y) < r + 26) return;
      if (Math.hypot(x - Gc.x, y - Gc.y) < greenR + r + 15) return;
      for (const f of h.fairways) if (distToPolyline(f.pts, x, y) < f.hw + r + treeGap) return;
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
    if (diff > 0) for (let zi = 1; zi < path.length - 1; zi++) {
      const a = legs[zi - 1].a, turn = legs[zi].a - a, n = perpOf(a), sgn = turn >= 0 ? 1 : -1;
      if (Math.abs(turn) < 0.3) continue;
      for (let k = 0; k < 4; k++) {
        const r = rng.range(7.5, 10), base = adv(path[zi], a, rng.range(-18, 14)), lat = hw + r + 7 + k * rng.range(7, 11);
        tryTree(base.x + n.x * sgn * lat, base.y + n.y * sgn * lat, r);
      }
    }
    const p1 = rng.range(0, 6), p2 = rng.range(0, 6), p3 = rng.range(0, 6);
    const nT = 70 + 35 * diff + (par - 3) * 25;
    for (let i = 0; i < nT; i++) {
      const x = rng.range(b.x0 + 8, b.x1 - 8), y = rng.range(b.y0 + 8, b.y1 - 8), r = rng.range(6.5, 10);
      const n = Math.sin(x * 0.031 + p1) * Math.cos(y * 0.027 + p2) + 0.5 * Math.sin((x + y) * 0.05 + p3);
      if (n > 0.12) tryTree(x, y, r);
    }
    buildTreeGrid(h);
    if (!force && !treesOK(h)) return fail('trees');

    tee.z = heightAt(h, tee.x, tee.y);
    h.pin.z = heightAt(h, h.pin.x, h.pin.y);
    for (const t of h.trees) t.z = heightAt(h, t.x, t.y);
    h.yards = Math.round(lead + dist(prev, h.pin));
    h.drop = Math.round((tee.z - h.pin.z) * 3); // feet the hole falls from tee to cup
    return h;
  }

  /* Fairness, cheapest checks first. layoutOK needs only the shapes, landOK the hills, treesOK the trees. */
  function layoutOK(h) {
    const P = h.path, n = P.length;
    for (const p of P) if (Math.abs(p.x) > 118) return false;
    if (terrainAt(h, h.tee.x, h.tee.y) !== T.TEE) return false;
    if (terrainAt(h, h.pin.x, h.pin.y) !== T.GREEN) return false;
    for (let k = 0; k < 8; k++) {
      const q = (k / 8) * Math.PI * 2;
      if (terrainAt(h, h.pin.x + Math.cos(q) * 5, h.pin.y + Math.sin(q) * 5) !== T.GREEN) return false;
    }
    for (const w of h.water) if (sdCircles(w, h.tee.x, h.tee.y) < 36) return false; // nothing wet around the tee
    for (let zi = 1; zi < n - 1; zi++) { // landing zones are fairway, with no water hard against them
      const a = h.legs[zi - 1].a, Z = P[zi];
      for (const off of [-12, 0]) {
        const p = adv(Z, a, off);
        if (terrainAt(h, p.x, p.y) !== T.FAIRWAY) return false;
        for (const w of h.water) if (sdCircles(w, p.x, p.y) < 13) return false;
      }
    }
    for (let i = 0; i < n - 1; i++) {
      const A = P[i], B = P[i + 1], L = dist(A, B);
      let wet = 0;
      for (let d = 0; d <= L; d += 3) {
        const x = A.x + ((B.x - A.x) * d) / L, y = A.y + ((B.y - A.y) * d) / L;
        if (terrainAt(h, x, y) === T.WATER) {
          wet += 3;
          if (d < 42 && i === 0) return false;        // nothing wet right off the tee
          if (i > 0 && d < 28) return false;          // or just past a landing zone
          if (i < n - 2 && L - d < 28) return false;  // or just short of one
        }
      }
      if (wet > 75) return false;
    }
    return true;
  }
  function landOK(h) {
    for (let zi = 1; zi < h.path.length - 1; zi++) { // landing zones are not on a steep bank
      const a = h.legs[zi - 1].a;
      for (const off of [-12, 0, 12]) {
        const p = adv(h.path[zi], a, off), g = gradAt(h, p.x, p.y);
        if (Math.hypot(g.x, g.y) > 0.16) return false;
      }
    }
    for (let k = 0; k < 5; k++) { // and the cup is not cut on one
      const q = (k / 4) * Math.PI * 2, r = k === 4 ? 0 : 2.5, g = gradAt(h, h.pin.x + Math.cos(q) * r, h.pin.y + Math.sin(q) * r);
      if (Math.hypot(g.x, g.y) > 0.125) return false;
    }
    return true;
  }
  function treesOK(h) {
    const P = h.path.slice(0, -1).concat([h.pin]);
    for (let i = 0; i < P.length - 1; i++) {
      const A = P[i], B = P[i + 1], L = dist(A, B);
      for (let d = 0; d <= L; d += 3) if (treeAt(h, A.x + ((B.x - A.x) * d) / L, A.y + ((B.y - A.y) * d) / L)) return false;
    }
    return true;
  }
  function validate(h) { return layoutOK(h) && landOK(h) && treesOK(h) && regulationOK(h) && threeShotOK(h); }

  /* Yards still to play from p: across to the centreline, then along it to the cup. */
  function pathRem(h, p) {
    const P = h.path, n = P.length;
    let best = 1e9, tail = 0;
    for (let i = n - 2; i >= 0; i--) {
      const A = P[i], B = i === n - 2 ? h.pin : P[i + 1];
      const dx = B.x - A.x, dy = B.y - A.y, l2 = dx * dx + dy * dy, L = Math.sqrt(l2);
      const t = l2 ? clamp(((p.x - A.x) * dx + (p.y - A.y) * dy) / l2, 0, 1) : 0;
      const rem = Math.hypot(p.x - (A.x + dx * t), p.y - (A.y + dy * t)) + L * (1 - t) + tail;
      if (rem < best) best = rem;
      tail += L;
    }
    return best;
  }
  /* Can the green be reached in regulation with sensible shots in still air: the driver from the tee only,
     an iron for the middle shot of a par 5, an iron or wedge in? Each candidate is a real simulated shot, so
     this stops at the first one that works. */
  function regulationOK(h) {
    let ball = { x: h.tee.x, y: h.tee.y };
    const shots = h.par - 2;
    for (let k = 0; k < shots; k++) {
      const opt = clubOptions(h, ball);
      if (opt.lie === T.GREEN) return true;
      const a0 = Math.atan2(h.pin.x - ball.x, h.pin.y - ball.y);
      if (k === shots - 1) { // the approach: work out the swing that should finish by the cup, then try near it
        const d = opt.dist, dz = h.pin.z - heightAt(h, ball.x, ball.y);
        for (const club of d <= opt.clubs.wedge.full * 1.04 ? ['wedge', 'iron'] : ['iron']) {
          const max = opt.clubs[club].max;
          let C = d;
          for (let i = 0; i < 3; i++) C = d - rollOut(club, T.GREEN, C);
          C += dz / Math.tan((CLUBS[club].loft * Math.PI) / 180); // a higher green cuts the flight short
          const p0 = C / max;
          if (p0 > 1.07) continue;
          for (const dp of [0, -0.045, 0.045, -0.09]) {
            const r = runShot(h, ball, club, a0, clamp(p0 + dp, 0.1, 1), false);
            if (r.kind === 'holed' || (r.kind !== 'water' && !r.tree && r.lie === T.GREEN)) return true;
          }
        }
        return false;
      }
      const club = k === 0 ? 'driver' : 'iron';
      if (!opt.clubs[club].ok) return false;
      const tgt = aimPoint(h, ball, opt.clubs[club].max * 1.12 + 4), a = Math.atan2(tgt.x - ball.x, tgt.y - ball.y);
      let next = null;
      for (let p = 1; p > 0.7 && !next; p -= 0.08) {
        const r = runShot(h, ball, club, a, p, false);
        if (r.kind === 'holed') return true;
        if (r.kind === 'water' || r.tree) continue;
        if (r.lie === T.GREEN) return true;
        if (r.lie !== T.FAIRWAY && r.lie !== T.FRINGE) continue;
        if (k === shots - 2 && pathRem(h, r) > 182) continue; // must leave an iron or less
        next = r;
      }
      if (!next) return false;
      ball = { x: next.x, y: next.y };
    }
    return false;
  }

  /* A par 5 is a three-shot hole: a full drive that stays on the short grass should not leave a full iron that runs onto
     the green, in the hole's own wind. A handful of drives are tried, not every one, so a rare perfect drive can still
     set up a long eagle chance. */
  function threeShotOK(h) {
    if (h.par !== 5) return true;
    const ap = aimPoint(h, h.tee, CLUBS.driver.max * 1.12 + 4), a0 = Math.atan2(ap.x - h.tee.x, ap.y - h.tee.y);
    for (let i = 0; i < 11; i++) {
      const r = runShot(h, h.tee, 'driver', a0 + (i - 5) * 0.06, 1, true);
      if (r.kind !== 'rest' || r.tree || (r.lie !== T.FAIRWAY && r.lie !== T.FRINGE)) continue;
      const edge = sdCircles(h.green, r.x, r.y);
      if (edge > 235) continue; // beyond any iron, whatever the wind and slope
      const q = runShot(h, r, 'iron', Math.atan2(h.pin.x - r.x, h.pin.y - r.y), 1, true);
      if (q.kind === 'holed' || dist(q, r) + 2 >= edge) return false;
    }
    return true;
  }

  const LAYOUTS = [[3, 4, 5], [4, 3, 5], [4, 5, 3], [3, 5, 4]];
  /* What a date brings: its day number, the four-day block it sits in, and the morning's prevailing wind. */
  function dayEnv(key) {
    const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(key);
    const day = m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 864e5) : null;
    return { day, block: day == null ? null : Math.floor(day / 4), wind: makeRng(hashStr('wind|' + key)).range(0, Math.PI * 2) };
  }
  function genHole(key, idx, par, diff, env) {
    env = env || dayEnv(key);
    /* dated rounds step through the kinds of hole block by block; anything else picks at random */
    const turn = env.block == null ? null : env.block * ((par + diff) % 2 ? 1 : 3) + par * 2 + diff;
    let h = null, n = 0;
    for (let round = 0; round < 4 && !h; round++) { // the plan is fixed first; only its geometry is redrawn. A plan that will not build gives way to the next
      const plan = choosePlan(makeRng(hashStr(key + '|' + idx + '|plan|' + round)), par, diff, turn == null ? null : turn + round);
      for (let attempt = 0; attempt < 30 && !h; attempt++) {
        n++;
        const c = buildHole(makeRng(hashStr(key + '|' + idx + '|' + round + '|' + attempt)), par, diff, env, plan, false);
        if (c && attempt < 20 && !threeShotOK(c)) GEN.fail.twoShot = (GEN.fail.twoShot || 0) + 1;
        else if (c && regulationOK(c)) h = c; else if (c) GEN.fail.regulation = (GEN.fail.regulation || 0) + 1;
      }
    }
    if (!h) { // never seen in testing: an unchecked hole is better than no hole
      const plan = choosePlan(makeRng(hashStr(key + '|' + idx + '|plan|x')), par, 0, 0);
      h = buildHole(makeRng(hashStr(key + '|' + idx + '|x')), par, diff, env, plan, true);
      GEN.fail.forced = (GEN.fail.forced || 0) + 1;
    }
    h.index = idx; h.attempts = n;
    return h;
  }
  function makeRound(key) {
    const rng = makeRng(hashStr('dew|' + key)), env = dayEnv(key);
    let pars = rng.pick(LAYOUTS);
    if (env.day != null) { // each four-day block plays all four orders of par once
      const br = makeRng(hashStr('block|' + env.block)), order = [0, 1, 2, 3];
      for (let i = 3; i > 0; i--) { const j = br.int(0, i), t = order[i]; order[i] = order[j]; order[j] = t; }
      pars = LAYOUTS[order[((env.day % 4) + 4) % 4]];
    }
    const holes = pars.map((par, i) => genHole(key, i, par, i, env));
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
    o.suggest = d <= wfull * 1.03 ? 'wedge' : d <= o.clubs.iron.max * 1.07 || !o.clubs.driver.ok ? 'iron' : 'driver'; // each club's carry plus its run-out
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
    const e = 0.6, hx1 = heightAt(h, s.x + e, s.y), hx0 = heightAt(h, s.x - e, s.y), hy1 = heightAt(h, s.x, s.y + e), hy0 = heightAt(h, s.x, s.y - e);
    const gx = (hx1 - hx0) / (2 * e), gy = (hy1 - hy0) / (2 * e); // the same four samples give the slope and the ground under the ball
    const ax = (-a * s.vx) / sp - PHYS.G_ROLL * gx, ay = (-a * s.vy) / sp - PHYS.G_ROLL * gy;
    let nvx = s.vx + ax * dt, nvy = s.vy + ay * dt;
    if (nvx * s.vx + nvy * s.vy <= 0) { finish(h, s, 'rest'); return; }
    const nx = s.x + nvx * dt, ny = s.y + nvy * dt;
    if (blockedAt(h, nx, ny)) { s.hitTree = true; s.events.push('tree'); finish(h, s, 'rest'); return; }
    s.z = (hx1 + hx0 + hy1 + hy0) / 4 + gx * (nx - s.x) + gy * (ny - s.y); s.x = nx; s.y = ny;
    s.rollT += dt;
    s.h = s.rollT < 1.5 ? s.hop * Math.abs(Math.sin((Math.PI * s.rollT) / 0.44)) * Math.exp(-s.rollT * 2.9) : 0;
    const d = Math.hypot(h.pin.x - nx, h.pin.y - ny);
    if (d < PHYS.CUP_R && s.h < 0.1) {
      const nsp = Math.hypot(nvx, nvy);
      /* a pitch or full shot has to find the middle of the cup, slowly; a putt gets the whole cup */
      const full = s.club !== 'putter';
      if (full ? d < PHYS.CUP_R * 0.4 && nsp < PHYS.CUP_V * 0.7 : nsp < PHYS.CUP_V || (d < PHYS.CUP_R * 0.5 && nsp < PHYS.CUP_V * 1.5)) {
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
    makeRound, genHole, validate, regulationOK, pathRem, dayEnv, _gen: GEN,
    clubOptions, rollOut, launch, createShot, stepShot, runShot, previewShot, aimPoint,
    scoreName, toPar, shareText
  };
});
