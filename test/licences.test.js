'use strict';

/*
 * Licences: every family read the way SPDX and the manifests people actually
 * write put it; the project's own licence found where it is stated; a
 * repository's policy honoured, choices read as choices; the settled GNU
 * conflicts caught and nothing else claimed; deps.dev asked anonymously,
 * within a bound, and an unanswered question left unknown; and the findings
 * reported beside the others without moving the grade or the fix-first list.
 */

const assert = require('assert');
const lic = require('../src/licences');
const audit = require('../src/code-audit');

/* ---- Reading a licence ------------------------------------------------------------ */
{
  const read = value => { const out = lic.readLicence(value); return [out.expression, out.family]; };
  assert.deepStrictEqual(read('MIT'), ['MIT', 'permissive']);
  assert.deepStrictEqual(read('(MIT OR Apache-2.0)'), ['MIT OR Apache-2.0', 'permissive']);
  assert.deepStrictEqual(read('GPL-2.0'), ['GPL-2.0-only', 'strong-copyleft'], 'a retired GNU identifier means -only');
  assert.deepStrictEqual(read('GPL-2.0+'), ['GPL-2.0-or-later', 'strong-copyleft']);
  assert.deepStrictEqual(read('GPL-2.0-only WITH Classpath-exception-2.0'), ['GPL-2.0-only WITH Classpath-exception-2.0', 'weak-copyleft'], 'a linking exception softens it');
  assert.deepStrictEqual(read('MIT AND GPL-3.0-only'), ['MIT AND GPL-3.0-only', 'strong-copyleft'], 'a combination asks the most of its parts');
  assert.deepStrictEqual(read('GPL-3.0-only OR MIT'), ['GPL-3.0-only OR MIT', 'permissive'], 'a choice asks the least');
  assert.deepStrictEqual(read('MIT OR (GPL-3.0 AND Apache-2.0)'), ['MIT OR (GPL-3.0-only AND Apache-2.0)', 'permissive']);
  assert.deepStrictEqual(read('AGPL-3.0-or-later'), ['AGPL-3.0-or-later', 'network-copyleft']);
  assert.deepStrictEqual(read('SSPL-1.0'), ['SSPL-1.0', 'network-copyleft']);
  assert.deepStrictEqual(read('BUSL-1.1'), ['BUSL-1.1', 'restricted']);
  assert.deepStrictEqual(read('CC-BY-NC-4.0'), ['CC-BY-NC-4.0', 'restricted']);
  assert.deepStrictEqual(read('LGPL-2.1-or-later'), ['LGPL-2.1-or-later', 'weak-copyleft']);
  assert.deepStrictEqual(read('MPL-2.0'), ['MPL-2.0', 'weak-copyleft']);
  assert.deepStrictEqual(read('CC0-1.0'), ['CC0-1.0', 'public-domain']);
  assert.deepStrictEqual(read('Apache-2.0 WITH LLVM-exception'), ['Apache-2.0 WITH LLVM-exception', 'permissive']);
  /* What manifests say instead of an identifier. */
  assert.deepStrictEqual(read('MIT License'), ['MIT', 'permissive']);
  assert.deepStrictEqual(read('Apache 2.0'), ['Apache-2.0', 'permissive']);
  assert.deepStrictEqual(read('Apache License, Version 2.0'), ['Apache-2.0', 'permissive']);
  assert.deepStrictEqual(read('Python Software Foundation License'), ['PSF-2.0', 'permissive']);
  assert.deepStrictEqual(read('GNU General Public License v3 (GPLv3)'), ['GPL-3.0-only', 'strong-copyleft']);
  assert.deepStrictEqual(read('BSD'), ['BSD', 'permissive'], 'a bare family name keeps the family');
  assert.deepStrictEqual(read('GNU Affero General Public License'), ['GNU Affero General Public License', 'network-copyleft']);
  /* Composer's list is a choice; npm's old object form carries a type. */
  assert.deepStrictEqual(read(['GPL-2.0-or-later', 'MIT']), ['GPL-2.0-or-later OR MIT', 'permissive']);
  assert.deepStrictEqual(read({ type: 'MIT' }), ['MIT', 'permissive']);
  /* No licence, and ones that cannot be judged without reading them. */
  assert.deepStrictEqual(read('UNLICENSED'), ['UNLICENSED', 'none']);
  assert.deepStrictEqual(read('SEE LICENSE IN LICENSE.md'), ['SEE LICENSE IN LICENSE.md', 'unknown']);
  assert.deepStrictEqual(read('non-standard'), ['non-standard', 'unknown']);
  assert.deepStrictEqual(read(null), [null, 'unknown']);
  assert.deepStrictEqual(read(''), [null, 'unknown']);
  assert.deepStrictEqual(read('LicenseRef-Acme AND MIT'), ['LicenseRef-Acme AND MIT', 'unknown'], 'an unread part leaves a combination unknown');
  assert.deepStrictEqual(read('LicenseRef-Acme AND GPL-3.0-only'), ['LicenseRef-Acme AND GPL-3.0-only', 'strong-copyleft'], 'unless a known part already asks more');
  /* Bounded, and control characters never cross into a report. */
  assert(lic.readLicence(`Weird\u0007${'x'.repeat(400)}`).expression.length <= 120);
  assert(!/\u0007/.test(lic.readLicence('Weird\u0007Licence').expression));
  assert.throws(() => lic.parseExpression(Array.from({ length: 50 }, () => 'MIT').join(' OR ')), /not an expression/);
  assert.throws(() => lic.parseExpression('(MIT OR Apache-2.0'), /unbalanced/);
}

