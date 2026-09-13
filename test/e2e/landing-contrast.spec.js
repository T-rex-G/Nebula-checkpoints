'use strict';

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

/*
 * Contrast under the glyphs, measured from the pixels that were actually
 * painted.
 *
 * axe cannot do this one, and its silence is why this was needed. The
 * colour-contrast rule steps aside whenever the backdrop is an image or a
 * video and reports the node as "incomplete" rather than as a violation -- so
 * the landing copy, which sits over exactly that, was never checked by the
 * axe sweep in public-alpha-accessibility.spec.js. It measured as low as
 * 1.35:1 on the lede while that suite was green.
 *
 * Two details decide whether a check like this is worth having:
 *
 *  - Sample under the line boxes, not under the element box. A short heading
 *    in a wide block otherwise samples background its glyphs never cover, and
 *    condemns copy no reader could find fault with.
 *  - Take the colour from the element the glyphs belong to. Reading it from
 *    the queried ancestor makes every accent-coloured <em> compare its own
 *    pixels against its parent's colour and report a failure that is not real.
 */

/* Every run of copy on the landing page, and nothing that is not copy. */
const COPY = [
  '.lp-brand', '.lp-state', '.lp-eyebrow', '.lp-title', '.lp-lede',
  '.lp-step-t', '.lp-step-d',
  '.alpha-access .eyebrow', '.alpha-access-rule', '.alpha-wake-state',
  '.alpha-access label', '.alpha-access .btn-primary',
  '.lp-sec-eyebrow', '.lp-sec-title', '.lp-sec-lede',
  '.lp-cap-t', '.lp-cap-d', '.lp-limit-b', '.lp-limit-d',
  '.lp-foot-brand', '.lp-foot-meta'
];

async function measure(page, selectors) {
  const runs = await page.evaluate(sels => {
    /*
     * The poster, not a frame of the video: a guard needs the same answer
     * every run. The poster is a real frame of the same scene, and the copy
     * has at most a few percent of the scene behind it by design, so the
     * difference a moving frame could make is far smaller than the headroom.
     */
    const video = document.getElementById('lpVideo');
    if (video) { try { video.pause(); } catch (e) { /* nothing to pause */ } video.classList.remove('is-playing'); }

    const out = [];
    for (const sel of sels) {
      document.querySelectorAll(sel).forEach(el => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (!node.nodeValue.trim()) continue;
          const style = getComputedStyle(node.parentElement);
          const size = parseFloat(style.fontSize);
          const weight = parseInt(style.fontWeight, 10) || 400;
          /* WCAG's large-text allowance: 24px, or 18.66px when bold. */
          const large = size >= 24 || (size >= 18.66 && weight >= 700);
          const range = document.createRange();
          range.selectNodeContents(node);
          for (const r of range.getClientRects()) {
            if (r.width < 4 || r.height < 4) continue;
            out.push({
              sel, color: style.color, large,
              x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height
            });
          }
        }
      });
    }
    /*
     * Hide the glyphs and their descendants. An !important on the parent does
     * not beat a child's own colour rule, so an accent <em> would stay painted
     * and be measured against itself.
     */
    const style = document.createElement('style');
    style.id = 'nv-contrast-probe';
    style.textContent = sels.map(s => `${s},${s} *`).join(',') + '{color:transparent!important}';
    document.head.appendChild(style);
    return out;
  }, selectors);

  /* CSS pixels, so the rects above index the image directly on any DPR. */
  const shot = await page.screenshot({ fullPage: true, scale: 'css' });

  return page.evaluate(async ({ runs: lines, png }) => {
    /* The browser decodes its own screenshot; no image library in the runner. */
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('screenshot did not decode'));
      image.src = 'data:image/png;base64,' + png;
    });
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);

    const channel = c => {
      const v = c / 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const luminance = (r, g, b) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const rgba = value => {
      const n = value.match(/[\d.]+/g).map(Number);
      return { r: n[0], g: n[1], b: n[2], a: n.length > 3 ? n[3] : 1 };
    };

    const worst = {};
    for (const line of lines) {
      const x = Math.max(0, Math.round(line.x));
      const y = Math.max(0, Math.round(line.y));
      const w = Math.min(canvas.width - x, Math.round(line.w));
      const h = Math.min(canvas.height - y, Math.round(line.h));
      if (w < 1 || h < 1) continue;
      const { data } = ctx.getImageData(x, y, w, h);
      const ink = rgba(line.color);
      for (let i = 0; i < data.length; i += 4) {
        const br = data[i], bg = data[i + 1], bb = data[i + 2];
        /* Translucent ink is composited over whatever it happens to sit on. */
        const fr = ink.r * ink.a + br * (1 - ink.a);
        const fg = ink.g * ink.a + bg * (1 - ink.a);
        const fb = ink.b * ink.a + bb * (1 - ink.a);
        const ratio = contrast(luminance(fr, fg, fb), luminance(br, bg, bb));
        const seen = worst[line.sel];
        if (!seen || ratio < seen.ratio) worst[line.sel] = { ratio, large: line.large };
      }
    }
    document.getElementById('nv-contrast-probe')?.remove();
    return worst;
  }, { runs, png: shot.toString('base64') });
}

for (const theme of ['dark', 'light']) {
  test(`landing copy clears WCAG AA contrast over the scene in ${theme}`, async ({ page }) => {
    test.setTimeout(60000);
    await mockPublicAlphaApi(page, { access: 'required', ready: 'ready' });
    await page.addInitScript(value => {
      try { localStorage.setItem('nv_theme', value); } catch (e) { /* private mode */ }
    }, theme);
    await page.goto('/');
    await expect(page.locator('.lp-poster')).toHaveJSProperty('complete', true);

    const worst = await measure(page, COPY);
    expect(Object.keys(worst).length).toBeGreaterThan(12);

    const failures = Object.entries(worst)
      .map(([sel, { ratio, large }]) => ({ sel, ratio: Number(ratio.toFixed(2)), need: large ? 3 : 4.5 }))
      .filter(row => row.ratio < row.need)
      .sort((a, b) => a.ratio - b.ratio);
    expect(failures).toEqual([]);
  });
}
