/* Bot-plays many 3D daily courses to check fairness, scoring spread and round length. */
const C = require('../src/core3d.js');
const T = C.T;
function gauss(rng) { const u = Math.max(1e-9, rng()), v = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function pathRemaining(h, p) {
  const direct = C.dist(p, h.pin);
  let clear = true;
  for (let d = 3; d < direct; d += 3) if (C.blockedAt(h, p.x + ((h.pin.x - p.x) * d) / direct, p.y + ((h.pin.y - p.y) * d) / direct)) { clear = false; break; }
  if (clear) return direct;
  let best = 1e9; const P = h.path, segLen = [];
  for (let i = 0; i < P.length - 1; i++) segLen.push(C.dist(P[i], P[i + 1]));
  for (let i = 0; i < P.length - 1; i++) {
    const ax = P[i].x, ay = P[i].y, dx = P[i + 1].x - ax, dy = P[i + 1].y - ay;
    let t = ((p.x - ax) * dx + (p.y - ay) * dy) / (dx * dx + dy * dy); t = Math.max(0, Math.min(1, t));
    let rem = Math.hypot(p.x - (ax + dx * t), p.y - (ay + dy * t)) + segLen[i] * (1 - t);
    for (let j = i + 1; j < segLen.length; j++) rem += segLen[j];
    best = Math.min(best, rem);
  }
  return best + 8;
}
function flyFast(h, ball, club, angle, power, max, windScale) {
  const L = C.launch(club, Math.max(2, power * max)), dt = 1 / 30, G = C.PHYS.G_FLY;
  const k = h.wind.mph * C.PHYS.WIND_K * C.CLUBS[club].wind * windScale;
  let x = ball.x, y = ball.y, z = C.heightAt(h, x, y), vx = Math.sin(angle) * L.vh, vy = Math.cos(angle) * L.vh, vz = L.vz;
  for (let i = 0; i < 400; i++) {
    vx += h.wind.x * k * dt; vy += h.wind.y * k * dt; vz -= G * dt; x += vx * dt; y += vy * dt; z += vz * dt;
    if (C.outside(h, x, y)) return null;
    const tr = C.treeAt(h, x, y); if (tr && z - tr.z < tr.H) return null;
    if (i > 1 && z <= C.heightAt(h, x, y)) {
      const ter = C.terrainAt(h, x, y), carry = Math.hypot(x - ball.x, y - ball.y), R = C.rollOut(club, ter, carry), l = Math.hypot(vx, vy) || 1;
      return { x, y, ter, ex: x + (vx / l) * R, ey: y + (vy / l) * R, R, ux: vx / l, uy: vy / l };
    }
  }
  return null;
}
function planSwing(h, ball, opt, windScale, wet) {
  const clubs = ['driver', 'iron', 'wedge'].filter((c) => opt.clubs[c].ok);
  const toPin = Math.atan2(h.pin.x - ball.x, h.pin.y - ball.y), ap = C.aimPoint(h, ball, 250), toAp = Math.atan2(ap.x - ball.x, ap.y - ball.y);
  const bases = Math.abs(toPin - toAp) > 0.05 ? [toPin, toAp] : [toPin];
  let best = null;
  const cands = [];
  const here = pathRemaining(h, ball);
  const score = (club, a, p) => {
    const f = flyFast(h, ball, club, a, p, opt.clubs[club].max, windScale);
    if (!f) return;
    let cost;
    if (f.ter === T.WATER) cost = here + 70;
    else {
      let ex = f.ex, ey = f.ey;
      if (C.blockedAt(h, ex, ey)) { ex = f.x; ey = f.y; }
      let et = C.terrainAt(h, ex, ey);
      for (let q = 0.25; q < 1; q += 0.25) if (C.terrainAt(h, f.x + f.ux * f.R * q, f.y + f.uy * f.R * q) === T.WATER) et = T.WATER;
      if (et === T.WATER) cost = here + 70;
      else if (et === T.GREEN) cost = C.dist({ x: ex, y: ey }, h.pin) * 0.5;
      else cost = pathRemaining(h, { x: ex, y: ey }) + (et === T.ROUGH ? 12 : et === T.SAND ? 28 : 0);
      for (let q = 0; q < 6; q++) { const an = q * 1.047; if (C.terrainAt(h, f.x + Math.cos(an) * 9, f.y + Math.sin(an) * 9) === T.WATER) cost += 6; }
    }
    cands.push({ club, a, p, cost });
    if (!best || cost < best.cost) best = { club, a, p, cost };
  };
  for (const club of clubs) for (const b of bases) for (let da = -0.5; da <= 0.5001; da += 0.0625) for (let p = 0.22; p <= 1.0001; p += 0.078) score(club, b + da, p);
  if (!best) { for (const club of clubs) for (let da = -3.1; da <= 3.1; da += 0.2) for (let p = 0.2; p <= 1; p += 0.2) score(club, toPin + da, p); }
  if (!best) return { club: opt.clubs.wedge.ok ? 'wedge' : 'iron', a: toPin + Math.PI, p: 0.3 };
  const c = best;
  for (let da = -0.05; da <= 0.0501; da += 0.0125) for (let dp = -0.06; dp <= 0.0601; dp += 0.02) score(c.club, c.a + da, Math.max(0.08, Math.min(1, c.p + dp)));
  /* a player who has watched a ball trickle into a pond: the best few are checked with the real ball (slopes included, wind as
     this player reads it) only to throw out the ones that end wet or in the trees. Reading the green stays approximate. */
  const hh = Object.assign({}, h, { wind: Object.assign({}, h.wind, { mph: h.wind.mph * windScale }) });
  cands.sort((x, y) => x.cost - y.cost);
  let pick = null;
  const dry = (q, a, p) => { const r = C.runShot(hh, ball, q.club, a, Math.max(0.05, Math.min(1, p)), true); return r.kind !== 'water' && !r.tree; };
  /* after a ball in the water from this spot, leave room for a miss as well */
  const m = wet ? 0.03 * wet : 0, am = wet ? 0.025 * wet : 0;
  for (const q of cands.slice(0, wet ? 40 : 12)) if (dry(q, q.a, q.p) && (!wet || (dry(q, q.a, q.p * (1 + m)) && dry(q, q.a, q.p * (1 - m)) && dry(q, q.a + am, q.p) && dry(q, q.a - am, q.p)))) { pick = q; break; }
  if (!pick) for (const q of cands.slice(wet ? 40 : 12, 400)) if (dry(q, q.a, q.p)) { pick = q; break; } // nothing good stays dry: find the best that does
  return pick || best;
}
function planPutt(h, ball, slopeScale) {
  const hh = Object.assign({}, h, { ter: Object.assign({}, h.ter, { gx: h.ter.gx * slopeScale, gy: h.ter.gy * slopeScale }) });
  const base = Math.atan2(h.pin.x - ball.x, h.pin.y - ball.y);
  let best = null;
  const tryIt = (a, p) => { const r = C.runShot(hh, ball, 'putter', a, p, true); const cost = r.kind === 'holed' ? -1 : C.dist(r, h.pin); if (!best || cost < best.cost) best = { a, p, cost }; };
  for (let da = -0.4; da <= 0.4; da += 0.05) for (let p = 0.2; p <= 1; p += 0.07) tryIt(base + da, p);
  const c = { a: best.a, p: best.p };
  for (let da = -0.05; da <= 0.05; da += 0.01) for (let dp = -0.06; dp <= 0.06; dp += 0.015) tryIt(c.a + da, Math.max(0.03, Math.min(1, c.p + dp)));
  return best;
}
function playHole(h, skill, rng) {
  let ball = { x: h.tee.x, y: h.tee.y }, strokes = 0, secs = 0, trail = '', clubs = '', fullDrivers = 0, retee = false, wetHere = 0;
  while (true) {
    const opt = C.clubOptions(h, ball), putt = opt.lie === T.GREEN;
    const plan = putt ? Object.assign(planPutt(h, ball, skill.read), { club: 'putter' }) : planSwing(h, ball, opt, skill.wind, wetHere);
    let a = plan.a + gauss(rng) * (putt ? skill.pang : skill.ang) * Math.PI / 180;
    const sw = opt.clubs[plan.club].sway; if (sw) a += (rng() * 2 - 1) * sw * skill.sway * Math.PI / 180;
    const p = Math.max(0.05, Math.min(1, plan.p * (1 + gauss(rng) * skill.pow)));
    if (plan.club === 'driver' && p >= 0.95 && !retee) fullDrivers++;
    const s = C.createShot(h, ball, plan.club, a, p, true);
    let n = 0; while (!s.done && n < 8000) { C.stepShot(h, s); n++; }
    secs += n * C.PHYS.DT; strokes++; clubs += plan.club[0];
    const r = s.result;
    if (r.kind === 'holed') return { score: strokes, secs, trail: trail + 'H', shots: strokes, clubs, fullDrivers };
    retee = r.kind === 'water'; wetHere = retee ? wetHere + 1 : 0;
    if (r.kind === 'water') { strokes++; trail += 'W'; } else { ball = { x: r.x, y: r.y }; trail += r.tree ? 'T' : 'RFFFGSW'[r.lie]; }
    if (C.blockedAt(h, ball.x, ball.y)) return { score: 99, secs, trail: trail + '!STUCK', shots: strokes, clubs, fullDrivers };
    if (strokes >= h.par + 3) return { score: h.par + 4, secs, trail: trail + 'X', shots: strokes, pickup: true, clubs, fullDrivers };
  }
}
const SKILLS = {
  expert: { ang: 0.5, pang: 0.4, pow: 0.012, wind: 1, read: 1, sway: 0.15 },
  regular: { ang: 1.1, pang: 1.0, pow: 0.03, wind: 0.7, read: 0.7, sway: 0.45 },
  newbie: { ang: 2.2, pang: 2.0, pow: 0.06, wind: 0.2, read: 0.3, sway: 0.9 }
};
module.exports = { playHole, planSwing, planPutt, SKILLS, pathRemaining, flyFast };
if (require.main === module) {
const DAYS = +(process.argv[2] || 14);
const start = new Date(2026, 10, 10);
const stats = {}; for (const k of Object.keys(SKILLS)) stats[k] = { rounds: [], byPar: { 3: [], 4: [], 5: [] }, names: {}, pick: 0, eagles5: 0, holes5: 0, maxFullDrivers: 0, stuck: 0, secs: [], swings: [], clubs: {} };
const flagged = []; let genFail = 0, drops = [], grads = [];
const t0 = Date.now();
for (let d = 0; d < DAYS; d++) {
  const dt = new Date(start.getTime() + d * 86400000);
  const key = dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
  const round = C.makeRound(key);
  round.holes.forEach((h, i) => {
    if (!C.validate(h)) { genFail++; flagged.push(key + ' hole ' + (i + 1) + ' INVALID'); }
    drops.push(h.drop);
    let mx = 0; for (const f of h.fairways) for (const p of f.pts) { const g = C.gradAt(h, p.x, p.y); mx = Math.max(mx, Math.hypot(g.x, g.y)); } grads.push(mx);
  });
  for (const [name, skill] of Object.entries(SKILLS)) {
    const rng = C.makeRng(C.hashStr(name + key));
    const reps = name === 'expert' ? 1 : 2;
    for (let rep = 0; rep < reps; rep++) {
      let total = 0, secs = 0, swings = 0;
      round.holes.forEach((h, i) => {
        const r = playHole(h, skill, rng);
        total += r.score; secs += r.secs; swings += r.shots;
        stats[name].byPar[h.par].push(r.score - h.par);
        const nm = C.scoreName(h.par, r.score); stats[name].names[nm] = (stats[name].names[nm] || 0) + 1;
        for (const c of r.clubs) stats[name].clubs[c] = (stats[name].clubs[c] || 0) + 1;
        if (r.pickup) stats[name].pick++;
        if (h.par === 5) { stats[name].holes5++; if (r.score <= 3) stats[name].eagles5++; }
        stats[name].maxFullDrivers = Math.max(stats[name].maxFullDrivers, r.fullDrivers);
        if (r.score === 99) stats[name].stuck++;
        if (r.score === 99 || (name === 'expert' && r.score >= h.par + 2)) flagged.push(key + ' hole ' + (i + 1) + ' par ' + h.par + ' ' + name + ' took ' + r.score + ' ' + r.trail);
      });
      stats[name].rounds.push(total - round.par); stats[name].secs.push(secs); stats[name].swings.push(swings);
    }
  }
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const hist = (a) => { const m = {}; a.forEach((v) => (m[v] = (m[v] || 0) + 1)); return Object.keys(m).map(Number).sort((x, y) => x - y).map((k) => C.toPar(k) + ':' + m[k]).join('  '); };
const gms = []; for (let d = 0; d < Math.min(DAYS, 10); d++) { const k = 'gen-' + d, t1 = Date.now(); C.makeRound(k); gms.push(Date.now() - t1); }
console.log('days', DAYS, 'invalid holes', genFail, 'gen ms per round max', Math.max(...gms), 'gen failures', JSON.stringify(C._gen.fail), 'elapsed', ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('tee-to-cup drop (ft): min', Math.min(...drops), 'max', Math.max(...drops), 'mean', mean(drops).toFixed(1), '| steepest fairway grade: mean', (mean(grads) * 100).toFixed(1) + '%', 'max', (Math.max(...grads) * 100).toFixed(1) + '%');
for (const [name, s] of Object.entries(stats)) {
  console.log('\n== ' + name + ' ==');
  console.log(' round to par: mean', mean(s.rounds).toFixed(2), '|', hist(s.rounds));
  console.log(' by par: 3 ->', mean(s.byPar[3]).toFixed(2), ' 4 ->', mean(s.byPar[4]).toFixed(2), ' 5 ->', mean(s.byPar[5]).toFixed(2));
  console.log(' par-5 eagles', s.eagles5 + '/' + s.holes5, '(' + ((100 * s.eagles5) / s.holes5).toFixed(1) + '%)', '| full-power drivers on one hole, max', s.maxFullDrivers, '| stuck', s.stuck);
  console.log(' results:', JSON.stringify(s.names), 'pickups', s.pick, 'clubs', JSON.stringify(s.clubs));
  console.log(' ball-in-motion secs per round: mean', mean(s.secs).toFixed(1), 'max', Math.max(...s.secs).toFixed(1), '| swings per round', mean(s.swings).toFixed(1));
}
if (flagged.length) { console.log('\nFLAGGED (' + flagged.length + ')'); flagged.slice(0, 40).forEach((f) => console.log(' ', f)); }
}
