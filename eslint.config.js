'use strict';

/*
 * Static identifier resolution for the alpha.17 candidate.
 *
 * `node --check` proves that each file parses. It does not prove that every
 * referenced name resolves. The browser layer is a set of classic scripts
 * sharing one global scope, so a name that lives inside another script's
 * module closure parses cleanly and throws only when the code path runs.
 * `no-undef` closes that gap.
 *
 * The shared surfaces below are declared exactly as the sources publish them,
 * so a name that is not genuinely published stays an error. Adding a new
 * cross-script global therefore requires declaring it here, which keeps the
 * implicit global contract explicit and reviewable.
 */

const globals = require('globals');

/* Published on `window` by the module wrappers that own them. */
const PUBLISHED_MODULE_GLOBALS = Object.freeze({
  NebulaAlphaUI: 'readonly',
  NebulaArchiveSafety: 'readonly',
  NebulaCapabilityUI: 'readonly',
  NebulaExportSafety: 'readonly',
  NebulaGovernanceUI: 'readonly',
  NebulaNeural: 'readonly',
  NebulaOfflineCachePolicy: 'readonly',
  NebulaTrustUI: 'readonly',
  NebulaUploadPlanning: 'readonly',
  NebulaWorkspaceUI: 'readonly',
  NebulaPwa: 'writable',
  _oauthOn: 'writable'
});

/*
 * Declared at the top level of public/app.js, which loads last and therefore
 * owns the shared application scope. public/neural.js is lazy-loaded by
 * app.js and the browser test callbacks run against the same document, so
 * both resolve against these names at runtime.
 */
const APP_SHELL_GLOBALS = Object.freeze({
  api: 'readonly',
  currentTab: 'readonly',
  dlFile: 'readonly',
  exportActivityFlow: 'readonly',
  modal: 'readonly',
  openFile: 'readonly',
  openSafeguards: 'readonly',
  openSettings: 'readonly',
  recoveryFlow: 'readonly',
  securityScanFlow: 'readonly',
  setSafety: 'readonly',
  state: 'readonly',
  stepUpApi: 'readonly',
  strategyFor: 'readonly',
  switchTab: 'readonly',
  toast: 'readonly'
});

/* Vendored browser libraries served from public/vendor. */
const VENDOR_GLOBALS = Object.freeze({
  CodeMirror: 'writable',
  DOMPurify: 'readonly',
  marked: 'readonly'
});

/* Loaded through a script tag and also required by Node tests or the server. */
const DUAL_TARGET_MODULES = Object.freeze([
  'public/archive-safety.js',
  'public/export-safety.js',
  'public/governance-ui.js',
  'public/offline-cache-policy.js',
  'public/repo-sigil.js',
  'public/upload-planning.js',
  'public/workspace-pulse.js'
]);

/*
 * The design's WebGL artwork. These are the only true ES modules in the
 * browser layer: they are loaded by dynamic import rather than a script tag,
 * because three.js ships as a module and a bare specifier would have cost an
 * inline import map -- and an inline script means relaxing script-src.
 */
const BROWSER_ES_MODULES = Object.freeze([
  'public/nebula-galaxy.js',
  'public/nebula-mark-3d.js'
]);

const RULES = Object.freeze({ 'no-undef': 'error' });

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'public/vendor/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**'
    ]
  },
  {
    name: 'nebulaverse/node-commonjs',
    files: [
      'server.js',
      'eslint.config.js',
      'playwright.config.js',
      'src/**/*.js',
      'scripts/**/*.js',
      'ci/**/*.js',
      'test/**/*.js'
    ],
    ignores: ['test/e2e/**', 'scripts/design-review.js', 'scripts/accessibility-audit.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node }
    },
    rules: RULES
  },
  {
    /* Node programs whose page callbacks are serialized into the browser. */
    name: 'nebulaverse/browser-test-programs',
    files: ['test/e2e/**/*.js', 'scripts/design-review.js', 'scripts/accessibility-audit.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...APP_SHELL_GLOBALS,
        ...PUBLISHED_MODULE_GLOBALS
      }
    },
    rules: RULES
  },
  {
    name: 'nebulaverse/browser-classic-scripts',
    files: ['public/*.js'],
    ignores: ['public/sw.js', ...DUAL_TARGET_MODULES, ...BROWSER_ES_MODULES],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...VENDOR_GLOBALS,
        ...APP_SHELL_GLOBALS,
        ...PUBLISHED_MODULE_GLOBALS
      }
    },
    rules: RULES
  },
  {
    name: 'nebulaverse/browser-es-modules',
    files: BROWSER_ES_MODULES,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser }
    },
    rules: RULES
  },
  {
    name: 'nebulaverse/service-worker',
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.serviceworker,
        ...PUBLISHED_MODULE_GLOBALS
      }
    },
    rules: RULES
  },
  {
    name: 'nebulaverse/dual-target-modules',
    files: DUAL_TARGET_MODULES,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.node,
        ...VENDOR_GLOBALS,
        ...PUBLISHED_MODULE_GLOBALS
      }
    },
    rules: RULES
  }
];
