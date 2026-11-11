from pathlib import Path
root = Path(__file__).parent
t = (root / 'src/index.template.html').read_text()
out = (t.replace('/*__CSS__*/', (root / 'src/style.css').read_text())
        .replace('/*__CORE__*/', (root / 'src/core.js').read_text())
        .replace('/*__UI__*/', (root / 'src/ui.js').read_text()))
(root / 'dist').mkdir(exist_ok=True)
(root / 'dist/index.html').write_text(out)
print('built', len(out), 'bytes')
