/* Dewsweeper 3D effect module: trees  (fx/trees.js)
   ---------------------------------------------------------------------------------------------------------
   What it draws : every tree in ctx.trees, i.e. the trees in play and the woods that ring the hole, as a
                   late-autumn parkland wood at first light. Low-poly, stylised species built procedurally
                   (seeded per hole) from a few merged, slightly irregular lobes:
                     in play : spreading oak, rounded maple, tall birch-poplar (pale trunk), layered conifer
                               (stacked drooping tiers), the odd sparse late-autumn tree with bare limbs.
                     woods   : cheaper broadleaf, pale-trunked tall tree and conifer, each with a dark
                               understorey skirt so the border reads as one continuous mass.
                   Colour: per-tree hue/value from `tone`, ~25% of broadleaves in autumn ambers/rusts in
                   position-noise clusters; inside a tree darker/cooler underneath and inward, warmer toward
                   ctx.sunDir. Wind: gentle vertex-shader sway, more at the crown, a slow gust front crossing
                   the wood along ctx.wind; amplitude from ctx.wind.mph; trunks planted.
   Fair play     : in-play canopies are normalised so their widest radius is PLAY_WIDTH * r, top exactly at H,
                   foliage never below PLAY_MIN_FOLIAGE * H (matches the host's collision cylinder).
   Replaces      : 'trees'
   Hooks         : init (shared uniforms), onHole (build templates + instanced meshes into ctx.holeGroup),
                   update (time / wind uniforms only, no allocation).
   Cost          : 8 draw calls (one InstancedMesh per template, empty ones skipped), opaque single-sided
                   MeshLambertMaterial patched with onBeforeCompile (host lights + fog). Triangles: see report;
                   about 300 per in-play broadleaf, 180 per conifer, ~110 per woods tree at quality 1.
   --------------------------------------------------------------------------------------------------------- */
