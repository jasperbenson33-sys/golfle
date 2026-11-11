/* Dewsweeper 3D effect module: water  (fx/water.js)
 *
 * Draws: still morning water for every pond and creek in hole.water. All ponds of a hole are merged into ONE
 *   mesh: a regular grid per pond, clipped to the union of circles plus a little overlap that hides under the
 *   bank (cells whose corners are all further than PAD yd outside the shore are dropped). Each vertex stores its
 *   pond's level (in position) and its signed shore distance (aShore, negative inside), so the shader can grade
 *   deep -> shallow -> shoreline. One opaque ShaderMaterial:
 *     - body colour: cool blue-green in the middle, paler in the shallows, thin soft bright line at the bank
 *     - sky in the water: fresnel blend toward a reflected sky gradient (horizon #E3E6D3 -> #BDD8E6 -> #79AEDB),
 *       warmed toward the sun's azimuth, with a darker tree-line band at the horizon so water never reads as fog/sand
 *     - sun: soft sheen plus a ripple-broken glitter path toward the low NE sun
 *     - ripples: two slow layers from a 128x128 tiling derivative-noise texture, scrolling with ctx.wind
 *       (near glassy when calm, livelier at 12+ mph), damped with distance to avoid shimmer
 *     - rings: on 'splash', expanding concentric rings (3 slots in uniforms, ~3 s each)
 *     - scene fog applies
 * Replaces: 'water' (the host's flat Phong discs).
 * Hooks: init (noise texture + persistent uniforms), onHole (merged geometry + material into ctx.holeGroup),
 *   update (time, wind-driven scroll offsets; no allocations), onEvent ('splash' -> ring slot).
 * Cost: 1 draw call per hole with water (0 without); <= ~5,600 triangles (grid cell size adapts to pond area);
 *   one 128x128 RGBA texture; opaque, so no blending overdraw.
 */
