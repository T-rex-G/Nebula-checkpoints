/*
 * The browser build. One entry, content-hashed output, nothing inlined, no
 * source maps: the page must satisfy the same Content-Security-Policy as the
 * scripts it replaces (script-src 'self', font-src 'self'), and what the
 * server attests as served must be exactly these files.
 */
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';

import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { PRODUCT_NAME } = require('../../src/version.js');
const { stripCssComments, stripHtmlComments } = require('../../src/public-assets.js');

export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  publicDir: 'public',
  logLevel: 'warn',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    /* Hashed output in /build/, apart from /assets/, whose icons keep stable names. */
    assetsDir: 'build',
    /* The application is one chunk until it is split by feature; the warning says nothing new. */
    chunkSizeWarningLimit: 1600,
    assetsInlineLimit: 0,
    sourcemap: false,
    modulePreload: { polyfill: false },
    target: 'es2022',
    /*
     * The stylesheet ships as written, less its comments. A CSS minifier
     * rewrites the cascade it is given: it read `backdrop-filter:none;
     * -webkit-backdrop-filter:none` as one property declared twice and kept
     * only the prefixed copy, so the unprefixed blur of an earlier rule won
     * again on every phone. It also respells custom-property values, which
     * scripts read as text. The cascade the stylesheet's own comments reason
     * about is the cascade the browser receives.
     */
    cssMinify: false,
    reportCompressedSize: false,
    /* A bundled library's licence travels with its code; source commentary does not. */
    rolldownOptions: { output: { comments: { legal: true, annotation: false, jsdoc: false } } }
  },
  plugins: [{
    /*
     * The licences of every package the build bundles, in one file served
     * beside the page. Most libraries put their notice in a LICENSE file
     * rather than in their code, so keeping legal comments is not enough.
     */
    name: 'nebulaverse-licences',
    generateBundle(_options, bundle) {
      const sources = new Set([...this.getModuleIds()]);
      for (const item of Object.values(bundle)) for (const name of item.originalFileNames || []) sources.add(name);
      const packages = new Map();
      for (const id of sources) {
        const match = /node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id);
        if (!match) continue;
        const name = match[1].replace(/\\/g, '/');
        if (packages.has(name)) continue;
        const directory = path.join(import.meta.dirname, '../../node_modules', name);
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
        const file = fs.readdirSync(directory).find(entry => /^(licen[sc]e|copying)(\.(md|txt))?$/i.test(entry));
        packages.set(name, { version: manifest.version, licence: manifest.license, text: file ? fs.readFileSync(path.join(directory, file), 'utf8').trim() : '' });
      }
      const body = [...packages].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, entry]) =>
        `${name} ${entry.version} (${entry.licence})\n\n${entry.text}`).join(`\n\n${'-'.repeat(72)}\n\n`);
      this.emitFile({ type: 'asset', fileName: 'licenses.txt', source: `${PRODUCT_NAME} bundles the following packages.\n\n${body}\n` });
    }
  }, {
    name: 'nebulaverse-stylesheet',
    generateBundle(_options, bundle) {
      for (const item of Object.values(bundle)) {
        if (item.type === 'asset' && item.fileName.endsWith('.css')) item.source = stripCssComments(String(item.source));
      }
    }
  }, {
    name: 'nebulaverse-page',
    transformIndexHtml: {
      order: 'post',
      handler: html => stripHtmlComments(html.replaceAll('__NV_PRODUCT_NAME__', PRODUCT_NAME))
    }
  }]
});
