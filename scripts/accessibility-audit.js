'use strict';

/*
 * A standing accessibility audit, wider than the suite that guards it.
 *
 * The browser suite checks seven points along the golden path, at critical and
 * serious impact, in whichever theme happens to be default. That is a
 * regression guard, and a good one, but it is not an audit: moderate findings
 * are discarded unread, the light palette is never scanned at all, and Neural,
 * Governance and every workbench tab past Editor are never visited.
 *
 * This visits them, in both themes and both viewports, keeps findings at every
 * impact, and adds three checks axe cannot make on its own -- pointer target
 * size, focus visibility, and text reflow at 200% zoom.
 *
 * It asserts nothing. It reports, so a person can decide what is worth fixing;
 * what gets fixed then earns a guard in the suite. Running it is cheap and
 * reading it is the point.
 *
 *   node scripts/accessibility-audit.js [outputDirectory]
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const { mockPublicAlphaApi } = require('../test/e2e/public-alpha-fixtures');

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

const VIEWS = Object.freeze([
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 820 }
]);
const THEMES = Object.freeze(['dark', 'light']);

/* Every destination the workbench offers, not only the one it opens on. */
const WORKBENCH_TABS = Object.freeze([
  'editor', 'upload', 'commits', 'pulls', 'issues',
  'releases', 'actions', 'compare', 'neural', 'governance'
]);

async function axeFindings(page, where) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return result.violations.map(violation => ({
    kind: 'axe',
    where,
    impact: violation.impact || 'unknown',
    id: violation.id,
    help: violation.help,
    nodes: violation.nodes.length,
    sample: violation.nodes.slice(0, 2).map(node => node.target.join(' ')).join(' | ')
  }));
}

/*
 * WCAG 2.2 target size (2.5.8): a pointer target is at least 24 by 24, unless
 * it is inline in a sentence or has 24px of clear spacing. Axe does not check
 * this, and it is the criterion a dense toolbar fails first.
 */
async function targetFindings(page, where) {
  return page.evaluate(scope => {
    const tooSmall = [];
    const selector = 'button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab]';
    for (const node of document.querySelectorAll(selector)) {
      const box = node.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      /* Inline controls inside running text are exempt. */
      if (node.closest('p, li, .hint, .dz-sub')) continue;
      if (box.width < 24 || box.height < 23.5) {
        const label = (node.getAttribute('aria-label')
          || node.textContent.trim().slice(0, 32) || node.id || node.className).toString();
        tooSmall.push({
          kind: 'target-size', where: scope, impact: 'moderate',
          id: 'target-size-24',
          help: `Pointer target smaller than 24x24 (${Math.round(box.width)}x${Math.round(box.height)})`,
          nodes: 1, sample: label
        });
      }
    }
    return tooSmall;
  }, where);
}