/* ---- The project's own licence ---------------------------------------------------- */
{
  const project = files => lic.projectLicence(files);
  assert.deepStrictEqual(
    (({ expression, family, source }) => ({ expression, family, source }))(project([{ path: 'package.json', text: '{"name":"x","license":"MIT"}' }])),
    { expression: 'MIT', family: 'permissive', source: 'package.json' });
  assert.strictEqual(project([{ path: 'package.json', text: '{"name":"x","private":true}' }]).family, 'proprietary', 'a private package that names no licence');
  assert.strictEqual(project([{ path: 'package.json', text: '{"license":"UNLICENSED"}' }]).family, 'proprietary');
  assert.strictEqual(project([{ path: 'Cargo.toml', text: '[package]\nname = "x"\nlicense = "MIT OR Apache-2.0"\n' }]).expression, 'MIT OR Apache-2.0');
  assert.strictEqual(project([{ path: 'pyproject.toml', text: '[project]\nname = "x"\nlicense = { text = "GPL-3.0-or-later" }\n' }]).family, 'strong-copyleft');
  assert.strictEqual(project([{ path: 'pyproject.toml', text: '[project]\nclassifiers = [\n  "License :: OSI Approved :: MIT License",\n]\n' }]).expression, 'MIT');
  assert.strictEqual(project([{ path: 'composer.json', text: '{"license":["AGPL-3.0-only"]}' }]).family, 'network-copyleft');
  /* A licence file, recognised by its own words. */
  const byText = text => project([{ path: 'LICENSE', text }]).expression;
  assert.strictEqual(byText('MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy'), 'MIT');
  assert.strictEqual(byText('GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007'), 'GPL-3.0-only');
  assert.strictEqual(byText('GNU GENERAL PUBLIC LICENSE\nVersion 2, June 1991'), 'GPL-2.0-only');
  assert.strictEqual(byText('GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3'), 'AGPL-3.0-only');
  assert.strictEqual(byText('GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3'), 'LGPL-3.0-only');
  assert.strictEqual(byText('Apache License\n                           Version 2.0, January 2004'), 'Apache-2.0');
  assert.strictEqual(byText('Redistribution and use in source and binary forms ... Neither the name of'), 'BSD-3-Clause');
  assert.strictEqual(byText('Redistribution and use in source and binary forms ...'), 'BSD-2-Clause');
  assert.strictEqual(byText('Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, provided that the above copyright notice and this permission notice appear in all copies.'), 'ISC');
  assert.strictEqual(byText('Business Source License 1.1'), 'BUSL-1.1');
  assert.strictEqual(project([{ path: 'COPYING', text: 'GNU GENERAL PUBLIC LICENSE Version 3' }]).expression, 'GPL-3.0-only');
  assert.strictEqual(project([{ path: 'docs/LICENSE', text: 'Permission is hereby granted, free of charge, to any person obtaining a copy' }]).missing, true, 'only the root licence speaks for the project');
  const unread = project([{ path: 'LICENSE.md', text: 'Copyright Acme. All rights reserved.' }]);
  assert.deepStrictEqual([unread.family, unread.unread], ['proprietary', true]);
  const nothing = project([]);
  assert.deepStrictEqual([nothing.family, nothing.missing, nothing.expression], ['proprietary', true, null], 'no licence is all rights reserved');
  /* The manifest's word wins over the file's. */
  assert.strictEqual(project([{ path: 'package.json', text: '{"license":"Apache-2.0"}' }, { path: 'LICENSE', text: 'Permission is hereby granted, free of charge, to any person obtaining a copy' }]).expression, 'Apache-2.0');
  assert(lic.isLicenceFile('LICENSE') && lic.isLicenceFile('LICENCE.txt') && lic.isLicenceFile('COPYING') && lic.isLicenceFile('LICENSE-MIT') && lic.isLicenceFile('UNLICENSE'));
  for (const code of ['src/LICENSE', 'license.js', 'license_check.py', 'licenses.ts', 'LICENSES/MIT.txt']) assert(!lic.isLicenceFile(code), `${code} is not the project's licence`);
}

