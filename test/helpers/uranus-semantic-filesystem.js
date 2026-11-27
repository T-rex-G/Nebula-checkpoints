'use strict';

const assert = require('node:assert/strict');
const file = (path, ...lines) => ({ path, text: lines.join('\n') });

function checkSemanticFilesystem(analyse, analyseFlows) {
  const routes = file('catalog/routes.ts',
    'import service from "express";',
    'import { moveReport, saveNote } from "./public.js";',
    'const calendar = service.Router();',
    'calendar.get("/notes", (incoming, response) => {',
    '  const selection = incoming.get("x-note");',
    '  moveReport({ selected: selection, fixed: "memos.txt" });',
    '  saveNote(selection);',
    '});');
  const bridge = file('catalog/public.ts', 'export { moveReport, saveNote } from "./disk.js";');
  const storage = file('catalog/disk.ts',
    'import { rename as move, writeFile as store } from "node:fs/promises";',
    'export function moveReport(fields) {',
    '  move("reports/today", fields.selected);',
    '  move(fields.fixed, "reports/previous");',
    '}',
    'export function saveNote(contents) { store("reports/memos", contents); }');
  const io = file('catalog/operations.cjs',
    'const { promises: files } = require("fs");',
    'const { readFile: getNote } = files;',
    'const core = require("node:fs");',
    'const routes = require("express")();',
    'routes.post("/copy", (incoming, response) => {',
    '  const filename = incoming.get("x-record");',
    '  getNote(filename);',
    '  core.copyFile("reports/today", filename, () => {});',
    '  core.writeFile("reports/today", filename, () => {});',
    '  core.copyFile("reports/today", filename);',
    '  files.readFileSync(filename);',
    '  if (false) getNote(filename);',
    '  const local = { promises: { readFile(value) { return value; } } };',
    '  local.promises.readFile(filename);',
    '  getNote(unresolved());',
    '  if (filename !== "today" && filename !== "yesterday") return;',
    '  getNote(filename);',
    '});');
  const controls = file('catalog/controls.ts',
    'import * as io from "fs/promises";',
    'import type { readFile as typeOnly } from "fs/promises";',
    'import application from "express";',
    'const router = application();',
    'const local = { readFile(value) { return value; } };',
    'router.get("/catalog", (incoming, reply) => {',
    '  const filename = incoming.get("x-record");',
    '  local.readFile(filename);',
    '  typeOnly(filename);',
    '  const key = "read" + "File";',
    '  io[key](filename);',
    '  function present(io) { io.readFile(filename); }',
    '  present(local);',
    '});',
    'import base from "node:fs";',
    'router.get("/select", (incoming, reply) => {',
    '  const selected = incoming.get("x-record");',
    '  base.module.readFileSync(selected);',
    '  base["promises.readFile"](selected);',
    '  function pick(require) { require("node:fs/promises").readFile(selected); }',
    '  pick(local);',
    '});');
  const replaced = file('catalog/replaced.cjs',
    'const io = require("node:fs/promises");',
    'const alias = io;',
    'alias.readFile = recorder;',
    'require("express")().get("/note", (incoming, reply) => io.readFile(incoming.get("x-record")));');
  const results = analyse({ files: [routes, bridge, storage, io, controls, replaced] });
  const at = (source, line) => results.findings.filter(f => f.rule === 'SEC-022' && f.path === source.path && f.line === line);
  for (const [source, line] of [[storage, 3], [io, 7], [io, 8], [controls, 11]]) {
    const records = at(source, line);
    assert.equal(records.length, 1, 'witnessed filename at ' + source.path + ':' + line);
    assert.equal(records[0].verdict, 'needs-validation');
    assert.equal(records[0].evidence, 'traced');
    assert.match(records[0].blocker, /permitted directory/);
  }
  assert(at(storage, 3)[0].trace.some(point => point.path === routes.path && point.role === 'entrypoint' && point.line === 5));
  for (const [source, lines] of [[storage, [4, 6]], [io, [9, 10, 11, 12, 14, 15, 17]], [controls, [8, 9, 12, 18, 19, 20]], [replaced, [4]]]) {
    for (const line of lines) assert.equal(at(source, line).length, 0, 'pathname control at ' + source.path + ':' + line);
  }
  const unknown = analyseFlows([file('notes.mjs', 'import { rename as mv } from "node:fs/promises";',
    'mv(configuredSource(), configuredDestination());')]);
  assert.equal(unknown.flows.filter(f => f.rule === 'SEC-022').length, 0);
  assert.equal(unknown.stats.semantic.unresolvedOperations, 1, 'two unresolved pathname slots are one incomplete operation');
  const fixed = analyseFlows([file('notes.mjs', 'import { rename as mv } from "node:fs/promises";',
    'mv("reports/daily", "reports/yesterday");')]);
  assert.equal(fixed.stats.semantic.unresolvedOperations, 0);

  const handler = (path, ...lines) => file(path,
    'import express from "express"; import p from "node:path";',
    'import { readFile as load, copyFile as copy } from "fs/promises";',
    'const root = "/archives";',
    'express().get("/index", (request, response) => {',
    '  const key = request.get("x-index");',
    ...lines, '});');
  const paths = handler('archive/guards.ts',
    'const target = p.resolve(root, key);',
    'if (!target.startsWith(root)) return;',
    'load(target);',
    'if (!target.startsWith(root + p.sep)) response.status(400);',
    'load(target);',
    'if (!target.startsWith(root + p.sep)) return;',
    'load(target);',
    'copy(target, p.join(root, key, ".index"));',
    'load(target); load(p.join(root, key));');
  const relative = handler('archive/relative.ts',
    'const target = p.resolve(root, key), rel = p.relative(root, target);',
    'if (rel === ".." || rel.startsWith(".." + p.sep)) return;',
    'load(target);',
    'if (p.isAbsolute(rel)) return;',
    'load(target);');
  const dialects = handler('archive/dialects.ts',
    'load(p.posix.resolve(key, "/fixed/index"));',
    'load(p.posix.join(key, "/fixed/index"));',
    'load(p.win32.resolve(key, "/fixed/index"));',
    'load(p.win32.resolve(key, "C:/fixed/index"));',
    'const other = { join(a, b) { return "index"; } };',
    'load(other.join(root, key));',
    'load(unknownTransform(key));',
    'load(p.join(root, key, 10));',
    'load(p.posix.resolve(root, key, null));',
    'load(p.posix.resolve(null, key));');
  const helper = file('archive/name.ts',
    'import { join as make } from "node:path/posix";',
    'export function archiveName(part) { return make("/archive", part); }');
  const consumer = file('archive/copy.ts',
    'import express from "express";',
    'import { copyFile as copy } from "fs/promises";',
    'import { archiveName } from "./name.js";',
    'express().get("/copy", (request, response) => {',
    '  const key = request.get("x-index");',
    '  copy("template", archiveName(key));',
    '  copy("template", archiveName("index"));',
    '});');
  const observed = analyse({ files: [paths, relative, dialects, helper, consumer] });
  const disk = observed.findings.filter(f => f.rule === 'SEC-022');
  for (const [source, expected] of [[paths, [8, 10, 12, 13, 14]], [relative, [8, 10]], [dialects, [7, 8, 15]], [consumer, [6]]]) {
    assert.deepEqual(disk.filter(f => f.path === source.path).map(f => f.line).sort((a, b) => a - b), expected);
  }
  for (const finding of disk) {
    assert.equal(finding.verdict, 'needs-validation');
    assert.equal(finding.evidence, 'traced');
    if ((finding.path === paths.path && finding.line === 12) || (finding.path === relative.path && finding.line === 10)) {
      assert.match(finding.blocker, /lexical directory/i);
      assert.match(finding.blocker, /symbolic link/i);
    } else {
      assert.match(finding.blocker, /permitted directory/);
    }
  }
  const moved = disk.find(f => f.path === consumer.path);
  assert(moved.trace.some(step => step.path === consumer.path && step.line === 5 && step.role === 'entrypoint'));
  assert(moved.trace.some(step => step.path === helper.path && step.line === 2 && step.role === 'propagation'));

  const legacy = file('archive/local.cjs',
    'const fs = require("fs"); const path = require("path");',
    'const root = "/archives";',
    'require("express")().get("/records", (req, res) => {',
    '  const user = req.query.name, target = path.resolve(root, user);',
    '  fs.readFileSync(target);',
    '  fs.readFileSync(path.posix.resolve(user, "/fixed/index"));',
    '  fs.readFileSync(path.posix.resolve(user, "/fixed/index")); fs.readFileSync(req.query.other);',
    '  const checked = target;',
    '  if (!checked.startsWith(root + path.sep)) return;',
    '  fs.readFileSync(target);',
    '  fs.readFileSync(target); fs.readFileSync(req.query.other);',
    '});');
  const legacyFlows = analyseFlows([legacy]).flows.filter(f => f.rule === 'SEC-022');
  assert.deepEqual(legacyFlows.map(f => f.line).sort((a, b) => a - b), [5, 7, 10, 11]);
  for (const flow of legacyFlows) {
    assert.equal(flow.verdict, flow.line === 10 ? 'needs-validation' : 'confirmed');
    if (flow.line === 10) assert.equal(flow.blocker.reason, 'path-contained');
    if ([7, 11].includes(flow.line)) assert.equal(flow.trace[0].line, flow.line, 'the unrelated access keeps its own source');
  }

  const dense = analyseFlows([handler('archive/many.ts', ...Array(43).fill('load(p.join(root, key));'))]);
  assert.equal(dense.flows.filter(f => f.rule === 'SEC-022').length, 40);
  assert.equal(dense.stats.semantic.truncatedFiles, 1);
}

module.exports = { checkSemanticFilesystem };
