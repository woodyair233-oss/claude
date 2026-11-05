// Renders the app icon, menu-bar template icons and DMG background from SVG
// using Playwright's Chromium. Output goes to build/ (committed).
//   node scripts/make-icons.cjs
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const OUT = path.resolve(__dirname, '..', 'build');

// macOS Big Sur+ icon grid: 1024 canvas, 824 squircle with ~185 corner radius.
const APP_ICON = `
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#4338ca"/>
      <stop offset="0.5" stop-color="#3b5bdb"/>
      <stop offset="1" stop-color="#0d9488"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.3" cy="0.18" r="0.75">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.32"/>
      <stop offset="0.6" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="arch" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#e0e7ff"/>
    </linearGradient>
    <linearGradient id="prompt" gradientUnits="userSpaceOnUse" x1="430" y1="548" x2="630" y2="700">
      <stop offset="0" stop-color="#99f6e4"/>
      <stop offset="1" stop-color="#5eead4"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.28"/>
    </filter>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#1e1b4b" flood-opacity="0.35"/>
    </filter>
    <clipPath id="sq"><rect x="100" y="100" width="824" height="824" rx="186"/></clipPath>
  </defs>
  <g filter="url(#shadow)">
    <rect x="100" y="100" width="824" height="824" rx="186" fill="url(#bg)"/>
  </g>
  <g clip-path="url(#sq)">
    <rect x="100" y="100" width="824" height="824" fill="url(#glow)"/>
    <!-- subtle ground line -->
    <rect x="100" y="760" width="824" height="164" fill="#0b1f3a" opacity="0.12"/>
  </g>
  <!-- the gate: two pillars and an arch -->
  <g filter="url(#soft)">
    <path d="M318 766 V488 a194 194 0 0 1 388 0 V766" fill="none" stroke="url(#arch)" stroke-width="78" stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <!-- terminal prompt inside the gate -->
  <g filter="url(#soft)">
    <path d="M430 548 l78 62 -78 62" fill="none" stroke="url(#prompt)" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M548 688 h82" fill="none" stroke="url(#prompt)" stroke-width="44" stroke-linecap="round"/>
  </g>
  <!-- glass highlight -->
  <g clip-path="url(#sq)">
    <path d="M100 100 H924 V380 C700 450 380 330 100 420 Z" fill="#ffffff" opacity="0.06"/>
  </g>
</svg>`;

const TRAY = (size) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 18 18">
  <path d="M4.2 15.2 V8.6 a4.8 4.8 0 0 1 9.6 0 V15.2" fill="none" stroke="#000" stroke-width="1.9" stroke-linecap="round"/>
  <path d="M7.1 9.6 l1.9 1.5 -1.9 1.5" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M10 13.2 h1.4" fill="none" stroke="#000" stroke-width="1.5" stroke-linecap="round"/>
</svg>`;

const DMG = (scale) => `
<html><body style="margin:0">
<div style="width:${540 * scale}px;height:${380 * scale}px;position:relative;overflow:hidden;
  background: radial-gradient(120% 120% at 0% 0%, #eef0ff 0%, #f7f7fb 45%, #eefaf8 100%);
  font-family: -apple-system, 'Inter', 'Helvetica Neue', sans-serif;">
  <div style="position:absolute;left:0;right:0;top:${34 * scale}px;text-align:center;color:#1d1d1f;font-size:${19 * scale}px;font-weight:650;letter-spacing:-0.01em">Install Gatehouse</div>
  <div style="position:absolute;left:0;right:0;top:${62 * scale}px;text-align:center;color:#6e6e76;font-size:${12.5 * scale}px">Drag the app into your Applications folder</div>
  <svg style="position:absolute;left:${232 * scale}px;top:${168 * scale}px" width="${76 * scale}" height="${44 * scale}" viewBox="0 0 76 44">
    <path d="M6 22 H62" stroke="#8b8bf0" stroke-width="5" stroke-linecap="round" stroke-dasharray="1 11"/>
    <path d="M54 10 L68 22 L54 34" fill="none" stroke="#6d5cf6" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>
  <div style="position:absolute;left:0;right:0;bottom:${18 * scale}px;text-align:center;color:#9a9aa3;font-size:${10.5 * scale}px">First launch: right-click → Open, or System Settings → Privacy &amp; Security → Open Anyway</div>
</div></body></html>`;

async function render(page, html, file, w, h, transparent = true) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html.startsWith('<svg') ? `<html><body style="margin:0;background:transparent">${html}</body></html>` : html);
  await page.screenshot({ path: file, omitBackground: transparent, clip: { x: 0, y: 0, width: w, height: h } });
  console.log('wrote', path.relative(process.cwd(), file));
}

(async () => {
  fs.mkdirSync(path.join(OUT, 'tray'), { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await render(page, APP_ICON, path.join(OUT, 'icon.png'), 1024, 1024);
  await render(page, TRAY(18), path.join(OUT, 'tray', 'trayTemplate.png'), 18, 18);
  await render(page, TRAY(36), path.join(OUT, 'tray', 'trayTemplate@2x.png'), 36, 36);
  await render(page, DMG(1), path.join(OUT, 'dmg-background.png'), 540, 380, false);
  await render(page, DMG(2), path.join(OUT, 'dmg-background@2x.png'), 1080, 760, false);
  // Small preview of the icon for docs.
  const small = await browser.newPage({ deviceScaleFactor: 1 });
  await small.setViewportSize({ width: 256, height: 256 });
  await small.setContent(`<html><body style="margin:0;background:transparent"><img src="data:image/png;base64,${fs.readFileSync(path.join(OUT, 'icon.png')).toString('base64')}" width="256" height="256"></body></html>`);
  await small.screenshot({ path: path.join(OUT, 'icon-256.png'), omitBackground: true });
  await browser.close();
})();
