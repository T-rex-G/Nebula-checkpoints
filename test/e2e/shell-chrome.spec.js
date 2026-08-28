'use strict';

/*
 * The application shell: a sidebar a reader can narrow, and one floating
 * action that carries whatever the screen in front of them actually needs.
 */

const { test, expect } = require('@playwright/test');
const { mockPublicAlphaApi } = require('./public-alpha-fixtures');
const ui = require('./semantic');

test.use({ serviceWorkers: 'block' });

async function openWorkspace(page) {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
}

test.describe('desktop shell', () => {
  test.skip(({ viewport }) => !viewport || viewport.width < 1140, 'the sidebar exists above 1140px');

  test('the sidebar narrows and remembers that it was narrowed', async ({ page }) => {
    await openWorkspace(page);
    const rail = page.getByRole('navigation', { name: 'Primary' });
    const expanded = (await rail.boundingBox()).width;

    /*
     * The rail animates to its narrow width, so its box has to be read once it
     * has settled rather than on the frame after the click -- measuring
     * immediately caught it still at its full width and reported a working
     * collapse as a broken one.
     */
    await ui.button(page, 'Collapse the sidebar').click();
    await expect.poll(async () => (await rail.boundingBox()).width,
      { message: 'collapsing must actually narrow the rail' }).toBeLessThan(expanded - 80);
    const collapsed = (await rail.boundingBox()).width;

    /*
     * Narrowed to marks, the entries still have to say what they are: a rail
     * of unlabelled icons is unusable by anyone navigating with a screen
     * reader, and unguessable for everyone else.
     */
    const entry = page.getByRole('button', { name: 'Repositories', exact: false }).first();
    await expect(entry).toHaveAttribute('title', /Repositories/i);
    await expect(ui.button(page, 'Expand the sidebar')).toBeVisible();

    /* The preference is the reader's, so it survives a reload. */
    await page.reload();
    await expect(ui.screen(page, 'overview')).toBeVisible();
    await expect.poll(async () => (await rail.boundingBox()).width).toBeLessThan(expanded - 80);

    await ui.button(page, 'Expand the sidebar').click();
    await expect.poll(async () => (await rail.boundingBox()).width).toBeGreaterThan(collapsed + 80);
  });
});

/*
 * Below the breakpoint only. Above it the top bar has room for these actions
 * and carries them directly, so the dock is not on the screen at all -- a
 * check that ran there was reading attributes off a control no one can press.
 */