/* ---- The repository's policy ------------------------------------------------------- */
{
  const file = text => [{ path: '.nebulaverse/licences.json', text }];
  const policy = lic.readPolicy(file(JSON.stringify({ allow: ['permissive', 'MPL-2.0'], deny: ['AGPL-3.0', 'restricted'], packages: { 'npm:Left-Pad': 'Cleared by legal', 'bogus key': 'x', 'pypi:foo': 42 } })));
  assert.strictEqual(policy.path, '.nebulaverse/licences.json');
  assert.deepStrictEqual(policy.allow, [{ family: 'permissive' }, { id: 'MPL-2.0' }]);
  assert.deepStrictEqual(policy.deny, [{ id: 'AGPL-3.0-only' }, { family: 'restricted' }], 'a retired identifier is read as what it meant');
  assert.deepStrictEqual([...policy.packages], [['npm:left-pad', 'Cleared by legal'], ['pypi:foo', null]], 'a key that names no ecosystem is ignored');
  assert.strictEqual(lic.readPolicy(file('{nope')).invalid, true);
  assert.strictEqual(lic.readPolicy(file('[]')).invalid, true);
  assert.strictEqual(lic.readPolicy([{ path: '.nebulaverse/licenses.json', text: '{}' }]).path, '.nebulaverse/licenses.json', 'either spelling');
  assert.strictEqual(lic.readPolicy([{ path: 'licences.json', text: '{}' }]), null, 'only the named place');

  const verdict = (expression, p = policy) => lic.policyVerdict(lic.readLicence(expression).tree, p);
  assert.deepStrictEqual(verdict('AGPL-3.0-only'), { denied: true, notAllowed: false });
  assert.deepStrictEqual(verdict('BUSL-1.1'), { denied: true, notAllowed: false }, 'a family term');
  assert.deepStrictEqual(verdict('MIT'), { denied: false, notAllowed: false });
  assert.deepStrictEqual(verdict('GPL-3.0-only'), { denied: false, notAllowed: true }, 'not among what the policy allows');
  assert.deepStrictEqual(verdict('GPL-3.0-only OR MIT'), { denied: false, notAllowed: false }, 'a choice passes when one option does');
  assert.deepStrictEqual(verdict('AGPL-3.0-only AND MIT'), { denied: true, notAllowed: false }, 'a combination fails when one part does');
  assert.deepStrictEqual(verdict('MPL-2.0'), { denied: false, notAllowed: false });
  assert.deepStrictEqual(verdict('GPL-3.0-only', null), { denied: false, notAllowed: false }, 'no policy, no verdict');
}

