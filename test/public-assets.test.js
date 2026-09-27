'use strict';

/*
 * The served page, scripts and stylesheet carry no source comments, and lose
 * nothing else. Every first-party script is tokenised by a real parser before
 * and after, and the two token streams must be identical: a comment stripper
 * that ate one character of code would change a token here, not in a
 * visitor's browser.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { stripJsComments, stripCssComments, stripHtmlComments, buildPublicAssets, etagMatches, securityContact } = require('../src/public-assets');

let acorn;
try { acorn = require('acorn'); } catch { acorn = require(require.resolve('acorn', { paths: [path.dirname(require.resolve('eslint'))] })); }

const root = path.join(__dirname, '..', 'public');
const tokens = (source, sourceType) => {
  const out = [];
  for (const token of acorn.tokenizer(source, { ecmaVersion: 'latest', sourceType })) out.push(`${token.type.label}:${token.value === undefined ? '' : String(token.value)}`);
  return out;
};
const commentsIn = (source, sourceType) => {
  const found = [];
  acorn.parse(source, { ecmaVersion: 'latest', sourceType, onComment: found });
  return found;
};

/* ---- Every first-party script: same tokens, no comments ------------------------------ */
for (const name of fs.readdirSync(root).filter(file => file.endsWith('.js'))) {
  const source = fs.readFileSync(path.join(root, name), 'utf8');
  const sourceType = /^\s*(?:import|export)\s/m.test(source) ? 'module' : 'script';
  const stripped = stripJsComments(source);
  assert.deepStrictEqual(tokens(stripped, sourceType), tokens(source, sourceType), `${name}: stripping comments changed a token`);
  assert.deepStrictEqual(commentsIn(stripped, sourceType), [], `${name}: a comment survived`);
}

/* ---- The lexer's hard cases ----------------------------------------------------------- */
{
  /* A comment across a line break still separates like one, so automatic semicolon insertion reads the same. */
  const asi = 'function f(){ return /* a\nb */ 1 }';
  assert.strictEqual(stripJsComments(asi), 'function f(){ return \n 1 }');
  assert.strictEqual(new Function(`${stripJsComments(asi)}; return f();`)(), undefined, 'return followed by a line break returns nothing, as in the source');

  /* Regular expressions and division. */
  assert.strictEqual(stripJsComments('const r = /\\/\\*not a comment*\\//g; // gone\n'), 'const r = /\\/\\*not a comment*\\//g; \n');
  assert.strictEqual(stripJsComments('x = a / b / c; // gone'), 'x = a / b / c; ');
  assert.strictEqual(stripJsComments('if (x) return /[/*]/.test(y);'), 'if (x) return /[/*]/.test(y);');
  assert.strictEqual(stripJsComments('a.in / 2'), 'a.in / 2', 'a property named like a keyword is a name');

  /* Strings and templates keep what looks like a comment; expressions inside templates lose real ones. */
  assert.strictEqual(stripJsComments('s = "http://x/*y*/"; t = \'// no\';'), 's = "http://x/*y*/"; t = \'// no\';');
  assert.strictEqual(stripJsComments('t = `a // b ${x /* c */ + `d${y}`} /* e */`;'), 't = `a // b ${x   + `d${y}`} /* e */`;');
  assert.strictEqual(stripJsComments('t = `${{ a: 1 }.a}`; // gone'), 't = `${{ a: 1 }.a}`; ');

  /* A comment that is the whole of its lines goes with them. */
  assert.strictEqual(stripJsComments('a();\n  // one\n  /* two\n     three */\nb();\n'), 'a();\nb();\n');

  assert.throws(() => stripJsComments('x = "unterminated'), /Unterminated/);
  assert.throws(() => stripJsComments('/* never closed'), /Unterminated/);
}

/* ---- CSS and HTML ------------------------------------------------------------------------- */
{
  assert.strictEqual(stripCssComments('/* head */\na{b:c} /* tail */\ne::after{content:"/* kept */"}\n'), 'a{b:c}  \ne::after{content:"/* kept */"}\n');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const cssOut = stripCssComments(css);
  assert(!cssOut.includes('/*'), 'the stylesheet ships no comment');
  assert.strictEqual(cssOut.replace(/\s+/g, ''), css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ''), 'only comments and the whitespace around them were removed');

  assert.strictEqual(stripHtmlComments('<a>\n  <!-- one -->\n<b><!-- two --></b> <!-- three --> <i>\n'), '<a>\n<b></b>  <i>\n');
  assert.strictEqual(stripHtmlComments('<!-- a --> <p>kept</p>\n<!-- b -->\n'), ' <p>kept</p>\n', 'a comment never swallows the markup up to the next one');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const htmlOut = stripHtmlComments(html);
  assert(!htmlOut.includes('<!--'), 'the page ships no comment');
  assert.strictEqual(htmlOut.replace(/\s+/g, ''), html.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ''), 'only comments and the whitespace around them were removed');
}

/* ---- What the server serves ---------------------------------------------------------------- */
{
  const assets = buildPublicAssets(root);
  const scripts = fs.readdirSync(root).filter(file => /\.(js|css)$/.test(file));
  assert.deepStrictEqual([...assets.keys()].sort(), scripts.map(file => `/${file}`).sort(), 'every first-party script and stylesheet is served stripped');
  const app = assets.get('/app.js');
  assert.match(app.type, /^application\/javascript/);
  assert.match(app.etag, /^"[\w-]{27}"$/);
  assert(app.body.length < fs.statSync(path.join(root, 'app.js')).size);
  assert(!assets.has('/vendor/marked/15.0.12/marked.min.js'), 'vendor files are served as published');
}

/* ---- Revalidation through a compressing proxy ---------------------------------------------- */
{
  const etag = '"abc123"';
  assert.strictEqual(etagMatches('"abc123"', etag), true);
  assert.strictEqual(etagMatches('W/"abc123"', etag), true, 'a proxy that compresses weakens the tag; If-None-Match compares weakly');
  assert.strictEqual(etagMatches('"zzz", W/"abc123"', etag), true, 'any member of a list');
  assert.strictEqual(etagMatches('*', etag), true);
  assert.strictEqual(etagMatches('"abc1234"', etag), false);
  assert.strictEqual(etagMatches('W/"other"', etag), false);
  assert.strictEqual(etagMatches('', etag), false);
  assert.strictEqual(etagMatches(undefined, etag), false);
}

/* ---- security.txt Contact is always a URI ---------------------------------------------------- */
{
  const fallback = 'https://github.com/T-rex-G/Nebula-checkpoints/security/advisories/new';
  const address = ['security', 'example.org'].join('@');
  assert.strictEqual(securityContact(address), `mailto:${address}`, 'a bare address becomes a mailto: URI');
  assert.strictEqual(securityContact(`  ${address}  `), `mailto:${address}`);
  assert.strictEqual(securityContact(`mailto:${address}`), `mailto:${address}`);
  assert.strictEqual(securityContact('https://example.org/report'), 'https://example.org/report');
  assert.strictEqual(securityContact(''), fallback);
  assert.strictEqual(securityContact(undefined), fallback);
  assert.strictEqual(securityContact('http://example.org/report'), fallback, 'not over plain http');
  assert.strictEqual(securityContact(`${address}\nExpires: 1970-01-01T00:00:00Z`), fallback, 'no second line can be written into the file');
  assert.strictEqual(securityContact('javascript:alert(1)'), fallback);
}

console.log('public asset tests passed');