test.describe('the floating action', () => {
  test.skip(({ viewport }) => !viewport || viewport.width >= 901, 'the dock exists below 901px');

  /*
   * It is offered where the screen cannot place its own actions, and nowhere
   * else. On a phone the overview shows five controls and the inventory ten,
   * and everything a floating menu would carry is already among them -- so on
   * those screens it was a second way to reach what was on screen anyway. The
   * workbench is the screen with the problem, and it is the screen that has
   * one. Guarding its absence matters as much as guarding its contents: a
   * control that turns up everywhere is the defect this replaced.
   */
  test('appears only where the screen cannot place its own actions', async ({ page }) => {
    await openWorkspace(page);
    const dock = page.locator('#paletteFab');
    await expect(dock).toBeHidden();

    await ui.enterRepositories(page);
    await expect(ui.screen(page, 'repos')).toBeVisible();
    await expect(dock).toBeHidden();

    await page.locator('.repo-card').first().click();
    await page.locator('#page-work.active').waitFor();
    await expect(dock).toBeVisible();
  });

  test('carries the actions the workbench has nowhere else to put', async ({ page }) => {
    await openWorkspace(page);
    await ui.enterRepositories(page);
    await page.locator('.repo-card').first().click();
    await page.locator('#page-work.active').waitFor();

    const dock = page.locator('#paletteFab');
    await expect(dock).toHaveAttribute('aria-controls', 'fabMenu');
    await dock.click();
    await expect(page.locator('#fabMenu')).toBeVisible();

    const entries = await page.locator('#fabMenu .nv-fab-item').allInnerTexts();
    expect(entries).toContain('Command palette');

    /*
     * And each entry has to be something the screen does not already show. A
     * menu that repeats a control a thumb can already reach is the duplicate
     * this was meant to stop being.
     */
    for (const entry of entries) {
      const elsewhere = page.locator('.page.active').getByRole('button', { name: entry, exact: true });
      await expect(elsewhere).toBeHidden();
    }

    await page.keyboard.press('Escape');
    await expect(page.locator('#fabMenu')).toBeHidden();
    await expect(dock).toBeFocused();
    await expect(dock).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('desktop shell regions', () => {
  test.skip(({ viewport }) => !viewport || viewport.width < 1140, 'the sidebar exists above 1140px');

  test('no screen lays its content underneath the sidebar', async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/#/sandbox/demo@main/files');
    await page.locator('#page-work.active').waitFor();

    const rail = page.getByRole('navigation', { name: 'Primary' });
    const regions = [
      {
        name: 'workbench',
        open: async () => {
          await rail.getByRole('button', { name: 'Classic workbench' }).click();
          await page.locator('#page-work.active').waitFor();
        },
        locator: page.locator('#page-work .workspace')
      },
      {
        name: 'overview',
        open: async () => {
          await rail.getByRole('button', { name: 'Overview' }).click();
          await expect(ui.screen(page, 'overview')).toBeVisible();
        },
        locator: page.locator('#page-overview .container')
      },
      {
        name: 'repositories',
        open: async () => {
          await rail.getByRole('button', { name: 'Repositories' }).click();
          await expect(ui.screen(page, 'repos')).toBeVisible();
        },
        locator: page.locator('#page-repos .container')
      }
    ];

    for (const collapsed of [false, true]) {
      if (collapsed) await ui.button(page, 'Collapse the sidebar').click();
      for (const region of regions) {
        await region.open();
        /* Polled, because the inset animates: the frame after a click still
         * holds the previous width. */
        await expect.poll(async () => {
          const edge = await rail.boundingBox();
          const content = await region.locator.boundingBox();
          return content ? Math.round(content.x - (edge.x + edge.width)) : null;
        }, { message: `${region.name} must start after the rail ends` }).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

/*
 * The plate is the application's ground -- the surface the sidebar and every
 * screen sit on. It was a pseudo-element that another rule already claimed:
 * body::after belongs to the standalone status-bar backdrop as well, and an
 * element has only one. The two declarations merged, the status bar's
 * height:env(safe-area-inset-top) survived because nothing in the plate's own
 * rule set a height, and an explicit height beats a bottom offset -- so the
 * plate computed to zero pixels tall. All that ever reached the screen was its
 * two borders, a 2px band across the top of the page whose corner radii CSS
 * clamps away at that height. The ground was never drawn, which is exactly
 * what it looked like.
 */
test.describe('the application plate', () => {
  test.skip(({ viewport }) => !viewport || viewport.width < 1140, 'the plate is drawn above 1140px');

  test('is a surface with real height and corners, not a hairline', async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/');
    await expect(ui.screen(page, 'overview')).toBeVisible();

    const plate = page.locator('#shellPlate');
    const box = await plate.boundingBox();
    const viewport = page.viewportSize();

    /* It has to cover the workspace, not sit on top of it as a strip. */
    expect(box.height).toBeGreaterThan(viewport.height * 0.8);
    expect(box.width).toBeGreaterThan(viewport.width * 0.8);

    /*
     * And its corners have to be round. CSS scales border radii down when the
     * box is too small to hold them, so a collapsed plate reports a radius it
     * does not draw -- comparing the declared radius against the box is what
     * catches that, not reading the radius alone.
     */
    const radius = await plate.evaluate(node => parseFloat(getComputedStyle(node).borderTopRightRadius));
    expect(radius).toBeGreaterThan(8);
    expect(box.height).toBeGreaterThan(radius * 2);
    expect(box.width).toBeGreaterThan(radius * 2);

    /* The sidebar sits on the plate; it must not hang off it. */
    const rail = await page.getByRole('navigation', { name: 'Primary' }).boundingBox();
    expect(rail.x).toBeGreaterThanOrEqual(box.x);
    expect(rail.y).toBeGreaterThanOrEqual(box.y);
  });
});

/*
 * The mobile menu had no height limit and no overflow. It carries fourteen
 * entries, so it grew past the bottom of the screen and everything below the
 * fold was clipped away with no way to reach it -- Settings, the last entry,
 * simply did not exist on a phone. The guard is that the last entry can be
 * brought into view, which is the property that actually matters; capping the
 * height without making it scroll would pass a check on height alone.
 */
test.describe('the mobile menu', () => {
  test.skip(({ viewport }) => !viewport || viewport.width >= 900, 'the menu is a phone surface');

  test('scrolls, so its last entry can be reached', async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/#/sandbox/demo@main/files');
    await page.locator('#page-work.active').waitFor();

    await page.locator('[data-nav="more"]').click();
    const sheet = page.locator('#sheet');
    await expect(sheet).toBeVisible();

    /*
     * It must not extend past the screen it is drawn on -- measured against
     * the viewport, which is what a fixed layer is positioned against.
     * boundingBox() reports document coordinates, so on a page scrolled down a
     * little it put a sheet that fits perfectly well past the bottom of the
     * screen by exactly the scroll offset.
     *
     * And measured once it has arrived. The sheet slides up from thirty pixels
     * below its resting place, so a rect read while that is still running is
     * the rect of a sheet part way through the journey: it reported a sheet
     * hanging off the bottom of the screen by whatever was left of the slide.
     */
    const box = await sheet.evaluate(async node => {
      await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {})));
      const rect = node.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, viewport: window.innerHeight };
    });
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThanOrEqual(box.viewport + 1);

    /*
     * The entry has to end up inside the sheet's own box, not merely inside
     * the viewport. Asking Playwright to scroll it into view and then checking
     * the viewport passes either way: with no scroll container it scrolls the
     * page instead, which moves the whole sheet and satisfies the check while
     * the entry is still clipped away by the sheet's overflow. The clipping is
     * the defect, so the clipping is what the guard has to measure.
     */
    const last = sheet.locator('.sheet-item').last();
    const reading = await sheet.evaluate(node => {
      const overflows = node.scrollHeight > node.clientHeight + 1;
      /*
       * overflow:hidden is still scrollable from script -- setting scrollTop
       * moves it -- and is not scrollable by a finger at all. So the state is
       * read before scrolling: an overflowing box that is not auto or scroll
       * is a box whose tail no one can reach, however well scrollTop works.
       */
      const usable = /^(auto|scroll)$/.test(getComputedStyle(node).overflowY);
      node.scrollTop = node.scrollHeight;
      const box = node.getBoundingClientRect();
      const entry = node.querySelector('.sheet-item:last-of-type').getBoundingClientRect();
      return { overflows, usable, top: entry.top - box.top, bottom: box.bottom - entry.bottom };
    });
    if (reading.overflows) expect(reading.usable, 'an overflowing menu has to be scrollable').toBe(true);
    expect(reading.top).toBeGreaterThanOrEqual(-1);
    expect(reading.bottom).toBeGreaterThanOrEqual(-1);

    /* And it has to be pressable where it ended up, not merely painted. */
    await expect(last).toBeEnabled();
  });
});

/*
 * The inventory's controls stay reachable while the list moves.
 *
 * An inventory is a list you scroll and then want to narrow, and the control
 * for narrowing it sat at the top of that scroll -- so filtering meant
 * scrolling all the way back before you could begin. On a phone, where the
 * list is one card per row and the scroll is long, that is most of the screen's
 * work.
 */
test.describe('the inventory toolbar', () => {
  test.skip(({ viewport }) => !viewport || viewport.width >= 901, 'the phone layout');

  test('stays under the bar while the list scrolls past it', async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/');
    await expect(ui.screen(page, 'overview')).toBeVisible();
    await ui.enterRepositories(page);
    await expect(ui.screen(page, 'repos')).toBeVisible();

    /* A single repository does not scroll, so there is nothing to stay put
       through. The list is lengthened here to give it something. */
    await page.evaluate(() => {
      const grid = document.getElementById('repoGrid');
      const card = grid.firstElementChild;
      for (let index = 0; index < 8; index += 1) grid.appendChild(card.cloneNode(true));
    });

    const filter = page.getByRole('searchbox', { name: 'Filter repositories' });
    await expect(filter).toBeInViewport();

    await page.evaluate(() => window.scrollTo(0, 1200));
    await expect.poll(() => page.evaluate(() => Math.round(window.scrollY))).toBeGreaterThan(600);

    /* Still on screen, and still under the bar rather than behind it. */
    await expect(filter).toBeInViewport();
    const placement = await page.evaluate(() => {
      const head = document.querySelector('#page-repos .page-head').getBoundingClientRect();
      const bar = document.querySelector('#page-repos .topbar').getBoundingClientRect();
      return { headTop: head.top, barBottom: bar.bottom };
    });
    expect(placement.headTop).toBeGreaterThanOrEqual(placement.barBottom - 1);
  });
});

/*
 * The workbench's tab strip shows every destination it carries.
 *
 * It used to scroll. Ten destinations needed 944px in an 835px box, so the
 * tenth -- Governance -- was drawn at x1400 against an edge at x1417: 17px of
 * a 120px tab, underneath the 18px fade that was supposed to announce it. The
 * fade worked and the outcome did not, which is the whole lesson: a strip that
 * declares "there is more" still reads as a strip that ends, and a reader who
 * never drags never learns the destination exists.
 *
 * So the strip wraps instead, and this asserts the outcome rather than the
 * apparatus: every tab is fully inside the strip's box. A guard on the fade
 * passed the entire time the tab was invisible.
 */
test.describe('the workbench tab strip', () => {
  /* Below the breakpoint the bottom navigation carries these destinations and
     the strip is not on the screen at all. */
  test.skip(({ viewport }) => !viewport || viewport.width < 901, 'the strip exists above 900px');

  test('shows every destination without scrolling', async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/#/sandbox/demo@main/files');
    await page.locator('#page-work.active').waitFor();

    const strip = page.locator('.tabs').first();
    await expect(strip).toBeVisible();

    const clipped = await strip.evaluate(node => {
      const box = node.getBoundingClientRect();
      return [...node.querySelectorAll('.tab')]
        .filter(tab => tab.offsetParent !== null)
        .map(tab => {
          const r = tab.getBoundingClientRect();
          return { name: tab.textContent.trim(), over: Math.round(Math.max(box.left - r.left, r.right - box.right)) };
        })
        .filter(entry => entry.over > 1);
    });
    expect(clipped, 'every destination has to be fully on screen').toEqual([]);

    /* And the box itself does not scroll: nothing is parked outside it. */
    const scrolls = await strip.evaluate(node => node.scrollWidth - node.clientWidth);
    expect(scrolls, 'a wrapped strip has nothing to scroll to').toBeLessThanOrEqual(1);
  });
});

/*
 * The artwork stays on the screen it decorates. On a phone it hung sixty-four
 * pixels past the right edge, so the viewport clipped the spiral through its
 * middle and left a straight cut where the arm should have faded -- which
 * reads as a rendering fault rather than as decoration.
 */
test('the inventory artwork is not clipped by the edge of the screen', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/');
  await expect(ui.screen(page, 'overview')).toBeVisible();
  await ui.enterRepositories(page);
  await expect(ui.screen(page, 'repos')).toBeVisible();

  const art = page.locator('#gxHeroArt');
  const box = await art.evaluate(node => {
    const rect = node.getBoundingClientRect();
    return { left: rect.left, right: rect.right, viewport: window.innerWidth };
  });
  expect(box.left).toBeGreaterThanOrEqual(-1);
  expect(box.right).toBeLessThanOrEqual(box.viewport + 1);

  /* And the page it sits on gains no horizontal scroll from it. */
  const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});

