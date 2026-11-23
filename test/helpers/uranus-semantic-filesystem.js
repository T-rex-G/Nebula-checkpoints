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
}

module.exports = { checkSemanticFilesystem };
