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
  function choosePlan(rng, par, diff) {
    const p = { water: [], cross: false, through: false, pot: false, teeUp: 0, greenUp: 0, climb: 0, name: 'Open ground' };
    if (par === 3) {
      if (diff === 1) {
        const k = rng.pick(['front', 'side', 'drop', 'sand']);
        if (k === 'front') { p.water.push('front'); p.name = 'Pond carry'; }
        else if (k === 'side') { p.water.push('side'); p.name = 'Water beside the green'; }
        else if (k === 'drop') { p.teeUp = rng.range(4, 6); p.name = 'Drop shot'; }
        else { p.pot = true; p.name = 'Ring of sand'; }
      } else if (diff === 2) {
        const k = rng.pick(['wrap', 'front', 'plateau', 'wrap']);
        if (k === 'plateau') { p.greenUp = rng.range(3, 4.5); p.pot = true; p.name = 'Plateau green'; }
        else if (k === 'wrap') { p.water.push('wrap'); p.name = 'Peninsula green'; }
        else { p.water.push('front'); if (rng.chance(0.5)) p.water.push('side'); p.name = 'Pond carry'; }
      }
    } else if (par === 4) {
      if (diff === 0) p.through = rng.chance(0.4);
      else if (diff === 1) {
        const k = rng.pick(['corner', 'creek', 'lake', 'cross']);
        if (k === 'cross') { p.cross = true; p.name = 'Cross bunkers'; } else { p.water.push(k); p.name = k === 'corner' ? 'Water on the corner' : k === 'creek' ? 'Creek before the green' : 'Lakeside'; }
        p.through = rng.chance(0.4);
      } else {
        const w = rng.pick(['corner', 'creek', 'lake', 'side']); p.water.push(w);
        const k = rng.pick(['cross', 'through', 'pot']); p[k] = true;
        if (rng.chance(0.35)) p.greenUp = rng.range(2, 3.5);
        p.name = w === 'corner' ? 'Water on the corner' : w === 'creek' ? 'Creek before the green' : w === 'lake' ? 'Lakeside' : 'Water beside the green';
      }
    } else {
      if (diff <= 1) { const w = rng.pick(['split', 'layup', 'corner', 'lake']); p.water.push(w); p.through = rng.chance(0.5); p.name = w === 'split' ? 'Creek across the fairway' : w === 'layup' ? 'Pond before the green' : w === 'corner' ? 'Water on the corner' : 'Lakeside'; }
      else { const a = rng.pick(['split', 'layup']); p.water.push(a, rng.pick(['corner', 'lake'])); p.cross = rng.chance(0.6); p.pot = rng.chance(0.4); p.name = a === 'split' ? 'Creek across the fairway' : 'Pond before the green'; }
    }
    p.climb = rng.range(-1, 1) * (0.004 + 0.008 * diff); // overall rise per yard from tee to green
    return p;
  }

  function buildHole(rng, par, diff, env) {
    const plan = choosePlan(rng, par, diff);
    const has = (k) => plan.water.indexOf(k) >= 0;
    const h = {
      par, diff, name: plan.name, tee: { x: 0, y: 0, z: 0 }, fringeW: 2.6,
      fairways: [], bunkers: [], water: [], trees: [], green: [],
      wind: { mph: 0, x: 0, y: 1 }, slope: { x: 0, y: 0 }
    };
    const tee = h.tee;
    const turnLo = [0.05, 0.25, 0.35][diff], turnHi = [0.3, 0.6, 0.78][diff];
    const hwR = [[26, 30], [23, 27], [20.5, 24.5]][diff];
    let path, legs, hw = 0;
    if (par === 3) {
      const L = diff === 0 ? rng.range(110, 140) : rng.range(122, 165);
      const a = rng.range(-0.2, 0.2);
      const G = adv(tee, a, L);
      path = [tee, G]; legs = [{ a, len: L }];
      h.fairways.push({ pts: [adv(G, a, -40), adv(G, a, -13)], hw: rng.range(11, 14) });
    } else if (par === 4) {
      const a1 = rng.range(-0.14, 0.14), d1 = rng.range(236, 258);
      const Z = adv(tee, a1, d1);
      const a2 = clamp(a1 + rng.sign() * rng.range(turnLo, turnHi), -0.85, 0.85);
      const d2 = has('creek') ? rng.range(108, 135) : rng.range(75, 132);
      const G = adv(Z, a2, d2);
      path = [tee, Z, G]; legs = [{ a: a1, len: d1 }, { a: a2, len: d2 }];
      hw = rng.range(hwR[0], hwR[1]);
      h.fairways.push({ pts: roundCorners([adv(tee, a1, 46), Z, adv(G, a2, -24)], 45), hw });
    } else {
      const a1 = rng.range(-0.18, 0.18), d1 = rng.range(236, 258);
      const Z1 = adv(tee, a1, d1);
      const s = rng.sign();
      const a2 = clamp(a1 + s * rng.range(0.2, 0.65), -0.9, 0.9), d2 = rng.range(150, 176);
      const Z2 = adv(Z1, a2, d2);
      const s2 = rng.chance(0.6) ? -s : s;
      const a3 = clamp(a2 + s2 * rng.range(0.2, 0.7), -1.0, 1.0), d3 = has('layup') ? rng.range(80, 90) : rng.range(62, 92);
      const G = adv(Z2, a3, d3);
      path = [tee, Z1, Z2, G]; legs = [{ a: a1, len: d1 }, { a: a2, len: d2 }, { a: a3, len: d3 }];
      hw = rng.range(hwR[0], hwR[1]);
      h.fairways.push({ pts: roundCorners([adv(tee, a1, 46), Z1, Z2, adv(G, a3, -24)], 45), hw });
    }
    h.path = path; h.legs = legs; h.hw = hw;
    const Gc = path[path.length - 1];
    const last = legs[legs.length - 1];

    /* green: two or three overlapping lobes, smaller as the round goes on */
    const gr = diff === 0 ? rng.range(13, 15.5) : diff === 1 ? rng.range(12, 14.5) : rng.range(11.2, 13.6);
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
      if (kind === 'front') {
        const c = adv(tee, legs[0].a, legs[0].len * rng.range(0.42, 0.62));
        const p = perpOf(legs[0].a), off = rng.range(-20, 20);
        h.water.push(blob(rng, { x: c.x + p.x * off, y: c.y + p.y * off }, legs[0].a + Math.PI / 2, 3, 15, 13, 18));
      } else if (kind === 'side') {
        let phi = appr + Math.PI;
        for (let i = 0; i < 20; i++) { phi = rng.range(0, Math.PI * 2); if (angDiff(phi, appr) > 1.0) break; }
        sidePond(phi, rng.int(2, 3), 11, 15);
      } else if (kind === 'wrap') { // water round the front corner and one side: a peninsula
        const s1 = rng.sign(), phi1 = appr + s1 * rng.range(0.55, 0.9);
        sidePond(phi1, 2, 11, 14); sidePond(phi1 + s1 * rng.range(1.0, 1.4), 2, 11, 14);
      } else if (kind === 'corner') {
        const Z = path[1], turn = legs[1].a - legs[0].a >= 0 ? 1 : -1, n = perpOf(legs[0].a);
        const lat = hw + rng.range(15, 22), base = adv(Z, legs[0].a, -rng.range(5, 30));
        h.water.push(blob(rng, { x: base.x + n.x * turn * lat, y: base.y + n.y * turn * lat }, legs[0].a, 3, 14, 13, 18));
      } else if (kind === 'creek') {
        creekAcross(adv(Gc, last.a, -rng.range(40, 56)), last.a);
      } else if (kind === 'split') { // the fairway is cut in two: the second shot must carry
        creekAcross(adv(path[1], legs[1].a, legs[1].len * rng.range(0.42, 0.58)), legs[1].a);
      } else if (kind === 'layup') { // a pond across the front of the green: lay up, then wedge over
        h.water.push(blob(rng, adv(Gc, last.a, -rng.range(36, 42)), last.a + Math.PI / 2, 3, 15, 11, 14.5));
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
    const nB = diff === 0 ? rng.int(1, 2) : diff === 1 ? rng.int(2, 3) : rng.int(3, 4);
    const used = [];
    for (let tries = 0; tries < 50 && used.length < nB; tries++) {
      const phi = rng.range(0, Math.PI * 2);
      const front = angDiff(phi, appr);
      if (front < (diff === 0 ? 1.0 : 0.55) && !(diff > 0 && rng.chance(diff === 2 ? 0.35 : 0.2))) continue;
      if (used.some((u) => angDiff(u, phi) < 0.9)) continue;
      const br = rng.range(5.5, 8);
      const d = greenExtent(h.green, Gc, phi) + br * 0.55 + rng.range(0.8, 3);
      const c0 = { x: Gc.x + Math.cos(phi) * d, y: Gc.y + Math.sin(phi) * d, r: br };
      if (terrainAt(h, c0.x, c0.y) === T.WATER) continue;
      const tx = -Math.sin(phi), ty = Math.cos(phi), k = rng.sign() * rng.range(4, 6.5);
      const b = [c0, { x: c0.x + tx * k, y: c0.y + ty * k, r: br * rng.range(0.72, 0.88) }];
      if (rng.chance(0.4)) b.push({ x: c0.x - tx * k * 0.9 + Math.cos(phi) * 1.5, y: c0.y - ty * k * 0.9 + Math.sin(phi) * 1.5, r: br * 0.7 });
      h.bunkers.push(b); used.push(phi);
    }
    const dry = (c) => terrainAt(h, c.x, c.y) !== T.WATER && terrainAt(h, c.x, c.y) !== T.GREEN;
    /* sand at the landing zones */
    for (let zi = 1; zi < path.length - 1; zi++) {
      if (!rng.chance([0.4, 0.7, 0.85][diff])) continue;
      const a = legs[zi - 1].a, pr = perpOf(a);
      const n = diff === 2 && rng.chance(0.4) ? 2 : 1;
      let side = rng.sign();
      for (let i = 0; i < n; i++, side = -side) {
        const base = adv(path[zi], a, -rng.range(-6, 30));
        const lat = hw + rng.range(-5, 3);
        const c0 = { x: base.x + pr.x * lat * side, y: base.y + pr.y * lat * side, r: rng.range(6, 8) };
        if (!dry(c0)) continue;
        const c1 = adv(c0, a, rng.range(5, 8)); c1.r = c0.r * 0.8;
        h.bunkers.push([c0, c1]);
      }
    }
    if (plan.through && path.length > 2) { // catches the drive that runs straight on through the corner
      const a = legs[0].a, c0 = adv(path[1], a, hw * 0.6 + rng.range(18, 30)); c0.r = rng.range(6.5, 8.5);
      if (dry(c0)) { const c1 = adv(c0, a + Math.PI / 2, rng.range(5, 8)); c1.r = c0.r * 0.8; h.bunkers.push([c0, c1]); }
    }
    if (plan.cross && path.length > 2) { // sand across one half of the fairway short of the landing zone: carry it or go round
      const a = legs[0].a, pr = perpOf(a), side = rng.sign(), base = adv(tee, a, rng.range(196, 212));
      for (const lat of [hw - 6, hw - 19]) {
        const c0 = { x: base.x + pr.x * lat * side + rng.range(-2, 2), y: base.y + pr.y * lat * side + rng.range(-2, 2), r: rng.range(6, 7.5) };
        if (dry(c0)) { const c1 = adv(c0, a, rng.range(4, 6)); c1.r = c0.r * 0.78; h.bunkers.push([c0, c1]); }
      }
    }
    if (plan.pot) { // small deep bunkers short of the green
      const n = rng.int(2, 3), pr = perpOf(last.a), w = Math.max(10, hw * 0.8);
      for (let i = 0; i < n; i++) {
        const base = adv(Gc, last.a, -rng.range(gr + 9, gr + 30)), lat = rng.range(-1, 1) * w;
        const c = { x: base.x + pr.x * lat, y: base.y + pr.y * lat, r: rng.range(3.6, 4.8) };
        if (dry(c) && !h.bunkers.some((bk) => inCircles(bk, c.x, c.y, c.r + 2))) h.bunkers.push([c]);
      }
    }

    /* bounds */
    let x0 = 1e9, x1 = -1e9, y1 = -1e9;
    const ext = (x, y, r) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r); };
    path.forEach((p) => ext(p.x, p.y, 0));
    h.green.forEach((c) => ext(c.x, c.y, c.r));
    h.water.forEach((w) => w.forEach((c) => ext(c.x, c.y, c.r * 0.6)));
    h.bounds = { x0: Math.min(x0 - 60, -105), x1: Math.max(x1 + 60, 105), y0: -40, y1: y1 + 50 };
    const b = h.bounds;

    /* trees: a wooded border, groves in the rough, and a guard on the inside of each corner */
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

    /* the land: long swells, a steady climb or fall, a raised tee and green, mounds and hollows beside the fairway */
    const waves = [], amp = [0.75, 1.0, 1.3][diff];
    const mk = (lam, A) => { const dir = rng.range(0, Math.PI * 2), k = (2 * Math.PI) / lam; waves.push({ kx: Math.cos(dir) * k, ky: Math.sin(dir) * k, ph: rng.range(0, 6.283), A: A * amp }); };
    mk(rng.range(300, 420), rng.range(2.2, 3.5));
    mk(rng.range(160, 220), rng.range(0.7, 1.2));
    mk(rng.range(80, 110), rng.range(0.2, 0.35));
    const gdir = Math.atan2(Gc.x - tee.x, Gc.y - tee.y), bumps = [];
    if (par > 3) {
      const f = h.fairways[0].pts;
      for (let i = 0; i < 4 + 3 * diff; i++) {
        const k = rng.int(2, f.length - 3), p = f[k], q = f[k + 1], n = perpOf(Math.atan2(q.x - p.x, q.y - p.y)), side = rng.sign(), lat = hw + rng.range(4, 20);
        bumps.push({ x: p.x + n.x * side * lat, y: p.y + n.y * side * lat, s: rng.range(9, 15), h: rng.chance(0.25) ? -rng.range(0.6, 1.2) : rng.range(0.9, 2.0) * (0.85 + 0.2 * diff) });
      }
    }
    for (let i = 0; i < 1 + diff; i++) {
      const phi = rng.range(0, Math.PI * 2), d = gr + rng.range(17, 27);
      bumps.push({ x: Gc.x + Math.cos(phi) * d, y: Gc.y + Math.sin(phi) * d, s: rng.range(8, 12), h: rng.range(0.8, 1.8) });
    }
    h.ter = {
      waves, bumps, tilt: { x: Math.sin(gdir) * plan.climb, y: Math.cos(gdir) * plan.climb }, G: { x: Gc.x, y: Gc.y },
      teeMound: rng.range(3.5, 6.5) + plan.teeUp, greenMound: [rng.range(1, 2), rng.range(1.5, 3.2), rng.range(2.2, 4.2)][diff] + plan.greenUp,
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
    for (const p of h.path) if (Math.abs(p.x) > 118) return false;
    if (terrainAt(h, h.tee.x, h.tee.y) !== T.TEE) return false;
    if (terrainAt(h, h.pin.x, h.pin.y) !== T.GREEN) return false;
    for (let k = 0; k < 8; k++) {
      const q = (k / 8) * Math.PI * 2;
      if (terrainAt(h, h.pin.x + Math.cos(q) * 5, h.pin.y + Math.sin(q) * 5) !== T.GREEN) return false;
    }
    for (let zi = 1; zi < h.path.length - 1; zi++) { // landing zones are fairway, and not on a steep bank
      const a = h.legs[zi - 1].a;
      for (const off of [-12, 0, 12]) {
        const p = adv(h.path[zi], a, off);
        if (off <= 0 && terrainAt(h, p.x, p.y) !== T.FAIRWAY) return false;
        const g = gradAt(h, p.x, p.y);
        if (Math.hypot(g.x, g.y) > 0.16) return false;
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
          if (d < 40 && i === 0) return false;                    // nothing wet right off the tee
          if (i > 0 && d < 28) return false;                       // or just past a landing zone
          if (i < h.path.length - 2 && L - d < 28) return false;  // or just short of one
        }
      }
      if (wet > 75) return false;
    }
    return regulationOK(h);
  }
  /* Can the green be reached in regulation with sensible shots in still air: one club per job, the driver once at most? */
  function regulationOK(h) {
    let ball = { x: h.tee.x, y: h.tee.y };
    const shots = h.par - 2;
    for (let k = 0; k < shots; k++) {
      const opt = clubOptions(h, ball), lastShot = k === shots - 1;
      const clubs = lastShot ? ['iron', 'wedge'] : k === 0 ? ['driver'] : ['iron'];
      let best = null;
      for (const club of clubs) {
        if (!opt.clubs[club].ok) continue;
        const tgt = lastShot ? h.pin : aimPoint(h, ball, opt.clubs[club].max * 1.12 + 4), a0 = Math.atan2(tgt.x - ball.x, tgt.y - ball.y);
        for (const da of lastShot ? [0, -0.05, 0.05] : [0]) for (let p = 1; p >= (lastShot ? 0.42 : 0.68); p -= lastShot ? 0.083 : 0.1) {
          const r = runShot(h, ball, club, a0 + da, p, false);
          if (r.kind === 'water' || r.tree) continue;
          if (lastShot ? (r.lie !== T.GREEN && r.kind !== 'holed') : (r.lie !== T.FAIRWAY && r.lie !== T.FRINGE && r.lie !== T.GREEN)) continue;
          const score = lastShot ? dist(r, h.pin) : pathRem(h, r);
          if (!best || score < best.score) best = { r, score };
        }
      }
      if (!best) return false;
      if (best.r.lie === T.GREEN || best.r.kind === 'holed') return true;
      ball = { x: best.r.x, y: best.r.y };
    }
    return false;
  }
  function genHole(key, idx, par, diff, env) {
    let h = null;
    for (let attempt = 0; attempt < 90; attempt++) {
      h = buildHole(makeRng(hashStr(key + '|' + idx + '|' + attempt)), par, diff, env);
      if (validate(h)) { h.attempts = attempt + 1; break; }
    }
    h.index = idx;
    return h;
  }
  function makeRound(key) {
    const rng = makeRng(hashStr('dew|' + key));
    const pars = rng.pick([[3, 4, 5], [4, 3, 5], [4, 5, 3], [3, 5, 4]]);
    const env = { wind: rng.range(0, Math.PI * 2) }; // one prevailing wind for the morning
    const holes = pars.map((par, i) => genHole(key, i, par, i, env));
    return { key, holes, par: pars.reduce((a, b) => a + b, 0) };
  }

