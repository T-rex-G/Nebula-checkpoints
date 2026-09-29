'use strict';

/*
 * Uranus reach: which vulnerable packages the code imports, names or only
 * carries; which dependency brought a transitive one in; and the one risk
 * number built from impact, threat and reach. Nothing here may call a
 * package unused -- the most it may say is "installed, no import found".
 */

const assert = require('assert');
const audit = require('../src/code-audit');
const { usageIndex, riskOf, threatOf, jsPackageOf, pythonModules, TIERS, BANDS } = require('../src/uranus-reach');

const isTest = filePath => /(^|\/)(test|tests|__tests__)\/|\.test\.[jt]s$|(^|\/)test_[^/]+\.py$/.test(filePath);

/* ---- Specifiers ---------------------------------------------------------------------------- */
{
  assert.strictEqual(jsPackageOf('express'), 'express');
  assert.strictEqual(jsPackageOf('lodash/merge'), 'lodash');
  assert.strictEqual(jsPackageOf('@scope/pkg/sub/path'), '@scope/pkg');
  assert.strictEqual(jsPackageOf('React-DOM/client'), 'react-dom');
  for (const local of ['./a', '../b', '/abs', 'node:fs', '#internal', '~/alias', '@/components', 'bun:test', '${name}', '@scope']) {
    assert.strictEqual(jsPackageOf(local), null, `${local} is not a package`);
  }
  assert(pythonModules('PyYAML').includes('yaml'));
  assert(pythonModules('beautifulsoup4').includes('bs4'));
  assert(pythonModules('google-cloud-storage').includes('google.cloud.storage'));
  assert(pythonModules('psycopg2-binary').includes('psycopg2'));
  assert(pythonModules('Django').includes('django'));
  assert(pythonModules('python-docx').includes('docx'), 'the python- prefix is not part of the import name');
}

