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
const { stripJsComments, stripCssComments, stripHtmlComments, securityContact } = require('../src/public-assets');

let acorn;
try { acorn = require('acorn'); } catch { acorn = require(require.resolve('acorn', { paths: [path.dirname(require.resolve('eslint'))] })); }

const root = path.join(__dirname, '..');
const copiedAsWritten = path.join(root, 'apps', 'web', 'public');
const built = path.join(root, 'dist', 'web');
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
for (const name of fs.readdirSync(copiedAsWritten).filter(file => file.endsWith('.js'))) {
  const source = fs.readFileSync(path.join(copiedAsWritten, name), 'utf8');
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
  const css = fs.readFileSync(path.join(root, 'apps', 'web', 'src', 'styles', 'style.css'), 'utf8');
  const cssOut = stripCssComments(css);
  assert(!cssOut.includes('/*'), 'the stylesheet ships no comment');
  assert.strictEqual(cssOut.replace(/\s+/g, ''), css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ''), 'only comments and the whitespace around them were removed');

  assert.strictEqual(stripHtmlComments('<a>\n  <!-- one -->\n<b><!-- two --></b> <!-- three --> <i>\n'), '<a>\n<b></b>  <i>\n');
  assert.strictEqual(stripHtmlComments('<!-- a --> <p>kept</p>\n<!-- b -->\n'), ' <p>kept</p>\n', 'a comment never swallows the markup up to the next one');
  const html = fs.readFileSync(path.join(root, 'apps', 'web', 'index.html'), 'utf8');
  const htmlOut = stripHtmlComments(html);
  assert(!htmlOut.includes('<!--'), 'the page ships no comment');
  assert.strictEqual(htmlOut.replace(/\s+/g, ''), html.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ''), 'only comments and the whitespace around them were removed');
}

/* ---- What the server serves ---------------------------------------------------------------- */
/*
 * What the build ships carries no source commentary: not the page, not the
 * classic script, not a module or the stylesheet. The one kind of comment kept
 * is a licence notice (`/*!`, @license, @preserve), which a bundled library's
 * licence requires to travel with its code.
 */
{
  const legal = text => /^!|@license|@preserve/.test(text.trim());
  assert(!fs.readFileSync(path.join(built, 'index.html'), 'utf8').includes('<!--'), 'the built page ships no comment');
  assert.deepStrictEqual(commentsIn(fs.readFileSync(path.join(built, 'theme-boot.js'), 'utf8'), 'script'), [],
    'the classic script ships no comment');
  const files = fs.readdirSync(path.join(built, 'build'));
  for (const file of files.filter(name => name.endsWith('.js'))) {
    const comments = commentsIn(fs.readFileSync(path.join(built, 'build', file), 'utf8'), 'module');
    assert.deepStrictEqual(comments.filter(comment => !legal(comment.value)).map(comment => comment.value.slice(0, 60)), [],
      `${file} ships source commentary`);
  }
  for (const file of files.filter(name => name.endsWith('.css'))) {
    const css = fs.readFileSync(path.join(built, 'build', file), 'utf8');
    const comments = [...css.matchAll(/\/\*([\s\S]*?)\*\//g)].map(match => match[1]);
    assert.deepStrictEqual(comments.filter(comment => !legal(comment)), [], `${file} ships source commentary`);
  }
  const worker = fs.readFileSync(path.join(built, 'sw.js'), 'utf8');
  assert.deepStrictEqual(commentsIn(worker, 'script').filter(comment => !legal(comment.value)), [], 'the service worker ships no comment');
}

/*
 * The stylesheet a browser receives is the one that was written: every sheet
 * the entry imports, in import order, less its comments, and nothing
 * rewritten. A CSS minifier once kept only the prefixed copy of
 * `backdrop-filter:none; -webkit-backdrop-filter:none`, and the blur of an
 * earlier rule came back on every phone. Only asset URLs differ, because the
 * build gives fonts hashed names.
 */
{
  const entry = path.join(root, 'apps', 'web', 'src', 'main.js');
  const sheets = [...fs.readFileSync(entry, 'utf8').matchAll(/^import '([^']+\.css)';$/gm)]
    .map(match => (match[1].startsWith('.') ? path.resolve(path.dirname(entry), match[1]) : require.resolve(match[1])));
  assert(sheets.length >= 2, 'the entry imports its stylesheets');
  const builtSheets = fs.readdirSync(path.join(built, 'build')).filter(name => name.endsWith('.css'));
  assert.strictEqual(builtSheets.length, 1, 'the page loads one stylesheet');
  const shape = text => text.replace(/url\([^)]*\)/g, 'url()').replace(/\s+/g, '');
  assert.strictEqual(shape(fs.readFileSync(path.join(built, 'build', builtSheets[0]), 'utf8')),
    sheets.map(sheet => shape(stripCssComments(fs.readFileSync(sheet, 'utf8')))).join(''),
    'the built stylesheet is the written cascade, in order, less comments');
}

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