/*
 * The neural section, which is where two layout faults surfaced at once.
 *
 * On a phone, opening it pushed the layout viewport from 393 pixels out to
 * 892 and zoomed the whole application down to fit -- because three
 * long-labelled buttons in its header could not wrap and could not shrink, so
 * their combined minimum width became the page's. Nothing about that is
 * visible as an overflow: the document reports no horizontal scroll, because
 * the viewport itself moved. The width of the viewport is the thing to watch.
 *
 * On a desktop its three columns were chosen by a media query, which asks how
 * wide the window is. The pane is not the window -- inside the application
 * plate it is a little over eight hundred pixels on a 1440px screen -- so a
 * layout whose tracks add up to 946 overflowed its own container while the
 * window stayed comfortably above the breakpoint.
 */
test.describe('the neural section', () => {
  async function openNeural(page) {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/#/sandbox/demo@main/files');
    await page.locator('#page-work.active').waitFor();
    await page.evaluate(() => window.switchTab('neural'));
    await expect(page.locator('#tab-neural.active')).toBeVisible();
  }

  test('does not widen the page it opens on', async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/#/sandbox/demo@main/files');
    await page.locator('#page-work.active').waitFor();

    const before = await page.evaluate(() => window.innerWidth);
    await page.evaluate(() => window.switchTab('neural'));
    await expect(page.locator('#tab-neural.active')).toBeVisible();

    await expect.poll(() => page.evaluate(() => window.innerWidth),
      { message: 'opening the neural section must not move the viewport' }).toBe(before);
    const overflow = await page.evaluate(() => document.body.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);

    /*
     * And the mechanism, because the symptom is not reliably reproducible.
     *
     * The fault was a child of the pane that could not shrink: a grid item's
     * minimum width defaults to its content's minimum, so an item whose
     * content will not fold becomes a floor the track cannot go below, and
     * that floor propagates outward until the browser widens the layout
     * viewport and zooms the page down to fit. Nothing reports it as an
     * overflow, because the viewport is what moved.
     *
     * Whether it bites depends on what the section has loaded -- with an empty
     * signal replay everything folds and the broken layout looks fine, which
     * is why a check written against the symptom alone passed on the code that
     * had the defect. What holds regardless is that no child of the pane
     * carries that floor.
     */
    const floors = await page.evaluate(() => {
      const shell = document.querySelector('.neural-shell');
      return [...shell.children]
        .map(node => ({ tag: node.tagName + '.' + String(node.className).split(' ')[0], min: getComputedStyle(node).minWidth }))
        .filter(entry => entry.min === 'auto');
    });
    expect(floors, 'every child of the neural pane must be able to shrink').toEqual([]);
  });

  test('lays itself out inside its own pane, not the window', async ({ page }) => {
    await openNeural(page);

    /*
     * Measured against the pane rather than the viewport, because the defect
     * was a pane narrower than the window: everything fitted the screen and
     * still overflowed the surface it was drawn on.
     */
    const escaping = await page.evaluate(() => {
      const shell = document.querySelector('.neural-shell');
      const bounds = shell.getBoundingClientRect();
      const out = [];
      for (const node of shell.children) {
        const box = node.getBoundingClientRect();
        if (box.width === 0) continue;
        if (box.right > bounds.right + 1 || box.left < bounds.left - 1) {
          out.push({ tag: node.tagName, over: Math.round(box.right - bounds.right) });
        }
      }
      return out;
    });
    expect(escaping).toEqual([]);
  });
});