/* ---- Where a package is imported, named or run, by role ------------------------------------- */
{
  const wanted = [
    { ecosystem: 'npm', key: 'express', name: 'express' }, { ecosystem: 'npm', key: 'pg', name: 'pg' },
    { ecosystem: 'npm', key: 'jquery', name: 'jquery' }, { ecosystem: 'npm', key: '@babel/core', name: '@babel/core' },
    { ecosystem: 'npm', key: 'lodash', name: 'lodash' }, { ecosystem: 'npm', key: 'next', name: 'next' },
    { ecosystem: 'npm', key: 'react-scripts', name: 'react-scripts' }, { ecosystem: 'npm', key: 'typescript', name: 'typescript' },
    { ecosystem: 'pypi', key: 'pyyaml', name: 'PyYAML' }, { ecosystem: 'pypi', key: 'djangorestframework', name: 'djangorestframework' },
    { ecosystem: 'pypi', key: 'google-cloud-storage', name: 'google-cloud-storage' }, { ecosystem: 'pypi', key: 'pytest', name: 'pytest' }
  ];
  const files = [
    { path: 'src/server.ts', text: "import express, {\n  Router,\n} from 'express';\nimport type { Pool } from 'pg';\nconst knex = require('knex')({ client: 'pg' });\n" },
    { path: 'web/main.js', text: "const $ = await import('jquery');\n" },
    { path: 'babel.config.js', text: "module.exports = { presets: ['@babel/core'] };\n" },
    { path: 'test/util.test.js', text: "const _ = require('lodash/fp');\n" },
    { path: 'package.json', text: JSON.stringify({ scripts: { start: 'next start', dev: 'react-scripts start', 'start:web': 'react-scripts start', build: 'tsc -p .' } }) },
    { path: 'app/settings.py', text: "INSTALLED_APPS = ['rest_framework', 'django.contrib.admin']\n" },
    { path: 'app/io.py', text: 'import os, yaml as y\nfrom google.cloud import storage\n' },
    { path: 'tests/test_io.py', text: 'import pytest\n' }
  ];
  const usage = usageIndex(files, wanted, isTest);
  const roleOf = (map, key) => ['runtime', 'build', 'test'].filter(role => map.get(key) && map.get(key)[role]).map(role => `${role}:${map.get(key)[role].how}`).join(',');
  assert.strictEqual(roleOf(usage.npm, 'express'), 'runtime:import', 'a multi-line import');
  assert.strictEqual(roleOf(usage.npm, 'pg'), 'runtime:import', 'a type import counts, and so does the dialect name');
  assert.strictEqual(roleOf(usage.npm, 'jquery'), 'runtime:import', 'a dynamic import');
  assert.strictEqual(roleOf(usage.npm, '@babel/core'), 'build:name', 'a preset named in build configuration');
  assert.strictEqual(roleOf(usage.npm, 'lodash'), 'test:import', 'a subpath import from a test');
  assert.strictEqual(roleOf(usage.npm, 'next'), 'runtime:name', '`start` serves in production');
  assert.strictEqual(roleOf(usage.npm, 'react-scripts'), 'build:name', 'a development server run by `start` is still build tooling');
  assert.strictEqual(roleOf(usage.npm, 'typescript'), 'build:name', 'a command whose package has another name');
  assert.deepStrictEqual(usage.npm.get('express').runtime.files, ['src/server.ts']);
  assert.strictEqual(roleOf(usage.pypi, 'pyyaml'), 'runtime:import', 'an import name that is not the package name');
  assert.strictEqual(roleOf(usage.pypi, 'djangorestframework'), 'runtime:name', 'a Django app named in settings');
  assert.strictEqual(roleOf(usage.pypi, 'google-cloud-storage'), 'runtime:import', 'a namespace package');
  assert.strictEqual(roleOf(usage.pypi, 'pytest'), 'test:import');

  /*
   * What a build ships is not build tooling: a bundler's input, a build
   * configuration's entry or provided global, and anything served from
   * node_modules all reach the user. Only a tool -- the command a script
   * runs, a loader, a plugin, a preset -- is build.
   */
  const shipping = [
    { ecosystem: 'npm', key: 'jquery', name: 'jquery' }, { ecosystem: 'npm', key: 'browserify', name: 'browserify' },
    { ecosystem: 'npm', key: 'babel-loader', name: 'babel-loader' }, { ecosystem: 'npm', key: 'moment', name: 'moment' },
    { ecosystem: 'npm', key: 'bootstrap', name: 'bootstrap' }, { ecosystem: 'npm', key: '@babel/preset-env', name: '@babel/preset-env' },
    { ecosystem: 'npm', key: 'chart.js', name: 'chart.js' }, { ecosystem: 'npm', key: 'nodemon', name: 'nodemon' }
  ];
  const built = usageIndex([
    { path: 'package.json', text: JSON.stringify({ scripts: { build: 'NODE_ENV=production npx browserify -r jquery > public/js/bundle.js', dev: 'cross-env DEBUG=1 nodemon app.js' } }) },
    { path: 'webpack.config.js', text: "module.exports = { module: { rules: [{ loader: 'babel-loader' }] }, plugins: [new webpack.ProvidePlugin({ moment: 'moment' })] };\n" },
    { path: 'app.js', text: "app.use('/vendor', express.static(path.join(__dirname, 'node_modules/bootstrap/dist')));\n" },
    { path: 'views/layout.html', text: '<script src="/node_modules/chart.js/dist/chart.umd.js"></script>\n' },
    { path: '.babelrc', text: JSON.stringify({ presets: ['@babel/preset-env'] }) }
  ], shipping, isTest);
  const tierOfUse = key => ['runtime', 'build', 'test'].filter(role => built.npm.get(key) && built.npm.get(key)[role]).map(role => `${role}:${built.npm.get(key)[role].how}`).join(',');
  assert.strictEqual(tierOfUse('jquery'), 'runtime:bundle', 'what browserify is handed ships');
  assert.strictEqual(tierOfUse('browserify'), 'build:name', 'the bundler itself is build tooling');
  assert.strictEqual(tierOfUse('babel-loader'), 'build:name', 'a loader named in build configuration');
  assert.strictEqual(tierOfUse('moment'), 'runtime:bundle', 'a global the build provides ships');
  assert.strictEqual(tierOfUse('bootstrap'), 'runtime:bundle', 'served from node_modules');
  assert.strictEqual(tierOfUse('chart.js'), 'runtime:bundle', 'a page loads it from node_modules');
  assert.strictEqual(tierOfUse('@babel/preset-env'), 'build:name', 'a preset in a tool’s own configuration');
  assert.strictEqual(tierOfUse('nodemon'), 'build:name', 'launchers and environment assignments are skipped to find the command');

  /* An import in build configuration is build; a type declaration never runs. */
  const configured = usageIndex([
    { path: 'scripts/package.mjs', text: "import { glob } from 'glob';\n" },
    { path: 'src/types.d.ts', text: "/// <reference types=\"vitest\" />\nimport type { Mock } from 'vitest';\n" }
  ], [{ ecosystem: 'npm', key: 'glob', name: 'glob' }, { ecosystem: 'npm', key: 'vitest', name: 'vitest' }], isTest);
  assert.deepStrictEqual(Object.keys(configured.npm.get('glob')).filter(role => configured.npm.get('glob')[role]), ['build'], 'an import’s own specifier is not also a bundled name');
  assert.deepStrictEqual(Object.keys(configured.npm.get('vitest')).filter(role => configured.npm.get('vitest')[role]), ['build']);

  /* A long run of words with no quote cannot make the import scan slow. */
  const slow = { path: 'src/huge.js', text: `import ${'a '.repeat(200_000)}\n` };
  const started = Date.now();
  usageIndex([slow], wanted, isTest);
  assert(Date.now() - started < 1000, 'bounded scan');
}

