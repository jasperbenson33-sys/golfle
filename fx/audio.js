/* fx/audio.js -- Dewsweeper sound: a quiet parkland course at first light.
 *
 * WHAT IT IS
 *   window.DewAudio(opts) -> api. Replaces SndBuiltin in base/ui3d.js. Every sound is synthesised with the
 *   Web Audio API; no assets, no network. The voice/graph code lives in DewAudio.Engine(ac, dest, opts), which
 *   builds on ANY context (live AudioContext or OfflineAudioContext) and takes explicit audio-clock times, so
 *   tools/audio-check.js can render and measure every sound offline. The api wrapper only gates and times.
 *
 * DESIGN
 *   Morning bed (fixed, long-lived nodes, started once):
 *     air tone   brown-noise loop -> lowpass ~260 Hz                               (a soft room-of-the-world hush)
 *     wind L/R   one pink-noise loop played by two sources at different rates/offsets -> bandpass -> pan +-0.6;
 *                gusts = two slow incommensurate sines + a damped random walk per side, level ~ (mph/12)^1.3
 *     leaves     the same pink loop -> highpass 2.6 kHz, level ~ gust^2 so it only rustles at the gust peaks
 *     -> ambBus (mode-scaled: fuller on title/summary, ducked while flying)
 *   Birds: five "individuals" made per session (species, home pan, distance, pitch); calls are one-shot voices
 *     (one oscillator per phrase, automation does the notes): two-note whistle, AM/FM trill, descending cascade,
 *     plus a distant crow or woodpecker every 20-45 s. Far birds are quieter, low-passed and sent to the reverb.
 *     Timing, pitch and tempo are randomised per call; 30 % of songs get an answer from the same bird.
 *   Impacts: layered tone + filtered-noise voices on the audio clock (see each fx function below).
 *   Roll: a fixed white-noise loop -> bandpass -> gain, retargeted with setTargetAtTime (tau 0.12 s) so it never
 *     flutters; brighter on the green.
 *   Score: soft bell/pluck notes (partials 1, 2, 3.01 with separate decays) + a bird flurry for birdie or better.
 *
 * NODE GRAPH
 *   one-shot voice: osc/noise -> gain env -> voice gain -> [lowpass] -> [pan] -> sfxBus | birdBus  (+ send -> verb)
 *   sfxBus ---------------------\
 *   ambBus (air, wind, leaves) + birdBus  --> busIn -> compressor -> limiter -> soft-clip shaper -> out(on/off) -> dest
 *   verbSend -> Convolver(generated 1.3 s stereo IR, darkening tail) -> verbRet --/
 *   The shaper is linear below 0.6 and bends asymptotically to <= 0.86, so nothing can exceed 0.9.
 *
 * VOICE CAPS
 *   One-shot voices are counted by end time. Birds start only while < MAX_SOFT voices are alive; impacts and
 *   chimes up to MAX_HARD. Each voice stops all its sources at one end time and disconnects every node in onended,
 *   so it is garbage-collectable. The bed is 6 sources total, created once.
 *
 * COST
 *   Per frame: a few comparisons; bed parameters are retargeted 5x/s. Typical load: bed (~16 nodes) + 0-3 bird
 *   voices + 1-3 impact voices. Buffers: ~1.6 MB (bed noise at 22.05 kHz, 1 s white, reverb IR).
 *
 * GATING
 *   Before init() and whenever ac.state !== 'running' every method is a silent no-op. setOn/opts.muted ramp the
 *   output gain (tau 25 ms); while off, no new voices are scheduled.
 */
