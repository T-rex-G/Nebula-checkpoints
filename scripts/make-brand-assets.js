/*
 * Regenerates the application icons from the product's own mark.
 *
 * They were still the previous brand: a ring with a teal dot, in colours the
 * interface no longer uses and a shape that is not the N at all. These are
 * drawn from the same four planes the dimensional mark extrudes and the same
 * sprite the sidebar and the sign-in hero use, so the icon on a home screen is
 * the mark in the product rather than a cousin of it.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

/*   node scripts/make-brand-assets.js   */

const OUT = path.join(__dirname, '..', 'public', 'assets');

/* The mark, in the plate proportions each target expects. `pad` is the share
   of the tile left clear around the mark; maskable icons need a wide margin
   because the platform may crop to a circle. */
function markup({ size, pad, radius, background }) {
  const inner = size * (1 - pad * 2);
  const offset = size * pad;
  return `<!doctype html><html><body style="margin:0">
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="deep" x1="1" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4C2FD6"/><stop offset="1" stop-color="#1A1440"/>
    </linearGradient>
    <linearGradient id="light" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#B9A8FF"/><stop offset="1" stop-color="#6D54FF"/>
    </linearGradient>
    <radialGradient id="bloom" cx="0.72" cy="0.16" r="0.9">
      <stop offset="0" stop-color="#3A1D8C"/><stop offset="1" stop-color="#0B0720"/>
    </radialGradient>
  </defs>
  ${background ? `<rect width="${size}" height="${size}" rx="${radius}" fill="url(#bloom)"/>` : ''}
  <g transform="translate(${offset} ${offset}) scale(${inner / 228}) translate(-28 -11)">
    <path d="M79 25 L40 217 L106 116 Z" fill="url(#deep)"/>
    <path d="M79 25 L106 116 L171 112 Z" fill="url(#light)"/>
    <path d="M244 23 L178 124 L205 215 Z" fill="url(#deep)"/>
    <path d="M178 124 L113 128 L205 215 Z" fill="url(#light)"/>
  </g>
</svg></body></html>`;
}

const TARGETS = [
  { file: 'icon-192.png', size: 192, pad: 0.16, radius: 42, background: true },
  { file: 'icon-512.png', size: 512, pad: 0.16, radius: 112, background: true },
  { file: 'icon-maskable-512.png', size: 512, pad: 0.26, radius: 0, background: true },
  { file: 'apple-touch-icon.png', size: 180, pad: 0.16, radius: 0, background: true }
];

(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox']
  });
  for (const target of TARGETS) {
    const page = await browser.newPage({ viewport: { width: target.size, height: target.size } });
    await page.setContent(markup(target));
    await page.waitForTimeout(120);
    await page.screenshot({ path: path.join(OUT, target.file), omitBackground: false });
    await page.close();
    process.stdout.write(`${target.file} ${target.size}x${target.size}\n`);
  }
  await browser.close();

  /* The scalable one is written as source, not captured. */
  const svg = markup({ size: 100, pad: 0.15, radius: 22, background: true })
    .replace(/^[\s\S]*?(<svg)/, '$1')
    .replace(/<\/svg>[\s\S]*$/, '</svg>\n')
    .replace(' width="100" height="100"', '');
  fs.writeFileSync(path.join(OUT, 'icon.svg'), svg);
  process.stdout.write('icon.svg\n');
})();
