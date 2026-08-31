'use strict';

/*
 * The graph can be enlarged to the whole viewport, and the controls that decide
 * what the graph shows live in a rail beside it. Enlarging used to cover that
 * rail, so changing intelligence mode meant collapsing, changing, and enlarging
 * again -- three steps to do the thing the enlarged view exists for.
 *
 * These run in both viewports the suite already uses, because the answer
 * differs between them: a wide screen holds the panel and the graph at once, a
 * phone opens the panel over the graph and gets out of the way once a mode is
 * chosen.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');

test.use({ serviceWorkers: 'block' });

async function openGraph(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/neural');
  await page.getByRole('main').first().waitFor({ state: 'visible' });
  await expect(page.locator('#neuralStage')).toBeVisible();
  await page.locator('#neuralCanvas').waitFor({ state: 'visible' });
}

test('the enlarged graph keeps the controls that decide what it shows', async ({ page }) => {
  await openGraph(page);

  const stage = page.locator('#neuralStage');
  const before = await stage.boundingBox();

  await page.locator('#neuralExpandBtn').click();
  await expect(stage).toHaveClass(/is-expanded/);

  /* It really is bigger, rather than merely marked as such. */
  const after = await stage.boundingBox();
  expect(after.width).toBeGreaterThan(before.width);
  expect(after.height).toBeGreaterThan(before.height);

  /* Every control came with it, as one moved rail rather than a second copy. */
  await expect(page.locator('#neuralStage #neuralRail')).toHaveCount(1);
  await expect(page.locator('#neuralRail')).toHaveClass(/is-docked/);
  await expect(page.locator('#neuralStage [data-neural-mode]')).toHaveCount(5);
  await expect(page.locator('#neuralStage [data-neural-filter]')).toHaveCount(3);

  /* The panel is opened by whichever route this viewport uses. */
  const panelButton = page.locator('#neuralPanelBtn');
  await expect(panelButton).toBeVisible();
  if (!(await stage.evaluate(node => node.classList.contains('panel-open')))) {
    await panelButton.click();
  }
  await expect(stage).toHaveClass(/panel-open/);

  /* The point of all of it: change mode without leaving the enlarged view. */
  await page.locator('#neuralStage [data-neural-mode="activity"]').click();
  await expect(page.locator('[data-neural-mode="activity"]')).toHaveClass(/active/);
  await expect(stage).toHaveClass(/is-expanded/);

  /* Escape backs out one step at a time: the panel first where one is open, the
   * enlargement after it. So the second press is conditional on still being
   * enlarged, not on the panel that the first press just closed. */
  await page.keyboard.press('Escape');
  if (await stage.evaluate(node => node.classList.contains('is-expanded'))) {
    await expect(stage).not.toHaveClass(/panel-open/);
    await page.keyboard.press('Escape');
  }
  await expect(stage).not.toHaveClass(/is-expanded/);
  await expect(page.locator('#neuralStage #neuralRail')).toHaveCount(0);
  await expect(page.locator('#neuralRail')).not.toHaveClass(/is-docked/);

  const restored = await stage.boundingBox();
  expect(Math.round(restored.width)).toBe(Math.round(before.width));
});