(function () {
  'use strict';

  /* ---------------- tunables ---------------- */
  var T = {
    PAD: 2.4,              // yd of surface kept outside the shoreline (hidden under the bank)
    LIFT: 0.115,           // surface sits this far above ter.wl so it laps over the bank step and its painted blue rim
    MAX_TRIS: 5600,        // triangle budget for all ponds of a hole
    MIN_CELL: 0.9,         // finest grid cell (yd)
    DEEP: [0.27, 0.50, 0.58],      // middle of the pond (cool blue-green, a touch darker than #4F8FAE)
    MID: [0.40, 0.62, 0.70],       // ~ #6FA6C2 family
    SHALLOW: [0.50, 0.69, 0.68],   // pale, slightly green shallows
    SHORE: [0.86, 0.90, 0.84],     // thin bright line at the bank
    SHORE_W: 0.4,          // yd width of the bright shore line
    DEPTH_YD: 4.5,         // shore distance at which water reaches full depth colour
    SKY_H: [0.890, 0.902, 0.827],  // #E3E6D3
    SKY_M: [0.741, 0.847, 0.902],  // #BDD8E6
    SKY_Z: [0.475, 0.682, 0.859],  // #79AEDB
    SKY_WARM: [1.0, 0.851, 0.635], // #FFD9A2
    TREELINE: [0.31, 0.47, 0.49],  // reflected far woods along the horizon band
    TREELINE_AMT: 0.66,    // how strongly the tree line darkens near-horizon reflections
    REFL_MAX: 0.52,        // cap on the fresnel blend (keeps water reading as water)
    SUN_COL: [1.0, 0.93, 0.74],
    SHEEN: 0.22,           // broad soft sun sheen strength
    GLITTER: 1.25,         // sharp glitter strength
    RIPPLE_CALM: 0.02,     // normal strength at 0 mph
    RIPPLE_WIND: 0.075,     // extra normal strength at 12 mph
    SCROLL: 0.05,          // ripple scroll speed (yd/s per mph-ish unit, see update)
    RING_SPEED: 2.6,       // yd/s ring expansion
    RING_LIFE: 3.2         // s
  };

  var S = { U: null, tex: null, ringI: 0, off: [0, 0, 0, 0] };

  function makeNoiseTexture(THREE) {
    var N = 128, G = 16;
    var rnd = (function (s) { return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })(91731);
    function lattice(g) { var a = new Float32Array(g * g); for (var i = 0; i < a.length; i++) a[i] = rnd(); return a; }
    function sm(t) { return t * t * (3 - 2 * t); }
    function vnoise(lat, g, x, y) { // x,y in [0,N)
      var fx = x / N * g, fy = y / N * g, ix = Math.floor(fx), iy = Math.floor(fy), tx = sm(fx - ix), ty = sm(fy - iy);
      var x0 = ix % g, y0 = iy % g, x1 = (ix + 1) % g, y1 = (iy + 1) % g;
      var a = lat[y0 * g + x0], b = lat[y0 * g + x1], c = lat[y1 * g + x0], d = lat[y1 * g + x1];
      return (a + (b - a) * tx) + ((c + (d - c) * tx) - (a + (b - a) * tx)) * ty;
    }
    var L1 = lattice(8), L2 = lattice(G), L3 = lattice(32);
    var h = new Float32Array(N * N), sp = new Float32Array(N * N);
    for (var y = 0; y < N; y++) for (var x = 0; x < N; x++) {
      h[y * N + x] = vnoise(L1, 8, x, y) * 0.55 + vnoise(L2, G, x, y) * 0.3 + vnoise(L3, 32, x, y) * 0.15;
      sp[y * N + x] = vnoise(L3, 32, x, y);
    }
    var cv = document.createElement('canvas'); cv.width = cv.height = N;
    var g2 = cv.getContext('2d'), img = g2.createImageData(N, N), d = img.data;
    for (var yy = 0; yy < N; yy++) for (var xx = 0; xx < N; xx++) {
      var i = yy * N + xx;
      var dx = h[yy * N + (xx + 1) % N] - h[yy * N + (xx + N - 1) % N];
      var dy = h[((yy + 1) % N) * N + xx] - h[((yy + N - 1) % N) * N + xx];
      d[i * 4] = Math.max(0, Math.min(255, 128 + dx * 900));
      d[i * 4 + 1] = Math.max(0, Math.min(255, 128 + dy * 900));
      d[i * 4 + 2] = Math.max(0, Math.min(255, sp[i] * 255));
      d[i * 4 + 3] = Math.max(0, Math.min(255, h[i] * 255));
    }
    g2.putImageData(img, 0, 0);
    var t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    return t;
  }

  function v3(THREE, a) { return new THREE.Vector3(a[0], a[1], a[2]); }

  var VS = [
    'attribute float aShore;',
    'varying float vShore;',
    'varying vec3 vWorld;',
    '#include <fog_pars_vertex>',
    'void main(){',
    '  vShore = aShore;',
    '  vec4 wp = modelMatrix * vec4(position, 1.0);',
    '  vWorld = wp.xyz;',
    '  vec4 mvPosition = viewMatrix * wp;',
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <fog_vertex>',
    '}'].join('\n');

  var FS = [
    'uniform sampler2D uNoise;',
    'uniform float uTime;',
    'uniform vec4 uOff;',            // two scroll offsets (layer A xy, layer B zw)
    'uniform float uAmp;',
    'uniform vec2 uWdir;',           // wind direction in three xz (unit)
    'uniform vec3 uSun;',
    'uniform vec3 uDeep; uniform vec3 uMid; uniform vec3 uShallow; uniform vec3 uShoreC;',
    'uniform vec3 uSkyH; uniform vec3 uSkyM; uniform vec3 uSkyZ; uniform vec3 uWarm; uniform vec3 uTree; uniform vec3 uSunC;',
    'uniform vec4 uP;',              // x shoreW, y depthYd, z treeAmt, w reflMax
    'uniform vec4 uP2;',             // x sheen, y glitter, z ringSpeed, w ringLife
    'uniform vec4 uRing[3];',        // xz pos (three), z start time, w strength
    'varying float vShore;',
    'varying vec3 vWorld;',
    '#include <fog_pars_fragment>',
    'void main(){',
    '  vec2 p = vWorld.xz;',
    '  vec3 toCam = cameraPosition - vWorld;',
    '  float dist = length(toCam);',
    '  vec3 V = toCam / dist;',
    '  float damp = 1.0 / (1.0 + dist * 0.012);',
    // wind-aligned frame: ripples are short along the wind and long across it
    '  vec2 q = vec2(dot(p, uWdir), dot(p, vec2(-uWdir.y, uWdir.x)));',
    '  vec4 nA = texture2D(uNoise, vec2(q.x * 0.16, q.y * 0.055) + uOff.xy);',
    '  vec4 nB = texture2D(uNoise, vec2(q.x * 0.37 + q.y * 0.08, q.y * 0.13) + uOff.zw);',
    '  vec2 gq = ((nA.xy - 0.5) * vec2(1.0, 0.35) + (nB.xy - 0.5) * vec2(0.8, 0.3)) * uAmp * damp;',
    '  vec2 g = uWdir * gq.x + vec2(-uWdir.y, uWdir.x) * gq.y;',
    // splash rings
    '  for (int i = 0; i < 3; i++) {',
    '    vec4 R = uRing[i];',
    '    float age = uTime - R.z;',
    '    if (R.w > 0.0 && age > 0.0 && age < uP2.w) {',
    '      vec2 dv = p - R.xy; float d = length(dv) + 1e-3;',
    '      float fade = (1.0 - age / uP2.w); fade *= fade;',
    '      float rad = age * uP2.z;',
    '      float x = d - rad;',
    '      float env = exp(-x * x * 1.2) * smoothstep(0.0, 0.3, age);',
    '      float w = sin(x * 5.0) * env * fade * R.w * 0.45 / (1.0 + rad * 0.25);',
    '      w += sin((d - rad * 0.6) * 5.0) * exp(-(d - rad * 0.6) * (d - rad * 0.6) * 1.5) * fade * R.w * 0.25 / (1.0 + rad * 0.2);',
    '      g += dv / d * w;',
    '    }',
    '  }',
    '  vec3 N = normalize(vec3(g.x, 1.0, g.y));',
    // body colour by depth
    '  float farK = smoothstep(35.0, 150.0, dist);',  // far away: thin slivers read as open water, not shoreline
    '  float depth = max(clamp(-vShore / uP.y, 0.0, 1.0), farK * 0.8);',
    '  vec3 body = mix(uShallow, uMid, smoothstep(0.0, 0.25, depth));',
    '  body = mix(body, uDeep, smoothstep(0.3, 1.0, depth));',
    // reflected sky
    '  vec3 Rv = reflect(-V, N);',
    '  float ry = max(Rv.y, 0.0);',
    '  vec3 sky = mix(uSkyH, uSkyM, smoothstep(0.02, 0.3, ry));',
    '  sky = mix(sky, uSkyZ, smoothstep(0.3, 0.85, ry));',
    '  vec2 sh = normalize(uSun.xz);',
    '  float toward = dot(normalize(Rv.xz + 1e-4), sh) * 0.5 + 0.5;',
    '  sky = mix(sky, uWarm, pow(toward, 3.0) * (1.0 - smoothstep(0.0, 0.5, ry)) * 0.55);',
    '  float band = (1.0 - smoothstep(0.06, 0.3, ry)) * uP.z * (1.0 - 0.6 * pow(toward, 4.0));',
    '  sky = mix(sky, uTree, band);',
    '  float ndv = clamp(dot(N, V), 0.0, 1.0);',
    '  float fr = 0.06 + 0.94 * pow(1.0 - ndv, 4.0);',
    '  vec3 col = mix(body, sky, min(fr, uP.w));',
    // sun: broad sheen + glitter broken by ripples
    '  float sd = max(dot(Rv, uSun), 0.0);',
    '  float sheen = pow(sd, 24.0) * uP2.x;',
    '  float spark = texture2D(uNoise, p * 0.9 + uOff.zw * 3.0).z * texture2D(uNoise, p * 0.63 - uOff.xy * 2.3).z;',
    '  float glit = pow(sd, 260.0) * uP2.y * (0.35 + 2.4 * smoothstep(0.22, 0.5, spark));',
    '  col += uSunC * (sheen + glit);',
    // shoreline
    '  float sl = smoothstep(-uP.x, uP.x * 1.2, vShore);',
    '  float brk = 0.75 + 0.5 * nA.w;',
    '  col = mix(col, uShoreC, clamp(sl * brk, 0.0, 1.0) * 0.55 * (1.0 - 0.8 * farK));',
    '  gl_FragColor = vec4(min(col, vec3(1.0)), 1.0);',
    '  #include <fog_fragment>',
    '}'].join('\n');

  function buildGeometry(ctx, hole) {
    var THREE = ctx.THREE, C = ctx.C, PAD = T.PAD;
    var ponds = hole.water || [], wl = (hole.ter && hole.ter.wl) || [];
    var green = hole.green || [];
    function sdAt(pond, x, y) {
      var s = C.sdCircles(pond, x, y);
      if (green.length) s = Math.max(s, -C.sdCircles(green, x, y));
      return s;
    }
    // estimate area kept to choose a cell size within budget
    var area = 0;
    ponds.forEach(function (pond) {
      for (var i = 0; i < pond.length; i++) area += Math.PI * (pond[i].r + PAD) * (pond[i].r + PAD);
    });
    // circles overlap a lot (creeks), so the sum overestimates; refine with a coarse sample
    var kept = 0, step = 2;
    ponds.forEach(function (pond) {
      var b = bbox(pond);
      for (var y = b.y0; y < b.y1; y += step) for (var x = b.x0; x < b.x1; x += step) if (C.sdCircles(pond, x + 1, y + 1) < PAD + 1.4) kept += step * step;
    });
    if (kept > 0) area = kept;
    var cell = Math.max(T.MIN_CELL, Math.sqrt(area * 2 / T.MAX_TRIS));
    function bbox(pond) {
      var b = { x0: 1e9, x1: -1e9, y0: 1e9, y1: -1e9 };
      for (var i = 0; i < pond.length; i++) {
        var c = pond[i];
        b.x0 = Math.min(b.x0, c.x - c.r - PAD - 1); b.x1 = Math.max(b.x1, c.x + c.r + PAD + 1);
        b.y0 = Math.min(b.y0, c.y - c.r - PAD - 1); b.y1 = Math.max(b.y1, c.y + c.r + PAD + 1);
      }
      return b;
    }
    var pos = [], shore = [], idx = [];
    ponds.forEach(function (pond, pi) {
      var L = wl[pi] != null ? wl[pi] : 0;
      var b = bbox(pond);
      var nx = Math.ceil((b.x1 - b.x0) / cell) + 1, ny = Math.ceil((b.y1 - b.y0) / cell) + 1;
      var sd = new Float32Array(nx * ny), vid = new Int32Array(nx * ny).fill(-1);
      for (var j = 0; j < ny; j++) for (var i = 0; i < nx; i++) sd[j * nx + i] = sdAt(pond, b.x0 + i * cell, b.y0 + j * cell);
      function vert(i, j) {
        var k = j * nx + i;
        if (vid[k] < 0) {
          vid[k] = pos.length / 3;
          var x = b.x0 + i * cell, y = b.y0 + j * cell;
          pos.push(x, L + T.LIFT, -y); shore.push(sd[k]);
        }
        return vid[k];
      }
      for (var j2 = 0; j2 < ny - 1; j2++) for (var i2 = 0; i2 < nx - 1; i2++) {
        var a = sd[j2 * nx + i2], bq = sd[j2 * nx + i2 + 1], c = sd[(j2 + 1) * nx + i2], d = sd[(j2 + 1) * nx + i2 + 1];
        if (Math.min(a, bq, c, d) > PAD) continue;
        var v0 = vert(i2, j2), v1 = vert(i2 + 1, j2), v2 = vert(i2, j2 + 1), v3_ = vert(i2 + 1, j2 + 1);
        // three coords: z = -y, so this winding faces +Y (up)
        idx.push(v0, v1, v2, v1, v3_, v2);
      }
    });
    if (!idx.length) return null;
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aShore', new THREE.Float32BufferAttribute(shore, 1));
    g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }

  /* INTEGRATION FIX: the host's 'farGround' disc sits at z = -2.05 over the whole world, so any pond whose level is
     below that (most of them) is hidden under it, in base too. The terrain mesh already covers ctx.ext, so the far
     plane is only needed outside it: discard its fragments inside the current extent. Guarded; the director may
     prefer to move this into the host. */
  function patchFarGround(ctx) {
    var fg = ctx.scene && ctx.scene.getObjectByName && ctx.scene.getObjectByName('farGround');
    if (!fg || !fg.material || fg.material.userData.dewWaterPatched) return;
    var THREE = ctx.THREE, prev = fg.material.onBeforeCompile;
    S.fgExt = { value: new THREE.Vector4(1e9, 1e9, -1e9, -1e9) };
    fg.material.userData.dewWaterPatched = true;
    fg.material.onBeforeCompile = function (sh, r) {
      if (typeof prev === 'function') { try { prev.call(this, sh, r); } catch (e) { /* keep going */ } }
      sh.uniforms.uDewExt = S.fgExt;
      sh.vertexShader = 'varying vec2 vDewW;\n' + sh.vertexShader.replace('#include <begin_vertex>',
        '#include <begin_vertex>\n  vDewW = (modelMatrix * vec4(transformed, 1.0)).xz;');
      sh.fragmentShader = 'uniform vec4 uDewExt;\nvarying vec2 vDewW;\n' + sh.fragmentShader.replace(/void main\(\)\s*\{/,
        'void main() {\n  if (vDewW.x > uDewExt.x && vDewW.x < uDewExt.z && vDewW.y > uDewExt.y && vDewW.y < uDewExt.w) discard;');
    };
    fg.material.needsUpdate = true;
  }

  window.DewFX = window.DewFX || [];
  window.DewFX.push({
    name: 'water',
    replaces: ['water'],
    init: function (ctx) {
      var THREE = ctx.THREE;
      S.tex = makeNoiseTexture(THREE);
      var rings = [];
      for (var i = 0; i < 3; i++) rings.push(new THREE.Vector4(0, 0, -100, 0));
      S.U = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]);
      S.U.uNoise = { value: S.tex };
      S.U.uTime = { value: 0 };
      S.U.uOff = { value: new THREE.Vector4() };
      S.U.uAmp = { value: T.RIPPLE_CALM };
      S.U.uWdir = { value: new THREE.Vector2(0.6, -0.8) };
      S.U.uSun = { value: ctx.sunDir ? ctx.sunDir.clone().normalize() : new THREE.Vector3(0.77, 0.26, -0.58).normalize() };
      S.U.uDeep = { value: v3(THREE, T.DEEP) }; S.U.uMid = { value: v3(THREE, T.MID) };
      S.U.uShallow = { value: v3(THREE, T.SHALLOW) }; S.U.uShoreC = { value: v3(THREE, T.SHORE) };
      S.U.uSkyH = { value: v3(THREE, T.SKY_H) }; S.U.uSkyM = { value: v3(THREE, T.SKY_M) }; S.U.uSkyZ = { value: v3(THREE, T.SKY_Z) };
      S.U.uWarm = { value: v3(THREE, T.SKY_WARM) }; S.U.uTree = { value: v3(THREE, T.TREELINE) }; S.U.uSunC = { value: v3(THREE, T.SUN_COL) };
      S.U.uP = { value: new THREE.Vector4(T.SHORE_W, T.DEPTH_YD, T.TREELINE_AMT, T.REFL_MAX) };
      S.U.uP2 = { value: new THREE.Vector4(T.SHEEN, T.GLITTER, T.RING_SPEED, T.RING_LIFE) };
      S.U.uRing = { value: rings };
      patchFarGround(ctx);
    },
    onHole: function (ctx, hole) {
      if (!S.U || !hole || !hole.water || !hole.water.length) return;
      var THREE = ctx.THREE;
      for (var i = 0; i < 3; i++) S.U.uRing.value[i].w = 0;
      if (S.fgExt && ctx.ext) S.fgExt.value.set(ctx.ext.x0 + 2, -ctx.ext.y1 + 2, ctx.ext.x1 - 2, -ctx.ext.y0 - 2);
      var g = buildGeometry(ctx, hole);
      if (!g) return;
      var mat = new THREE.ShaderMaterial({ uniforms: S.U, vertexShader: VS, fragmentShader: FS, fog: true });
      var m = new THREE.Mesh(g, mat);
      m.name = 'fx-water';
      m.frustumCulled = true;
      ctx.holeGroup.add(m);
    },
    update: function (ctx, dt) {
      if (!S.U) return;
      var w = ctx.wind || { x: 0, y: 1, mph: 0 };
      var mph = Math.max(0, Math.min(15, w.mph || 0));
      var k = Math.min(1, mph / 12);
      var red = ctx.reduced ? 0.25 : 1;
      S.U.uTime.value = ctx.time;
      S.U.uAmp.value = T.RIPPLE_CALM + T.RIPPLE_WIND * k;
      // scroll in the wind-aligned texture frame: layer A along the wind, layer B slower and slightly across
      var wx = w.x || 0, wz = -(w.y || 0), wl = Math.sqrt(wx * wx + wz * wz);
      if (mph < 0.5 || wl < 1e-3) { wx = 0.6; wz = -0.8; } else { wx /= wl; wz /= wl; }
      S.U.uWdir.value.set(wx, wz);
      var sp = (0.12 + mph * 0.1) * T.SCROLL * red * dt;   // yd per frame
      var o = S.off;
      o[0] = (o[0] - sp * 0.16) % 1; o[1] = (o[1] - sp * 0.01) % 1;
      o[2] = (o[2] - sp * 0.37 * 0.7) % 1; o[3] = (o[3] + sp * 0.03) % 1;
      S.U.uOff.value.set(o[0], o[1], o[2], o[3]);
    },
    onEvent: function (ctx, type, data) {
      if (type !== 'splash' || !S.U || !data) return;
      var r = S.U.uRing.value[S.ringI];
      r.set(data.x || 0, -(data.y || 0), ctx.time, 1);
      S.ringI = (S.ringI + 1) % 3;
    }
  });
})();
