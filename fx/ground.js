/* Dewsweeper 3D — fx/ground.js : the ground at first light.

   What it draws
     - paintTerrain: crisp detail painted into the host's colour map (world units, seeded per hole):
         dappled woods floor with leaf litter, a darker first cut hugging each fairway with a soft feathered edge,
         re-laid mowing stripes, a worn tee with divots, a lighter collar and clean-up ring round the green,
         damp dark pond margins, bunkers with a grass lip, a sun-side shaded face and faint rake lines,
         drifts of fallen leaves under and downwind of the in-play trees (autumn trees drop their own colour).
     - terrainMaterial: the host's MeshLambertMaterial (same lights, same fog chunks) patched in onBeforeCompile:
         * a small per-hole surface mask (DataTexture, <=256x512) = green / fairway / sand weights + hollow depth,
         * fine grass grain and soft tonal mottling from a 128x128 tiling noise texture sampled in world yards,
           different per surface (velvet green, combed fairway, clumpy rough, rippled sand),
           faded by on-screen footprint so nothing shimmers at distance,
         * cooler tone in hollows, faint warm dew sheen at grazing angles looking toward the low sun.
   Replaces: nothing (only the ground material and extra paint, through the two ground hooks).
   Hooks: init (noise texture), paintTerrain, terrainMaterial, onHole (no-op), update (pixel-footprint uniform).
   Cost: 0 extra draw calls, 0 extra triangles. Fragment: 4 texture taps (map, mask, noise x2) + a sin.
         Per hole: one 256x512 RGBA DataTexture (disposed by this module on the next hole), ~40k Core.heightAt
         calls for the hollow bake (coarse 64x128 grid), a few thousand small canvas fills.
*/
(function () {
  'use strict';

  /* ---------------- tunables ---------------- */
  var T = {
    grainRough: 0.24,     // albedo amplitude of the rough's clumpy grain near the camera
    grainFairway: 0.11,  // fairway combed grain
    grainGreen: 0.12,    // green velvet
    grainSand: 0.10,      // sand granules + ripples
    mottle: 0.07,         // soft tonal mottling (all surfaces, fades by ~250 yd)
    grainTile: 5.0,       // yards per repeat of the fine noise (small = finer grass)
    mottleTile: 46.0,     // yards per repeat of the mottle noise
    hollowCool: 0.55,     // how much hollows shift toward cool blue-green
    sheen: 0.16,          // warm dew sheen toward the sun at grazing angles
    firstCut: 3.2,        // yards of darker first cut each side of the fairway
    leavesPerTree: 70,    // fallen leaves per in-play autumn tree (green trees drop ~25%)
    maskW: 256            // surface mask width in texels (height 2x for tall holes)
  };

  var S = { noise: null, mask: null, maskData: null, uniforms: null, sun: null, mat: null };
  var AUTUMN = ['#C98A32', '#B5572C', '#D8A63C', '#A94A2B', '#CF7A2E'];

  /* ---------- tiling noise: R fine hash (lightly smoothed), G value noise 8px cells, B 32px cells, A another fine ---------- */
  function makeNoise(THREE) {
    var N = 128, d = new Uint8Array(N * N * 4), i, x, y;
    var rnd = (function (s) { return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })(91731);
    var h1 = new Float32Array(N * N), h2 = new Float32Array(N * N);
    for (i = 0; i < N * N; i++) { h1[i] = rnd(); h2[i] = rnd(); }
    function lattice(cell, seed) {
      var n = N / cell, L = new Float32Array(n * n), r = (function (s) { return function () { s = (s * 22695477 + 1) >>> 0; return s / 4294967296; }; })(seed);
      for (var k = 0; k < n * n; k++) L[k] = r();
      return function (px, py) {
        var fx = px / cell, fy = py / cell, ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
        tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
        var a = L[(iy % n) * n + ix % n], b = L[(iy % n) * n + (ix + 1) % n], c = L[((iy + 1) % n) * n + ix % n], e = L[((iy + 1) % n) * n + (ix + 1) % n];
        return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
      };
    }
    var vA = lattice(8, 777), vA2 = lattice(4, 31), vB = lattice(32, 4242), vB2 = lattice(16, 99);
    for (y = 0; y < N; y++) for (x = 0; x < N; x++) {
      var s = 0, s2 = 0;
      for (var oy = -1; oy <= 1; oy++) for (var ox = -1; ox <= 1; ox++) {
        var w = (ox === 0 && oy === 0) ? 4 : (ox === 0 || oy === 0) ? 2 : 1, q = ((y + oy + N) % N) * N + (x + ox + N) % N;
        s += h1[q] * w; s2 += h2[q] * w;
      }
      s /= 16; s2 /= 16;
      i = (y * N + x) * 4;
      d[i] = Math.max(0, Math.min(255, (0.5 + (s - 0.5) * 3.4) * 255));
      d[i + 1] = (vA(x, y) * 0.65 + vA2(x, y) * 0.35) * 255;
      d[i + 2] = (vB(x, y) * 0.65 + vB2(x, y) * 0.35) * 255;
      d[i + 3] = Math.max(0, Math.min(255, (0.5 + (s2 - 0.5) * 3.4) * 255));
    }
    var t = new THREE.DataTexture(d, N, N, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true; t.needsUpdate = true;
    return t;
  }

  /* ---------- per-hole surface mask: R green(+collar half), G fairway/tee, B sand, A hollow (128 = level) ---------- */
  function bakeMask(ctx, h, info) {
    var THREE = ctx.THREE, C = ctx.C, ext = info.ext;
    var tall = (ext.y1 - ext.y0) / (ext.x1 - ext.x0) > 1.5, W = T.maskW, H = tall ? W * 2 : W;
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var g = cv.getContext('2d'), sx = W / (ext.x1 - ext.x0), sy = H / (ext.y1 - ext.y0);
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.setTransform(sx, 0, 0, -sy, -ext.x0 * sx, ext.y1 * sy);
    var circ = function (list, pad) { g.beginPath(); for (var k = 0; k < list.length; k++) { var c = list[k]; g.moveTo(c.x + c.r + pad, c.y); g.arc(c.x, c.y, c.r + pad, 0, 6.283); } };
    g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = '#00ff00';
    h.fairways.forEach(function (f) { g.beginPath(); f.pts.forEach(function (p, i) { if (i) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }); g.lineWidth = f.hw * 2; g.stroke(); });
    g.fillStyle = '#00ff00'; g.fillRect(h.tee.x - 6, h.tee.y - 6, 12, 12);
    circ(h.green, h.fringeW); g.fillStyle = '#808000'; g.fill();
    h.water.forEach(function (w) { circ(w, 0.6); g.fillStyle = '#000'; g.fill(); });
    h.bunkers.forEach(function (k) { circ(k, 0); g.fillStyle = '#0000ff'; g.fill(); });
    circ(h.green, 0); g.fillStyle = '#ff0000'; g.fill();
    var img = g.getImageData(0, 0, W, H).data;
    /* hollows: height minus the mean of a ring 9 yd round, on a coarse grid, bilinear up */
    var GW = 64, GH = tall ? 128 : 64, cav = new Float32Array((GW + 1) * (GH + 1)), R = 9, x, y, i, j;
    for (j = 0; j <= GH; j++) for (i = 0; i <= GW; i++) {
      x = ext.x0 + (ext.x1 - ext.x0) * i / GW; y = ext.y0 + (ext.y1 - ext.y0) * j / GH;
      var z = ctx.meshH(h, x, y), m = (ctx.meshH(h, x + R, y) + ctx.meshH(h, x - R, y) + ctx.meshH(h, x, y + R) + ctx.meshH(h, x, y - R)) * 0.25;
      cav[j * (GW + 1) + i] = z - m;
    }
    var out = S.maskData && S.maskData.length === W * H * 4 ? S.maskData : new Uint8Array(W * H * 4);
    for (var r = 0; r < H; r++) {
      var srcRow = H - 1 - r;                       // DataTexture row 0 = south (v = 0)
      var gy = (r + 0.5) / H * GH, j0 = Math.min(GH - 1, Math.floor(gy)), ty = gy - j0;
      for (var c = 0; c < W; c++) {
        var o = (r * W + c) * 4, s = (srcRow * W + c) * 4;
        out[o] = img[s]; out[o + 1] = img[s + 1]; out[o + 2] = img[s + 2];
        var gx = (c + 0.5) / W * GW, i0 = Math.min(GW - 1, Math.floor(gx)), tx = gx - i0;
        var a = cav[j0 * (GW + 1) + i0], b = cav[j0 * (GW + 1) + i0 + 1], cc = cav[(j0 + 1) * (GW + 1) + i0], d = cav[(j0 + 1) * (GW + 1) + i0 + 1];
        var v = (a + (b - a) * tx) * (1 - ty) + (cc + (d - cc) * tx) * ty;
        out[o + 3] = Math.max(0, Math.min(255, 128 + v * 60));
      }
    }
    S.maskData = out;
    if (S.mask) S.mask.dispose();
    var t = new THREE.DataTexture(out, W, H, THREE.RGBAFormat);
    t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true; t.needsUpdate = true;
    S.mask = t;
  }

  /* ---------- paint ---------- */
  function paint(ctx, h, g, info) {
    var C = ctx.C, ext = info.ext, b = h.bounds, sunH = ctx.sunH, circ = info.circ;
    var rng = C.makeRng(C.hashStr('ground-paint|' + h.yards + '|' + h.par));
    var inPlayTurf = function (x, y) { var t = C.terrainAt(h, x, y); return t !== C.T.GREEN && t !== C.T.SAND && t !== C.T.WATER; };
    var i, k, x, y;
    g.lineCap = 'round'; g.lineJoin = 'round';

    /* woods floor: dappled light and shade, then leaf litter, outside the playing area */
    g.save(); g.beginPath(); g.rect(ext.x0, ext.y0, ext.x1 - ext.x0, ext.y1 - ext.y0); g.rect(b.x0 - 2, b.y0 - 2, b.x1 - b.x0 + 4, b.y1 - b.y0 + 4); g.clip('evenodd');
    for (i = 0; i < 700; i++) {
      x = rng.range(ext.x0, ext.x1); y = rng.range(ext.y0, ext.y1);
      g.fillStyle = rng.chance(0.55) ? 'rgba(28,52,38,0.13)' : 'rgba(150,160,95,0.10)';
      g.beginPath(); g.ellipse(x, y, rng.range(1.5, 6), rng.range(1.2, 4), rng.range(0, 3.14), 0, 6.283); g.fill();
    }
    for (i = 0; i < 3200; i++) {
      x = rng.range(ext.x0, ext.x1); y = rng.range(ext.y0, ext.y1);
      g.globalAlpha = rng.range(0.25, 0.55); g.fillStyle = rng.chance(0.3) ? '#8A7A4A' : rng.pick(AUTUMN);
      g.beginPath(); g.ellipse(x, y, rng.range(0.3, 0.7), rng.range(0.18, 0.35), rng.range(0, 3.14), 0, 6.283); g.fill();
    }
    g.globalAlpha = 1; g.restore();

    /* rough: soft long patches, then a darker first cut and the feathered fairway, re-mown */
    g.save(); g.beginPath(); g.rect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0); g.clip();
    for (i = 0; i < 260; i++) {
      x = rng.range(b.x0, b.x1); y = rng.range(b.y0, b.y1);
      g.fillStyle = rng.chance(0.5) ? 'rgba(40,78,48,0.07)' : 'rgba(200,215,140,0.05)';
      g.beginPath(); g.ellipse(x, y, rng.range(3, 12), rng.range(2, 6), rng.range(0, 3.14), 0, 6.283); g.fill();
    }
    g.restore();
    var stroke = function (f, w, style) { g.beginPath(); f.pts.forEach(function (p, j) { if (j) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }); g.lineWidth = w; g.strokeStyle = style; g.stroke(); };
    h.fairways.forEach(function (f) {
      stroke(f, f.hw * 2 + T.firstCut * 2 + 1.2, 'rgba(98,140,86,0.55)');
      stroke(f, f.hw * 2 + T.firstCut * 2, '#658F59');
      stroke(f, f.hw * 2 + 1.6, 'rgba(134,180,109,0.45)');
      stroke(f, f.hw * 2 + 0.8, 'rgba(146,192,116,0.6)');
    });
    var st = document.createElement('canvas'); st.width = 32; st.height = 2; var sq = st.getContext('2d');
    sq.fillStyle = '#A8D284'; sq.fillRect(0, 0, 32, 2); sq.fillStyle = '#9BC878'; sq.fillRect(0, 0, 16, 2);
    sq.fillStyle = 'rgba(120,170,100,0.10)'; sq.fillRect(15, 0, 2, 2); sq.fillRect(0, 0, 1, 2); sq.fillRect(31, 0, 1, 2);
    var pat = g.createPattern(st, 'repeat');
    if (pat.setTransform && window.DOMMatrix) pat.setTransform(new DOMMatrix([0.5, 0, 0, 1, 0, 0]));   // 16 yd period, 8 yd stripes
    h.fairways.forEach(function (f) { stroke(f, f.hw * 2, pat); });
    /* faint mower overlap lines and cross-cut tone so the stripes read as mown, not painted */
    h.fairways.forEach(function (f) {
      g.save(); g.beginPath(); f.pts.forEach(function (p, j) { if (j) g.lineTo(p.x, p.y); else g.moveTo(p.x, p.y); }); g.lineWidth = f.hw * 2; g.strokeStyle = '#000';
      for (k = 0; k < 40; k++) {
        var p = f.pts[rng.int(0, f.pts.length - 1)]; x = p.x + rng.range(-f.hw, f.hw); y = p.y + rng.range(-40, 40);
        g.fillStyle = rng.chance(0.5) ? 'rgba(255,250,210,0.05)' : 'rgba(40,90,50,0.05)';
        g.beginPath(); g.ellipse(x, y, rng.range(4, 10), rng.range(3, 7), 0, 0, 6.283); g.fill();
      }
      g.restore();
    });

    /* tee: neat box, worn and divoted where everyone stands */
    var tx = h.tee.x, ty = h.tee.y;
    g.fillStyle = '#A6D083'; g.fillRect(tx - 6, ty - 6, 12, 12);
    g.strokeStyle = 'rgba(70,110,60,0.35)'; g.lineWidth = 0.3; g.strokeRect(tx - 6, ty - 6, 12, 12);
    for (i = 0; i < 26; i++) { g.fillStyle = 'rgba(176,184,120,0.10)'; g.beginPath(); g.ellipse(tx + rng.range(-3, 3), ty + rng.range(-2.5, 1.5), rng.range(1.2, 2.6), rng.range(0.9, 1.8), rng.range(0, 3), 0, 6.283); g.fill(); }

    /* ponds: damp dark margins, a muddy line at the water, the bed */
    h.water.forEach(function (w) { circ(w, 5); g.fillStyle = 'rgba(60,96,62,0.18)'; g.fill(); circ(w, 3.4); g.fillStyle = 'rgba(56,90,60,0.25)'; g.fill(); });
    h.water.forEach(function (w) { circ(w, 2.0); g.fillStyle = '#6A8C5E'; g.fill(); circ(w, 1.2); g.fillStyle = '#6E7D58'; g.fill(); });
    h.water.forEach(function (w) { circ(w, 0.6); g.fillStyle = '#5A8EA6'; g.fill(); });

    /* green: lighter collar, a slightly darker clean-up ring, then the checked surface (host's checks repainted) */
    circ(h.green, h.fringeW + 0.6); g.fillStyle = 'rgba(150,196,120,0.6)'; g.fill();
    circ(h.green, h.fringeW); g.fillStyle = '#A9D486'; g.fill();
    var ck = document.createElement('canvas'); ck.width = ck.height = 6; var cq = ck.getContext('2d');
    cq.fillStyle = '#B4DE90'; cq.fillRect(0, 0, 6, 6); cq.fillStyle = '#BCE499'; cq.fillRect(0, 0, 3, 3); cq.fillRect(3, 3, 3, 3);
    circ(h.green, 0.25); g.fillStyle = '#A4CF83'; g.fill();
    circ(h.green, -0.3); g.fillStyle = g.createPattern(ck, 'repeat'); g.fill();

    /* bunkers: grass lip, shaded face on the sun side, lit far face, faint rake lines */
    h.bunkers.forEach(function (bk, bi) {
      circ(bk, 1.3); g.fillStyle = '#76A465'; g.fill();
      circ(bk, 0.5); g.fillStyle = '#6C9A5E'; g.fill();
      g.save(); circ(bk, 0); g.clip();
      g.fillStyle = '#C9C2A0'; g.fillRect(ext.x0, ext.y0, ext.x1 - ext.x0, ext.y1 - ext.y0);
      var sh = function (d, col) { g.beginPath(); bk.forEach(function (c) { var cx = c.x - sunH.x * d, cy = c.y - sunH.y * d; g.moveTo(cx + c.r, cy); g.arc(cx, cy, c.r, 0, 6.283); }); g.fillStyle = col; g.fill(); };
      sh(0.5, '#D9D1AD'); sh(1.2, '#E4DBB6'); sh(2.0, '#EDE3BE');
      circ(bk, -2.6); g.fillStyle = 'rgba(255,250,228,0.28)'; g.fill();
      var a = rng.range(0, 3.14), dx = Math.cos(a), dy = Math.sin(a), c0 = bk[0], span = 0;
      bk.forEach(function (c) { span = Math.max(span, Math.hypot(c.x - c0.x, c.y - c0.y) + c.r); });
      g.strokeStyle = 'rgba(150,135,95,0.13)'; g.lineWidth = 0.22;
      for (var o = -span; o <= span; o += 0.85) {
        g.beginPath();
        for (var s = -span; s <= span; s += 2) { var wob = Math.sin(s * 0.35 + bi * 1.7 + o * 0.2) * 0.25; x = c0.x + dx * s - dy * (o + wob); y = c0.y + dy * s + dx * (o + wob); if (s === -span) g.moveTo(x, y); else g.lineTo(x, y); }
        g.stroke();
      }
      g.restore();
    });

    /* fallen leaves: under each in-play tree, drifting downwind; autumn trees drop their own colour */
    var wx = h.wind.x || 0, wy = h.wind.y || 0, wm = Math.min(1, (h.wind.mph || 0) / 10);
    for (i = 0; i < h.trees.length; i++) {
      var t = h.trees[i], f = (t.tone * 7.31) % 1, autumn = !t.kind && f < 0.24;
      var own = autumn ? AUTUMN[Math.floor(f / 0.24 * AUTUMN.length) % AUTUMN.length] : null;
      var n = Math.round(T.leavesPerTree * (autumn ? 1 : t.kind ? 0.12 : 0.28));
      for (k = 0; k < n; k++) {
        var drift = rng() * rng() * (0.6 + wm * 1.6) * t.r * 1.6, ang = rng.range(0, 6.283), rr = Math.sqrt(rng()) * t.r * 1.05;
        x = t.x + Math.cos(ang) * rr + wx * drift + rng.range(-1, 1); y = t.y + Math.sin(ang) * rr + wy * drift + rng.range(-1, 1);
        if (!inPlayTurf(x, y)) continue;
        g.globalAlpha = rng.range(0.55, 0.85);
        g.fillStyle = own && rng.chance(0.7) ? own : rng.chance(0.25) ? '#9A8452' : rng.pick(AUTUMN);
        g.beginPath(); g.ellipse(x, y, rng.range(0.22, 0.42), rng.range(0.12, 0.22), rng.range(0, 3.14), 0, 6.283); g.fill();
      }
    }
    g.globalAlpha = 1;
  }

  /* ---------- material: the host's Lambert, patched ---------- */
  var VERT_PARS = 'varying vec3 vGW;\nvarying vec3 vGN;\n';
  var VERT_MAIN = [
    '#include <project_vertex>',
    'vGW = (modelMatrix * vec4(transformed, 1.0)).xyz;',
    'vGN = normalize(mat3(modelMatrix) * objectNormal);'].join('\n');
  var FRAG_PARS = [
    'varying vec3 vGW;', 'varying vec3 vGN;',
    'uniform sampler2D uMask;', 'uniform sampler2D uNoise;',
    'uniform vec3 uSun;', 'uniform vec3 uCam;', 'uniform float uPix;',
    'uniform vec4 uAmp;', 'uniform vec4 uK;'   // uAmp: rough, fairway, green, sand; uK: mottle, grainTile, mottleTile, sheen
  ].join('\n') + '\n';
  var FRAG_MAP = [
    'vec4 texelColor = texture2D( map, vUv );',
    'vec4 msk = texture2D( uMask, vUv );',
    'vec2 gp = vec2( vGW.x, -vGW.z );',                       // game coords, yards
    'vec3 Vd = uCam - vGW; float dist = length( Vd ); Vd /= dist;',
    'vec3 Nn = normalize( vGN );',
    'float nv = max( abs( dot( Nn, Vd ) ), 0.06 );',
    'float foot = dist * uPix / nv;',                          // yards per pixel along the ground
    'float wG = msk.r, wF = msk.g, wS = msk.b, wR = clamp( 1.0 - wG - wF - wS, 0.0, 1.0 );',
    'vec2 fp = gp / uK.y;',
    'vec2 fpF = vec2( gp.x / uK.y, gp.y / ( uK.y * 2.2 ) );',  // fairway grain combed along the stripes (north-south)
    'vec4 n1 = texture2D( uNoise, wF > 0.5 ? fpF : fp );',
    'vec4 n2 = texture2D( uNoise, fp * 0.37 + vec2( 0.31, 0.77 ) );',
    'vec4 nm = texture2D( uNoise, gp / uK.z );',
    'float fine = 1.0 - smoothstep( 0.03, 0.12, foot );',       // fade grain once a texel is sub-pixel
    'float mid = 1.0 - smoothstep( 0.25, 1.6, foot );',
    'float clump = ( n2.g - 0.5 ) * 0.9 + ( n1.r - 0.5 ) * 0.8;',
    'float velvet = ( n1.a - 0.5 ) * 0.7 + ( n2.r - 0.5 ) * 0.3;',
    'float comb = ( n1.r - 0.5 ) * 0.75 + ( n1.a - 0.5 ) * 0.25 + ( n2.b - 0.5 ) * 0.3;',
    'float rip = sin( dot( gp, vec2( 0.57, 0.82 ) ) * 8.5 + ( n2.b - 0.5 ) * 7.0 );',
    'float sandv = ( n1.a - 0.5 ) * 0.6 + rip * 0.35 * ( 1.0 - smoothstep( 0.04, 0.09, foot ) );',
    'float grain = ( wR * uAmp.x * clump + wF * uAmp.y * comb + wG * uAmp.z * velvet + wS * uAmp.w * sandv ) * fine;',
    'grain += wR * uAmp.x * 0.45 * ( n2.b - 0.5 ) * mid;',     // clumps in the rough survive a little further
    'float mot = ( nm.b - 0.5 ) * 0.7 + ( nm.g - 0.5 ) * 0.3;',
    'float far = 1.0 - smoothstep( 120.0, 320.0, dist );',
    'vec3 tcol = texelColor.rgb;',
    'tcol *= 1.0 + grain + mot * uK.x * far * ( 1.0 - 0.7 * wS );',
    'float hol = clamp( ( 0.5 - msk.a ) * 4.0, 0.0, 1.0 ) - clamp( ( msk.a - 0.5 ) * 2.0, 0.0, 1.0 ) * 0.4;',
    'tcol *= mix( vec3( 1.0 ), vec3( 0.90, 0.985, 1.05 ), hol * HOLLOW );',
    'diffuseColor.rgb *= tcol;'
  ].join('\n');
  var FRAG_SHEEN = [
    '{',
    '  vec3 toP = -Vd;',
    '  float fwd = max( dot( normalize( vec3( toP.x, 0.0, toP.z ) ), normalize( vec3( uSun.x, 0.0, uSun.z ) ) ), 0.0 );',
    '  float graze = pow( 1.0 - nv, 3.0 );',
    '  float turf = 1.0 - 0.8 * wS;',
    '  float sh = fwd * fwd * graze * turf * ( 0.75 + 0.5 * n2.g ) * ( 1.0 - smoothstep( 90.0, 260.0, dist ) );',
    '  gl_FragColor.rgb += vec3( 1.0, 0.89, 0.62 ) * sh * uK.w;',
    '}',
    '#include <tonemapping_fragment>'].join('\n');

  function sunVec(ctx) {
    var a = ctx.sunAz, e = ctx.sunEl;
    return new ctx.THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e)).normalize();
  }

  function makeMaterial(ctx, map) {
    var THREE = ctx.THREE;
    if (!S.noise) S.noise = makeNoise(THREE);
    S.noise.anisotropy = Math.min(4, ctx.renderer.capabilities.getMaxAnisotropy());
    var mat = new THREE.MeshLambertMaterial({ map: map });
    var u = S.uniforms = S.uniforms || {
      uMask: { value: null }, uNoise: { value: S.noise }, uSun: { value: sunVec(ctx) }, uCam: { value: new THREE.Vector3() }, uPix: { value: 0.0015 },
      uAmp: { value: new THREE.Vector4() }, uK: { value: new THREE.Vector4() }
    };
    u.uMask.value = S.mask; u.uNoise.value = S.noise;
    var q = ctx.quality === 0 ? 0.7 : 1;
    u.uAmp.value.set(T.grainRough * q, T.grainFairway * q, T.grainGreen * q, T.grainSand * q);
    u.uK.value.set(T.mottle, T.grainTile, T.mottleTile, T.sheen);
    mat.onBeforeCompile = function (sh) {
      for (var k in u) sh.uniforms[k] = u[k];
      sh.vertexShader = VERT_PARS + sh.vertexShader.replace('#include <project_vertex>', VERT_MAIN);
      sh.fragmentShader = FRAG_PARS + '#define HOLLOW ' + T.hollowCool.toFixed(3) + '\n' + sh.fragmentShader
        .replace('#include <map_fragment>', FRAG_MAP)
        .replace('#include <tonemapping_fragment>', FRAG_SHEEN);
    };
    S.mat = mat;
    return mat;
  }

  window.DewFX = window.DewFX || [];
  window.DewFX.push({
    name: 'ground',
    init: function (ctx) { if (!S.noise) S.noise = makeNoise(ctx.THREE); },
    paintTerrain: function (ctx, hole, g, info) {
      bakeMask(ctx, hole, info);
      paint(ctx, hole, g, info);
    },
    terrainMaterial: function (ctx, map, info) {
      if (!S.mask) return null;
      return makeMaterial(ctx, map);
    },
    onHole: function () {},
    update: function (ctx) {
      if (!S.uniforms) return;
      var hpx = (ctx.viewH || 780) * (ctx.PR || 1);
      var e = ctx.camera.matrixWorld.elements; S.uniforms.uCam.value.set(e[12], e[13], e[14]);   // Lambert gets no cameraPosition in r128
      S.uniforms.uPix.value = 2 * Math.tan(31 * Math.PI / 180) / Math.max(200, hpx);
    }
  });
})();