test('the signal filters read as one object carrying colour and state', async ({ page }) => {
  await openGraph(page);
  await page.locator('#neuralExpandBtn').click();
  await expect(page.locator('#neuralStage')).toHaveClass(/is-expanded/);
  if (!(await page.locator('#neuralStage').evaluate(node => node.classList.contains('panel-open')))) {
    await page.locator('#neuralPanelBtn').click();
  }

  const filter = page.locator('#neuralStage [data-neural-filter="warning"]');
  await expect(filter).toBeVisible();

  const read = () => filter.evaluate(node => {
    const style = getComputedStyle(node);
    const mark = getComputedStyle(node, '::before');
    const rect = node.getBoundingClientRect();
    return {
      appearance: style.appearance,
      /* This control paints its state in the rim, not the fill: the body is
       * transparent glass and the colour is entirely inset shadow. */
      rim: style.boxShadow,
      markWidth: parseFloat(mark.width),
      markHeight: parseFloat(mark.height),
      markRadius: mark.borderRadius,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      checked: node.checked
    };
  });

  const on = await read();
  /* A native checkbox at this size is the blunt square this replaced. */
  expect(on.appearance).toBe('none');
  /* WCAG 2.5.8 still applies to the rebuilt control. */
  expect(on.width).toBeGreaterThanOrEqual(24);
  expect(on.height).toBeGreaterThanOrEqual(24);
  expect(on.checked).toBe(true);

  await filter.click();
  /* The mark morphs over a fifth of a second; reading it in the same tick as
   * the click measures the shape it is leaving, not the one it arrives at. */
  await expect.poll(async () => (await read()).markWidth).toBeGreaterThan(on.markWidth);
  const off = await read();
  expect(off.checked).toBe(false);
  expect(off.rim).not.toBe(on.rim);

  /*
   * State must not rest on colour alone, so the centre mark changes shape as
   * well: a dot while the signal is live, a dash once it is muted.
   */
  /* Muted is a rounded square, live is a narrow bar: the shape carries the
   * state alongside the hue, so it still reads without colour vision. */
  expect(off.markWidth).toBeGreaterThan(on.markWidth);
  expect(off.markRadius).not.toBe(on.markRadius);

  /*
   * The muted ring is the control's visible boundary, which WCAG 1.4.11 asks to
   * clear 3:1 against what is behind it. axe cannot check this: nothing tells it
   * a CSS ring is what marks the control, so it reported zero findings while all
   * three rings sat between 1.45 and 2.65. Measured here instead, from what the
   * browser actually painted.
   */
  /* Both themes, because the panel behind the ring changes with the theme and
   * the first version of this check only ever looked at the one the browser
   * happened to open in -- which was the theme that was already passing. */
  const measureContrast = () => page.evaluate(() => {
    const channel = value => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    const ratio = (a, b) => {
      const [hi, lo] = luminance(a) > luminance(b) ? [luminance(a), luminance(b)] : [luminance(b), luminance(a)];
      return (hi + 0.05) / (lo + 0.05);
    };
    /*
     * Colour and alpha both, because a ring at 62 per cent of a bright hue is
     * not that bright hue. Reading the channels and discarding the alpha is how
     * the first version of this check passed against the very value it was
     * written to reject.
     */
    const colour = value => {
      const text = String(value || '').trim();
      if (text.startsWith('#')) {
        const hex = text.length === 4
          ? [1, 2, 3].map(i => parseInt(text[i] + text[i], 16))
          : [1, 3, 5].map(i => parseInt(text.slice(i, i + 2), 16));
        return { rgb: hex, alpha: 1 };
      }
      const parts = (text.match(/[\d.]+/g) || []).map(Number);
      if (parts.length < 3) return null;
      return { rgb: parts.slice(0, 3), alpha: parts.length > 3 ? parts[3] : 1 };
    };
    const composite = (fore, ground) => fore.rgb.map((c, i) => Math.round(c * fore.alpha + ground[i] * (1 - fore.alpha)));
    /* The first ancestor that actually paints something opaque enough to be the
     * ground the ring is read against. */
    const groundOf = node => {
      let el = node.parentElement;
      while (el) {
        const parsed = colour(getComputedStyle(el).backgroundColor);
        if (parsed && parsed.alpha > 0.85) return parsed.rgb;
        el = el.parentElement;
      }
      return colour(getComputedStyle(document.body).backgroundColor)?.rgb || [0, 0, 0];
    };
    return [...document.querySelectorAll('#neuralStage .neural-filter input')].flatMap(input => {
      const style = getComputedStyle(input);
      const ground = groundOf(input);
      /* Both states: the ring marks the muted control, the fill marks the live
       * one, and each is the boundary a viewer has to find. */
      /* The rim is drawn as inset shadows, so the boundary colour is read out of
       * the resolved box-shadow rather than a variable. The darkest colour in
       * that stack is the rim; the white entries are its edge highlights. */
      const colours = (style.boxShadow.match(/rgba?\([^)]*\)/g) || [])
        .map(colour)
        .filter(Boolean)
        .map(parsed => ({ parsed, rgb: composite(parsed, ground) }));
      const rim = colours
        .filter(entry => entry.rgb.some(channel => channel < 240))
        .sort((a, b) => ratio(b.rgb, ground) - ratio(a.rgb, ground))[0];
      return [{
        signal: `${input.dataset.neuralFilter} rim`,
        alpha: rim ? rim.parsed.alpha : null,
        ratio: rim ? ratio(rim.rgb, ground) : 0
      }];
    });
  });
  for (const theme of ['dark', 'light']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    /*
     * The rim is a transitioned box-shadow, so it spends the next fifth of a
     * second on its way to the new theme's colour. Reading it before it lands
     * measures the theme being left against the panel being arrived at, which
     * is how this reported 1.83 for a rim that resolves to 3.15.
     *
     * Sleeping for longer than the transition is not the fix, and was the
     * defect CI caught: a fixed 400ms is 400ms of wall clock, not 400ms of
     * transition, and on a loaded runner the transition starts late enough that
     * the read still lands mid-flight -- 2.38, a value the rim only ever holds
     * on its way somewhere else. Wait for the transition itself instead.
     *
     * Two frames first, so the theme change is committed to style and the
     * transitions have actually been created; then until none of them is still
     * running. Scoped to these inputs because the page carries animations that
     * never stop, and waiting on those would wait forever.
     */
    await page.evaluate(() => new Promise(resolve => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    }));
    await page.waitForFunction(() => {
      const inputs = [...document.querySelectorAll('#neuralStage .neural-filter input')];
      return document.getAnimations().every(animation => {
        const target = animation.effect && animation.effect.target;
        return animation.playState !== 'running' || !inputs.includes(target);
      });
    });
    const contrast = await measureContrast();
    expect(contrast.length).toBe(3);
    for (const entry of contrast) {
      expect(entry.ratio, `${theme}: ${entry.signal} ring is ${entry.ratio.toFixed(2)}:1 against its panel`)
        .toBeGreaterThanOrEqual(3);
    }
  }
  await page.evaluate(() => { delete document.documentElement.dataset.theme; });

  /*
   * Removing the browser's own control also removes its focus ring, so the
   * replacement has to draw one. It has to be reached by keyboard to see it:
   * :focus-visible deliberately does not match a programmatic focus, which is
   * the whole point of that selector.
   */
  await page.locator('#neuralStage [data-neural-filter="critical"]').focus();
  await page.keyboard.press('Tab');
  const focused = await filter.evaluate(node => ({
    isTarget: document.activeElement === node,
    focusVisible: node.matches(':focus-visible'),
    outline: getComputedStyle(node).outlineWidth
  }));
  expect(focused.isTarget).toBe(true);
  expect(focused.focusVisible).toBe(true);
  expect(parseFloat(focused.outline)).toBeGreaterThan(0);
});

