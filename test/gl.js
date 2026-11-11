const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
  const page = await browser.newPage();
  await page.route('https://cdnjs.cloudflare.com/**', (r) => r.fulfill({ path: path.join(__dirname, '..', 'vendor', 'three.min.js'), contentType: 'application/javascript' }));
  await page.setContent('<canvas id=c></canvas><script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>');
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => { try { const R = new THREE.WebGLRenderer({ canvas: document.getElementById('c') }); const gl = R.getContext(); return { rev: THREE.REVISION, webgl2: R.capabilities.isWebGL2, maxTex: R.capabilities.maxTextureSize, aniso: R.capabilities.getMaxAnisotropy(), inst: typeof THREE.InstancedMesh, vendor: gl.getParameter(gl.VERSION) }; } catch (e) { return { err: String(e) }; } });
  console.log(JSON.stringify(r));
  await browser.close();
})();