(function () {
  'use strict';

  /* ---------------- tunables ---------------- */
  var T = {
    PLAY_WIDTH: 0.96,        // widest canopy radius / r for trees in play (collision is r)
    PLAY_MIN_FOLIAGE: 0.32,  // lowest foliage / H for trees in play
    BG_WIDTH: 1.12,          // woods canopies a little wider than r so the border closes up
    BG_MIN_FOLIAGE: 0.2,
    AUTUMN_SHARE: 0.25,      // share of broadleaves in autumn colour
    TURNING_SHARE: 0.1,      // next band: half-turned olive-gold
    SPARSE_OF_AUTUMN: 0.3,   // share of autumn in-play broadleaves drawn as sparse late-autumn trees
    TRUNK: 0x5A4A3B, BIRCH: 0xC9BFAA,
    UNDER: 0x34573F,         // woods understorey (a touch darker than the woods floor #4C7550)
    WARM: [1.0, 0.78, 0.48], WARM_AMT: 0.2,   // sun-side warmth added to foliage
    COOL: [0.8, 0.9, 1.04],
    GLOW: [0.75, 0.6, 0.38],  // back-lit leaf translucency when looking toward the sun (x foliage colour)  // multiplier on the side away from the sun
    AO_LO: 0.66, AO_HI: 1.07, // foliage value from inner/under to outer/top
    SWAY_BASE: 0.07,         // yd of crown movement for a 20 yd tree in calm air
    SWAY_PER_MPH: 0.02,      // extra yd per mph
    SWAY_SPEED: 0.9,         // rad/s of the main sway
    GUST_SPEED: 0.22,        // rad/s of the gust envelope
    GUST_WAVELEN: 160,       // yd between gust fronts crossing the wood
    REDUCED: 0.25            // amplitude factor when ctx.reduced
  };

  var S = { uni: null, ready: false };
  window.DewFX = window.DewFX || [];

  /* ---------------- small helpers ---------------- */
  function hash3(x, y, z, s) {
    var v = Math.sin(Math.round(x * 1000) * 0.0127 + Math.round(y * 1000) * 0.0311 + Math.round(z * 1000) * 0.0193 + s * 17.17) * 43758.5453;
    return v - Math.floor(v);
  }
  function smooth(a, b, v) { var t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); }
  function norm(v) { var l = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; }

  /* geometry builder: kind 0 trunk, 1 leaf, 2 understorey, 3 branch */
  function newB() { return { p: [], n: [], k: [], t: [] }; }
  function vert(B, p, n, kind, tint) { B.p.push(p[0], p[1], p[2]); B.n.push(n[0], n[1], n[2]); B.k.push(kind); B.t.push(tint[0], tint[1], tint[2]); }
  function tri(B, a, b, c, hint, kind, tint) {         // flat-shaded triangle, wound to face along `hint`
    var u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    var n = norm([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]);
    if (n[0] * hint[0] + n[1] * hint[1] + n[2] * hint[2] < 0) { var s = b; b = c; c = s; n = [-n[0], -n[1], -n[2]]; }
    vert(B, a, n, kind, tint); vert(B, b, n, kind, tint); vert(B, c, n, kind, tint);
  }
  function hexRGB(h) { var c = new THREE.Color(h); return [c.r, c.g, c.b]; }

  /* tapered trunk / limb between two points: rings of `sides` vertices, optional base flare */
  function limb(B, a, b, r0, r1, sides, kind, tint, flare) {
    var d = norm([b[0] - a[0], b[1] - a[1], b[2] - a[2]]);
    var ax = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    var e1 = norm([d[1] * ax[2] - d[2] * ax[1], d[2] * ax[0] - d[0] * ax[2], d[0] * ax[1] - d[1] * ax[0]]);
    var e2 = [d[1] * e1[2] - d[2] * e1[1], d[2] * e1[0] - d[0] * e1[2], d[0] * e1[1] - d[1] * e1[0]];
    var rings = flare ? [[0, r0 * flare], [0.07, r0 * 1.12], [1, r1]] : [[0, r0], [1, r1]];
    var R = rings.map(function (q) {
      var c = [a[0] + (b[0] - a[0]) * q[0], a[1] + (b[1] - a[1]) * q[0], a[2] + (b[2] - a[2]) * q[0]], pts = [];
      for (var i = 0; i < sides; i++) {
        var t = (i / sides) * Math.PI * 2, cs = Math.cos(t) * q[1], sn = Math.sin(t) * q[1];
        pts.push([c[0] + e1[0] * cs + e2[0] * sn, c[1] + e1[1] * cs + e2[1] * sn, c[2] + e1[2] * cs + e2[2] * sn]);
      }
      return { c: c, pts: pts };
    });
    for (var j = 0; j < R.length - 1; j++) for (var i = 0; i < sides; i++) {
      var p0 = R[j].pts[i], p1 = R[j].pts[(i + 1) % sides], p2 = R[j + 1].pts[i], p3 = R[j + 1].pts[(i + 1) % sides];
      var mid = [(p0[0] + p3[0]) / 2 - (R[j].c[0] + R[j + 1].c[0]) / 2, 0, (p0[2] + p3[2]) / 2 - (R[j].c[2] + R[j + 1].c[2]) / 2];
      var h = [mid[0], (p0[1] + p3[1]) / 2 - (R[j].c[1] + R[j + 1].c[1]) / 2, mid[2]];
      tri(B, p0, p1, p2, h, kind, tint); tri(B, p1, p3, p2, h, kind, tint);
    }
  }

  /* merged lobes: unit polyhedron per lobe, jittered, triangles buried inside another lobe are dropped */
  var POLY = {};
  function poly(detail) {
    if (!POLY[detail]) {
      var g = detail === 'hi' ? new THREE.IcosahedronGeometry(1, 1) : new THREE.OctahedronGeometry(1, 1);
      POLY[detail] = Array.prototype.slice.call(g.attributes.position.array); g.dispose();
    }
    return POLY[detail];
  }
  function lobes(B, list, cc, detail, kind) {
    var src = poly(detail);
    function inside(p, skip) {
      for (var m = 0; m < list.length; m++) {
        if (m === skip) continue; var L = list[m];
        var dx = (p[0] - L.x) / L.rx, dy = (p[1] - L.y) / L.ry, dz = (p[2] - L.z) / L.rz;
        if (dx * dx + dy * dy + dz * dz < 0.86) return true;
      }
      return p[1] < -0.03;   // below the ground
    }
    list.forEach(function (L, li) {
      var vs = [];
      for (var k = 0; k < src.length; k += 3) {
        var ux = src[k], uy = src[k + 1], uz = src[k + 2], j = 1 + L.jit * (hash3(ux, uy, uz, L.seed) - 0.5);
        var fy = uy < 0 ? uy * 0.78 : uy;
        var p = [L.x + ux * L.rx * j, L.y + fy * L.ry * j, L.z + uz * L.rz * j];
        var ln = norm([ux / L.rx, fy / L.ry, uz / L.rz]), cd = norm([p[0] - cc[0], (p[1] - cc[1]) * 1.2, p[2] - cc[2]]);
        vs.push({ p: p, n: norm([ln[0] * 0.5 + cd[0] * 0.5, ln[1] * 0.5 + cd[1] * 0.5 + 0.08, ln[2] * 0.5 + cd[2] * 0.5]) });
      }
      for (var t = 0; t < vs.length; t += 3) {
        if (inside(vs[t].p, li) && inside(vs[t + 1].p, li) && inside(vs[t + 2].p, li)) continue;
        for (var q = 0; q < 3; q++) vert(B, vs[t + q].p, vs[t + q].n, kind, L.tint);
      }
    });
  }

  /* conifer: stacked, slightly drooping tiers */
  function tiers(B, rng, y0, top, n, sides, Rmax, tint) {
    var span = top - y0, step = span / (n + 0.35);
    for (var i = 0; i < n; i++) {
      var yB = y0 + i * step * 0.98, yT = i === n - 1 ? top : yB + step * 1.75;
      var R = Rmax * Math.pow(1 - (0.8 * i) / n, 0.95), rot = i * 2.39996 + rng() * 0.5;
      var apex = [0, yT, 0], under = [0, yB + (yT - yB) * 0.22, 0], r1 = [], r2 = [], tt = [tint[0] * (0.96 + 0.04 * i), tint[1] * (0.97 + 0.03 * i), tint[2]];
      for (var s = 0; s < sides; s++) {
        var a = rot + (s / sides) * Math.PI * 2, jr = 0.9 + rng() * 0.14, dr = (rng() - 0.5) * 0.06 * span;
        r1.push([Math.cos(a) * R * 0.5, yT - (yT - yB) * 0.44, Math.sin(a) * R * 0.5]);
        r2.push([Math.cos(a) * R * jr, yB + dr, Math.sin(a) * R * jr]);
      }
      for (s = 0; s < sides; s++) {
        var s1 = (s + 1) % sides, am = rot + ((s + 0.5) / sides) * Math.PI * 2, rad = [Math.cos(am), 0, Math.sin(am)];
        tri(B, apex, r1[s], r1[s1], [rad[0], 0.9, rad[2]], 1, tt);
        tri(B, r1[s], r2[s], r1[s1], [rad[0], 0.5, rad[2]], 1, tt);
        tri(B, r1[s1], r2[s], r2[s1], [rad[0], 0.5, rad[2]], 1, tt);
        tri(B, r2[s], r2[s1], under, [rad[0] * 0.3, -1, rad[2] * 0.3], 1, tt);
      }
    }
  }

  /* normalise a template: foliage width -> `width`, top -> 1, foliage no lower than minF; bake AO + sway */
  function finish(B, width, minF) {
    var P = B.p, N = B.n, K = B.k, nv = K.length, i, maxR = 0, top = 0;
    for (i = 0; i < nv; i++) {
      top = Math.max(top, P[i * 3 + 1]);
      if (K[i] === 1) maxR = Math.max(maxR, Math.hypot(P[i * 3], P[i * 3 + 2]));
    }
    var sx = width / maxR, sy = 1 / top, fMin = 1;
    for (i = 0; i < nv; i++) {
      P[i * 3] *= sx; P[i * 3 + 2] *= sx; P[i * 3 + 1] *= sy;
      var n = norm([N[i * 3] / sx, N[i * 3 + 1] / sy, N[i * 3 + 2] / sx]); N[i * 3] = n[0]; N[i * 3 + 1] = n[1]; N[i * 3 + 2] = n[2];
      if (K[i] === 1) fMin = Math.min(fMin, P[i * 3 + 1]);
    }
    if (fMin < minF) for (i = 0; i < nv; i++) if (K[i] === 1) P[i * 3 + 1] = minF + ((P[i * 3 + 1] - fMin) * (1 - minF)) / (1 - fMin);
    fMin = Math.max(fMin, minF);
    var info = new Float32Array(nv * 4);
    for (i = 0; i < nv; i++) {
      var x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2], k = K[i], yn = (y - fMin) / (1 - fMin), rd = Math.hypot(x, z) / width;
      var ao = k === 1 ? 0.12 + 0.55 * yn + 0.32 * rd + 0.14 * N[i * 3 + 1] : k === 2 ? 0.2 + 2.5 * y + 0.2 * N[i * 3 + 1] : 0.55 + 0.45 * Math.min(1, y / fMin);
      var sw = k === 1 || k === 3 ? Math.pow(smooth(fMin * 0.55, 1, y), 1.4) * (k === 3 ? 0.8 : 1) : 0;
      info[i * 4] = k === 1 || k === 2 ? 1 : 0; info[i * 4 + 1] = Math.min(1, Math.max(0, ao)); info[i * 4 + 2] = sw; info[i * 4 + 3] = k === 2 ? 1 : 0;
    }
    var g = new THREE.BufferGeometry();
    g.userData.nat = [Math.round(sx / sy / width * 100) / 100, Math.round(fMin * 100) / 100, nv / 3];
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('aInfo', new THREE.BufferAttribute(info, 4));
    g.setAttribute('aTint', new THREE.Float32BufferAttribute(B.t, 3));
    return g;
  }

  function lobeTint(rng) { var v = 0.88 + rng() * 0.22, w = rng(); return [v * (0.95 + w * 0.12), v, v * (1.04 - w * 0.12)]; }
  function L(rng, x, y, z, r, flat, jit) { return { x: x, y: y, z: z, rx: r, ry: r * flat, rz: r, jit: jit || 0.22, seed: rng() * 100, tint: lobeTint(rng) }; }

  /* ---------------- species templates (designed in r units, height A, then normalised) ---------------- */
  function ringLobes(rng, n, dist, dj, y, yj, r, rj, flat) {
    var out = [], a0 = rng() * 6.283;
    for (var i = 0; i < n; i++) {
      var a = a0 + (i / n) * 6.283 + (rng() - 0.5) * 0.7, d = dist + (rng() - 0.5) * 2 * dj;
      out.push(L(rng, Math.cos(a) * d, y + (rng() - 0.5) * 2 * yj, Math.sin(a) * d, r + (rng() - 0.5) * 2 * rj, flat));
    }
    return out;
  }
  function boughs(B, rng, base, list, r0, tint) {
    for (var i = 0; i < list.length; i++) { var o = list[i]; limb(B, base, [o.x * 0.75, o.y - o.ry * 0.3, o.z * 0.75], r0, r0 * 0.4, 4, 3, tint); }
  }
  var BUILD = {
    oak: function (rng, q) {
      var B = newB(), tr = hexRGB(T.TRUNK), ring = ringLobes(rng, q > 0 ? 5 : 4, 0.54, 0.08, 1.0, 0.09, 0.44, 0.07, 0.74);
      var all = [L(rng, 0, 1.15, 0, 0.6, 0.72)].concat(ring);
      if (q > 0) all.push(L(rng, (rng() - 0.5) * 0.4, 1.38, (rng() - 0.5) * 0.4, 0.36, 0.8));
      lobes(B, all, [0, 1.05, 0], q > 0 ? 'hi' : 'lo', 1);
      limb(B, [0, -0.05, 0], [0.03, 1.05, 0.02], 0.055, 0.03, q > 0 ? 6 : 5, 0, tr, 1.7);
      boughs(B, rng, [0, 0.72, 0], ring.slice(0, 3), 0.03, tr);
      return finish(B, T.PLAY_WIDTH, T.PLAY_MIN_FOLIAGE);
    },
    maple: function (rng, q) {
      var B = newB(), tr = hexRGB(T.TRUNK), ring = ringLobes(rng, q > 0 ? 5 : 4, 0.46, 0.07, 1.24, 0.12, 0.47, 0.06, 0.9);
      var all = [L(rng, 0, 1.42, 0, 0.56, 0.95), L(rng, (rng() - 0.5) * 0.3, 1.62, (rng() - 0.5) * 0.3, 0.38, 0.95)].concat(ring);
      lobes(B, all, [0, 1.35, 0], q > 0 ? 'hi' : 'lo', 1);
      limb(B, [0, -0.05, 0], [0, 1.3, 0], 0.05, 0.026, q > 0 ? 6 : 5, 0, tr, 1.6);
      boughs(B, rng, [0, 0.95, 0], ring.slice(0, 2), 0.026, tr);
      return finish(B, T.PLAY_WIDTH, T.PLAY_MIN_FOLIAGE);
    },
    poplar: function (rng, q) {   // tall birch-poplar, pale trunk
      var B = newB(), a = rng() * 6.283;
      var all = [L(rng, Math.cos(a) * 0.12, 1.02, Math.sin(a) * 0.12, 0.8, 0.95), L(rng, -Math.cos(a) * 0.12, 1.5, -Math.sin(a) * 0.12, 0.7, 1.0),
        L(rng, Math.cos(a + 1.6) * 0.08, 1.88, Math.sin(a + 1.6) * 0.08, 0.44, 1.1)];
      lobes(B, all, [0, 1.65, 0], q > 0 ? 'hi' : 'lo', 1);
      limb(B, [0, -0.05, 0], [0.02, 2.2, 0], 0.042, 0.02, 5, 0, hexRGB(T.BIRCH), 1.45);
      return finish(B, T.PLAY_WIDTH, T.PLAY_MIN_FOLIAGE);
    },
    sparse: function (rng, q) {   // the odd late-autumn tree: thin crown of small tufts on bare limbs
      var B = newB(), tr = hexRGB(T.TRUNK), all = [], n = 8;
      for (var i = 0; i < n; i++) {
        var a = (i / n) * 6.283 + rng() * 0.5, d = 0.42 + rng() * 0.4, up = i % 2 ? 0.3 : 0;
        all.push(L(rng, Math.cos(a) * d, 0.98 + up + rng() * 0.3, Math.sin(a) * d, 0.17 + rng() * 0.08, 0.7, 0.45));
      }
      all.push(L(rng, 0.05, 1.55, -0.05, 0.22, 0.8, 0.4));
      lobes(B, all, [0, 1.2, 0], 'lo', 1);
      limb(B, [0, -0.05, 0], [0.02, 1.2, 0.01], 0.05, 0.024, 5, 0, tr, 1.6);
      for (i = 0; i < all.length; i++) limb(B, [0, 0.6 + 0.06 * i, 0], [all[i].x * 0.9, all[i].y - 0.05, all[i].z * 0.9], 0.022, 0.008, 3, 3, tr);
      return finish(B, T.PLAY_WIDTH, T.PLAY_MIN_FOLIAGE);
    },
    conifer: function (rng, q) {
      var B = newB();
      tiers(B, rng, 0.64, 2.0, q > 0 ? 5 : 4, q > 0 ? 8 : 7, 1, [1, 1, 1]);
      limb(B, [0, -0.05, 0], [0, 1.2, 0], 0.05, 0.02, 5, 0, hexRGB(T.TRUNK), 1.5);
      return finish(B, T.PLAY_WIDTH, T.PLAY_MIN_FOLIAGE);
    },
    /* woods: cheaper, with a dark understorey skirt */
    bgBroad: function (rng, q) {
      var B = newB(), ring = ringLobes(rng, q > 0 ? 3 : 2, 0.5, 0.06, 1.05, 0.12, 0.52, 0.05, 0.85);
      lobes(B, [L(rng, 0, 1.32, 0, 0.62, 0.85)].concat(ring), [0, 1.15, 0], 'lo', 1);
      lobes(B, [L(rng, 0.15, 0.08, -0.1, 1.05, 0.3, 0.3)], [0, 0, 0], 'lo', 2);
      limb(B, [0, -0.05, 0], [0, 1.0, 0], 0.05, 0.03, 4, 0, hexRGB(T.TRUNK));
      return finish(B, T.BG_WIDTH, T.BG_MIN_FOLIAGE);
    },
    bgTall: function (rng, q) {
      var B = newB();
      lobes(B, [L(rng, 0.1, 1.05, 0, 0.66, 1.05), L(rng, -0.08, 1.55, 0.06, 0.56, 1.1), L(rng, 0, 1.95, 0, 0.36, 1.2)], [0, 1.5, 0], 'lo', 1);
      lobes(B, [L(rng, -0.1, 0.06, 0.1, 0.8, 0.32, 0.3)], [0, 0, 0], 'lo', 2);
      limb(B, [0, -0.05, 0], [0, 2.0, 0], 0.045, 0.02, 4, 0, hexRGB(T.BIRCH));
      return finish(B, 0.8, T.BG_MIN_FOLIAGE);
    },
    bgConifer: function (rng, q) {
      var B = newB();
      tiers(B, rng, 0.42, 2.0, 3, 6, 1, [1, 1, 1]);
      lobes(B, [L(rng, 0, 0.06, 0, 0.95, 0.3, 0.3)], [0, 0, 0], 'lo', 2);
      limb(B, [0, -0.05, 0], [0, 0.8, 0], 0.05, 0.03, 4, 0, hexRGB(T.TRUNK));
      return finish(B, 1.02, 0.18);
    }
  };
  var ORDER = ['oak', 'maple', 'poplar', 'sparse', 'conifer', 'bgBroad', 'bgTall', 'bgConifer'];

  /* ---------------- material ---------------- */
  function makeMaterial() {
    var m = new THREE.MeshLambertMaterial({ color: 0xffffff });
    m.onBeforeCompile = function (sh) {
      var u = S.uni;
      for (var k in u) sh.uniforms[k] = u[k];
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', [
          '#include <common>',
          'attribute vec4 aInfo; attribute vec3 aTint;',
          'uniform float uTime, uAmp, uGustK; uniform vec3 uWind, uSun, uWarm, uCool, uUnder, uGlow;'].join('\n'))
        .replace('#include <color_vertex>', '')
        .replace('#include <defaultnormal_vertex>', [
          '#include <defaultnormal_vertex>',
          'vec3 wn = vec3(0.0, 1.0, 0.0);',
          '#ifdef USE_INSTANCING_COLOR',
          '{ mat3 im = mat3(instanceMatrix);',
          '  wn = normalize(im * (normal / vec3(dot(im[0], im[0]), dot(im[1], im[1]), dot(im[2], im[2]))));',
          '  float sf = dot(wn, uSun), ao = aInfo.y;',
          '  vec3 lc = instanceColor * aTint * mix(' + T.AO_LO.toFixed(3) + ', ' + T.AO_HI.toFixed(3) + ', ao);',
          '  lc *= mix(uCool, vec3(1.0), smoothstep(-0.4, 0.5, sf));',
          '  lc += uWarm * (pow(max(sf, 0.0), 1.5) * (0.35 + 0.65 * ao));',
          '  vec3 tc = aTint * (0.6 + 0.4 * ao) * mix(vec3(0.9, 0.95, 1.05), vec3(1.08, 1.0, 0.9), smoothstep(-0.3, 0.6, sf));',
          '  vec3 uc = uUnder * (0.7 + 0.4 * ao);',
          '  vColor = mix(mix(tc, lc, aInfo.x), uc, aInfo.w); }',
          '#endif'].join('\n'))
        .replace('#include <project_vertex>', [
          'vec4 mvPosition = vec4(transformed, 1.0);',
          '#ifdef USE_INSTANCING',
          'mvPosition = instanceMatrix * mvPosition;',
          '{ vec3 root = instanceMatrix[3].xyz; float hs = length(instanceMatrix[1].xyz) / 20.0;',
          '  float along = dot(root.xz, uWind.xz), w = aInfo.z * uAmp * hs;',
          '  float gust = 0.55 + 0.45 * sin(uTime * ' + T.GUST_SPEED.toFixed(3) + ' - along * uGustK);',
          '  float s1 = sin(uTime * ' + T.SWAY_SPEED.toFixed(3) + ' - along * 0.045 + root.x * 0.013);',
          '  float s2 = sin(uTime * ' + (T.SWAY_SPEED * 0.73).toFixed(3) + ' + root.z * 0.021 + 1.7);',
          '  float fl = sin(uTime * 1.9 + mvPosition.x * 0.55 + mvPosition.z * 0.45 + mvPosition.y * 0.3);',
          '  vec2 side = vec2(-uWind.z, uWind.x);',
          '  mvPosition.xz += (uWind.xz * (0.45 + 0.55 * s1) * gust + side * 0.35 * s2 + vec2(0.18 * fl)) * w;',
          '  mvPosition.y -= abs(s1) * 0.08 * w; }',
          '#ifdef USE_INSTANCING_COLOR',
          '{ vec3 vd = normalize((modelMatrix * mvPosition).xyz - cameraPosition);',
          '  float back = pow(max(dot(vd, uSun), 0.0), 2.5), rim = 1.0 - abs(dot(wn, vd));',
          '  vColor += instanceColor * uGlow * (back * (0.25 + 0.75 * rim) * aInfo.x * (1.0 - aInfo.w) * (0.4 + 0.6 * aInfo.y)); }',
          '#endif',
          '#endif',
          'mvPosition = modelViewMatrix * mvPosition;',
          'gl_Position = projectionMatrix * mvPosition;'].join('\n'));
    };
    return m;
  }

  /* ---------------- colour ---------------- */
  var AUTUMN = [0xC98A32, 0xB5572C, 0xD8A63C, 0xA94A2B, 0xCF7A2E];
  function field(x, y, s) {   // smooth position noise, roughly -1..1
    return 0.5 * Math.sin(x * 0.019 + s) * Math.sin(y * 0.016 + s * 1.7) + 0.3 * Math.sin((x + y) * 0.031 + s * 2.3) + 0.25 * Math.sin((x - 0.6 * y) * 0.012 + s * 0.6);
  }
  function fr(v) { return v - Math.floor(v); }

  window.DewFX.push({
    name: 'trees',
    replaces: ['trees'],
    init: function (ctx) {
      var V3 = ctx.THREE.Vector3;
      S.uni = {
        uTime: { value: 0 }, uAmp: { value: T.SWAY_BASE }, uGustK: { value: 6.283 / T.GUST_WAVELEN },
        uWind: { value: new V3(0, 0, -1) }, uSun: { value: (ctx.sunDir || new V3(0.6, 0.26, -0.75)).clone().normalize() },
        uWarm: { value: new V3(T.WARM[0] * T.WARM_AMT, T.WARM[1] * T.WARM_AMT, T.WARM[2] * T.WARM_AMT) },
        uCool: { value: new V3(T.COOL[0], T.COOL[1], T.COOL[2]) },
        uUnder: { value: new V3().fromArray(hexRGB(T.UNDER)) },
        uGlow: { value: new V3(T.GLOW[0], T.GLOW[1], T.GLOW[2]) }
      };
      S.ready = true;
    },
    onHole: function (ctx, hole) {
      if (!S.ready) return;
      var C = ctx.C, q = ctx.quality === 0 ? 0 : 1, trees = ctx.trees || [], seedS = C.hashStr('dew-trees|' + hole.yards);
      var wl = Math.hypot(ctx.wind.x, ctx.wind.y) || 1;
      S.uni.uWind.value.set(ctx.wind.x / wl, 0, -ctx.wind.y / wl);
      S.uni.uAmp.value = (T.SWAY_BASE + T.SWAY_PER_MPH * (ctx.wind.mph || 0)) * (ctx.reduced ? T.REDUCED : 1);

      /* autumn: rank broadleaves by clustered noise (+ a little tone), take the top share */
      var fs = (seedS % 1000) / 159.0, score = [], i, t;
      for (i = 0; i < trees.length; i++) { t = trees[i]; score.push(t.kind ? -9 : field(t.x, t.y, fs) + 0.35 * (t.tone - 0.5)); }
      var sorted = score.filter(function (v) { return v > -9; }).sort(function (a, b) { return b - a; });
      var thA = sorted.length ? sorted[Math.floor(sorted.length * T.AUTUMN_SHARE)] : 9, thT = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * (T.AUTUMN_SHARE + T.TURNING_SHARE)))] : 9;

      /* classify */
      var groups = {}, col = new THREE.Color(), c2 = new THREE.Color();
      ORDER.forEach(function (k) { groups[k] = []; });
      for (i = 0; i < trees.length; i++) {
        t = trees[i];
        var asp = t.H / t.r, h2 = fr(t.tone * 13.37 + 0.31), autumn = !t.kind && score[i] > thA, turning = !t.kind && !autumn && score[i] > thT, key;
        if (t.play) key = t.kind ? 'conifer' : autumn && h2 < T.SPARSE_OF_AUTUMN ? 'sparse' : asp < 1.68 ? 'oak' : asp < 1.93 ? 'maple' : 'poplar';
        else key = t.kind ? 'bgConifer' : asp > 1.98 || h2 < 0.18 ? 'bgTall' : 'bgBroad';
        /* colour */
        var n2 = field(t.x * 1.7 + 40, t.y * 1.7 - 25, fs + 3.1);
        if (t.kind) col.setHSL(0.41 + 0.03 * n2 + (t.tone - 0.5) * 0.03, 0.27 + 0.05 * t.tone, 0.2 + 0.06 * fr(t.tone * 5.1) - (t.play ? 0 : 0.015));
        else {
          col.setHSL(0.27 + 0.05 * n2 + (t.tone - 0.5) * 0.045 + (key === 'poplar' || key === 'bgTall' ? -0.025 : 0), 0.34 + 0.07 * fr(t.tone * 3.7), 0.29 + 0.08 * fr(t.tone * 7.9) + (key === 'poplar' || key === 'bgTall' ? 0.03 : 0) - (t.play ? 0 : 0.02));
          if (autumn || turning) {
            var ai = Math.floor(fr(n2 * 0.9 + t.tone * 0.45 + 0.5) * AUTUMN.length) % AUTUMN.length;
            c2.setHex(AUTUMN[ai]).multiplyScalar(0.84 + 0.2 * fr(t.tone * 11.3));
            if (key === 'poplar' || key === 'bgTall') c2.setHex(0xD8A63C).multiplyScalar(0.88 + 0.12 * t.tone);
            col.lerp(c2, autumn ? 1 : 0.35 + 0.25 * fr(t.tone * 4.4));
          }
        }
        groups[key].push({ t: t, c: col.clone() });
      }

      /* build */
      var dummy = new THREE.Object3D(), tris = 0, calls = 0, mat = makeMaterial();
      ORDER.forEach(function (key) {
        var list = groups[key];
        if (!list.length) return;
        var geo = BUILD[key](C.makeRng(C.hashStr('dew-tree-' + key + '|' + hole.yards)), q);
        var im = new THREE.InstancedMesh(geo, mat, list.length);
        list.forEach(function (e, j) {
          var tt = e.t, sq = 0.9 + 0.1 * fr(tt.tone * 7.7);
          ctx.P(dummy.position, tt.x, tt.y, tt.z - 0.3);
          dummy.rotation.set(0, fr(tt.tone * 91.7) * 6.283, 0);
          dummy.scale.set(tt.r, tt.H + 0.3, tt.r * sq);
          dummy.updateMatrix();
          im.setMatrixAt(j, dummy.matrix); im.setColorAt(j, e.c);
        });
        im.instanceMatrix.needsUpdate = true; if (im.instanceColor) im.instanceColor.needsUpdate = true;
        im.frustumCulled = false; im.name = 'trees-' + key;
        ctx.holeGroup.add(im);
        tris += (geo.attributes.position.count / 3) * list.length; calls++; S.nat = S.nat || {}; S.nat[key] = geo.userData.nat.concat([list.length]);
      });
      S.stats = { calls: calls, tris: tris, n: trees.length };
      window.__dewTreeStats = S.stats; S.stats.nat = S.nat; S.nat = null;
    },
    update: function (ctx, dt) {
      if (!S.uni) return;
      S.uni.uTime.value = ctx.time || 0;
    }
  });
})();
