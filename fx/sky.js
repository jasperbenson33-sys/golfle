/* fx/sky.js — Dewsweeper 3D: the dawn sky, the low sun, clouds and the far country.

   Replaces: 'sky' (the default vertex-coloured dome, the additive sun sprite and the two ridge rings).
   Does NOT touch fog, lights or the far ground plane.

   What it draws
   - Dome (1 draw, ~2.3k tris): a camera-centred sphere whose fragment shader computes, per pixel from the view
     direction: haze (exactly the fog colour #E3E6D3 at and below the horizon) -> pale mid blue -> soft zenith blue,
     a warm peach-gold bloom spreading from the sun's azimuth, the sun disc with three layers of glow, and the
     clouds: thin streaky cirrus on a virtual high plane plus (quality >= 1) a few soft low banks peeking over the
     hills. Clouds are lit warm on the sun side, cool away from it, with a bright rim close to the sun. They drift
     with ctx.wind at a barely perceptible pace and parallax very slightly as the camera travels. 1/255 dither.
     The clouds live inside the dome shader, so they cost no extra layer and no extra overdraw.
   - Far country (1 draw, ~5k tris): three ridgeline rings merged into one opaque vertex-coloured mesh. Each farther
     ring is paler and closer to the haze; the bases sink into haze (valley mist); sun-facing slopes are a touch
     darker and warmer (backlit). The nearest ring carries patches of serrated tree-line. Centred on the hole.
   - Sun bloom (1 draw, 2 tris): small additive sprite drawn over silhouettes so the sun reads as light.
     Swells softly for ~4 s on a 'score' event with diff < 0.
   - Lens ghosts (quality >= 1; 1 draw, 10 tris): five faint additive discs placed in clip space along the
     sun-centre line, fading in only when the sun is on screen.
   Cost: 4 draw calls, ~7.5k triangles (base sky/sun/ridges were 3 draws, ~1.2k tris). No render targets,
   no per-frame allocation. ctx.reduced: no cloud drift. ctx.quality 0: cirrus only, fewer noise octaves, no ghosts.

   Hooks: init (builds everything), onHole (centres the ridges on hole.bounds), update (follows the camera,
   drifts clouds, flare visibility, swell envelope), onEvent ('score').
*/
(function () {
  'use strict';

  /* ---------------- tunables ---------------- */
  var T = {
    DOME_R: 6000,
    HAZE: 0xE3E6D3, MID: 0xBDD8E6, ZEN: 0x79AEDB, WARM: 0xFFD9A2,   // palette (haze must equal the fog colour)
    CORE: 0xFFFCEB, HALO: 0xFFE296,
    MID_RATE: 6.0,          // how fast haze gives way to mid blue above the horizon (higher = thinner haze band)
    WARM_AMT: 0.62,         // strength of the peach bloom on the sun's side
    WARM_SPREAD: 2.5,       // azimuthal tightness of the bloom (higher = narrower)
    SUN_R: 0.012,           // sun disc radius (radians, ~0.6 deg; enlarged for phones)
    GLOW: [0.42, 0.58, 0.45], // inner / middle / wide glow strength
    CLOUD_COOL: 0xD8DFEA, CLOUD_WARM: 0xFFE3BC,
    CIRRUS: 0.62,           // cirrus max opacity
    CIRRUS_COVER: 0.41,     // patch threshold (higher = sparser cirrus)
    BANKS: 0.62,            // low bank max opacity (quality >= 1)
    DRIFT: 0.0035,          // cloud drift in plane units per second per (mph/10)
    PARALLAX: 1 / 3200,     // camera travel to cloud-plane offset (cloud height ~3200 yd)
    BLOOM_SCALE: 700, BLOOM_OPACITY: 0.12,
    FLARE: 0.15,            // ghost intensity
    SWELL: 0.55,            // glow gain at the peak of a birdie swell
    RIDGES: [               // radius yd, segments, min/max elevation (deg), colour, seed, treeline
      { R: 1900, N: 720, lo: 1.2, hi: 3.6, col: 0x9FB3A2, sunCol: 0x93A493, seed: 31, trees: true },
      { R: 2800, N: 320, lo: 1.8, hi: 5.4, col: 0xB8C7BE, sunCol: 0xB4BFB4, seed: 47, trees: false },
      { R: 3900, N: 256, lo: 2.4, hi: 7.6, col: 0xCDD6D1, sunCol: 0xCFD3C9, seed: 59, trees: false }
    ]
  };

  var S = { swellT: 0 };

  var DOME_VS = [
    'varying vec3 vDir;',
    'void main(){',
    '  vDir = position;',
    '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
    '}'].join('\n');

  var DOME_FS = [
    'uniform vec3 uSun, uHaze, uMid, uZen, uWarm, uCore, uHalo, uCool, uCWarm;',
    'uniform vec2 uOff;',
    'uniform float uMidRate, uWarmAmt, uWarmSpread, uSunR, uSwell, uCirrus, uCover, uBanks;',
    'uniform vec3 uGlow;',
    'varying vec3 vDir;',
    'float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'float noise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));',
    '  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y); }',
    'float fbm(vec2 p){ float s = 0.0, a = 0.5;',
    '  for (int i = 0; i < OCT; i++){ s += a * noise(p); p = mat2(1.6, 1.2, -1.2, 1.6) * p; a *= 0.5; }',
    '  return s; }',
    'void main(){',
    '  vec3 d = normalize(vDir);',
    '  float h = max(d.y, 0.0);',
    '  vec2 hz = d.xz / max(length(d.xz), 1e-4);',
    '  float ca = dot(hz, normalize(uSun.xz));',
    '  float side = ca * 0.5 + 0.5;',
    '  float low = smoothstep(0.0, 0.12, h);',
    // gradient
    '  vec3 col = mix(uHaze, uMid, 1.0 - exp(-h * uMidRate));',
    '  col = mix(col, uZen, pow(smoothstep(0.06, 1.0, h), 0.85));',
    '  col = mix(col, uWarm, pow(side, uWarmSpread) * exp(-h * 3.6) * uWarmAmt * low);',
    // clouds
    '#ifdef CLOUDS',
    '  if (h > 0.01) {',
    '    vec2 p = d.xz / (h + 0.06) + uOff;',
    '    vec2 q = mat2(0.82, 0.57, -0.57, 0.82) * p;',
    '    float warp = fbm(q * 0.8 + 1.7);',
    '    float patchy = smoothstep(uCover, uCover + 0.22, fbm(q * 0.45 + vec2(4.1, 9.3)));',
    '    float st = fbm(vec2(q.x * 0.6, q.y * 7.5 + warp * 3.0));',
    '    float cir = smoothstep(0.47, 0.78, st) * patchy * smoothstep(0.03, 0.24, h) * uCirrus;',
    '    float fwd = pow(max(dot(d, uSun), 0.0), 10.0);',
    '    vec3 cc = mix(uCool, uCWarm, smoothstep(0.15, 1.0, side)) + uCore * fwd * 0.35;',
    '    col = mix(col, cc, cir);',
    '#ifdef BANKS',
    '    vec2 b = p * 0.42 + vec2(7.3, -2.1);',
    '    float bn = fbm(b + 0.6 * vec2(fbm(b * 1.7 + 3.0), 0.0));',
    '    float band = smoothstep(0.03, 0.075, h) * (1.0 - smoothstep(0.10, 0.20, h));',
    '    float bank = smoothstep(0.47, 0.68, bn) * band * uBanks;',
    '    vec3 bc = mix(cc, uHaze, 0.25 + 0.5 * (1.0 - smoothstep(0.02, 0.11, h)));',
    '    bc *= 1.0 - 0.06 * smoothstep(0.55, 0.85, bn) * (1.0 - side);',  // faint shading on the cool side
    '    col = mix(col, bc, bank);',
    '#endif',
    '  }',
    '#endif',
    // sun and glow
    '  float ang = length(d - uSun);',
    '  float sw = 1.0 + uSwell;',
    '  float hl = smoothstep(0.0, 0.05, h);',
    '  col = mix(col, uWarm, exp(-ang * 2.6) * uGlow.z * low * sw);',
    '  col = mix(col, uHalo, min(1.0, exp(-ang * 11.0) * uGlow.y * hl * sw));',
    '  col += uCore * exp(-ang * 42.0) * uGlow.x * sw * hl;',
    '  col = mix(col, uCore, smoothstep(uSunR * 1.25, uSunR * 0.85, ang));',
    '  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;',
    '  gl_FragColor = vec4(col, 1.0);',
    '}'].join('\n');

  var FLARE_VS = [
    'attribute vec2 corner;',
    'attribute vec3 ghost;',   // t along sun->centre->beyond, size (ndc), tint index 0..1
    'uniform vec2 uSunNdc;',
    'uniform float uAspect;',
    'varying vec2 vC;',
    'varying float vTint;',
    'void main(){',
    '  vC = corner; vTint = ghost.z;',
    '  vec2 c = uSunNdc * (1.0 - 2.0 * ghost.x);',
    '  gl_Position = vec4(c + corner * ghost.y * vec2(1.0 / uAspect, 1.0), 0.0, 1.0);',
    '}'].join('\n');
  var FLARE_FS = [
    'uniform float uAmt;',
    'varying vec2 vC;',
    'varying float vTint;',
    'void main(){',
    '  float r = length(vC);',
    '  float a = smoothstep(1.0, 0.75, r) * (0.55 + 0.45 * smoothstep(0.2, 0.95, r));',
    '  vec3 c = mix(vec3(1.0, 0.86, 0.6), vec3(0.62, 0.82, 0.95), vTint);',
    '  gl_FragColor = vec4(c * a * uAmt, 1.0);',
    '}'].join('\n');

  function col3(T3, hex) { return new T3.Color(hex); }

  function buildRidges(THREE, C, haze, sunH) {
    var pos = [], colr = [], idx = [], base = 0, c = new THREE.Color(), cs = new THREE.Color(), hz = new THREE.Color(haze);
    for (var k = 0; k < T.RIDGES.length; k++) {
      var r = T.RIDGES[k], N = r.N, rng = C.makeRng(r.seed), H = [], harm = [], i, j;
      for (j = 0; j < 9; j++) { var n = [2, 3, 5, 7, 11, 17, 26, 41, 63][j]; harm.push({ n: n, a: Math.pow(n, -0.85) * rng.range(0.6, 1.4), p: rng() * 6.2832 }); }
      var mn = 1e9, mx = -1e9;
      for (i = 0; i < N; i++) {
        var a = (i / N) * 6.2832, s = 0;
        for (j = 0; j < harm.length; j++) s += harm[j].a * Math.sin(harm[j].n * a + harm[j].p);
        H.push(s); if (s < mn) mn = s; if (s > mx) mx = s;
      }
      // tree-line patches (nearest ring)
      var tp1 = rng() * 6.28, tp2 = rng() * 6.28;
      for (i = 0; i <= N; i++) {
        var ii = i % N, ang = (ii / N) * 6.2832, u = (H[ii] - mn) / (mx - mn || 1);
        u = Math.pow(u, 1.45);                                        // broad valleys, sharper crests
        var el = (r.lo + (r.hi - r.lo) * u) * Math.PI / 180, top = r.R * Math.tan(el);
        if (r.trees) {
          var patch = Math.max(0, Math.sin(ang * 5 + tp1) * 0.6 + Math.sin(ang * 13 + tp2) * 0.4 - 0.05);
          patch = Math.min(1, patch * 2.2);
          var crown = (ii % 2 === 0 ? 1 : 0.35) * (0.6 + 0.4 * Math.sin(ii * 2.39 + tp1) * Math.sin(ii * 0.77));
          top += patch * crown * 11;
        }
        var x = Math.sin(ang) * r.R, z = -Math.cos(ang) * r.R;     // ang clockwise from north
        var face = Math.max(0, Math.sin(ang) * sunH.x + Math.cos(ang) * sunH.y);
        c.setHex(r.col); cs.setHex(r.sunCol); c.lerp(cs, face * face);
        var mid = top * 0.42;
        pos.push(x, top, z, x, mid, z, x, -30, z);
        colr.push(c.r, c.g, c.b);
        cs.copy(c).lerp(hz, 0.38); colr.push(cs.r, cs.g, cs.b);
        cs.copy(c).lerp(hz, 0.92); colr.push(cs.r, cs.g, cs.b);
      }
      for (i = 0; i < N; i++) {
        var v = base + i * 3, w = v + 3;
        idx.push(v, v + 1, w, v + 1, w + 1, w, v + 1, v + 2, w + 1, v + 2, w + 2, w + 1);
      }
      base += (N + 1) * 3;
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
    g.setIndex(idx);
    var m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide }));
    m.frustumCulled = false; m.name = 'skyRidges'; m.renderOrder = -5;
    return m;
  }

  function bloomTex(THREE) {
    var cv = document.createElement('canvas'), s = 128; cv.width = cv.height = s;
    var g = cv.getContext('2d'), r = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    r.addColorStop(0, 'rgba(255,248,225,1)'); r.addColorStop(0.12, 'rgba(255,236,190,0.55)');
    r.addColorStop(0.4, 'rgba(255,222,150,0.16)'); r.addColorStop(1, 'rgba(255,214,140,0)');
    g.fillStyle = r; g.fillRect(0, 0, s, s);
    return new THREE.CanvasTexture(cv);
  }

  function buildFlare(THREE) {
    var G = [[0.32, 0.05, 0.0], [0.55, 0.025, 0.6], [0.78, 0.08, 1.0], [1.15, 0.04, 0.3], [1.45, 0.11, 0.8]];
    var cor = [], gh = [], pos = [], idx = [];
    for (var i = 0; i < G.length; i++) {
      var q = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (var j = 0; j < 4; j++) { cor.push(q[j][0], q[j][1]); gh.push(G[i][0], G[i][1], G[i][2]); pos.push(0, 0, 0); }
      var b = i * 4; idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('corner', new THREE.Float32BufferAttribute(cor, 2));
    g.setAttribute('ghost', new THREE.Float32BufferAttribute(gh, 3));
    g.setIndex(idx);
    var mat = new THREE.ShaderMaterial({
      uniforms: { uSunNdc: { value: new THREE.Vector2() }, uAspect: { value: 0.5 }, uAmt: { value: 0 } },
      vertexShader: FLARE_VS, fragmentShader: FLARE_FS, blending: THREE.AdditiveBlending,
      transparent: true, depthTest: false, depthWrite: false, fog: false
    });
    var m = new THREE.Mesh(g, mat); m.frustumCulled = false; m.renderOrder = 50; m.visible = false; m.name = 'skyFlare';
    return m;
  }

  window.DewFX = window.DewFX || [];
  window.DewFX.push({
    name: 'sky',
    replaces: ['sky'],
    init: function (ctx) {
      var THREE = ctx.THREE, q = ctx.quality | 0;
      S.v = new THREE.Vector3(); S.fw = new THREE.Vector3();
      var sunDir = ctx.sunDir || new THREE.Vector3(0.6, 0.26, -0.75).normalize();
      var defs = { OCT: q === 0 ? 3 : q === 1 ? 4 : 5, CLOUDS: 1 };
      if (q > 0) defs.BANKS = 1;
      S.u = {
        uSun: { value: sunDir.clone().normalize() },
        uHaze: { value: col3(THREE, T.HAZE) }, uMid: { value: col3(THREE, T.MID) }, uZen: { value: col3(THREE, T.ZEN) },
        uWarm: { value: col3(THREE, T.WARM) }, uCore: { value: col3(THREE, T.CORE) }, uHalo: { value: col3(THREE, T.HALO) },
        uCool: { value: col3(THREE, T.CLOUD_COOL) }, uCWarm: { value: col3(THREE, T.CLOUD_WARM) },
        uOff: { value: new THREE.Vector2(0, 0) },
        uMidRate: { value: T.MID_RATE }, uWarmAmt: { value: T.WARM_AMT }, uWarmSpread: { value: T.WARM_SPREAD },
        uSunR: { value: T.SUN_R }, uSwell: { value: 0 }, uCirrus: { value: T.CIRRUS }, uCover: { value: T.CIRRUS_COVER },
        uBanks: { value: T.BANKS }, uGlow: { value: new THREE.Vector3(T.GLOW[0], T.GLOW[1], T.GLOW[2]) }
      };
      var mat = new THREE.ShaderMaterial({
        uniforms: S.u, defines: defs, vertexShader: DOME_VS, fragmentShader: DOME_FS,
        side: THREE.BackSide, depthWrite: false, fog: false, precision: 'highp'
      });
      S.dome = new THREE.Mesh(new THREE.SphereGeometry(T.DOME_R, 48, 24), mat);
      S.dome.renderOrder = -10; S.dome.frustumCulled = false; S.dome.name = 'skyDome';
      ctx.scene.add(S.dome);

      S.ridges = buildRidges(THREE, ctx.C, T.HAZE, ctx.sunH || { x: 0.8, y: 0.6 });
      ctx.scene.add(S.ridges);

      S.bloom = new THREE.Sprite(new THREE.SpriteMaterial({ map: bloomTex(THREE), blending: THREE.AdditiveBlending,
        transparent: true, depthWrite: false, depthTest: false, fog: false, opacity: T.BLOOM_OPACITY }));
      S.bloom.scale.set(T.BLOOM_SCALE, T.BLOOM_SCALE, 1); S.bloom.renderOrder = 40; S.bloom.frustumCulled = false;
      ctx.scene.add(S.bloom);

      if (q > 0) { S.flare = buildFlare(THREE); ctx.scene.add(S.flare); }
      S.sunDir = sunDir;
      S.drift = 0;
    },
    onHole: function (ctx, hole) {
      if (!S.ridges || !hole || !hole.bounds) return;
      var b = hole.bounds;
      S.ridges.position.set((b.x0 + b.x1) / 2, 0, -(b.y0 + b.y1) / 2);
    },
    update: function (ctx, dt) {
      if (!S.dome || !ctx.camPos) return;
      var cp = ctx.camPos;
      S.dome.position.copy(cp);
      S.bloom.position.copy(cp).addScaledVector(S.sunDir, 5000);

      // clouds: wind drift (game coords -> three xz) + tiny camera parallax
      var off = S.u.uOff.value, w = ctx.wind || { x: 0, y: 1, mph: 0 };
      if (!ctx.reduced) {
        var sp = T.DRIFT * (0.35 + (w.mph || 0) / 10) * dt;
        S.ox = (S.ox || 0) + (w.x || 0) * sp; S.oz = (S.oz || 0) - (w.y || 0) * sp;
      }
      off.set((S.ox || 0) + cp.x * T.PARALLAX, (S.oz || 0) + cp.z * T.PARALLAX);

      // birdie swell
      var sw = 0;
      if (S.swellT > 0) { S.swellT = Math.max(0, S.swellT - dt); var k = Math.sin(Math.PI * (1 - S.swellT / 4)); sw = k * k * T.SWELL; }
      S.u.uSwell.value = sw;
      S.bloom.material.opacity = T.BLOOM_OPACITY * (1 + sw * 1.4);

      // lens ghosts
      if (S.flare) {
        var cam = ctx.camera, look = ctx.camLook, amt = 0;
        if (look) {
          S.fw.copy(look).sub(cp).normalize();
          if (S.fw.dot(S.sunDir) > 0.2) {
            S.v.copy(cp).addScaledVector(S.sunDir, 1000).project(cam);
            var ax = Math.abs(S.v.x), ay = Math.abs(S.v.y);
            amt = (1 - Math.min(1, Math.max(0, (ax - 0.75) / 0.35))) * (1 - Math.min(1, Math.max(0, (ay - 0.8) / 0.3)));
            S.flare.material.uniforms.uSunNdc.value.set(S.v.x, S.v.y);
          }
        }
        S.flare.material.uniforms.uAspect.value = (ctx.viewW && ctx.viewH) ? ctx.viewW / ctx.viewH : (cam.aspect || 0.5);
        S.flare.material.uniforms.uAmt.value = amt * T.FLARE * (1 + sw);
        S.flare.visible = amt > 0.002;
      }
    },
    onEvent: function (ctx, type, data) {
      if (type === 'score' && data && data.diff < 0) S.swellT = 4;
    }
  });
})();
