'use strict';

const assert = require('node:assert/strict');

function checkSemanticChildProcess(analyse) {
  const setup = [
    'import express from "express";',
    'import * as jobs from "node:child_process";',
    'import { execFile as render } from "child_process";',
    'const { spawnSync: renderSync } = require("node:child_process");',
    'const router = express.Router();',
    'router.get("/labels", (request, response) => {',
    '  const label = request.query.label, args = ["summary", label];',
    '  const on = {shell:true}, off = {shell:false}, opaque = getOptions();',
    '  const changed = {shell:true}; updateSettings(changed);',
    '  function done() {}'
  ];
  const cases = [
    ['jobs.spawn("report-tool", args, on);', 'confirmed'],
    ['jobs.spawn("report-tool", args, off);'],
    ['render("report-tool", [label], {shell:"/bin/sh"}, done);', 'confirmed'],
    ['render("report-tool", [label], done);'],
    ['renderSync("report-tool", args, {shell:true});', 'confirmed'],
    ['renderSync("report-tool", args);'],
    ['jobs.execFileSync("report-tool", [label], {...opaque, shell:true});', 'confirmed'],
    ['jobs.execFileSync("report-tool", [label], {...opaque, shell:false});'],
    ['jobs.spawn("report-tool", [label], {shell:true, ...opaque});', 'needs-validation'],
    ['render("report-tool", [label], {shell: externalSetting});', 'needs-validation'],
    ['jobs.spawn("report-tool", [label], changed);', 'needs-validation'],
    ['jobs.spawn("report-tool", ["summary"], {shell:true, cwd:label});'],
    ['jobs.spawn("report-tool", [Number(label)], {shell:true});'],
    ['{ const jobs = {spawn() {}}; jobs.spawn("report-tool", [label], {shell:true}); }'],
    ['jobs.spawn("report-tool", request.body.args, {shell:true});', 'needs-validation'],
    ['jobs.spawn("report-tool", [...request.body.args], {shell:true});', 'needs-validation'],
    ['jobs.spawn(request.body.program, [label], {shell: externalSetting});', 'needs-validation'],
    ['jobs.spawn(request.body.program, [label], {nested:{shell:true}});'],
    ['jobs.spawn(request.body.program, [label], {shell:true, shell:false}); jobs.exec(label);', 'confirmed'],
    ['jobs.exec(label); jobs.spawn(request.body.program, [label], {shell: externalSetting});', 'confirmed']
  ];
  const path = 'server/reports.ts';
  const text = [...setup, ...cases.map(([source]) => source), '});'].join('\n');
  const findings = analyse({files:[{path, text}]}).findings.filter(f => f.rule === 'SEC-011');
  const expected = cases.flatMap(([,verdict], i) => verdict ? [[setup.length + i + 1, verdict]] : []);
  assert.deepEqual(findings.map(f => [f.line, f.verdict]).sort((a, b) => a[0] - b[0]), expected);
  for (const f of findings) {
    assert.equal(f.path, path);
    assert.equal(f.trace[0].role, 'entrypoint');
    assert.equal(f.trace.at(-1).line, f.line);
    if (f.verdict === 'needs-validation') assert.match(f.blocker, /shell option|argument-vector slot/);
  }
}
module.exports = { checkSemanticChildProcess };