test('every graph tool draws an icon that is visible against its own button' , async ({ page }) => {
  await openGraph(page);
  await page.locator('#neuralExpandBtn').click();
  await expect(page.locator('#neuralStage')).toHaveClass(/is-expanded/);

  /*
   * Two of these once fell back to the SVG default of a black fill and no
   * stroke: invisible on the dark button, a filled smudge on the light one.
   */
  const findings = await page.evaluate(() => {
    const out = [];
    for (const button of document.querySelectorAll('.neural-stage-tools .neural-tool')) {
      const icon = [...button.querySelectorAll('svg')].find(svg => getComputedStyle(svg).display !== 'none');
      if (!icon) continue;
      const style = getComputedStyle(icon.querySelector('path, rect, circle') || icon);
      const rect = icon.getBoundingClientRect();
      const box = button.getBoundingClientRect();
      out.push({
        id: button.id,
        painted: style.stroke !== 'none' || style.fill !== 'none',
        black: style.fill === 'rgb(0, 0, 0)' && style.stroke === 'none',
        dy: Math.abs((rect.top + rect.height / 2) - (box.top + box.height / 2))
      });
    }
    return out;
  });

  expect(findings.length).toBeGreaterThanOrEqual(4);
  for (const finding of findings) {
    expect(finding.painted, `${finding.id} draws nothing`).toBe(true);
    expect(finding.black, `${finding.id} falls back to a black fill`).toBe(false);
    expect(finding.dy, `${finding.id} is off centre by ${finding.dy}px`).toBeLessThanOrEqual(0.5);
  }
});
