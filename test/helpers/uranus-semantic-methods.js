'use strict';

const assert = require('node:assert/strict');

function checkSemanticMethods(analyse) {
  const path = 'src/notice.ts';
  const definitions = { path: 'src/fields.ts', text: [
    'export const property = "inner" + "HTML";',
    'export const stream = document.writeln.bind(document, "<p>");'
  ].join('\n') };
  const text = [
    'import { property, stream } from "./fields";',
    'const card = document.createElement("section");',
    'const method = "insert" + "AdjacentHTML";',
    'const locationName = "before" + "end";',
    'const captured = card[method].bind(card, locationName);',
    'const display = captured;',
    'const title = window.location.hash;',
    'display(title);',
    'display("Notice");',
    'card[property] = title;',
    'stream(title);',
    'const detached = card[method];',
    'detached(locationName, title);',
    'const wrong = card[method].bind({});',
    'wrong(locationName, title);',
    'let variable = method;',
    'card[variable](locationName, title);',
    'const parser = new window.DOMParser();',
    'const mime = "text/" + "html";',
    'parser.parseFromString(title, mime);',
    'parser.parseFromString(title, "application/xml");',
    'parser.parseFromString("<p>Notice</p>", mime);',
    'function parseLocally(DOMParser) { return new DOMParser().parseFromString(title, mime); }',
    'const read = parser.parseFromString.bind(parser);',
    'read(title, mime);',
    'const invalid = card[method].bind(card, "within");',
    'invalid(title);'
  ].join('\n');
  const audit = analyse({ files: [definitions, { path, text }] });
  const findings = audit.findings.filter(finding => finding.rule === 'SEC-002' && finding.path === path);
  const at = line => findings.filter(finding => finding.line === line);
  for (const line of [8, 10, 11]) {
    const got = at(line);
    assert.equal(got.length, 1, 'expected one notice rendering at line ' + line);
    assert.equal(got[0].verdict, 'confirmed');
    assert(got[0].trace.some(step => step.role === 'entrypoint' && step.path === path && step.line === 7));
    assert.equal(got[0].trace.at(-1).line, line, 'the invoked method is the sink');
  }
  for (const line of [20, 25]) {
    const got = at(line);
    assert.equal(got.length, 1);
    assert.equal(got[0].verdict, 'needs-validation');
    assert.match(got[0].blocker, /detached document/);
    assert.equal(got[0].trace.at(-1).line, line);
  }
  for (const line of [5, 9, 12, 13, 14, 15, 17, 19, 21, 22, 23, 24, 26, 27]) {
    assert.equal(at(line).length, 0, 'a method reference, safe value or unproven operation at line ' + line);
  }

  const changed = analyse({ files: [{ path, text: [
    'const parser = new DOMParser();',
    'parser.parseFromString = keepText;',
    'parser.parseFromString(window.location.hash, "text/html");',
    'const logger = {};',
    'logger.write = saveText;',
    'document.write(window.location.hash);'
  ].join('\n') }] });
  const mutations = changed.findings.filter(finding => finding.rule === 'SEC-002' && finding.path === path);
  assert(!mutations.some(finding => finding.line === 3), 'a replaced parser cannot establish a parser sink');
  assert(mutations.some(finding => finding.line === 6 && finding.verdict === 'confirmed'), 'an unrelated object can have a write method');

  const computed = { path: 'app/field.ts', text: [
    'const field = "in" + "ner" + "HT" + "ML";',
    'const method = "set" + "HT" + "ML" + "Un" + "safe";',
    'const notice = window.location.hash;',
    'document.body[field]! = notice;',
    '((document.body[method] as (message: string) => void))(notice);',
    '(document.body[method] satisfies (message: string) => void)(notice);',
    'document.body // a line comment ending with =',
    '[method] /* trivia */ !(notice);',
    'document.body[field]! = "fixed";'
  ].join('\n') };
  const named = { path: 'outside/known.ts', text: 'document.body.innerHTML = "fixed";' };
  const arrays = Array.from({ length: 32 }, (_, i) => ({ path: 'arrays/data' + i + '.ts',
    text: 'const numbers: number[] = [1, 2, 3]; export const first = numbers[0];' }));
  for (const files of [[computed], [computed, named, ...arrays]]) {
    const checked = analyse({ files });
    const results = checked.findings.filter(f => f.rule === 'SEC-002' && f.path === computed.path);
    assert.deepEqual(results.filter(f => f.verdict === 'confirmed').map(f => f.line).sort((a, b) => a - b), [4, 5, 6, 8]);
    assert(!results.some(f => f.line === 9));
    assert.equal(checked.engine.traced.semantic.complete, true);
    assert.equal(checked.engine.traced.semantic.files, files.length === 1 ? 1 : 2);
  }

  const binder = { path: 'app/present.ts', text: [
    'const op = "set" + "HT" + "ML" + "Un" + "safe";',
    'const bindKey = "b" + "ind";',
    'const piece = document.body[op];',
    'export const show = piece[bindKey](document.body);'
  ].join('\n') };
  const consumer = { path: 'app/route.ts', text: [
    'import { show } from "./present.js";',
    'show(window.location.hash);'
  ].join('\n') };
  const imported = analyse({ files: [consumer, binder, ...arrays] });
  assert(imported.findings.some(f => f.rule === 'SEC-002' && f.path === consumer.path && f.line === 2 && f.verdict === 'confirmed'),
    'the caller of a computed bound method is admitted through an emitted-js import');

  const possible = Array.from({ length: 200 }, (_, i) => ({ path: 'a/possible' + i + '.ts',
    text: 'export function first(values: string[], index: number) { return values[index]; }' }));
  const renderer = { path: 'z/alerts.ts', text: 'export function display(value: string) { document.body.innerHTML = value; }' };
  const caller = { path: 'z/route.ts', text: 'import { display } from "./alerts.js"; display(window.location.hash);' };
  const capped = analyse({ files: [...possible, renderer, caller] });
  const visible = capped.findings.find(f => f.rule === 'SEC-002' && f.path === renderer.path);
  assert(visible?.trace?.some(step => step.role === 'entrypoint' && step.path === caller.path), 'named roots and their callers precede weak candidates');
  assert.equal(capped.engine.traced.semantic.files, 192);
  assert.equal(capped.engine.traced.semantic.skippedFiles, 10);
  assert.equal(capped.engine.traced.semantic.complete, false);
}

module.exports = { checkSemanticMethods };
