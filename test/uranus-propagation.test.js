'use strict';

/*
 * Uranus follows a value through the functions and files of a repository:
 * a helper that hands a built statement to the helper that runs it, a query
 * a function builds and returns, a method of a class or an object, a module
 * that exports an instance, a re-export, a response handed to a helper, a
 * callback run over a promise's result or a list's items -- in JavaScript
 * and Python, and a method of a locally made object in Java and PHP.
 *
 * The cases are the `flow-*` directories of the benchmark corpus, read here
 * by the flow engine alone: each line marked `expect: SEC-...` is a
 * flow ending on that line with the marked confidence, and a safe
 * twin is quiet even where a pattern rule still leaves a lead to confirm.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { analyseFlows } = require('../apps/api/src/modules/uranus/index.ts');
const { markersOf, ROOT } = require('../scripts/uranus-benchmark');

function filesOf(dir, base = dir) {
  return fs.readdirSync(dir).sort().flatMap(name => {
    const full = path.join(dir, name);
    return fs.statSync(full).isDirectory() ? filesOf(full, base) : [{ client: false, path: path.relative(base, full).split(path.sep).join('/'), text: fs.readFileSync(full, 'utf8') }];
  });
}

const byCase = new Map();
let unsafe = 0;
let safe = 0;
for (const language of fs.readdirSync(ROOT).sort()) {
  for (const name of fs.readdirSync(path.join(ROOT, language)).sort()) {
    if (!name.startsWith('flow-')) continue;
    const files = filesOf(path.join(ROOT, language, name));
    const location = item => `${item.rule}@${item.path}:${item.line}`;
    const expected = markersOf(files).filter(mark => mark.kind === 'expect' && mark.rule.startsWith('SEC-'))
      .map(mark => `${location(mark)} ${mark.verdict === 'to-confirm' ? 'needs-validation' : 'confirmed'}`).sort();
    const flows = analyseFlows(files).flows;
    assert.deepStrictEqual(flows.map(flow => `${location(flow)} ${flow.verdict}`).sort(), expected, `${language}/${name}`);
    for (const flow of flows.filter(flow => flow.verdict === 'needs-validation')) assert.strictEqual(flow.blocker.reason, 'conditional');
    if (expected.length) unsafe += 1; else safe += 1;
    byCase.set(`${language}/${name}`, flows);
  }
}
assert(unsafe >= 50 && safe >= 25, `the corpus holds ${unsafe} unsafe and ${safe} safe propagation cases`);

/* The trace names each place the value was carried, in order, and never the code. */
const notes = id => {
  const [flow] = byCase.get(id) || [];
  assert(flow, `${id} has a flow`);
  return flow.trace.map(step => `${step.role} ${step.path}:${step.line} ${step.note}`);
};
const through = (id, pattern) => assert(notes(id).some(note => pattern.test(note)), `${id}: ${pattern} in\n${notes(id).join('\n')}`);

/* Three files: the route, the service it calls, the repository that runs the statement. */
const chain = byCase.get('javascript/flow-three-file-chain')[0];
assert.strictEqual(chain.viaHelper, 'file');
assert.deepStrictEqual(chain.trace.map(step => [step.role, step.path]), [
  ['entrypoint', 'server/app.js'], ['propagation', 'server/app.js'], ['propagation', 'server/services/users.js'], ['sink', 'server/repo/users.js']
]);
/* A statement built in one function and run by another: the flow ends where it is run. */
through('javascript/flow-two-hop-same-file', /^sink server\/app\.js:3 used in a SQL statement$/);
through('javascript/flow-two-hop-same-file', /^propagation server\/app\.js:4 passed to a function$/);
through('javascript/flow-this-method-in-one-class', /^sink server\/app\.js:4 /);
through('python/flow-wrapper-run-query', /^sink db\.py:6 /);
/* A callback is handed the value it is run over. */
const [handed] = analyseFlows([{ client: false, path: 'server/app.js', text: "const express = require('express');\nconst app = express();\napp.get('/u', (req, res) => {\n  lookup(req.query.name)\n    .then(found => {\n      return db.query(\"SELECT * FROM u WHERE n = '\" + found + \"'\");\n    });\n});\n" }]).flows;
assert.deepStrictEqual(handed.trace.map(step => `${step.role} ${step.line} ${step.note}`), ['entrypoint 4 query string enters here', 'propagation 5 handed to a callback', 'sink 6 used in a SQL statement']);
/* A method is found through the instance that names it. */
through('javascript/flow-controller-injected-service', /^sink src\/users\/users\.service\.ts:9 /);
through('python/flow-service-class-with-repo-field', /^sink repo\/orders\.py:5 /);
through('php/flow-namespaced-new', /^sink app\/lib\/Reports\.php:7 /);
through('java/flow-var-local-service', /^sink src\/main\/java\/app\/UserFinder\.java:6 /);

console.log(`uranus propagation tests passed (${unsafe} unsafe, ${safe} safe)`);
