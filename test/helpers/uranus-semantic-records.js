'use strict';

const assert = require('node:assert/strict');

function checkSemanticRecords(analyse) {
  const helper = 'widgets/labels.ts', page = 'widgets/view.ts';
  const helpers = [
    'export function heading(record) { const alias = record; return alias.labels.heading; }',
    'export function detail(record) { const alias = record.labels; return alias.detail; }',
    'export function choose(record) {',
    '  if (record.mode === "fixed") return record.labels.heading;',
    '  return record.labels.detail;',
    '}'
  ];
  const body = [
    'import { heading, detail, choose } from "./labels";',
    'const card = document.createElement("article");',
    'const caption = window.location.hash;',
    'const options = { labels: {heading: "Schedule", detail: caption}, mode: "fixed" };',
    'const ref = options;',
    'card.insertAdjacentHTML("beforeend", heading(ref));',
    'card.insertAdjacentHTML("beforeend", detail(ref));',
    'card.insertAdjacentHTML("beforeend", choose(ref));',
    'const variants = { labels: {heading: "Schedule", detail: caption}, mode: readMode() };',
    'card.insertAdjacentHTML("beforeend", choose(variants));',
    'const mutable = { labels: {heading: "Schedule"} };',
    'const alias = mutable.labels;',
    'alias.heading = readTitle();',
    'card.insertAdjacentHTML("beforeend", heading(mutable));',
    'const shared = { labels: {heading: "Schedule"} };',
    'sendToUnknown(shared);',
    'card.insertAdjacentHTML("beforeend", heading(shared));',
    'const custom = { get labels() { return readLabels(); } };',
    'card.insertAdjacentHTML("beforeend", heading(custom));'
  ];
  const files = [{ path: helper, text: helpers.join('\n') }, { path: page, text: body.join('\n') }];
  const audit = analyse({ files });
  const at = line => audit.findings.filter(f => f.path === page && f.line === line && f.rule === 'SEC-002');
  for (const line of [6, 8]) assert.equal(at(line).length, 0, 'the selected immutable field is a fixed string at line ' + line);
  const [detail] = at(7);
  assert.equal(detail?.verdict, 'confirmed');
  assert(detail.trace.some(s => s.role === 'entrypoint' && s.path === page && s.line === 3));
  assert(detail.trace.some(s => s.role === 'propagation' && s.path === helper && s.line === 2));
  const [choice] = at(10);
  assert.equal(choice?.verdict, 'needs-validation');
  assert(choice.trace.some(s => s.path === helper && s.line === 5), 'the witness identifies the feasible return carrying the input');
  for (const line of [14, 17, 19]) {
    const [finding] = at(line);
    assert.equal(finding?.verdict, 'needs-validation', 'mutation, escape, or an accessor invalidates the data property at line ' + line);
  }
}

module.exports = { checkSemanticRecords };
