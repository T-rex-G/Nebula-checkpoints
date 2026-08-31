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
      background: style.backgroundImage + style.backgroundColor,
      markWidth: parseFloat(mark.width),
      markHeight: parseFloat(mark.height),
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
  expect(off.background).not.toBe(on.background);

  /*
   * State must not rest on colour alone, so the centre mark changes shape as
   * well: a dot while the signal is live, a dash once it is muted.
   */
  expect(off.markWidth).toBeGreaterThan(on.markWidth);
  expect(off.markHeight).toBeLessThan(on.markHeight);

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
