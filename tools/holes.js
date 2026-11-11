/* Print the layout of a day's three holes: node tools/holes.js 2026-11-12 [--from base] */
const path = require('path');
const from = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : 'src';
const C = require(path.join(__dirname, '..', from, 'core3d.js'));
const key = process.argv[2] || '2026-11-12';
const r = C.makeRound(key);
r.holes.forEach((h, i) => {
  const f = (n) => Math.round(n * 10) / 10;
  console.log('hole index ' + i + ': par ' + h.par + ', ' + h.yards + ' yd, wind ' + h.wind.mph + ' mph toward (' + f(h.wind.x) + ',' + f(h.wind.y) + '), trees in play ' + h.trees.length);
  console.log('  tee (' + f(h.tee.x) + ',' + f(h.tee.y) + ',' + f(h.tee.z) + ')  pin (' + f(h.pin.x) + ',' + f(h.pin.y) + ',' + f(h.pin.z) + ')  bounds x ' + f(h.bounds.x0) + '..' + f(h.bounds.x1) + ' y ' + f(h.bounds.y0) + '..' + f(h.bounds.y1));
  console.log('  path ' + h.path.map((p) => '(' + f(p.x) + ',' + f(p.y) + ')').join(' -> '));
  h.water.forEach((w, k) => console.log('  water ' + k + ': level z=' + f(h.ter.wl[k]) + ', ' + w.length + ' circles, first at (' + f(w[0].x) + ',' + f(w[0].y) + ') r=' + f(w[0].r)));
  console.log('  bunkers ' + h.bunkers.map((b) => '(' + f(b[0].x) + ',' + f(b[0].y) + ')').join(' ') + '  green lobes ' + h.green.map((g) => '(' + f(g.x) + ',' + f(g.y) + ' r' + f(g.r) + ')').join(' '));
});