/* ---- Compatibility with the project's licence -------------------------------------- */
{
  const fits = (project, dependency) => lic.compatibility(lic.readLicence(project), lic.readLicence(dependency).tree).compatible;
  assert.strictEqual(fits('GPL-2.0-only', 'Apache-2.0'), false, 'Apache-2.0 cannot join a GPL-2.0-only work');
  assert.strictEqual(fits('GPL-2.0-or-later', 'Apache-2.0'), true, 'it can join one that may become GPL-3.0');
  assert.strictEqual(fits('GPL-2.0-only', 'GPL-3.0-only'), false);
  assert.strictEqual(fits('GPL-3.0-only', 'GPL-2.0-only'), false);
  assert.strictEqual(fits('GPL-3.0-only', 'GPL-2.0-or-later'), true);
  assert.strictEqual(fits('GPL-3.0-or-later', 'BSD-4-Clause'), false, 'the advertising clause');
  assert.strictEqual(fits('AGPL-3.0-only', 'EPL-1.0'), false);
  assert.strictEqual(fits('GPL-3.0-only', 'CDDL-1.0 OR MIT'), true, 'a choice with a compatible option');
  assert.strictEqual(fits('GPL-2.0-only', 'GPL-2.0-only WITH Classpath-exception-2.0'), true);
  assert.strictEqual(fits('MIT', 'BSD-4-Clause'), true, 'only the settled GNU conflicts are judged');
  assert.strictEqual(fits('LGPL-3.0-only', 'Apache-2.0'), true);
}