/* ---- Risk ---------------------------------------------------------------------------------- */
{
  assert.strictEqual(threatOf({ exploited: true }), 1);
  assert.strictEqual(threatOf(null), 0.35, 'unknown is neither reassuring nor alarming');
  assert(threatOf({ epss: { score: 0.0004 } }) < 0.06);
  assert(Math.abs(threatOf({ epss: { score: 0.01 } }) - 0.347) < 0.01);
  assert(threatOf({ epss: { score: 0.5 } }) > 0.89);

  const exploitedImported = riskOf({ severity: 'serious', cvss: 7.5, intel: { exploited: true }, tier: 'imported' });
  assert.strictEqual(exploitedImported.score, 90);
  assert.strictEqual(exploitedImported.band, 'urgent');
  assert.deepStrictEqual(exploitedImported.factors, { impact: 0.75, threat: 1, reach: 1 });
  const exploitedLowImpact = riskOf({ severity: 'warning', cvss: 4.3, intel: { exploited: true }, tier: 'installed' });
  assert.strictEqual(exploitedLowImpact.score, 80, 'exploited in something that ships is never below urgent');
  const exploitedDev = riskOf({ severity: 'serious', cvss: 7.8, intel: { exploited: true }, tier: 'dev' });
  assert(exploitedDev.score < 60, 'a development tool is not held at urgent');
  const unlikely = riskOf({ severity: 'critical', cvss: 9.8, intel: { epss: { score: 0.0004 } }, tier: 'imported' });
  assert.strictEqual(unlikely.band, 'moderate', 'severe but unlikely');
  const floorOnly = riskOf({ severity: 'serious', cvss: 7.5, intel: { exploited: true }, tier: 'imported', certainty: 0.4 });
  assert(floorOnly.score < 60, 'a range that admits the fix is uncertain, and not held at urgent');
  assert.strictEqual(riskOf({ malicious: true }).score, 100);
  assert.strictEqual(riskOf({ severity: 'serious', cvss: null, intel: null, tier: 'unknown' }).factors.impact, 0.75, 'no CVSS: the severity stands in');
  assert(BANDS.every(([, floor], index, all) => index === 0 || floor < all[index - 1][1]));
  assert(Object.values(TIERS).filter(tier => !tier.production).every(tier => tier.factor < TIERS.installed.factor));
}