(function () {
  'use strict';

  /* ======================= TUNABLES (tune by ear) ======================= */
  var T = {
    MASTER: 0.9,             // output gain when on
    COMP: { thr: -12, knee: 10, ratio: 2.5, att: 0.004, rel: 0.25 },
    LIMIT: { thr: -4, ratio: 20, att: 0.001, rel: 0.12 },
    REV_LEN: 1.3,            // seconds, generated impulse
    REV_RET: 0.55,           // reverb return level

    AIR: 0.035,              // air tone level (brown noise, pre-chain)
    WIND: 0.11,              // wind level at 12+ mph, full gust
    WIND_CALM: 0.06,         // fraction of WIND kept when calm (near silence, not dead)
    LEAVES: 0.05,            // leaf rustle at full gust
    AMB_MODE: { title: 1, summary: 1, aim: 0.8, swing: 0.7, flying: 0.45, holed: 0.85 },
    BIRD_RATE: { title: 1.3, summary: 1.3, aim: 0.9, swing: 0.5, flying: 0.3, holed: 1 },
    BIRD_GAP: [4, 10],       // seconds between songs at rate 1
    BIRD_FAR_GAP: [20, 45],  // crow / woodpecker
    BIRD_ANSWER: 0.3,        // chance the same bird answers soon after
    BIRD_G: 0.07,            // near bird peak (pre-chain)

    WHOOSH_LEAD: 0.04,       // driver/iron whoosh starts this much before contact (impact is delayed by it)
    DRIVER: 0.6, IRON: 0.6, WEDGE: 0.75, PUTT: 0.45,
    LAND: 0.5, SAND: 0.4, SPLASH: 0.55, TREE: 0.5, LIP: 0.22, CUP: 0.3,
    ROLL: 0.07,              // roll rustle at full speed
    CHIME: 0.13, CHIME_DELAY: 0.3, CHIME_SEND: 0.35,
    MAX_SOFT: 10, MAX_HARD: 24
  };

  var clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  var rnd = function (a, b) { return a + Math.random() * (b - a); };

  function Engine(ac, dest, eopts) {
    eopts = eopts || {};
    var E = {}, sr = ac.sampleRate, active = [];
    var on = eopts.on !== false;

    /* ---------- buffers ---------- */
    function loopBuf(sec, rate, kind) {
      var n = Math.floor(sec * rate), m = Math.floor(0.25 * rate), x = new Float32Array(n + m), i;
      var b0 = 0, b1 = 0, b2 = 0, last = 0;
      for (i = 0; i < n + m; i++) {
        var w = Math.random() * 2 - 1;
        if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; x[i] = last; }
        else if (kind === 'pink') { b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913; x[i] = b0 + b1 + b2 + w * 0.1848; }
        else x[i] = w;
      }
      var b = ac.createBuffer(1, n, rate), d = b.getChannelData(0), pk = 1e-9;
      for (i = 0; i < n; i++) {                  // equal-power crossfade of the overrun into the head: seamless loop
        var v = x[i];
        if (i < m) { var k = i / m; v = x[i] * Math.sqrt(k) + x[n + i] * Math.sqrt(1 - k); }
        d[i] = v; if (Math.abs(v) > pk) pk = Math.abs(v);
      }
      var s = 0.9 / pk, mean = 0;
      for (i = 0; i < n; i++) mean += d[i];
      mean /= n;
      for (i = 0; i < n; i++) d[i] = (d[i] - mean) * s;
      return b;
    }
    var slow = 22050;
    var bufBrown = loopBuf(7.1, slow, 'brown'), bufPink = loopBuf(11.3, slow, 'pink'), bufWhite = loopBuf(1, sr, 'white');

    function makeIR() {
      var len = Math.floor(sr * T.REV_LEN), b = ac.createBuffer(2, len, sr), pre = Math.floor(0.014 * sr);
      for (var c = 0; c < 2; c++) {
        var d = b.getChannelData(c), y = 0;
        for (var i = 0; i < len; i++) {
          if (i < pre) { d[i] = 0; continue; }
          var p = (i - pre) / (len - pre), k = 0.75 - 0.6 * p;           // one-pole lowpass that darkens
          y += k * ((Math.random() * 2 - 1) - y);
          d[i] = y * Math.exp(-6.9 * p) * Math.min(1, (i - pre) / (0.004 * sr));
        }
      }
      return b;
    }

    /* ---------- master chain ---------- */
    function softClip() {
      var n = 2048, c = new Float32Array(n);
      for (var i = 0; i < n; i++) {
        var x = i / (n - 1) * 2 - 1, a = Math.abs(x);
        var y = a < 0.6 ? a : 0.6 + 0.26 * Math.tanh((a - 0.6) / 0.26);
        c[i] = x < 0 ? -y : y;
      }
      return c;
    }
    var out = ac.createGain(); out.gain.value = on ? T.MASTER : 0;
    var comp = ac.createDynamicsCompressor();
    comp.threshold.value = T.COMP.thr; comp.knee.value = T.COMP.knee; comp.ratio.value = T.COMP.ratio;
    comp.attack.value = T.COMP.att; comp.release.value = T.COMP.rel;
    var lim = ac.createDynamicsCompressor();
    lim.threshold.value = T.LIMIT.thr; lim.knee.value = 0; lim.ratio.value = T.LIMIT.ratio;
    lim.attack.value = T.LIMIT.att; lim.release.value = T.LIMIT.rel;
    var clip = ac.createWaveShaper(); clip.curve = softClip();
    var busIn = ac.createGain();
    busIn.connect(comp); comp.connect(lim); lim.connect(clip); clip.connect(out); out.connect(dest || ac.destination);

    var sfx = ac.createGain(); sfx.connect(busIn);
    var amb = ac.createGain(); amb.gain.value = 0; amb.connect(busIn);
    var birdBus = ac.createGain(); birdBus.connect(busIn);   // birds follow the mode level but need no fade-in
    var verbIn = ac.createGain(), verb = ac.createConvolver(), verbRet = ac.createGain();
    verb.buffer = makeIR(); verbRet.gain.value = T.REV_RET;
    verbIn.connect(verb); verb.connect(verbRet); verbRet.connect(busIn);

    function mkPan(p) {
      if (ac.createStereoPanner) { var s = ac.createStereoPanner(); s.pan.value = clamp(p, -1, 1); return s; }
      var n = ac.createPanner(); n.panningModel = 'equalpower';
      var z = 1 - Math.abs(p);
      if (n.positionX) { n.positionX.value = p; n.positionY.value = 0; n.positionZ.value = z; } else n.setPosition(p, 0, z);
      return n;
    }
    function filt(type, f, q) { var b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q != null) b.Q.value = q; return b; }

    /* ---------- the morning bed (fixed nodes) ---------- */
    function loopSrc(buf, rate, dst) {
      var s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate || 1;
      s.connect(dst); s.start(ac.currentTime, Math.random() * buf.duration); return s;
    }
    var airG = ac.createGain(); airG.gain.value = T.AIR;
    var airF = filt('lowpass', 260, 0.5); airF.connect(airG); airG.connect(amb);
    loopSrc(bufBrown, 1, airF);
    var wind = [-0.6, 0.6].map(function (p, i) {
      var f = filt('bandpass', 700, 0.55), g = ac.createGain(), pn = mkPan(p);
      g.gain.value = 0; f.connect(g); g.connect(pn); pn.connect(amb);
      loopSrc(bufPink, i ? 0.87 : 1.0, f);
      return { f: f, g: g, ph1: rnd(0, 6.3), ph2: rnd(0, 6.3), rw: 0, gust: 0.6 };
    });
    var leafF = filt('highpass', 2600, 0.6), leafG = ac.createGain(); leafG.gain.value = 0;
    leafF.connect(leafG); leafG.connect(amb); loopSrc(bufPink, 1.13, leafF);
    var rollF = filt('bandpass', 900, 0.8), rollG = ac.createGain(); rollG.gain.value = 0;
    rollF.connect(rollG); rollG.connect(sfx); loopSrc(bufWhite, 1, rollF);

    /* ---------- one-shot voice plumbing ---------- */
    function room(hard) {
      var now = ac.currentTime, k = 0;
      for (var i = 0; i < active.length; i++) if (active[i] > now) active[k++] = active[i];
      active.length = k;
      return k < (hard ? T.MAX_HARD : T.MAX_SOFT);
    }
    function Voice(t, len, o) {
      o = o || {};
      var v = { t: t, end: t + len, nodes: [], srcs: [] };
      var g = ac.createGain(); g.gain.value = o.gain == null ? 1 : o.gain; v.nodes.push(g); v.out = g;
      var last = g;
      if (o.lp) { var f = filt('lowpass', o.lp, 0.6); last.connect(f); last = f; v.nodes.push(f); }
      if (o.pan) { var p = mkPan(o.pan); last.connect(p); last = p; v.nodes.push(p); }
      last.connect(o.bus || sfx);
      if (o.send) { var s = ac.createGain(); s.gain.value = o.send; last.connect(s); s.connect(verbIn); v.nodes.push(s); }
      return v;
    }
    function finish(v) {
      var stopAt = v.end + 0.02;
      v.srcs.forEach(function (s) { s.stop(stopAt); });
      if (v.srcs.length) v.srcs[0].onended = function () { v.nodes.forEach(function (n) { try { n.disconnect(); } catch (e) { /* gone */ } }); v.nodes = v.srcs = null; };
      active.push(v.end);
    }
    function hit(p, t, a, peak, d) {   // 0 -> peak (linear, a s) -> exp decay (d s) -> exactly 0
      peak = Math.max(peak, 2e-4);
      p.setValueAtTime(0, t); p.linearRampToValueAtTime(peak, t + a);
      p.exponentialRampToValueAtTime(1e-4, t + a + d); p.linearRampToValueAtTime(0, t + a + d + 0.006);
    }
    function gainNode(v, dst) { var g = ac.createGain(); g.gain.value = 0; g.connect(dst || v.out); v.nodes.push(g); return g; }
    function osc(v, type, f, t, dst) {
      var o = ac.createOscillator(); o.type = type || 'sine'; o.frequency.setValueAtTime(f, Math.max(0, t - 0.001));
      o.connect(dst); o.start(Math.max(0, t - 0.001)); v.srcs.push(o); v.nodes.push(o); return o;
    }
    // tone: { f, f1, glide, type, at, a, d, g, dst }
    function tn(v, o) {
      var t = v.t + (o.at || 0), g = gainNode(v, o.dst), n = osc(v, o.type, o.f, t, g);
      if (o.f1) n.frequency.exponentialRampToValueAtTime(o.f1, t + (o.glide || (o.a || 0.003) + o.d));
      hit(g.gain, t, o.a || 0.003, o.g, o.d); return n;
    }
    // noise: { at, a, d, g, type, f, f1, glide, q, dst }  (returns gain node for extra shaping)
    function nz(v, o) {
      var t = v.t + (o.at || 0), g = gainNode(v, o.dst), f = filt(o.type || 'bandpass', o.f, o.q == null ? 0.8 : o.q);
      f.frequency.setValueAtTime(o.f, t);
      if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t + (o.glide || (o.a || 0.003) + o.d));
      f.connect(g); v.nodes.push(f);
      var s = ac.createBufferSource(); s.buffer = bufWhite; s.loop = true; s.connect(f);
      s.start(Math.max(0, t - 0.001), Math.random() * 0.9); v.srcs.push(s); v.nodes.push(s);
      if (!o.grain) hit(g.gain, t, o.a || 0.003, o.g, o.d);
      else grains(g.gain, t, o.a || 0.003, o.g, o.d, o.grain);
      return g;
    }
    // granular amplitude (sand spray, leaves): random 8-24 ms steps under an exponential decay
    function grains(p, t, a, g, d, depth) {
      p.setValueAtTime(0, t); p.linearRampToValueAtTime(g, t + a);
      var tt = t + a, end = t + a + d;
      while (tt < end - 0.03) {
        tt += rnd(0.008, 0.024);
        var e = Math.exp(-3.5 * (tt - t - a) / d);
        p.linearRampToValueAtTime(g * e * (1 - depth * Math.random()), tt);
      }
      p.linearRampToValueAtTime(0, end);
    }

    /* ---------- birds ---------- */
    var birds = [
      { kind: 'two', f: rnd(3500, 4100), pan: rnd(-0.85, -0.35), far: 0.15 },
      { kind: 'trill', f: rnd(4300, 5100), pan: rnd(0.3, 0.8), far: 0.45 },
      { kind: 'desc', f: rnd(3700, 4300), pan: rnd(-0.3, 0.35), far: 0.1 },
      { kind: 'two', f: rnd(2700, 3200), pan: rnd(0.5, 0.9), far: 0.75 },
      { kind: 'desc', f: rnd(3100, 3600), pan: rnd(-0.9, -0.5), far: 0.7 }
    ];
    var farBird = { kind: Math.random() < 0.5 ? 'crow' : 'pecker', pan: rnd(-0.8, 0.8), far: 0.85 };

    E.bird = function (b, t, gm) {
      if (!room(false)) return;
      var pv = rnd(0.96, 1.04), tempo = rnd(0.9, 1.1), far = b.far, G = T.BIRD_G * (gm || 1) * (1 - 0.65 * far);
      var v, o, g, f, i, len;
      var vo = { bus: birdBus, pan: clamp(b.pan + rnd(-0.1, 0.1), -1, 1), lp: 9000 - 7200 * far, send: 0.08 + 0.45 * far };
      if (b.kind === 'two') {
        var n1 = rnd(0.17, 0.25) * tempo, gap = rnd(0.07, 0.13) * tempo, n2 = n1 * rnd(1.0, 1.4), f1 = b.f * pv, f2 = f1 * rnd(0.78, 0.86);
        len = n1 + gap + n2; v = Voice(t, len + 0.05, vo); g = gainNode(v); o = osc(v, 'sine', f1 * 0.97, t, g);
        o.frequency.exponentialRampToValueAtTime(f1, t + 0.05);
        o.frequency.setValueAtTime(f2 * 1.02, t + n1 + gap * 0.5); o.frequency.exponentialRampToValueAtTime(f2 * 0.98, t + len);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(G, t + 0.025); g.gain.linearRampToValueAtTime(G * 0.8, t + n1 - 0.03); g.gain.linearRampToValueAtTime(0, t + n1);
        g.gain.setValueAtTime(0, t + n1 + gap); g.gain.linearRampToValueAtTime(G * 0.9, t + n1 + gap + 0.025);
        g.gain.linearRampToValueAtTime(G * 0.6, t + len - 0.04); g.gain.linearRampToValueAtTime(0, t + len);
      } else if (b.kind === 'trill') {
        len = rnd(0.6, 1.1) * tempo; f = b.f * pv; v = Voice(t, len + 0.05, vo);
        var env = gainNode(v), am = ac.createGain(); am.gain.value = 0.5; am.connect(env); v.nodes.push(am);
        o = osc(v, 'sine', f, t, am); o.frequency.linearRampToValueAtTime(f * 0.9, t + len);
        var la = ac.createGain(); la.gain.value = 0.5; la.connect(am.gain); v.nodes.push(la);      // AM depth
        var lg = ac.createGain(); lg.gain.value = f * 0.05; lg.connect(o.frequency); v.nodes.push(lg); // FM depth
        var lfo = osc(v, 'sine', rnd(19, 27), t, la); lfo.connect(lg);
        env.gain.setValueAtTime(0, t); env.gain.linearRampToValueAtTime(G, t + 0.08);
        env.gain.linearRampToValueAtTime(G * 0.7, t + len - 0.12); env.gain.linearRampToValueAtTime(0, t + len);
      } else if (b.kind === 'desc') {
        var n = 5 + Math.floor(Math.random() * 4), dt = rnd(0.095, 0.13) * tempo, nl = dt * 0.68;
        len = n * dt; v = Voice(t, len + 0.05, vo); g = gainNode(v); o = osc(v, 'sine', b.f * pv * 1.1, t, g);
        for (i = 0; i < n; i++) {
          var ti = t + i * dt, fi = b.f * pv * 1.12 * Math.pow(0.66, i / (n - 1));
          o.frequency.setValueAtTime(fi * 1.08, ti); o.frequency.exponentialRampToValueAtTime(fi * 0.95, ti + nl);
          g.gain.setValueAtTime(0, ti); g.gain.linearRampToValueAtTime(G * (1 - 0.35 * i / n), ti + 0.012); g.gain.linearRampToValueAtTime(0, ti + nl);
        }
      } else if (b.kind === 'crow') {
        var c = 2 + Math.floor(Math.random() * 2), cl = 0.3 * tempo, cg = 0.26 * tempo; f = 430 * pv;
        len = c * (cl + cg); v = Voice(t, len, vo);
        var bp = filt('bandpass', 1150, 1.4); g = gainNode(v); bp.connect(g); v.nodes.push(bp);
        o = osc(v, 'sawtooth', f, t, bp);
        for (i = 0; i < c; i++) {
          var ci = t + i * (cl + cg);
          o.frequency.setValueAtTime(f * 1.08, ci); o.frequency.exponentialRampToValueAtTime(f * 0.82, ci + cl);
          g.gain.setValueAtTime(0, ci); g.gain.linearRampToValueAtTime(G * 1.3, ci + 0.03);
          g.gain.linearRampToValueAtTime(G * 0.95, ci + cl - 0.06); g.gain.linearRampToValueAtTime(0, ci + cl);
        }
      } else { // woodpecker drum
        var taps = 12 + Math.floor(Math.random() * 7), iv = rnd(0.052, 0.064); f = 1150 * pv;
        len = taps * iv + 0.05; v = Voice(t, len, vo); g = gainNode(v); o = osc(v, 'triangle', f, t, g);
        for (i = 0; i < taps; i++) {
          var tk = t + i * iv * (1 - 0.15 * i / taps);
          o.frequency.setValueAtTime(f * (1 - 0.08 * i / taps), tk);
          hit(g.gain, tk, 0.002, G * 1.4 * (1 - 0.5 * i / taps), 0.025);
        }
      }
      finish(v);
    };
    E.birdKinds = function () { return birds.concat([farBird]); };

    /* ---------- the bed: levels ---------- */
    var bedT = 0, bedAcc = 0, songT = rnd(1.5, 4), farT = rnd(12, 25), lastSong = null, mph = 0, mode = 'title', ambNow = -1;
    E.bed = function (windMph, md, immediate) {
      mph = clamp(+windMph || 0, 0, 20); mode = md || 'title';
      var now = ac.currentTime, tau = immediate ? 0.001 : 0.6;
      var amt = clamp((mph - 1.5) / 10.5, 0, 1), wl = T.WIND * Math.max(T.WIND_CALM, Math.pow(amt, 1.3));
      var am = T.AMB_MODE[mode] == null ? 0.8 : T.AMB_MODE[mode];
      if (am !== ambNow) { amb.gain.setTargetAtTime(am, now, immediate ? 0.001 : 0.8); birdBus.gain.setTargetAtTime(am, now, immediate ? 0.001 : 0.8); ambNow = am; }
      var gl = 0;
      wind.forEach(function (w) {
        if (!immediate) {
          w.rw = clamp(w.rw * 0.97 + (Math.random() - 0.5) * 0.08, -0.25, 0.25);
          w.gust = clamp(0.58 + 0.27 * Math.sin(0.11 * bedT + w.ph1) + 0.15 * Math.sin(0.37 * bedT + w.ph2) + w.rw, 0.12, 1.2);
        } else w.gust = 1;
        w.g.gain.setTargetAtTime(wl * w.gust, now, tau);
        w.f.frequency.setTargetAtTime(420 + 650 * w.gust * (0.4 + 0.6 * amt), now, tau);
        gl += w.gust * 0.5;
      });
      leafG.gain.setTargetAtTime(T.LEAVES * amt * gl * gl, now, tau);
    };
    E.tick = function (dt, info) {
      dt = clamp(+dt || 0, 0, 0.25); bedT += dt; bedAcc += dt;
      var md = (info && info.mode) || mode, w = info ? info.windMph : mph;
      if (bedAcc >= 0.2 || md !== mode) { bedAcc = 0; E.bed(w, md, false); }
      var rate = T.BIRD_RATE[mode] == null ? 1 : T.BIRD_RATE[mode], now = ac.currentTime;
      songT -= dt * rate; farT -= dt * rate;
      if (songT <= 0) {
        var b = (lastSong && Math.random() < T.BIRD_ANSWER) ? lastSong : birds[Math.floor(Math.random() * birds.length)];
        E.bird(b, now + 0.02);
        lastSong = (b === lastSong) ? null : b;
        songT = lastSong ? rnd(0.9, 1.8) : rnd(T.BIRD_GAP[0], T.BIRD_GAP[1]);
      }
      if (farT <= 0) { E.bird(farBird, now + 0.02); farT = rnd(T.BIRD_FAR_GAP[0], T.BIRD_FAR_GAP[1]); }
    };

    /* ---------- roll ---------- */
    var rollLast = -1, rollLie = -1;
    E.roll = function (speed, lie) {
      var s = clamp((+speed || 0) / 18, 0, 1), green = lie === 4, target = T.ROLL * Math.pow(s, 1.3) * (green ? 0.85 : 1);
      if (Math.abs(target - rollLast) < 0.0015 && lie === rollLie) return;
      var now = ac.currentTime;
      rollG.gain.setTargetAtTime(target, now, 0.12);
      rollF.frequency.setTargetAtTime(green ? 2300 + 900 * s : 750 + 500 * s, now, 0.12);
      rollF.Q.setTargetAtTime(green ? 1.1 : 0.7, now, 0.12);
      rollLast = target; rollLie = lie;
    };

    /* ---------- impacts ---------- */
    E.swing = function (t, power, club) {
      if (!room(true)) return;
      var p = clamp(+power || 0, 0, 1), k = 0.25 + 0.75 * p, v, ti;
      if (club === 'driver') {
        var G = T.DRIVER * k, L = T.WHOOSH_LEAD; ti = t + L;
        v = Voice(t, L + 0.3, { send: 0.12 });
        nz(v, { at: 0, a: L * 0.9, d: 0.03, g: G * 0.22 * k, type: 'bandpass', f: 450, f1: 2400, glide: L + 0.02, q: 1.1 });   // air whoosh
        nz(v, { at: L, a: 0.001, d: 0.035, g: G * 0.55, type: 'highpass', f: 2600, q: 0.7 });                                 // crack
        tn(v, { at: L, f: 3150, d: 0.09, g: G * 0.16 });                                                                        // metallic ring
        tn(v, { at: L, f: 4870, d: 0.07, g: G * 0.11 });
        tn(v, { at: L, f: 6620, d: 0.05, g: G * 0.07 });
        tn(v, { at: L, f: 125, f1: 52, d: 0.15, g: G * 0.6, a: 0.002 });                                                        // low thump
        nz(v, { at: L, a: 0.001, d: 0.045, g: G * 0.3, type: 'bandpass', f: 900, q: 1.2 });                                    // body
      } else if (club === 'wedge') {
        var Gw = T.WEDGE * k; v = Voice(t, 0.3, { send: 0.06 });
        nz(v, { at: 0, a: 0.001, d: 0.022, g: Gw * 0.4, type: 'bandpass', f: 2400, q: 1 });                                    // soft click
        tn(v, { at: 0, f: 170, f1: 95, d: 0.08, g: Gw * 0.55, a: 0.002 });                                                      // thud
        nz(v, { at: 0.005, a: 0.01, d: 0.22, g: Gw * 0.38, type: 'bandpass', f: 1300, f1: 480, q: 0.9, grain: 0.5 });          // turf brush
      } else {
        var Gi = T.IRON * k, Li = T.WHOOSH_LEAD * 0.7; ti = t + Li;
        v = Voice(t, Li + 0.25, { send: 0.08 });
        nz(v, { at: 0, a: Li * 0.9, d: 0.02, g: Gi * 0.13 * k, type: 'bandpass', f: 600, f1: 2200, glide: Li + 0.01, q: 1.1 });
        nz(v, { at: Li, a: 0.001, d: 0.02, g: Gi * 0.55, type: 'bandpass', f: 3800, q: 1.4 });                                // click
        tn(v, { at: Li, f: 2520, d: 0.035, g: Gi * 0.14 });
        tn(v, { at: Li, f: 160, f1: 78, d: 0.09, g: Gi * 0.65, a: 0.002 });                                                     // thud
        nz(v, { at: Li + 0.004, a: 0.004, d: 0.08, g: Gi * 0.22, type: 'lowpass', f: 1500, q: 0.6 });                          // turf
      }
      finish(v);
    };
    E.putt = function (t, power) {
      if (!room(true)) return;
      var G = T.PUTT * (0.4 + 0.6 * clamp(+power || 0, 0, 1)), v = Voice(t, 0.12, {});
      var lp = filt('lowpass', 1900, 0.7); lp.connect(v.out); v.nodes.push(lp);
      tn(v, { f: 930, f1: 860, d: 0.06, g: G * 0.6, dst: lp });
      tn(v, { f: 1480, d: 0.028, g: G * 0.2, dst: lp });
      nz(v, { a: 0.001, d: 0.014, g: G * 0.35, type: 'bandpass', f: 1100, q: 2.5, dst: lp });
      finish(v);
    };
    E.land = function (t, lie, speed) {
      if (!room(true)) return;
      var s = clamp(((+speed || 15) - 5) / 30, 0, 1), G = T.LAND * (0.3 + 0.7 * s);
      var f0 = [92, 118, 124, 120, 150][lie] || 110, bright = [650, 1100, 1300, 1150, 1900][lie] || 900;
      var v = Voice(t, 0.32, {});
      tn(v, { f: f0 * (1 + 0.2 * s), f1: f0 * 0.62, d: 0.1 + 0.04 * s, g: G * 0.7, a: 0.003 });
      nz(v, { a: 0.002, d: 0.06 + 0.03 * s, g: G * 0.35, type: 'lowpass', f: bright, q: 0.6 });
      if (lie === 0) nz(v, { at: 0.01, a: 0.015, d: 0.22, g: G * 0.2, type: 'bandpass', f: 2600, f1: 1500, q: 0.7, grain: 0.6 });     // grass swish
      if (lie === 4) nz(v, { a: 0.001, d: 0.012, g: G * 0.18, type: 'bandpass', f: 2400, q: 1.5 });                                  // crisp green
      finish(v);
    };
    E.sand = function (t) {
      if (!room(true)) return;
      var G = T.SAND, v = Voice(t, 0.45, {});
      nz(v, { a: 0.004, d: 0.38, g: G * 0.55, type: 'bandpass', f: 3200, f1: 2200, q: 0.6, grain: 0.75 });   // dry spray
      nz(v, { a: 0.002, d: 0.07, g: G * 0.5, type: 'lowpass', f: 700, q: 0.6 });                            // soft bed thump
      tn(v, { f: 140, f1: 90, d: 0.07, g: G * 0.3 });
      finish(v);
    };
    E.splash = function (t) {
      if (!room(true)) return;
      var G = T.SPLASH, v = Voice(t, 1.3, { send: 0.25 }), i;
      tn(v, { f: 560, f1: 130, d: 0.14, g: G * 0.45, a: 0.004 });                                             // plunge
      nz(v, { a: 0.006, d: 0.38, g: G * 0.5, type: 'lowpass', f: 2800, f1: 650, q: 0.7, grain: 0.35 });     // body of water
      nz(v, { at: 0.12, a: 0.08, d: 1.0, g: G * 0.12, type: 'lowpass', f: 900, f1: 400, q: 0.5 });          // tail
      var dg = gainNode(v), d = osc(v, 'sine', 1800, t + 0.08, dg), tt = t + 0.08;                           // droplets
      for (i = 0; i < 9; i++) {
        tt += rnd(0.03, 0.09); var fd = rnd(1300, 3200);
        d.frequency.setValueAtTime(fd, tt); d.frequency.exponentialRampToValueAtTime(fd * 1.5, tt + 0.035);
        hit(dg.gain, tt, 0.002, G * rnd(0.06, 0.13) * (1 - i / 12), 0.03);
      }
      finish(v);
    };
    E.tree = function (t) {
      if (!room(true)) return;
      var G = T.TREE, v = Voice(t, 0.85, { pan: rnd(-0.25, 0.25), send: 0.12 });
      tn(v, { f: 390, f1: 330, d: 0.09, g: G * 0.5, a: 0.001 });                                           // woody knock
      tn(v, { f: 720, f1: 690, d: 0.05, g: G * 0.25, a: 0.001 });
      tn(v, { f: 1180, d: 0.03, g: G * 0.12, type: 'triangle', a: 0.001 });
      nz(v, { a: 0.001, d: 0.02, g: G * 0.3, type: 'bandpass', f: 1800, q: 1.2 });
      nz(v, { at: 0.03, a: 0.06, d: 0.7, g: G * 0.22, type: 'highpass', f: 2800, q: 0.6, grain: 0.8 });   // leaves
      finish(v);
    };
    E.lip = function (t) {
      if (!room(true)) return;
      var G = T.LIP, v = Voice(t, 0.1, {});
      tn(v, { f: 2350, d: 0.06, g: G * 0.5, a: 0.001 });
      tn(v, { f: 3570, d: 0.04, g: G * 0.3, a: 0.001 });
      tn(v, { f: 5120, d: 0.025, g: G * 0.15, a: 0.001 });
      tn(v, { f: 720, d: 0.03, g: G * 0.3, a: 0.001 });
      finish(v);
    };
    E.cup = function (t) {
      if (!room(true)) return;
      var G = T.CUP, v = Voice(t, 0.6, { send: 0.08 }), rt = [0, 0.065, 0.11, 0.145, 0.17];
      var rg = gainNode(v), r = osc(v, 'sine', 1240, t, rg), r2g = gainNode(v), r2 = osc(v, 'sine', 1870, t, r2g);
      rt.forEach(function (x, i) {                                              // rattle round the rim (hollow ticks)
        var a = G * (0.5 - 0.06 * i), q = rnd(0.97, 1.03);
        r.frequency.setValueAtTime(1240 * q, t + x); r2.frequency.setValueAtTime(1870 * q, t + x);
        hit(rg.gain, t + x, 0.001, a * 0.5, 0.018); hit(r2g.gain, t + x, 0.001, a * 0.25, 0.012);
      });
      var dt = 0.22;                                                            // the drop
      tn(v, { at: dt, f: 270, f1: 175, d: 0.2, g: G * 0.8, a: 0.002 });
      nz(v, { at: dt, a: 0.001, d: 0.12, g: G * 0.45, type: 'bandpass', f: 430, q: 4 });
      tn(v, { at: dt + 0.13, f: 240, f1: 180, d: 0.12, g: G * 0.3, a: 0.002 }); // little settle bounce
      finish(v);
    };

    /* ---------- score moments ---------- */
    function bell(v, f, at, g, len) {
      tn(v, { at: at, f: f, d: len, g: g, a: 0.005 });
      tn(v, { at: at, f: f * 2, d: len * 0.45, g: g * 0.28, a: 0.004 });
      tn(v, { at: at, f: f * 3.01, d: len * 0.22, g: g * 0.08, a: 0.003 });
    }
    E.chime = function (t, diff) {
      if (!room(true)) return;
      diff = Math.round(clamp(+diff || 0, -3, 4)); t += T.CHIME_DELAY;
      var G = T.CHIME, v, i;
      if (diff <= -1) {
        var notes = diff <= -2 ? [587.33, 739.99, 880, 1174.66, 1479.98] : [587.33, 739.99, 880, 1174.66];
        if (diff <= -3) notes.push(1760);
        var sp = diff <= -2 ? 0.13 : 0.15, len = notes.length * sp + 2.0;
        v = Voice(t, len, { send: T.CHIME_SEND });
        notes.forEach(function (f, k) {
          bell(v, f, k * sp, G * (0.85 + 0.15 * k / notes.length), 1.5);
          if (diff <= -2) tn(v, { at: k * sp + 0.06, f: f * 4.007, d: 0.9, g: G * 0.05, a: 0.02 });   // shimmer
        });
        finish(v);
        var near = birds.filter(function (b) { return b.far < 0.5; }), nf = diff <= -2 ? 5 : 3;
        for (i = 0; i < nf; i++) E.bird(near[i % near.length], t + 0.5 + i * rnd(0.35, 0.55), 1.3);
      } else if (diff === 0) {
        v = Voice(t, 2.2, { send: T.CHIME_SEND });
        bell(v, 440, 0, G * 0.85, 1.4); bell(v, 587.33, 0.32, G * 0.9, 1.7);
        finish(v);
      } else {
        v = Voice(t, 2.3, { send: T.CHIME_SEND * 0.8 });
        tn(v, { f: 293.66, d: 2.1, g: G * 0.8, a: 0.03 });
        tn(v, { f: 587.33, d: 0.9, g: G * 0.12, a: 0.03 });
        finish(v);
      }
    };

    E.setOn = function (v) {
      on = !!v; var now = ac.currentTime, p = out.gain;
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(now); else { p.cancelScheduledValues(now); p.setValueAtTime(p.value, now); }
      p.setTargetAtTime(on ? T.MASTER : 0, now, 0.025);
    };
    E.T = T;
    return E;
  }

  window.DewAudio = function (opts) {
    var ac = null, E = null, on = !(opts && opts.muted);
    function live() { return !!E && ac.state === 'running'; }
    function ok() { return on && live(); }
    function now() { return ac.currentTime + 0.005; }
    return {
      init: function () {
        if (!ac) {
          var AC = window.AudioContext || window.webkitAudioContext;
          if (!AC) return;
          try { ac = new AC(); E = Engine(ac, ac.destination, { on: on }); } catch (e) { ac = null; E = null; return; }
        }
        if (ac.state !== 'running' && ac.resume) { var p = ac.resume(); if (p && p.catch) p.catch(function () {}); }
      },
      setOn: function (v) { on = !!v; if (E) E.setOn(on); },
      isOn: function () { return on; },
      tick: function (dt, info) { if (ok()) E.tick(dt, info); },
      swing: function (power, club) { if (ok()) E.swing(now(), power, club); },
      putt: function (power) { if (ok()) E.putt(now(), power); },
      land: function (lie, speed) { if (ok()) E.land(now(), lie, speed); },
      sand: function () { if (ok()) E.sand(now()); },
      splash: function () { if (ok()) E.splash(now()); },
      tree: function () { if (ok()) E.tree(now()); },
      lip: function () { if (ok()) E.lip(now()); },
      cup: function () { if (ok()) E.cup(now()); },
      roll: function (speed, lie) { if (ok()) E.roll(speed, lie); else if (live()) E.roll(0, lie); },
      chime: function (diff) { if (ok()) E.chime(now(), diff); }
    };
  };
  window.DewAudio.Engine = Engine;
})();