/*
 * Arriving by link leaves the workbench with something in it.
 *
 * The route's fourth segment is a tab name, and it was handed to switchTab
 * unchecked. switchTab marks the chosen tab by toggling `active` against every
 * tab and every pane -- so a name that matches nothing does not select
 * nothing, it *deselects everything*, and the workbench draws its chrome
 * around an empty hole.
 *
 * The segment this suite has always used, /files, is one of those names: it is
 * never a tab, so ten tests in this file have been entering a blanked
 * workbench and asserting happily around the hole. Nothing here asserted that
 * the workbench had any content, which is why the suite could not see it.
 *
 * Both halves are guarded: an unrecognised segment still lands somewhere, and
 * whatever it lands on is exactly one tab and its one pane.
 */
test.describe('entering the workbench by link', () => {
  /* 'nosuchtab' is the unknown-but-parseable case: the route's own segment
     matcher is [a-z]+, so a hyphenated name never reaches the workbench at all
     -- it fails to parse and the app goes home, which is right. */
  for (const route of ['files', 'editor', 'commits', 'nosuchtab']) {
    test(`leaves exactly one section showing for /${route}`, async ({ page }) => {
      await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
      await page.goto(`/#/sandbox/demo@main/${route}`);
      await page.locator('#page-work.active').waitFor();

      await expect.poll(async () => page.evaluate(() => {
        const shown = [...document.querySelectorAll('.tabpane')]
          .filter(pane => getComputedStyle(pane).display !== 'none');
        return {
          tabs: document.querySelectorAll('.tab.active').length,
          panes: shown.length,
          height: shown.length === 1 ? Math.round(shown[0].getBoundingClientRect().height) : 0
        };
      }), { message: 'a link must land on one section, and that section must be drawn' })
        .toEqual({ tabs: 1, panes: 1, height: expect.any(Number) });

      const height = await page.evaluate(() => {
        const pane = [...document.querySelectorAll('.tabpane')]
          .find(node => getComputedStyle(node).display !== 'none');
        return Math.round(pane.getBoundingClientRect().height);
      });
      expect(height, 'the section that is showing has to occupy real space').toBeGreaterThan(80);
    });
  }
});

