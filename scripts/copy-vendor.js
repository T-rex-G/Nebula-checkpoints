'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const vendorRoot = path.join(root, 'public', 'vendor');

const files = [
  ['node_modules/codemirror/lib/codemirror.js', 'codemirror/5.65.16/codemirror.min.js'],
  ['node_modules/codemirror/lib/codemirror.css', 'codemirror/5.65.16/codemirror.min.css'],
  ['node_modules/codemirror/mode/meta.js', 'codemirror/5.65.16/mode/meta.min.js'],
  ['node_modules/codemirror/mode/javascript/javascript.js', 'codemirror/5.65.16/mode/javascript/javascript.min.js'],
  ['node_modules/codemirror/mode/xml/xml.js', 'codemirror/5.65.16/mode/xml/xml.min.js'],
  ['node_modules/codemirror/mode/css/css.js', 'codemirror/5.65.16/mode/css/css.min.js'],
  ['node_modules/codemirror/mode/htmlmixed/htmlmixed.js', 'codemirror/5.65.16/mode/htmlmixed/htmlmixed.min.js'],
  ['node_modules/codemirror/mode/markdown/markdown.js', 'codemirror/5.65.16/mode/markdown/markdown.min.js'],
  ['node_modules/codemirror/mode/python/python.js', 'codemirror/5.65.16/mode/python/python.min.js'],
  ['node_modules/codemirror/mode/shell/shell.js', 'codemirror/5.65.16/mode/shell/shell.min.js'],
  ['node_modules/codemirror/mode/yaml/yaml.js', 'codemirror/5.65.16/mode/yaml/yaml.min.js'],
  ['node_modules/codemirror/addon/search/searchcursor.js', 'codemirror/5.65.16/addon/search/searchcursor.min.js'],
  ['node_modules/codemirror/theme/ayu-mirage.css', 'codemirror/5.65.16/theme/ayu-mirage.min.css'],
  ['node_modules/codemirror/theme/base16-light.css', 'codemirror/5.65.16/theme/base16-light.min.css'],
  ['node_modules/codemirror/theme/dracula.css', 'codemirror/5.65.16/theme/dracula.min.css'],
  ['node_modules/codemirror/theme/eclipse.css', 'codemirror/5.65.16/theme/eclipse.min.css'],
  ['node_modules/codemirror/theme/material-ocean.css', 'codemirror/5.65.16/theme/material-ocean.min.css'],
  ['node_modules/codemirror/theme/monokai.css', 'codemirror/5.65.16/theme/monokai.min.css'],
  ['node_modules/codemirror/theme/nord.css', 'codemirror/5.65.16/theme/nord.min.css'],
  ['node_modules/marked/marked.min.js', 'marked/15.0.12/marked.min.js'],
  ['node_modules/dompurify/dist/purify.min.js', 'dompurify/3.4.13/purify.min.js'],
  /*
   * Variable upright latin faces. One file per family covers every weight the
   * interface uses, which is why three files replace the eleven static faces a
   * hosted stylesheet would have fetched. Served from this origin because
   * font-src is 'self': a third-party font URL is blocked by the policy, and
   * would not survive an offline session or appear in the release archive.
   */
  ['node_modules/@fontsource-variable/archivo/files/archivo-latin-standard-normal.woff2', 'fonts/archivo-variable-latin.woff2'],
  ['node_modules/@fontsource-variable/public-sans/files/public-sans-latin-wght-normal.woff2', 'fonts/public-sans-variable-latin.woff2'],
  ['node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2', 'fonts/jetbrains-mono-variable-latin.woff2'],
  /*
   * The editor font picker. A declared face costs nothing until a rule applies
   * it, so all five ship and a reader downloads only the one they chose. They
   * are here rather than behind the former Google proxy so the choice survives
   * an offline session and appears in the release archive.
   */
  ['node_modules/@fontsource-variable/fira-code/files/fira-code-latin-wght-normal.woff2', 'fonts/fira-code-variable-latin.woff2'],
  ['node_modules/@fontsource-variable/source-code-pro/files/source-code-pro-latin-wght-normal.woff2', 'fonts/source-code-pro-variable-latin.woff2'],
  ['node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2', 'fonts/ibm-plex-mono-400-latin.woff2'],
  ['node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2', 'fonts/ibm-plex-mono-500-latin.woff2'],
  ['node_modules/@fontsource/dm-mono/files/dm-mono-latin-400-normal.woff2', 'fonts/dm-mono-400-latin.woff2'],
  ['node_modules/@fontsource/dm-mono/files/dm-mono-latin-500-normal.woff2', 'fonts/dm-mono-500-latin.woff2']
];

fs.rmSync(vendorRoot, { recursive: true, force: true });
for (const [sourceRelative, targetRelative] of files) {
  const source = path.join(root, sourceRelative);
  const target = path.join(vendorRoot, targetRelative);
  if (!fs.existsSync(source)) throw new Error(`Missing vendor source: ${sourceRelative}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

console.log(`Copied ${files.length} pinned browser vendor assets.`);