/* ---- Asking deps.dev ---------------------------------------------------------------- */
(async () => {
  {
    const calls = [];
    const transport = async input => {
      calls.push(input);
      if (/left-pad/.test(input.url)) return { statusCode: 404, body: '' };
      if (/broken/.test(input.url)) throw new Error('socket hang up');
      if (/requests/.test(input.url)) return { statusCode: 200, body: JSON.stringify({ licenses: ['Apache-2.0'] }) };
      if (/two/.test(input.url)) return { statusCode: 200, body: JSON.stringify({ licenses: ['MIT', 'BSD-3-Clause'] }) };
      return { statusCode: 200, body: JSON.stringify({ licenses: ['MIT'] }) };
    };
    const inventory = [
      { ecosystem: 'npm', name: 'express', version: '4.18.2', license: 'MIT', direct: true },
      { ecosystem: 'npm', name: '@scope/pkg', version: '1.0.0', direct: true },
      { ecosystem: 'npm', name: 'left-pad', version: '1.3.0', direct: false },
      { ecosystem: 'npm', name: 'broken', version: '1.0.0', direct: false },
      { ecosystem: 'npm', name: 'two', version: '1.0.0', direct: false },
      { ecosystem: 'pypi', name: 'Requests', version: '2.31.0', direct: true },
      { ecosystem: 'pypi', name: 'requests', version: '2.31.0', direct: false },
      { ecosystem: 'go', name: 'github.com/gin-gonic/gin', version: '1.9.1', direct: true },
      { ecosystem: 'maven', name: 'org.slf4j:slf4j-api', version: '2.0.9', direct: true },
      { ecosystem: 'packagist', name: 'monolog/monolog', version: '3.0.0', direct: true }
    ];
    const result = await lic.lookupLicences(inventory, transport);
    assert.strictEqual(result.total, 9, 'one question per version');
    assert.strictEqual(result.fromLock, 1, 'a licence the lockfile states is never asked about');
    assert.strictEqual(result.asked, 7, 'Packagist is not on deps.dev; its lockfile states licences');
    assert(calls.every(input => input.profile === 'licence-query' && input.method === 'GET' && !input.headers.authorization && !input.url.includes('?')), 'anonymous, through the licence profile');
    assert.deepStrictEqual(calls.map(input => input.url).sort(), [
      'https://api.deps.dev/v3/systems/go/packages/github.com%2Fgin-gonic%2Fgin/versions/v1.9.1',
      'https://api.deps.dev/v3/systems/maven/packages/org.slf4j%3Aslf4j-api/versions/2.0.9',
      'https://api.deps.dev/v3/systems/npm/packages/%40scope%2Fpkg/versions/1.0.0',
      'https://api.deps.dev/v3/systems/npm/packages/broken/versions/1.0.0',
      'https://api.deps.dev/v3/systems/npm/packages/left-pad/versions/1.3.0',
      'https://api.deps.dev/v3/systems/npm/packages/two/versions/1.0.0',
      'https://api.deps.dev/v3/systems/pypi/packages/requests/versions/2.31.0'
    ]);
    const answer = (ecosystem, name, version) => result.answers.get(lic.versionKey({ ecosystem, name, version }));
    assert.deepStrictEqual(answer('npm', 'express', '4.18.2'), { value: 'MIT', source: 'lock' });
    assert.deepStrictEqual(answer('pypi', 'requests', '2.31.0'), { value: 'Apache-2.0', source: 'deps.dev' });
    assert.deepStrictEqual(answer('npm', 'two', '1.0.0'), { value: '(MIT) AND (BSD-3-Clause)', source: 'deps.dev' }, 'several licences all apply');
    assert.deepStrictEqual(answer('npm', 'left-pad', '1.3.0'), { value: null, source: 'deps.dev', missing: true });
    assert.strictEqual(answer('npm', 'broken', '1.0.0'), 'unknown', 'an unanswered question is unknown, never permissive');
    assert.strictEqual(answer('packagist', 'monolog/monolog', '3.0.0'), undefined);

    /* A bound: the project's own dependencies are asked about first; past it, not asked. */
    const many = Array.from({ length: 5 }, (_, index) => ({ ecosystem: 'npm', name: `p${index}`, version: '1.0.0', direct: index === 4 }));
    const bounded = await lic.lookupLicences([...many].sort((a, b) => Number(b.direct) - Number(a.direct)), async () => ({ statusCode: 200, body: '{"licenses":["MIT"]}' }), { maxLookups: 2, concurrency: 2, maxResponseBytes: 1024 });
    assert.strictEqual(bounded.asked, 2);
    assert.strictEqual(bounded.answers.get(lic.versionKey(many[4])).source, 'deps.dev');
    assert.strictEqual([...bounded.answers.values()].filter(value => value === 'not-asked').length, 3);
  }

  /* ---- Findings -------------------------------------------------------------------- */
  {
    const entry = (name, extra = {}) => ({ ecosystem: 'npm', name, version: '1.0.0', path: 'package.json', line: 3, direct: true, dev: false, ...extra });
    const answers = map => new Map(Object.entries(map).map(([name, value]) => [lic.versionKey({ ecosystem: 'npm', name, version: '1.0.0' }), value === 'unknown' ? value : { value, source: 'deps.dev' }]));
    const judge = (inventory, map, { project = lic.projectLicence([]), policy = null } = {}) => lic.licenceFindings(inventory, answers(map), { project, policy });
    const rules = result => result.out.map(item => [item.rule, item.detail && item.detail.package, item.severity || null]);

    /* Proprietary code: what each family asks of it. */
    const proprietary = judge([
      entry('agpl'), entry('gpl'), entry('lgpl'), entry('nc'), entry('mit'), entry('none'), entry('odd'),
      entry('dev-agpl', { dev: true }), entry('dev-nc', { dev: true }), entry('deep-odd', { direct: false, path: 'package-lock.json' }), entry('gone')
    ], { agpl: 'AGPL-3.0-only', gpl: 'GPL-3.0-only', lgpl: 'LGPL-3.0-only', nc: 'CC-BY-NC-4.0', mit: 'MIT', none: 'UNLICENSED', odd: 'SEE LICENSE IN LICENSE', 'dev-agpl': 'AGPL-3.0-only', 'dev-nc': 'CC-BY-NC-4.0', 'deep-odd': 'non-standard', gone: 'unknown' });
    assert.deepStrictEqual(rules(proprietary), [
      ['LIC-001', 'agpl', null], ['LIC-002', 'gpl', null], ['LIC-003', 'nc', null], ['LIC-004', 'none', null], ['LIC-004', 'odd', null], ['LIC-003', 'dev-nc', 'warning']
    ], 'weak copyleft is listed, not reported; a development tool never ships its copyleft; an unread transitive is counted, not reported');
    assert.deepStrictEqual(proprietary.out.find(item => item.detail.package === 'none').detail.none, true);
    assert.deepStrictEqual(proprietary.summary.families, { 'public-domain': 0, permissive: 1, 'weak-copyleft': 1, 'strong-copyleft': 1, 'network-copyleft': 2, restricted: 2, none: 1, unknown: 3 });
    assert.deepStrictEqual(proprietary.summary.status, { versions: 11, known: 8, unknown: 3, notAsked: 0, fromLock: 0, fromRegistry: 10 });
    assert.deepStrictEqual(proprietary.summary.packages.map(item => item.package), ['odd', 'deep-odd', 'none', 'nc', 'dev-nc', 'agpl', 'dev-agpl', 'gpl', 'lgpl'], 'the least settled and most demanding first; what ships before what only developers install; the project\u2019s own before what came with it');
    assert(!proprietary.summary.packages.some(item => item.family === 'permissive'), 'the permissive majority is not listed');
    assert.strictEqual(proprietary.out[0].path, 'package.json');
    assert.strictEqual(proprietary.out[0].line, 3);

    /* A GPL project: GPL is its own terms; AGPL still asks more, one step softer; a settled conflict is its own finding. */
    const gplProject = lic.projectLicence([{ path: 'LICENSE', text: 'GNU GENERAL PUBLIC LICENSE Version 3' }]);
    const gpl = judge([entry('gpl'), entry('agpl'), entry('bsd4'), entry('gpl2only')], { gpl: 'GPL-3.0-or-later', agpl: 'AGPL-3.0-only', bsd4: 'BSD-4-Clause', gpl2only: 'GPL-2.0-only' }, { project: gplProject });
    assert.deepStrictEqual(rules(gpl), [['LIC-001', 'agpl', 'warning'], ['LIC-006', 'bsd4', null], ['LIC-006', 'gpl2only', null]]);
    assert.strictEqual(gpl.out.find(item => item.rule === 'LIC-006').detail.project, 'GPL-3.0-only');

    /* A policy: a denial and an allow list are findings of their own, an allowed family settles the default rules, and a cleared package is waived with its reason. */
    const policy = lic.readPolicy([{ path: '.nebulaverse/licences.json', text: JSON.stringify({ allow: ['permissive', 'strong-copyleft'], deny: ['network-copyleft'], packages: { 'npm:cleared': 'Legal said yes' } }) }]);
    const governed = judge([entry('agpl'), entry('gpl'), entry('mpl'), entry('cleared'), entry('mit')], { agpl: 'AGPL-3.0-only', gpl: 'GPL-3.0-only', mpl: 'MPL-2.0', cleared: 'SSPL-1.0', mit: 'MIT' }, { policy });
    assert.deepStrictEqual(rules(governed), [['LIC-005', 'agpl', null], ['LIC-005', 'mpl', null], ['LIC-005', 'cleared', null]]);
    assert.deepStrictEqual(governed.out.map(item => item.detail.reason), ['denied', 'not-allowed', 'denied']);
    assert.deepStrictEqual(governed.out[2].suppression, { reason: 'Legal said yes', line: null, policy: '.nebulaverse/licences.json' });
    assert.deepStrictEqual(governed.summary.policy, { path: '.nebulaverse/licences.json', invalid: false, allow: 2, deny: 1, cleared: 1 });

    /* A policy that does not parse is reported, and the defaults apply. */
    const broken = judge([entry('gpl')], { gpl: 'GPL-3.0-only' }, { policy: lic.readPolicy([{ path: '.nebulaverse/licences.json', text: 'nope' }]) });
    assert.deepStrictEqual(rules(broken), [['LIC-007', undefined, null], ['LIC-002', 'gpl', null]]);

    /* One finding per version, however many manifests name it. */
    const twice = judge([entry('gpl'), entry('gpl', { path: 'apps/web/package.json' })], { gpl: 'GPL-3.0-only' });
    assert.strictEqual(twice.out.length, 1);
  }

  /* ---- In the audit ------------------------------------------------------------------- */
  {
    const files = [
      { path: 'package.json', text: JSON.stringify({ name: 'shop', version: '1.0.0', dependencies: { express: '4.18.2', ghostscript: '1.0.0' } }, null, 2) },
      { path: 'package-lock.json', text: JSON.stringify({ lockfileVersion: 3, packages: {
        '': { name: 'shop', dependencies: { express: '4.18.2', ghostscript: '1.0.0' } },
        'node_modules/express': { version: '4.18.2', license: 'MIT' },
        'node_modules/ghostscript': { version: '1.0.0' }
      } }) },
      { path: 'README.md', text: '# shop' },
      { path: 'LICENSE', text: 'Copyright Shop Ltd. All rights reserved.' },
      { path: 'src/index.js', text: 'const express = require("express");\nconst gs = require("ghostscript");\nmodule.exports = express();\n' }
    ];
    const answers = new Map([
      [lic.versionKey({ ecosystem: 'npm', name: 'express', version: '4.18.2' }), { value: 'MIT', source: 'lock' }],
      [lic.versionKey({ ecosystem: 'npm', name: 'ghostscript', version: '1.0.0' }), { value: 'AGPL-3.0-only', source: 'deps.dev' }]
    ]);
    const without = audit.analyse({ files, paths: files.map(file => file.path) });
    const withLicences = audit.analyse({ files, paths: files.map(file => file.path), licences: answers });
    const finding = withLicences.findings.find(item => item.rule === 'LIC-001');
    assert(finding, 'the AGPL dependency is reported');
    assert.strictEqual(finding.category, 'licences');
    assert.strictEqual(finding.standards, null, 'no CWE is claimed for a licence');
    assert.match(finding.prompt, /ghostscript 1\.0\.0 -- AGPL-3\.0-only/);
    assert.strictEqual(withLicences.score, without.score, 'a licence never moves the grade');
    assert.strictEqual(withLicences.grade, without.grade);
    assert(!withLicences.priorities.includes(finding.id), 'nor enters what to fix first');
    const family = withLicences.categories.find(category => category.id === 'licences');
    assert.deepStrictEqual([family.weight, family.counts.serious], [0, 1], 'its own family, weighed at nothing');
    assert.strictEqual(withLicences.licences.project.family, 'proprietary');
    assert.strictEqual(withLicences.licences.project.unread, true);
    const row = withLicences.ledger.find(item => item.id === 'licences');
    assert.strictEqual(row.status, 'covered');
    assert.match(row.detail, /^2 of 2 package versions read \(1 from lockfiles, 1 from deps\.dev\) and judged against use in proprietary code/);
    assert.strictEqual(without.ledger.find(item => item.id === 'licences').status, 'not-assessed', 'an audit that did not look them up says so');
    assert.strictEqual(without.licences, null);
    /* The bill of materials carries the licence deps.dev answered. */
    assert.strictEqual(withLicences.components.find(component => component.name === 'ghostscript').license, 'AGPL-3.0-only');
    assert.strictEqual(withLicences.components.find(component => component.name === 'express').license, 'MIT');
    /* The licence file is read for its licence, never scanned as code. */
    assert(!withLicences.findings.some(item => item.path === 'LICENSE'));
    /* A waiver in the policy keeps the finding visible, unscored. */
    const cleared = audit.analyse({ files: [...files, { path: '.nebulaverse/licences.json', text: '{"packages":{"npm:ghostscript":"Commercial licence bought 2026-02"}}' }], paths: [...files.map(file => file.path), '.nebulaverse/licences.json'], licences: answers });
    assert(!cleared.findings.some(item => item.rule === 'LIC-001'));
    assert.strictEqual(cleared.suppressed.find(item => item.rule === 'LIC-001').suppression.reason, 'Commercial licence bought 2026-02');
  }

  /* ---- Selection: the licence and the policy are always read ---------------------------- */
  {
    const entries = [
      { path: 'LICENSE', size: 1000, sha: 'a' }, { path: '.nebulaverse/licences.json', size: 100, sha: 'b' },
      { path: 'docs/LICENSE', size: 1000, sha: 'c' }, ...Array.from({ length: 5 }, (_, index) => ({ path: `src/f${index}.js`, size: 10, sha: `s${index}` }))
    ];
    const selection = audit.selectFiles(entries, { ...audit.LIMITS, maxFiles: 2 });
    assert.deepStrictEqual(selection.selected.map(entry => entry.path).sort(), ['.nebulaverse/licences.json', 'LICENSE']);
  }

  console.log('licence tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