/*
 * The work surface is on the screen when the workbench opens.
 *
 * The trust summary is five fields of prose, and on a phone it drew all five
 * as full cards: 393px of an 820px screen, before anything the reader came to
 * do. The editor pane below it kept a near-viewport minimum height, so its
 * empty state -- centred in that pane by margin:auto -- was pushed past the
 * fold and came to rest underneath the bottom navigation, clipped off the
 * bottom of the screen.
 *
 * Collapsing the detail is not the same as hiding the signal: the rollup keeps
 * every evidence state on the screen, and the prose is one tap away. What this
 * asserts is the outcome that was actually broken -- that the active pane has
 * real, unobstructed room above the navigation when the workbench opens.
 */
test.describe('the workbench work surface', () => {
  test.skip(({ viewport }) => !viewport || viewport.width > 900, 'the fold is a phone problem');

  test('is on the screen, above the navigation, when the workbench opens', async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/#/sandbox/demo@main/editor');
    await page.locator('#page-work.active').waitFor();
    await page.locator('#trustSummary').waitFor();
    await page.waitForTimeout(600);

    const reading = await page.evaluate(() => {
      const pane = [...document.querySelectorAll('.tabpane')]
        .find(node => getComputedStyle(node).display !== 'none');
      const nav = document.querySelector('#bottomNav');
      const navTop = nav && getComputedStyle(nav).display !== 'none'
        ? nav.getBoundingClientRect().top : window.innerHeight;
      const card = document.querySelector('#editorEmpty');
      const rect = card.getBoundingClientRect();
      return {
        paneTop: Math.round(pane.getBoundingClientRect().top),
        cardTop: Math.round(rect.top),
        cardBottom: Math.round(rect.bottom),
        navTop: Math.round(navTop)
      };
    });

    /* The pane has to begin above the halfway line: what sits over it is
       context, and context must not own most of the first screen. */
    expect(reading.paneTop, 'the work surface must start in the top half of the screen')
      .toBeLessThan(410);
    /* And the thing it draws has to be entirely clear of the navigation. */
    expect(reading.cardBottom, 'the pane content must clear the bottom navigation')
      .toBeLessThanOrEqual(reading.navTop);
    expect(reading.cardTop, 'the pane content must not start off the top').toBeGreaterThan(0);
  });
});

