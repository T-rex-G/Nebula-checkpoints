'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const alpha = fs.readFileSync(path.join(root, 'public', 'alpha-ui.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');

for (const id of [
  'page-alpha-access', 'alphaInviteInput', 'alphaTermsAccept',
  'alphaRedeemBtn', 'alphaAccessError', 'alphaWakeState'
]) assert(html.includes(`id="${id}"`), `missing #${id}`);
assert(html.includes('sandbox/test repository'));
assert(html.includes('/alpha-ui.js?v=__NV_ASSET_VERSION__'));
assert(/id="page-alpha-access"[^>]*class="[^"]*active/.test(html)
  || /class="[^"]*active[^"]*"[^>]*id="page-alpha-access"/.test(html),
'the access gate must be the only initial page');
assert(!/class="[^"]*active[^"]*"[^>]*id="page-login"/.test(html));

assert(alpha.includes('/api/alpha/status'));
assert(alpha.includes('/api/alpha/redeem'));
assert(alpha.includes('/readyz'));
assert(alpha.includes('acceptedTermsVersion'));
assert(alpha.includes('1000, 2000, 4000, 8000'));
assert(alpha.includes("new CustomEvent('nebula:alpha-access-granted')"));
assert(alpha.includes('Object.freeze'));
assert(sw.includes('/alpha-ui.js?v='));

assert(app.includes('window.NebulaAlphaUI.boot().then'));
assert(app.includes("window.addEventListener('nebula:alpha-access-granted'"));
assert(app.includes("['ALPHA_SESSION_EXPIRED', 'ALPHA_ACCESS_REVOKED']"));
assert(app.includes('NebulaAlphaUI.showExpired(error.code)'));
const expiryStart = app.indexOf("if (['ALPHA_SESSION_EXPIRED', 'ALPHA_ACCESS_REVOKED'].includes(error.code))");
const expiryEnd = app.indexOf('throw error;', expiryStart);
const expiryBlock = app.slice(expiryStart, expiryEnd);
assert(expiryBlock.includes('alphaBootStarted = false;'),
  'a new invitation must be able to restart the app after expiry or revocation');
assert(expiryBlock.indexOf('await purgeLocalData(true)') < expiryBlock.indexOf('alphaBootStarted = false;'),
  'private browser state must be purged before app restart is re-enabled');

const safeguardsStart = app.indexOf('async function openSafeguards()');
const safeguardsEnd = app.indexOf('\nasync function moveFolderFlow', safeguardsStart);
const safeguardsBlock = app.slice(safeguardsStart, safeguardsEnd);
assert(app.includes("if (typeof onOpen === 'function') onOpen($('#modalBody'));"),
  'modal controls must support synchronous open-time binding');
assert(safeguardsBlock.includes('onOpen: () => {'),
  'Safeguards controls must bind as part of modal rendering');
assert(!safeguardsBlock.includes('setTimeout(() => {'),
  'Safeguards must not expose clickable controls before their handlers are bound');


/*
 * Every typeface the interface names must be one this origin actually serves.
 *
 * The stylesheet asked for DM Sans and DM Mono for two releases and nothing
 * ever loaded them: there was no @font-face rule and font-src is 'self', so a
 * hosted stylesheet would have been refused by the policy anyway. Every user
 * silently got the system fallback, and nothing failed, because no check tied
 * the names in the font stacks to the files on disk. This is that check.
 */
{
  const styles = fs.readFileSync(path.join(root, 'public', 'style.css'), 'utf8');
  const declared = new Set(
    [...styles.matchAll(/@font-face\{font-family:'([^']+)'/g)].map(match => match[1])
  );
  assert(declared.size >= 3, 'the interface must declare its own faces rather than assume the system has them');

  for (const family of declared) {
    const rule = styles.slice(styles.indexOf(`@font-face{font-family:'${family}'`));
    const source = /url\('([^']+)'\)/.exec(rule);
    assert(source, `${family} must name a file`);
    assert(
      fs.existsSync(path.join(root, 'public', source[1])),
      `${family} names ${source[1]}, which this origin does not serve`
    );
    assert(/font-display:swap/.test(rule.slice(0, rule.indexOf('}'))),
      `${family} must render in a fallback while it loads`);
  }

  /*
   * Every quoted family named by a stack must resolve to a declared face.
   *
   * The stacks live in custom properties, not only in font-family, which an
   * earlier version of this check did not read -- so it still accepted the very
   * bug it was written for. Both declaration forms are scanned now.
   */
  const stacks = styles.replace(/@font-face\{[^}]*\}/g, '');
  const stackDeclarations = [...stacks.matchAll(/(?:font-family|--font-[a-z-]+|--ed-family)\s*:([^;}]*)/g)];
  assert(
    stackDeclarations.length >= 4,
    'the font stacks must be readable as declarations for this check to mean anything'
  );
  for (const [, value] of stackDeclarations) {
    for (const [, family] of value.matchAll(/'([^']+)'/g)) {
      assert(declared.has(family), `a font stack asks for ${family}, which this origin never loads`);
    }
  }

  /*
   * Canvas text names its own face and is reached by no stylesheet rule, which
   * is how neural.js kept asking for a typeface nobody shipped. Interpolations
   * are removed first: the quoted values inside them are weights and node
   * kinds, not families.
   */
  const neural = fs.readFileSync(path.join(root, 'public', 'neural.js'), 'utf8');
  for (const [, literal] of neural.matchAll(/ctx\.font\s*=\s*`([^`]*)`/g)) {
    for (const [, family] of literal.replace(/\$\{[^}]*\}/g, '').matchAll(/'([^']+)'/g)) {
      assert(declared.has(family), `canvas text asks for ${family}, which this origin never loads`);
    }
  }

  /*
   * Only the faces every visit loads are warmed.
   *
   * The core stacks apply on first paint, so a first offline visit needs them
   * already in the cache. The editor picker faces do not: a declared face is
   * not downloaded until a rule applies it, and the worker's static branch
   * caches any same-origin asset it fetches, so a chosen face is kept from
   * first use. Warming all nine would download every picker face on install to
   * serve the one a reader actually picked.
   */
  const worker = fs.readFileSync(path.join(root, 'public', 'sw.js'), 'utf8');
  const coreStacks = [...styles.matchAll(/--font-(?:display|body|mono)\s*:([^;}]*)/g)];
  assert.strictEqual(coreStacks.length, 3, 'the three core stacks must be declared');
  for (const [, value] of coreStacks) {
    for (const [, family] of value.matchAll(/'([^']+)'/g)) {
      const rule = styles.slice(styles.indexOf(`@font-face{font-family:'${family}'`));
      const file = /url\('([^']+)'\)/.exec(rule)[1];
      assert(worker.includes(file), `a first offline visit needs ${family}: ${file} is not warmed`);
    }
  }
}

console.log('alpha UI contract tests passed');
