/* Bot-plays many daily courses to check fairness, scoring spread and round length. */
const C = require('../src/core.js');
const T = C.T;

function gauss(rng) { // Box-Muller
  const u = Math.max(1e-9, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function pathRemaining(h, p) {
  const direct = C.dist(p, h.pin);
  let clear = true;
  for (let d = 3; d < direct; d += 3) {
    if (C.blockedAt(h, p.x + ((h.pin.x - p.x) * d) / direct, p.y + ((h.pin.y - p.y) * d) / direct)) { clear = false; break; }
  }
  if (clear) return direct;
  let best = 1e9;
  const P = h.path;
  const segLen = []; for (let i = 0; i < P.length - 1; i++) segLen.push(C.dist(P[i], P[i + 1]));
  for (let i = 0; i < P.length - 1; i++) {
    const ax = P[i].x, ay = P[i].y, dx = P[i + 1].x - ax, dy = P[i + 1].y - ay;
    let t = ((p.x - ax) * dx + (p.y - ay) * dy) / (dx * dx + dy * dy); t = Math.max(0, Math.min(1, t));
    const qx = ax + dx * t, qy = ay + dy * t;
    let rem = Math.hypot(p.x - qx, p.y - qy) + segLen[i] * (1 - t);
    for (let j = i + 1; j < segLen.length; j++) rem += segLen[j];
    best = Math.min(best, rem);
  }
  return best + 8;
}
/* fast planner: analytic landing + roll estimate */
function planSwing(h, ball, windScale) {
  const info = C.shotInfo(h, ball);
  const base = Math.atan2(h.pin.x - ball.x, h.pin.y - ball.y);
  let best = null;
  for (let da = -1.3; da <= 1.3; da += 0.04) {
    for (let p = 0.2; p <= 1.0001; p += 0.04) {
      const a = base + da, dir = { x: Math.sin(a), y: Math.cos(a) };
      const Cy = Math.max(2, p * info.max);
      const k = h.wind.mph * C.PHYS.WIND_K * Math.pow(Cy / 225, 0.85) * windScale;
      let ok = true;
      for (let d = 2; d <= Cy; d += 3) {
        const u = d / Cy;
        if (C.blockedAt(h, ball.x + dir.x * d + h.wind.x * k * u * u, ball.y + dir.y * d + h.wind.y * k * u * u)) { ok = false; break; }
      }
      if (!ok) continue;
      const lx = ball.x + dir.x * Cy + h.wind.x * k, ly = ball.y + dir.y * Cy + h.wind.y * k;
      const ter = C.terrainAt(h, lx, ly);
      let cost;
      if (ter === T.WATER) cost = pathRemaining(h, ball) + 70;
      else {
        const R = C.rollOut(ter, Cy);
        let ex = lx + dir.x * R, ey = ly + dir.y * R;
        if (C.blockedAt(h, ex, ey)) { ex = lx; ey = ly; }
        let et = C.terrainAt(h, ex, ey);
        for (let q = 0.25; q < 1; q += 0.25) if (C.terrainAt(h, lx + dir.x * R * q, ly + dir.y * R * q) === T.WATER) et = T.WATER;
        if (et === T.WATER) cost = pathRemaining(h, ball) + 70;
        else if (et === T.GREEN) cost = C.dist({ x: ex, y: ey }, h.pin) * 0.5;
        else cost = pathRemaining(h, { x: ex, y: ey }) + (et === T.ROUGH ? 12 : et === T.SAND ? 28 : 0);
        // safety margin: penalise landing near water
        for (let q = 0; q < 6; q++) { const an = q * 1.047; if (C.terrainAt(h, lx + Math.cos(an) * 9, ly + Math.sin(an) * 9) === T.WATER) { cost += 6; } }
      }
      if (!best || cost < best.cost) best = { a, p, cost };
    }
  }
  return best || { a: base + Math.PI, p: 0.3, cost: 999 };
}
function planPutt(h, ball, slopeScale) {
  const hh = Object.assign({}, h, { slope: { x: h.slope.x * slopeScale, y: h.slope.y * slopeScale } });
  const base = Math.atan2(h.pin.x - ball.x, h.pin.y - ball.y);
  let best = null;
  const tryIt = (a, p) => {
    const r = C.runShot(hh, ball, a, p, true);
    const cost = r.kind === 'holed' ? -1 : C.dist(r, h.pin);
    if (!best || cost < best.cost) best = { a, p, cost };
  };
  for (let da = -0.4; da <= 0.4; da += 0.05) for (let p = 0.2; p <= 1; p += 0.06) tryIt(base + da, p);
  const c = { a: best.a, p: best.p };
  for (let da = -0.05; da <= 0.05; da += 0.008) for (let dp = -0.06; dp <= 0.06; dp += 0.012) tryIt(c.a + da, Math.max(0.03, Math.min(1, c.p + dp)));
  return best;
}
function playHole(h, skill, rng) {
  let ball = { x: h.tee.x, y: h.tee.y }, strokes = 0, secs = 0, trail = '';
  while (true) {
    const info = C.shotInfo(h, ball);
    const plan = info.putt ? planPutt(h, ball, skill.read) : planSwing(h, ball, skill.wind);
    let a = plan.a + gauss(rng) * (info.putt ? skill.pang : skill.ang) * Math.PI / 180;
    if (info.sway) a += (rng() * 2 - 1) * info.sway * skill.sway * Math.PI / 180;
    const p = Math.max(0.05, Math.min(1, plan.p * (1 + gauss(rng) * skill.pow)));
    const s = C.createShot(h, ball, a, p, true);
    let n = 0; while (!s.done && n < 6000) { C.stepShot(h, s); n++; }
    secs += n * C.PHYS.DT;
    strokes++;
    const r = s.result;
    if (r.kind === 'holed') { trail += 'H'; return { score: strokes, secs, trail, shots: strokes }; }
    if (r.kind === 'water') { strokes++; trail += 'W'; }
    else { ball = { x: r.x, y: r.y }; trail += r.tree ? 'T' : 'RFFFGSW'[r.lie]; }
    if (strokes >= h.par + 3) return { score: h.par + 4, secs, trail: trail + 'X', shots: strokes, pickup: true };
  }
}

const SKILLS = {
  expert: { ang: 0.5, pang: 0.4, pow: 0.012, wind: 1, read: 1, sway: 0.15 },
  regular: { ang: 1.1, pang: 1.0, pow: 0.03, wind: 0.7, read: 0.7, sway: 0.45 },
  newbie: { ang: 2.2, pang: 2.0, pow: 0.06, wind: 0.2, read: 0.3, sway: 0.9 }
};

const DAYS = +(process.argv[2] || 40);
const start = new Date(2026, 10, 10);
const stats = {};
for (const k of Object.keys(SKILLS)) stats[k] = { rounds: [], byPar: { 3: [], 4: [], 5: [] }, names: {}, pick: 0, secs: [], swings: [] };
const flagged = [];
let genFail = 0;
const t0 = Date.now();
for (let d = 0; d < DAYS; d++) {
  const dt = new Date(start.getTime() + d * 86400000);
  const key = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  const round = C.makeRound(key);
  round.holes.forEach((h, i) => { if (!C.validate(h)) { genFail++; flagged.push(key + ' hole ' + (i + 1) + ' INVALID'); } });
  for (const [name, skill] of Object.entries(SKILLS)) {
    const rng = C.makeRng(C.hashStr(name + key));
    const reps = name === 'expert' ? 1 : 3;
    for (let rep = 0; rep < reps; rep++) {
      let total = 0, secs = 0, swings = 0;
      round.holes.forEach((h, i) => {
        const r = playHole(h, skill, rng);
        total += r.score; secs += r.secs; swings += r.shots;
        stats[name].byPar[h.par].push(r.score - h.par);
        const nm = C.scoreName(h.par, r.score); stats[name].names[nm] = (stats[name].names[nm] || 0) + 1;
        if (r.pickup) stats[name].pick++;
        if (name === 'expert' && r.score >= h.par + 2) flagged.push(key + ' hole ' + (i + 1) + ' par ' + h.par + ' expert took ' + r.score + ' ' + r.trail);
      });
      stats[name].rounds.push(total - round.par); stats[name].secs.push(secs); stats[name].swings.push(swings);
    }
  }
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const hist = (a) => { const m = {}; a.forEach((v) => (m[v] = (m[v] || 0) + 1)); return Object.keys(m).map(Number).sort((x, y) => x - y).map((k) => C.toPar(k) + ':' + m[k]).join('  '); };
console.log('days', DAYS, 'invalid holes', genFail, 'elapsed', ((Date.now() - t0) / 1000).toFixed(1) + 's');
for (const [name, s] of Object.entries(stats)) {
  console.log('\n== ' + name + ' ==');
  console.log(' round to par: mean', mean(s.rounds).toFixed(2), '|', hist(s.rounds));
  console.log(' by par: 3 ->', mean(s.byPar[3]).toFixed(2), ' 4 ->', mean(s.byPar[4]).toFixed(2), ' 5 ->', mean(s.byPar[5]).toFixed(2));
  console.log(' results:', JSON.stringify(s.names), 'pickups', s.pick);
  console.log(' ball-in-motion secs per round: mean', mean(s.secs).toFixed(1), 'max', Math.max(...s.secs).toFixed(1), '| swings per round', mean(s.swings).toFixed(1));
}
if (flagged.length) { console.log('\nFLAGGED (' + flagged.length + ')'); flagged.slice(0, 40).forEach((f) => console.log(' ', f)); }