/*
 * The file tree draws icons, not typography.
 *
 * A directory was a Unicode triangle and a file was U+00B7 -- a period -- set
 * at 15px in the muted colour. Against a list of filenames that reads as
 * nothing at all, and the tree is the workbench's primary navigation: it is
 * the control a reader uses most and the one that said least.
 *
 * The rest of the product draws stroked SVG at 1.7, so this asserts the tree
 * agrees with it: every row's icon slot holds a drawn mark and carries no text
 * of its own.
 */
test('every row in the file tree is marked with a drawn icon', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.route('**/api/repo/sandbox/demo/tree*', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([
      { name: 'src', path: 'src', type: 'dir' },
      { name: 'README.md', path: 'README.md', type: 'file', size: 4821 }
    ])
  }));
  await page.goto('/#/sandbox/demo@main/editor');
  await page.locator('#page-work.active').waitFor();
  await page.locator('#tree .tree-item').first().waitFor();

  const rows = await page.evaluate(() => [...document.querySelectorAll('#tree .tree-item')]
    .map(row => {
      const slot = row.querySelector('.ti-icon');
      return {
        name: row.querySelector('.ti-name') ? row.querySelector('.ti-name').textContent : '',
        hasSlot: !!slot,
        drawn: !!(slot && slot.querySelector('svg')),
        text: slot ? slot.textContent.trim() : ''
      };
    }));

  expect(rows.length, 'the fixture has to produce rows to inspect').toBeGreaterThan(0);
  expect(rows.filter(row => !row.drawn), 'every row needs a drawn mark').toEqual([]);
  expect(rows.filter(row => row.text !== ''), 'no row may fall back to a text glyph').toEqual([]);
});

