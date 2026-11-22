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
}

module.exports = { checkSemanticMethods };