/* ---- Lockfile graphs --------------------------------------------------------------------- */
{
  const npm = audit.readDependencies([
    { path: 'package.json', text: JSON.stringify({ dependencies: { express: '^4' }, devDependencies: { jest: '^29' } }) },
    { path: 'package-lock.json', text: JSON.stringify({ lockfileVersion: 3, packages: {
      '': { dependencies: { express: '^4' }, devDependencies: { jest: '^29' } },
      'node_modules/express': { version: '4.17.1', dependencies: { 'body-parser': '1', qs: '6' } },
      'node_modules/body-parser': { version: '1.19.0', dependencies: { qs: '6' } },
      'node_modules/qs': { version: '6.7.0' },
      'node_modules/jest': { version: '29.0.0', dev: true, dependencies: { json5: '2' } },
      'node_modules/json5': { version: '2.0.0', dev: true },
      'node_modules/orphan': { version: '1.0.0' }
    } }) }
  ]);
  const graph = npm.graphs.get('package-lock.json');
  assert.deepStrictEqual(audit.introducedThrough(graph, 'qs'), { roots: [{ name: 'express', dev: false }], chain: ['express', 'qs'] }, 'the shortest chain');
  assert.deepStrictEqual(audit.introducedThrough(graph, 'json5'), { roots: [{ name: 'jest', dev: true }], chain: ['jest', 'json5'] });
  assert.deepStrictEqual(audit.introducedThrough(graph, 'orphan'), { roots: [], chain: [] }, 'required by nothing the project asked for');
  assert(npm.inventory.every(entry => entry.source !== 'lock' || entry.lock === 'package-lock.json'));

  const yarn = audit.readDependencies([
    { path: 'package.json', text: JSON.stringify({ dependencies: { express: '^4' } }) },
    { path: 'yarn.lock', text: 'express@^4:\n  version "4.17.1"\n  dependencies:\n    "body-parser" "1.19.0"\n    qs "6.7.0"\n\nbody-parser@1.19.0:\n  version "1.19.0"\n  dependencies:\n    qs "6.7.0"\n\nqs@6.7.0:\n  version "6.7.0"\n' }
  ]);
  assert.deepStrictEqual(audit.introducedThrough(yarn.graphs.get('yarn.lock'), 'qs').chain, ['express', 'qs']);
  const berry = audit.readDependencies([
    { path: 'package.json', text: JSON.stringify({ dependencies: { express: '^4' } }) },
    { path: 'yarn.lock', text: '__metadata:\n  version: 6\n\n"express@npm:^4":\n  version: 4.17.1\n  dependencies:\n    qs: 6.7.0\n\n"qs@npm:6.7.0":\n  version: 6.7.0\n' }
  ]);
  assert.deepStrictEqual(audit.introducedThrough(berry.graphs.get('yarn.lock'), 'qs').chain, ['express', 'qs']);
  assert.deepStrictEqual(berry.inventory.map(entry => `${entry.name}@${entry.version}`), ['express@4.17.1', 'qs@6.7.0']);

  const pnpm = audit.readDependencies([
    { path: 'pnpm-lock.yaml', text: "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      express:\n        specifier: ^4\n        version: 4.17.1\n    devDependencies:\n      jest:\n        specifier: ^29\n        version: 29.0.0\npackages:\n  express@4.17.1:\n    resolution: {}\n  qs@6.7.0:\n    resolution: {}\n  jest@29.0.0:\n    resolution: {}\nsnapshots:\n  express@4.17.1:\n    dependencies:\n      qs: 6.7.0\n  qs@6.7.0: {}\n  jest@29.0.0: {}\n" }
  ]);
  const pnpmGraph = pnpm.graphs.get('pnpm-lock.yaml');
  assert.deepStrictEqual(audit.introducedThrough(pnpmGraph, 'qs'), { roots: [{ name: 'express', dev: false }], chain: ['express', 'qs'] }, 'importers name the roots, snapshots the edges');
  assert.strictEqual(pnpmGraph.roots.get('jest').dev, true);
  const pnpm6 = audit.readDependencies([
    { path: 'pnpm-lock.yaml', text: "lockfileVersion: '6.0'\ndependencies:\n  express:\n    specifier: ^4\n    version: 4.17.1\npackages:\n  /express@4.17.1:\n    resolution: {}\n    dependencies:\n      qs: 6.7.0\n    dev: false\n  /qs@6.7.0:\n    resolution: {}\n    dev: false\n" }
  ]);
  assert.deepStrictEqual(audit.introducedThrough(pnpm6.graphs.get('pnpm-lock.yaml'), 'qs').chain, ['express', 'qs']);

  const poetry = audit.readDependencies([
    { path: 'requirements.txt', text: 'requests==2.25.0\n' },
    { path: 'poetry.lock', text: '[[package]]\nname = "requests"\nversion = "2.25.0"\n\n[package.dependencies]\nurllib3 = ">=1.21.1,<1.27"\nidna = {version = ">=2.5"}\n\n[package.extras]\nsocks = ["PySocks"]\n\n[[package]]\nname = "urllib3"\nversion = "1.26.0"\n\n[metadata]\nlock-version = "1.1"\n' }
  ]);
  assert.deepStrictEqual(audit.introducedThrough(poetry.graphs.get('poetry.lock'), 'urllib3').chain, ['requests', 'urllib3']);
  assert.deepStrictEqual(poetry.inventory.map(entry => `${entry.name}@${entry.version}`).sort(), ['requests@2.25.0', 'urllib3@1.26.0']);

  const pipfile = audit.readDependencies([{ path: 'Pipfile.lock', text: JSON.stringify({ default: { urllib3: { version: '==1.26.0' } } }) }]);
  assert.strictEqual(audit.introducedThrough(pipfile.graphs.get('Pipfile.lock'), 'urllib3'), null, 'a flat lockfile records no requirements');
}

console.log('uranus reach tests passed');