/*
 * An empty repository is not told to pick a file.
 *
 * The editor's resting state says "Pick a file from the constellation on the
 * left, or press Ctrl K to jump anywhere" -- correct when there are files, and
 * an instruction that cannot be followed when there are none. The tree said
 * "Empty repository" in the same breath, so the workbench contradicted itself
 * on the first screen a new repository ever shows.
 */
test('an empty repository is not asked to open a file that does not exist', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/editor');
  await page.locator('#page-work.active').waitFor();
  /* The fixture's tree is empty, which is the case under test. */
  await expect(page.locator('#tree')).toContainText('Empty repository');

  /*
   * Read as innerText, not textContent: both wordings live in the DOM and one
   * is hidden, so textContent contains the sentence that is not on the screen
   * and would report the contradiction as unfixed forever.
   */
  const empty = page.locator('#editorEmpty');
  await expect(empty).toBeVisible();
  await expect(empty, 'nothing may point at a file list that has no files')
    .not.toContainText(/Pick a file|tap Files/i, { useInnerText: true });
  await expect(empty, 'the reader needs the action that does apply')
    .toContainText(/add the first one/i, { useInnerText: true });
});

/*
 * A message must not land on the navigation. Anchored to the bottom of a
 * phone, a toast sat squarely over the bar and covered every destination in it
 * for as long as it was up.
 */
test('a message never covers the bottom navigation', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/files');
  await page.locator('#page-work.active').waitFor();

  const nav = page.locator('#bottomNav');
  if (!(await nav.isVisible())) return;

  await page.evaluate(() => window.toast('A message that has to stay out of the way', 'ok'));
  const toast = page.locator('#toasts');
  await expect(toast).toBeVisible();

  const clash = await page.evaluate(() => {
    const box = id => document.getElementById(id).getBoundingClientRect();
    const message = box('toasts');
    const bar = box('bottomNav');
    return !(message.bottom <= bar.top || message.top >= bar.bottom);
  });
  expect(clash, 'the message overlaps the navigation').toBe(false);
});

/*
 * Every destination the rail claims to offer, it reaches -- and the two tabs
 * that are destinations rather than views of an open file are both there.
 *
 * Neural and Governance sit side by side in the workbench's tab strip as the
 * only two named surfaces with their own identity and their own capability
 * gate, and only Neural had been promoted to the rail. Governance was also the
 * tenth tab, the one past the fold, so the surface hardest to reach in the
 * whole application was the one with no entry of its own.
 */
test.describe('the rail', () => {
  test.skip(({ viewport }) => !viewport || viewport.width < 1140, 'the rail exists above 1140px');

  test('offers every destination, and each one arrives', async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/#/sandbox/demo@main/files');
    await page.locator('#page-work.active').waitFor();

    const rail = page.getByRole('navigation', { name: 'Primary' });

    /*
     * The two tabs that are applications rather than views.
     *
     * Named here rather than derived, because the first attempt to derive them
     * -- any tab carrying a capability gate -- swept in Push files, which is a
     * gated view of the open repository and not a destination at all. What
     * actually separates these two is that each is its own module with its own
     * state and its own top-level heading inside the pane: the nervous system
     * and the policy twin are applications embedded in the workbench, while
     * commits, issues, releases and the rest are views over provider data.
     * That is a product decision, so it is written down rather than guessed at.
     */
    const promoted = ['neural', 'governance'];
    for (const name of promoted) {
      const entry = rail.locator(`[data-rail="${name}"]`);
      await expect(entry, `${name} is an application of its own and has no rail entry`).toHaveCount(1);
    }

    /* And pressing each entry lands on the thing it names. */
    for (const name of promoted) {
      await rail.locator(`[data-rail="${name}"]`).click();
      await expect(page.locator(`#tab-${name}.active`)).toBeVisible();
      await expect(rail.locator(`[data-rail="${name}"]`)).toHaveAttribute('aria-current', 'page');
    }
  });
});

