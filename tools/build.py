#!/usr/bin/env python3
"""Build the single-file game page.

  python3 tools/build.py                        # src/ + every module in fx/  -> dist/index.html
  python3 tools/build.py --from base --fx water --out dist/dev-water.html
  python3 tools/build.py --fx none              # no effect modules at all

--from  which copy of the game to build from: 'src' (live) or 'base' (frozen snapshot for module work)
--fx    comma-separated module names (files fx/<name>.js), 'all' (default) or 'none'
--out   output file
"""
import argparse, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
ap = argparse.ArgumentParser()
ap.add_argument('--from', dest='src', default='src')
ap.add_argument('--fx', default='all')
ap.add_argument('--out', default='dist/index.html')
a = ap.parse_args()
src = root / a.src
ORDER = ['audio', 'sky', 'ground', 'water', 'trees', 'strike']
if a.fx == 'all':
    names = [n for n in ORDER if (root / 'fx' / (n + '.js')).exists()]
    names += sorted(p.stem for p in (root / 'fx').glob('*.js') if p.stem not in ORDER)
elif a.fx in ('none', ''):
    names = []
else:
    names = [n.strip() for n in a.fx.split(',') if n.strip()]
fx = '\n'.join('/* ---- fx/%s.js ---- */\n%s' % (n, (root / 'fx' / (n + '.js')).read_text()) for n in names)
t = (src / 'index.template.html').read_text()
ui = (src / 'ui3d.js').read_text()
out = (t.replace('/*__CSS__*/', (src / 'style.css').read_text())
        .replace('/*__CORE__*/', (src / 'core3d.js').read_text())
        .replace('/*__UI__*/', 'window.DewFX = window.DewFX || [];\n' + fx + '\n' + ui))
o = root / a.out
o.parent.mkdir(parents=True, exist_ok=True)
o.write_text(out)
print('built %s (%d bytes) from %s with fx: %s' % (a.out, len(out), a.src, ', '.join(names) or 'none'))