/* Every keyboard-reachable control has to show where focus is. */
async function focusFindings(page, where) {
  return page.evaluate(scope => {
    const invisible = [];
    const focusable = [...document.querySelectorAll(
      'button, a[href], input:not([type=hidden]), select, textarea, [tabindex]:not([tabindex="-1"])')]
      .filter(node => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .slice(0, 60);
    for (const node of focusable) {
      const before = getComputedStyle(node);
      const resting = `${before.outlineStyle}|${before.outlineWidth}|${before.boxShadow}|${before.borderColor}|${before.backgroundColor}`;
      node.focus();
      const after = getComputedStyle(node);
      const focused = `${after.outlineStyle}|${after.outlineWidth}|${after.boxShadow}|${after.borderColor}|${after.backgroundColor}`;
      if (resting === focused) {
        const label = (node.getAttribute('aria-label')
          || node.textContent.trim().slice(0, 32) || node.id || node.className).toString();
        invisible.push({
          kind: 'focus-visible', where: scope, impact: 'serious',
          id: 'focus-not-visible',
          help: 'Focusing this control changes nothing a sighted keyboard user can see',
          nodes: 1, sample: label
        });
      }
    }
    document.activeElement?.blur();
    return invisible;
  }, where);
}

/*
 * WCAG 1.4.4 asks for 200% text scaling without loss of content. Emulated by
 * halving the viewport, which is the same ratio from the layout's point of
 * view, and looking for anything driven off the side of the page.
 */
async function reflowFindings(page, where) {
  const overflow = await page.evaluate(() => {
    const escaping = [];
    const limit = document.documentElement.clientWidth;
    for (const node of document.querySelectorAll('body *')) {
      const box = node.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (box.right > limit + 2 && getComputedStyle(node).position !== 'fixed') {
        escaping.push(`${node.tagName.toLowerCase()}.${String(node.className).split(' ')[0]}`);
      }
    }
    return { escaping: [...new Set(escaping)].slice(0, 6), documentOverflow: document.body.scrollWidth - limit };
  });
  if (overflow.documentOverflow <= 2 && !overflow.escaping.length) return [];
  return [{
    kind: 'reflow', where, impact: 'serious', id: 'reflow-200',
    help: `Content escapes the viewport at 200% scale (${overflow.documentOverflow}px of document overflow)`,
    nodes: overflow.escaping.length, sample: overflow.escaping.join(' | ')
  }];
}

/*
 * The fixture used here carries an active session, so the application opens on
 * the overview and the sign-in screen is never drawn. Typing into it -- which
 * is what the design-review rig does, because it runs without this fixture --
 * waits thirty seconds for a field that is present but hidden.
 */
async function openSignedIn(page) {
  await page.goto('/');
  await page.getByRole('main', { name: 'Workspace overview' }).waitFor({ state: 'visible', timeout: 25000 });
}

async function main() {
  const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'design-review'));
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage']
  });
  const findings = [];
  try {
    for (const view of VIEWS) {
      for (const theme of THEMES) {
        const context = await browser.newContext({
          viewport: { width: view.width, height: view.height },
          baseURL: process.env.NV_REVIEW_URL || 'http://127.0.0.1:21999',
          serviceWorkers: 'block'
        });
        const page = await context.newPage();
        await mockPublicAlphaApi(page, { access: 'active', repositoryState: 'current' });
        await openSignedIn(page);
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await page.waitForTimeout(900);

        const label = suffix => `${view.name}/${theme}/${suffix}`;
        findings.push(...await axeFindings(page, label('overview')));
        findings.push(...await targetFindings(page, label('overview')));
        findings.push(...await focusFindings(page, label('overview')));

        await page.getByRole('navigation', { name: 'Primary' })
          .getByRole('button', { name: 'Repositories' }).click();
        await page.getByRole('main', { name: 'Your galaxies' }).waitFor({ state: 'visible' });
        await page.waitForTimeout(600);
        findings.push(...await axeFindings(page, label('repositories')));
        findings.push(...await targetFindings(page, label('repositories')));

        /*
         * Every workbench destination, which the suite never visits past
         * Editor. Opened once and then switched in place: page.goto to a URL
         * differing only in its hash does not reload, and the route is
         * resolved at load, so navigating that way left the workbench closed
         * and waited twenty seconds for a screen nothing had opened.
         */
        await page.goto('/#/sandbox/demo@main/editor');
        await page.reload();
        await page.locator('#page-work.active').waitFor({ timeout: 25000 });
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await page.waitForTimeout(900);

        for (const tab of WORKBENCH_TABS) {
          const opened = await page.evaluate(name => {
            if (typeof window.switchTab !== 'function') return false;
            window.switchTab(name);
            const pane = document.querySelector(`#tab-${name}`);
            return !!(pane && pane.classList.contains('active'));
          }, tab);
          if (!opened) {
            findings.push({
              kind: 'coverage', where: label(`work/${tab}`), impact: 'unknown',
              id: 'destination-not-opened',
              help: 'This destination did not open, so it was not scanned',
              nodes: 0, sample: tab
            });
            continue;
          }
          await page.waitForTimeout(1000);
          findings.push(...await axeFindings(page, label(`work/${tab}`)));
          findings.push(...await targetFindings(page, label(`work/${tab}`)));
        }

        /* Text at 200%, emulated by halving the space the layout is given. */
        await page.setViewportSize({ width: Math.round(view.width / 2), height: Math.round(view.height / 2) });
        await page.waitForTimeout(800);
        findings.push(...await reflowFindings(page, label('work/editor @200%')));
        await page.setViewportSize({ width: view.width, height: view.height });

        await context.close();
        process.stdout.write(`scanned ${view.name}/${theme}\n`);
      }
    }
  } finally {
    await browser.close();
  }

  const order = { critical: 0, serious: 1, moderate: 2, minor: 3, unknown: 4 };
  findings.sort((a, b) => (order[a.impact] ?? 9) - (order[b.impact] ?? 9));

  const report = path.join(out, 'accessibility-audit.json');
  fs.writeFileSync(report, `${JSON.stringify(findings, null, 2)}\n`);

  const counts = {};
  for (const finding of findings) counts[finding.impact] = (counts[finding.impact] || 0) + 1;
  const byRule = {};
  for (const finding of findings) {
    const key = `${finding.impact}  ${finding.id}`;
    if (!byRule[key]) byRule[key] = { count: 0, where: new Set(), sample: finding.sample, help: finding.help };
    byRule[key].count += 1;
    byRule[key].where.add(finding.where);
  }

  process.stdout.write(`\n${findings.length} findings  ${JSON.stringify(counts)}\n\n`);
  for (const [key, value] of Object.entries(byRule).sort()) {
    process.stdout.write(`${key}  x${value.count}  (${value.where.size} places)\n`);
    process.stdout.write(`    ${value.help}\n`);
    process.stdout.write(`    e.g. ${String(value.sample).slice(0, 96)}\n`);
    process.stdout.write(`    seen: ${[...value.where].slice(0, 3).join(', ')}\n\n`);
  }
  process.stdout.write(`Full report: ${report}\n`);
}

main().catch(error => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  process.exit(1);
});