/*
 * One name, one thing.
 *
 * "Governance" had been the name of two different things at once: the
 * destination where policy is authored, and a view filter inside the graph
 * that hides every node type except the protected-asset-shaped ones. The
 * filter reads no policy data at all -- its whole implementation is a set of
 * node types -- so the shared name promised a relationship that does not
 * exist, and a reader who found one while looking for the other had no way to
 * tell which they had.
 *
 * The filter is named for what it does now. This guards the separation rather
 * than the wording: whatever these two end up called, they must not be called
 * the same thing.
 */
test('the graph filter and the policy destination do not share a name', async ({ page }) => {
  await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
  await page.goto('/#/sandbox/demo@main/files');
  await page.locator('#page-work.active').waitFor();
  await page.evaluate(() => window.switchTab('neural'));
  await expect(page.locator('#tab-neural.active')).toBeVisible();

  const names = await page.evaluate(() => {
    const clean = node => (node.textContent || '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    return {
      destination: clean(document.querySelector('[data-tab="governance"]')),
      filter: clean(document.querySelector('[data-neural-mode="governance"] b'))
    };
  });

  expect(names.destination.length).toBeGreaterThan(0);
  expect(names.filter.length).toBeGreaterThan(0);
  expect(names.filter,
    'the graph filter and the policy destination must not answer to the same name').not.toBe(names.destination);

  /*
   * And the destination is the one that keeps the word, since it is the one a
   * reader goes looking for. Where the sidebar is on screen it has to agree
   * with the tab; below that width the sidebar is not drawn at all.
   */
  const rail = page.getByRole('navigation', { name: 'Primary' }).locator('[data-rail="governance"]');
  if (await rail.isVisible().catch(() => false)) await expect(rail).toContainText(/governance/i);
});

/*
 * A destination answers to one name, wherever a control points at it.
 *
 * The policy surface had three: "Governance" in the sidebar and on its tab,
 * and "Policy Digital Twin" in the phone menu -- so someone who learned it on
 * a desktop could not find it on a phone, and the other way round. Neural had
 * the same split. Descriptive titles belong to the content: the pane still
 * calls itself the Policy Digital Twin, which is what it is. The controls that
 * lead there say where they lead.
 *
 * And every destination is reachable by name, which Governance was not: it was
 * the one tab with no command-palette entry, so the surface hardest to see in
 * the strip was also the one that could not be jumped to.
 */
test.describe('destination names', () => {
  const DESTINATIONS = [
    { tab: 'neural', name: 'Neural' },
    { tab: 'governance', name: 'Governance' }
  ];

  test('every control that leads to a destination calls it the same thing', async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/#/sandbox/demo@main/files');
    await page.locator('#page-work.active').waitFor();

    for (const { tab, name } of DESTINATIONS) {
      const labels = await page.evaluate(selector => {
        const clean = node => node
          ? (node.textContent || '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim()
          : null;
        return {
          tab: clean(document.querySelector(`[data-tab="${selector}"]`)),
          /* The first span in a menu row can be a decorative glyph; the name
             is the one that is not hidden from the accessibility tree. */
          menu: clean(document.querySelector(`.sheet-item[data-act="${selector}"] span:not([aria-hidden])`)),
          rail: clean(document.querySelector(`[data-rail="${selector}"] .nv-rail-t`))
        };
      }, tab);

      for (const [where, label] of Object.entries(labels)) {
        if (label === null) continue;
        expect(label, `the ${where} calls this destination "${label}"`).toBe(name);
      }
    }
  });

  test('every destination can be reached by name from the palette', async ({ page }) => {
    await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
    await page.goto('/#/sandbox/demo@main/files');
    await page.locator('#page-work.active').waitFor();

    for (const { tab, name } of DESTINATIONS) {
      await (await ui.action(page, 'Command palette')).click();
      await expect(page.locator('#paletteScrim:not([hidden])')).toBeVisible();
      await ui.palette(page).fill(name);
      /*
       * By its label, not its accessible name: each row appends a kind badge,
       * so the option announces itself as "Neuralview" and an exact match on
       * the destination's name finds nothing.
       */
      await page.locator('#paletteList .pal-item')
        .filter({ has: page.getByText(name, { exact: true }) })
        .first().click();
      await expect(page.locator(`#tab-${tab}.active`)).toBeVisible();
    }
  });
});
