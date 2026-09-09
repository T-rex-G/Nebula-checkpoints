'use strict';

const { test, expect } = require('@playwright/test');
const ui = require('./semantic');

/* Exercise the real accessibility tree with a screen that exposes its actions
 * after rendering. This delay belongs to the fixture, not to the helper: the
 * helper must wait for a visible entry point, not guess a layout from a frame
 * in which neither the desktop action nor the mobile dock is ready. */
async function renderActions(page, { mobile = true, open = false, delayed = false } = {}) {
  await page.setContent(`
    <button id="direct" hidden>Command palette</button>
    <button id="dock" hidden aria-expanded="${open}" aria-controls="menu">Workspace actions</button>
    <div id="menu" role="group" aria-label="Workspace actions" hidden>
      <button>Command palette</button>
    </div>
    <p role="status">Waiting for action</p>
  `);
  await page.evaluate(({ mobile, open, delayed }) => {
    const direct = document.getElementById('direct');
    const dock = document.getElementById('dock');
    const menu = document.getElementById('menu');
    dock.addEventListener('click', () => {
      const expanded = dock.getAttribute('aria-expanded') === 'true';
      dock.setAttribute('aria-expanded', String(!expanded));
      menu.hidden = expanded;
    });
    for (const action of [direct, menu.querySelector('button')]) {
      action.addEventListener('click', () => {
        document.querySelector('[role="status"]').textContent = 'Command palette opened';
      });
    }
    const ready = () => {
      direct.hidden = mobile;
      dock.hidden = !mobile;
      menu.hidden = !mobile || !open;
    };
    if (delayed) setTimeout(ready, 250);
    else ready();
  }, { mobile, open, delayed });
}

for (const mobile of [true, false]) {
  test(`action discovery waits for a delayed ${mobile ? 'mobile dock' : 'desktop button'}`, async ({ page }) => {
    await renderActions(page, { mobile, delayed: true });
    await (await ui.action(page, 'Command palette')).click({ timeout: 1500 });
    await expect(page.getByRole('status')).toHaveText('Command palette opened');
    await expect(page.getByRole('button', { name: 'Workspace actions', exact: true, includeHidden: true }))
      .toHaveAttribute('aria-expanded', String(mobile));
  });
}

test('action discovery leaves an already-open mobile menu open', async ({ page }) => {
  await renderActions(page, { open: true });
  await (await ui.action(page, 'Command palette')).click();
  await expect(page.getByRole('status')).toHaveText('Command palette opened');
  await expect(page.getByRole('button', { name: 'Workspace actions', exact: true }))
    .toHaveAttribute('aria-expanded', 'true');
});

test('the focus anchor waits for the mobile dock instead of choosing the hidden desktop action', async ({ page }) => {
  await renderActions(page, { delayed: true });
  const anchor = await ui.actionAnchor(page, 'Command palette');
  await expect(anchor).toHaveAccessibleName('Workspace actions', { timeout: 1500 });
  await expect(anchor).toHaveAttribute('aria-expanded', 'false');
});

test('a genuinely missing action still fails', async ({ page }) => {
  await page.setContent('<main aria-label="Screen without actions">No action is available.</main>');
  page.setDefaultTimeout(200);
  await expect((async () => {
    await (await ui.action(page, 'Command palette')).click();
  })()).rejects.toThrow(/Timeout/);
});
