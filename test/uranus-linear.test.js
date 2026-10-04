'use strict';

/*
 * A file somebody else wrote decides how long the JavaScript and Python
 * tracer and the SQL reader run. None of these crafted files may cost more
 * than a straight read: brackets left open by the thousand, calls, arrows,
 * literals and templates nested thousands deep, and one SQL statement that
 * never ends. Each is ~200 KB; read in linear time it takes well under a
 * second, and the readings these replace took from four seconds to well over
 * a minute. The bound leaves room for a slow runner.
 *
 * Then what the bounds keep: a bracket's partner is the one the walk would
 * have found, an argument list splits where it did, the nesting the tracer
 * stops following is said in the coverage ledger, and a flow beside it is
 * still traced.
 */

const assert = require('assert');
const { analyse } = require('../src/code-audit');
const { lexJs, matching, splitArgs } = require('../src/uranus-lex');

const SIZE = 200 * 1024;
const fill = unit => unit.repeat(Math.floor(SIZE / unit.length));
const nest = (open, middle, close) => {
  const levels = Math.floor(SIZE / (open.length + close.length));
  return open.repeat(levels) + middle + close.repeat(levels);
};
const route = "const app = require('express')();\napp.get('/a', (req, res) => { ";

/* ---- Crafted files, read in linear time --------------------------------------- */
{
  const crafted = {
    'calls left open': { path: 'server.js', text: route + fill('f(') },
    'calls nested deep': { path: 'server.js', text: route + 'const x = req.query.a; ' + nest('exec(', 'x', ')') + '; });' },
    'arrows nested deep': { path: 'server.js', text: route + nest('(() => ', 'req.query.a', ')') + ' });' },
    'arrays nested deep': { path: 'server.js', text: route + 'const x = ' + nest('[', 'req.query.a', ']') + '; });' },
    'objects nested deep': { path: 'server.js', text: route + 'const x = ' + nest('{a:', 'req.query.a', '}') + '; });' },
    'templates nested deep': { path: 'server.js', text: route + 'const x = ' + nest('`${', 'req.query.a', '}`') + '; });' },
    'brackets left open': { path: 'server.js', text: route + fill('x[') },
    'a test chained in a condition': { path: 'v.js', text: route + 'if (' + fill('/^a$/.test(') + ') {} });' },
    'Python calls left open': { path: 'app.py', text: 'from flask import request\n' + fill('f(') },
    'Python calls nested deep': { path: 'app.py', text: 'from flask import request\nx = ' + nest('f(', 'request.args["a"]', ')') + '\n' },
    'Python handler of open calls': { path: 'app.py', text: 'from flask import Flask, request\napp = Flask(__name__)\n@app.route("/a", methods=["POST"])\ndef restore():\n  ' + fill('session.add(') },
    'SQL statement that never ends': { path: 'schema.sql', text: fill('create table if not exists a (') },
    'SQL statements by the thousand': { path: 'schema.sql', text: fill('create table a (id int); alter table a enable row level security;\n') }
  };
  for (const [name, file] of Object.entries(crafted)) {
    const started = Date.now();
    analyse({ files: [file], paths: [file.path] });
    const took = Date.now() - started;
    assert(took < 2500, `${name}: ${took} ms -- a crafted file must not make the tracer quadratic`);
  }
}

/* ---- A bracket's partner, as the walk found it ---------------------------------- */
{
  const tokens = lexJs('f(a, [b, c], { d: (e) }, g(h(i)))');
  const at = value => tokens.findIndex(token => token.t === 'punc' && token.v === value);
  assert.strictEqual(tokens[matching(tokens, at('('))].v, ')');
  assert.strictEqual(matching(tokens, at('(')), tokens.length - 1, 'the outer call closes last');
  assert.strictEqual(tokens[matching(tokens, at('['))].v, ']');
  assert.strictEqual(tokens[matching(tokens, at('{'))].v, '}');
  const { args, close } = splitArgs(tokens, at('('));
  assert.strictEqual(close, tokens.length - 1);
  assert.deepStrictEqual(args.map(arg => arg.map(token => token.v).join('')), ['a', '[b,c]', '{d:(e)}', 'g(h(i))']);
  /* A trailing comma adds no argument; an empty one between commas is kept. */
  assert.deepStrictEqual(splitArgs(lexJs('f(a, )'), 1).args.map(arg => arg.length), [1]);
  assert.deepStrictEqual(splitArgs(lexJs('f(a, , b)'), 1).args.map(arg => arg.length), [1, 0, 1]);
  /* Never closed: taken to close at the last token, which the arguments stop before, as the walk did. */
  const open = lexJs('f(a, (b, c');
  assert.strictEqual(matching(open, 1), open.length - 1);
  assert.deepStrictEqual(splitArgs(open, 1).args.map(arg => arg.map(token => token.v).join('')), ['a', '(b,']);
  /* A list that grew after it was paired is paired again. */
  const grown = lexJs('(a');
  assert.strictEqual(matching(grown, 0), 1);
  grown.push({ t: 'punc', v: ')', line: 1 });
  assert.strictEqual(matching(grown, 0), 2);
}

/* ---- What the bounds stop following is said, and the rest is still traced ------- */
{
  const text = route + 'const x = ' + 'f('.repeat(3000) + 'req.query.a' + ')'.repeat(3000) +
    '; db.query("SELECT * FROM t WHERE a = " + req.query.b); });';
  const result = analyse({ files: [{ path: 'server.js', text }], paths: ['server.js'] });
  assert(result.findings.some(finding => finding.rule === 'SEC-001' && finding.verdict === 'confirmed'),
    'a flow beside deep nesting is still traced');
  assert.strictEqual(result.engine.traced.deep, 1);
  const injection = result.ledger.find(entry => entry.id === 'injection');
  assert.strictEqual(injection.status, 'partial');
  assert.match(injection.detail, /1 file nests expressions deeper than values are followed/);
  /* Ordinary nesting is followed in full and says nothing. */
  const plain = analyse({ files: [{ path: 'server.js', text: route + 'res.send(String(Number(parseInt(req.query.a, 10)))); });' }], paths: ['server.js'] });
  assert.strictEqual(plain.engine.traced.deep, 0);
}

console.log('uranus linear-time tests passed');
