'use strict';

const assert = require('node:assert/strict');

const source = (path, ...lines) => ({ path, text: lines.join('\n') });
const at = (audit, path, line) => audit.findings.filter(f => f.rule === 'SEC-001' && f.path === path && f.line === line);

function checkSemanticSql(analyse) {
  const routes = source('server/routes.ts',
    'import express from "express";',
    'import { useColumn, useValue } from "./public.js";',
    'const calendar = express.Router();',
    'calendar.get("/calendar/:column", (incoming, response) => {',
    '  const fields = incoming.params;',
    '  const supplied = fields["column"];',
    '  useColumn(supplied);',
    '  useValue(supplied);',
    '});');
  const store = source('server/storage.ts',
    'import { Pool as Store } from "pg";',
    'const calendar = new Store();',
    'export function ordered(column: string) {',
    '  const text = `SELECT title FROM calendar ORDER BY ${column}`;',
    '  return calendar.query({ text });',
    '}',
    'export function filtered(name: string) {',
    '  return calendar.query({ text: "SELECT title FROM calendar WHERE name = $1", values: [name] });',
    '}');
  const bridge = source('server/public.ts', 'export { ordered as useColumn, filtered as useValue } from "./storage.js";');
  const result = analyse({ files: [routes, bridge, store] });
  const trace = at(result, store.path, 5);
  assert.equal(trace.length, 1, 'an Express route field reaches the statement-text field of the imported database client');
  assert.equal(trace[0].evidence, 'traced');
  assert(trace[0].trace.some(step => step.role === 'entrypoint' && step.path === routes.path && step.line === 6));
  assert(trace[0].trace.some(step => step.role === 'sink' && step.path === store.path && step.line === 5));
  assert.equal(at(result, store.path, 8).length, 0, 'values bound to a fixed statement remain data');

  const local = source('server/headers.cjs',
    'const service = require("express");',
    'const { Client: Catalog } = require("pg");',
    'const router = service.Router();',
    'const archive = new Catalog();',
    'router.route("/column").post((incoming, reply) => {',
    '  const field = incoming.get("x-calendar-column");',
    '  archive["query"]({ text: field });',
    '  archive["query"]("SELECT $1", [field]);',
    '});');
  const second = analyse({ files: [local] });
  const direct = at(second, local.path, 7);
  assert.equal(direct.length, 1, 'the detector resolves CommonJS factories and a chained Express route');
  assert.equal(direct[0].verdict, 'confirmed');
  assert(direct[0].trace.some(step => step.role === 'entrypoint' && step.line === 6));
  assert.equal(at(second, local.path, 8).length, 0);

  const guards = source('server/guards.ts',
    'import factory from "express";',
    'import * as storage from "pg";',
    'const ledger = new storage.Pool();',
    'const api = factory();',
    'const mirror = { query(value: unknown) { return value; } };',
    'api.get("/item", (input, output) => {',
    '  const field = input.query.column;',
    '  mirror.query({ text: field });',
    '  ledger.query({ text: field, ...makeConfig() });',
    '  ledger.query({ text: field, submit: customSubmit });',
    '  ledger.query({ text: "SELECT $1", values: [field] });',
    '});',
    'const ledgerAlias = new storage.Client();',
    'const receiver = ledgerAlias;',
    'receiver.query = record;',
    'api.post("/item", (input, output) => ledgerAlias.query({ text: input.query.column }));',
    'const view = { get(path: string, fn: unknown) {} };',
    'view.get("/item", (input, output) => ledger.query({ text: input.params.column }));',
    'api.get("/reset", (input, output) => {',
    '  const params = input.params;',
    '  params.column = "title";',
    '  ledger.query({ text: input.params.column });',
    '});',
    'api.get("/size", (input, output) => ledger.query({ text: "SELECT " + input.params.column.length }));');
  const safe = analyse({ files: [guards] });
  for (const line of [8, 9, 10, 11, 16, 18, 22, 24]) {
    assert.equal(at(safe, guards.path, line).length, 0, `unproven SQL execution or input at ${guards.path}:${line}`);
  }
}

module.exports = { checkSemanticSql };
