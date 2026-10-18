'use strict';

/*
 * Static identifier resolution.
 *
 * `node --check` proves that each file parses. It does not prove that every
 * referenced name resolves, and a name that does not resolve parses cleanly and
 * throws only when its code path runs. `no-undef` closes that gap.
 *
 * The browser application is ES modules under apps/web and packages/contracts:
 * a module sees only what it imports and the platform's own globals. Until the
 * interface is rebuilt from typed components, some modules still read each
 * other's published objects by name; those names are declared below exactly as
 * the sources publish them, so a name that is not genuinely published stays an
 * error and adding one requires declaring it here.
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
  NebulaOverlayMotion: 'readonly',
  NebulaTrustUI: 'readonly',
  NebulaUploadPlanning: 'readonly',
  NebulaPwa: 'writable',
  _oauthOn: 'writable'
});

/*
 * The workbench functions the browser suite still calls by name, published on
 * window by apps/web/src/legacy/app.js until the read-only diagnostics probe
 * replaces them. Test callbacks serialized into the page resolve against these.
 */
const APP_SHELL_GLOBALS = Object.freeze({
  switchTab: 'readonly',
  toast: 'readonly',
  showPage: 'readonly',
  openSettings: 'readonly',
  openFile: 'readonly',
  stepUpApi: 'readonly',
  strategyFor: 'readonly',
  loadActivityFeed: 'readonly',
  clearExposureState: 'readonly',
  showSiteScan: 'readonly',
  runtimeLimitsKnown: 'readonly',
  uploadOne: 'readonly'
});

/* Bundled from their npm packages and published by apps/web/src/legacy/vendor-globals.js. */
const VENDOR_GLOBALS = Object.freeze({
  CodeMirror: 'writable',
  DOMPurify: 'readonly',
  marked: 'readonly'
});

const RULES = Object.freeze({ 'no-undef': 'error' });

module.exports = [
  {
    ignores: [
      'node_modules/**',
      'public/vendor/**',
      'dist/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      /* the benchmark's applications: deliberately flawed code the engine reads, never code this repository runs */
      'test/fixtures/uranus-benchmark/**'
    ]
  },
  {
    name: 'nebulaverse/node-commonjs',
    files: [
      'server.js',
      'eslint.config.js',
      'playwright*.config.js',
      'src/**/*.js',
      'scripts/**/*.js',
      'ci/**/*.js',
      'test/**/*.js'
    ],
    ignores: ['test/e2e/**', 'test/integration/app-fixture.js', 'scripts/design-review.js', 'scripts/accessibility-audit.js'],
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
    files: ['test/e2e/**/*.js', 'test/integration/app-fixture.js', 'scripts/design-review.js', 'scripts/accessibility-audit.js'],
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
    name: 'nebulaverse/browser-modules',
    files: ['apps/web/src/**/*.js'],
    ignores: ['apps/web/src/offline/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...VENDOR_GLOBALS,
        ...PUBLISHED_MODULE_GLOBALS
      }
    },
    rules: RULES
  },
  {
    /* Classic, blocking, and first: it decides the theme of the first paint. */
    name: 'nebulaverse/theme-boot',
    files: ['apps/web/public/theme-boot.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'script', globals: { ...globals.browser } },
    rules: RULES
  },
  {
    name: 'nebulaverse/service-worker',
    files: ['apps/web/src/offline/sw.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.serviceworker }
    },
    rules: RULES
  },
  {
    /* Shared by the server, the page and the service worker; they depend on no platform. */
    name: 'nebulaverse/contracts',
    files: ['packages/contracts/src/**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.serviceworker }
    },
    rules: RULES
  },
  {
    name: 'nebulaverse/build-configuration',
    files: ['apps/web/vite.config.js'],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: { ...globals.node } },
    rules: RULES
  }
];
