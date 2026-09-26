'use strict';

/*
 * The landing page's claims, held to the engine that makes them.
 *
 * Every figure on the page is a count the build can take of itself, every
 * rule it quotes is quoted from the rule, and the audit the page plays is the
 * one the engine gives for the project it depicts. A promotion, a new rule or
 * a reworded title that leaves the page behind fails here, before a visitor
 * reads a number the product no longer ships.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const { EXPOSURE_RULES } = require('../src/exposure-rules');
const { ADAPTERS } = require('../src/credential-verification');
const audit = require('../src/code-audit');
const site = require('../src/site-check');

/* ---- The counts ---------------------------------------------------------------- */
const claims = new Map([...html.matchAll(/data-count="(\d+)" data-claim="([a-z-]+)">(\d+)</g)]
  .map(([, count, claim, shown]) => [claim, { count: Number(count), shown: Number(shown) }]));
const expected = {
  'secret-detectors': EXPOSURE_RULES.length,
  'credential-verifiers': Object.keys(ADAPTERS).length,
  'audit-rules': Object.keys(audit.RULES).length,
  'site-rules': Object.keys(site.RULES).length
};
assert.deepStrictEqual([...claims.keys()].sort(), Object.keys(expected).sort(), 'every counted claim is checked, and only those');
for (const [claim, value] of Object.entries(expected)) {
  assert.strictEqual(claims.get(claim).count, value, `${claim}: the page counts ${claims.get(claim).count}, the engine ${value}`);
  assert.strictEqual(claims.get(claim).shown, value, `${claim}: the figure without script must be the same number`);
}
assert.match(html, /<b data-claim="unpreviewed-writes">0<\/b> writes reach a provider without a preview/);

/* ---- The rules it quotes ----------------------------------------------------------- */
const RULES = { ...audit.RULES, ...site.RULES };
const quoted = [...html.matchAll(/<span data-rule="([A-Z]{3}-\d{3})">\1 · ([^<]+)<\/span>/g)];
assert(quoted.length >= 8, 'the ticker quotes rules');
for (const [, rule, title] of quoted) {
  assert(RULES[rule], `${rule} is not a rule`);
  assert.strictEqual(title, RULES[rule].title, `${rule} is quoted as the rule words it`);
}
const items = [...html.matchAll(/<li class="lp-au-item" data-sev="(\w+)" data-rule="([A-Z]{3}-\d{3})">\s*<span class="lp-au-pill">[^<]+<\/span><span class="lp-au-title">([^<]+)<\/span>\s*<span class="lp-au-where">\2 · ([^<]+)<\/span>/g)];
assert.strictEqual(items.length, 2, 'the played audit shows two findings');

/* ---- The audit it plays is the engine's ---------------------------------------------- */
/*
 * The project the scene depicts: an ordinary app with one interpolated query
 * and one deployment action on a movable tag. Fixed, both are gone.
 */
const base = [
  { path: 'README.md', text: '# demo\n' },
  { path: '.gitignore', text: 'node_modules\n.env\n' },
  { path: 'package-lock.json', text: '{}' },
  { path: 'test/app.test.js', text: 'test\n' },
  { path: 'package.json', text: JSON.stringify({ name: 'demo', dependencies: { express: '^4.19.2' } }, null, 2) }
];
const workflow = pin => [
  'on: push', 'jobs:', '  deploy:', '    runs-on: ubuntu-latest', '    steps:',
  '      - uses: actions/checkout@v4', `      - uses: someone/deploy-action@${pin}`, ''
].join('\n');
const query = ['db.query(`SELECT * FROM users WHERE id = ', '$', '{req.params.id}`);\n'].join('');
const before = audit.analyse({ files: [...base,
  { path: 'api/users.js', text: query },
  { path: '.github/workflows/deploy.yml', text: workflow('v2') }] });
const after = audit.analyse({ files: [...base,
  { path: 'api/users.js', text: 'db.query("SELECT * FROM users WHERE id = $1", [id]);\n' },
  { path: '.github/workflows/deploy.yml', text: workflow('0123456789abcdef0123456789abcdef01234567') }] });

for (const [severity, rule, title, where] of items.map(match => match.slice(1))) {
  const finding = before.findings.find(item => item.rule === rule);
  assert(finding, `${rule} is shown but the engine does not find it`);
  assert.strictEqual(severity, finding.severity);
  assert.strictEqual(title, finding.title);
  assert.strictEqual(where, `${finding.path}:${finding.line}`);
}
assert.strictEqual(before.findings.length, items.length, 'the scene shows every finding the engine makes, and no other');

const shown = only => {
  const letter = new RegExp(`<b class="lp-au-letter">[\\s\\S]*?<span data-only="${only}">([^<]+)</span>`).exec(html)[1];
  const score = new RegExp(`<span class="lp-au-score">[\\s\\S]*?<span data-only="${only}">([^<]+)</span>`).exec(html)[1];
  return { letter, score };
};
assert.deepStrictEqual(shown('find fix'), { letter: before.grade, score: `${before.score}/100` });
assert.strictEqual(before.capped, true, 'the scene says the grade is held below 50, so the cap must be what holds it');
assert.match(html, /<p class="lp-au-cap" data-only="find fix">Held below 50 while a critical finding is open\.<\/p>/);
assert.match(html, new RegExp(`<span data-only="find fix">${before.findings.length} findings: 1 critical, 1 warning\\.</span>`));
assert.deepStrictEqual(shown('again'), { letter: after.grade, score: `${after.score}/100` });
assert.strictEqual(after.findings.length, 0);
assert.match(html, new RegExp(`0 new findings, ${before.findings.length} resolved since the audit of`));

for (const category of before.categories) {
  const family = new RegExp(`data-family="${category.id}" style="--find:(\\d+)%;--again:(\\d+)%"><span>[^<]+</span><b><span data-only="read">&mdash;</span><span data-only="find fix">(\\d+)</span><span data-only="again">(\\d+)</span>`).exec(html);
  assert(family, `the ${category.id} family is drawn`);
  const later = after.categories.find(item => item.id === category.id).score;
  assert.deepStrictEqual(family.slice(1).map(Number), [category.score, later, category.score, later], `${category.id} is drawn at the engine's scores`);
}

/* The prompt it copies is the engine's own, cut short, and never the code. */
const prompt = /<span data-prompt="SEC-001">([^<]+)<\/span>/.exec(html)[1];
const engine = before.findings.find(item => item.rule === 'SEC-001').prompt;
assert(engine.startsWith(prompt), 'the prompt shown is the start of the one the engine writes');
assert(!/SELECT \*|req\.params/.test(prompt));

console.log('landing claims tests passed');
