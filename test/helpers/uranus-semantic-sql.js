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
  checkMysqlBoundaries(analyse);
}

function checkMysqlBoundaries(analyse) {
  const routes = source('calendar/router.ts',
    'import createApi from "express";',
    'import { selected, byValue } from "./lookup.js";',
    'const api = createApi();',
    'api.get("/calendar/:column", (incoming, response) => {',
    '  const field = incoming.params.column;',
    '  selected(field);',
    '  byValue(field);',
    '});');
  const storage = source('calendar/lookup.ts',
    'import { createPool as catalog } from "mysql2/promise";',
    'const archive = catalog({ database: "calendar" });',
    'export async function selected(column: string) {',
    '  const session = await archive.getConnection();',
    '  const sql = `SELECT title FROM calendar ORDER BY ${column}`;',
    '  return session.execute({ sql });',
    '}',
    'export function byValue(column: string) {',
    '  return archive.execute({ sql: "SELECT title FROM calendar WHERE title = ?", values: [column] });',
    '}');
  const joined = analyse({ files: [routes, storage] });
  const result = at(joined, storage.path, 6);
  assert.equal(result.length, 1, 'a MySQL2 prepared statement receives the computed statement text');
  assert.equal(result[0].evidence, 'traced');
  assert(result[0].trace.some(step => step.role === 'entrypoint' && step.path === routes.path && step.line === 5));
  assert(result[0].trace.some(step => step.role === 'sink' && step.path === storage.path && step.line === 6));
  assert.equal(at(joined, storage.path, 9).length, 0);

  const legacy = source('calendar/legacy.cjs',
    'const openCalendar = require("mysql").createPool;',
    'const calendar = openCalendar({ database: "calendar" });',
    'const api = require("express")();',
    'api.get("/calendar", (incoming, response) => {',
    '  const column = incoming.get("x-calendar-field");',
    '  calendar.getConnection((err, archive) => {',
    '    archive.query({ sql: column });',
    '    archive.query({ sql: "SELECT ?", values: [column] });',
    '    archive.format(column);',
    '    archive.execute({ sql: column });',
    '  });',
    '});');
  const callback = analyse({ files: [legacy] });
  assert.equal(at(callback, legacy.path, 7)[0]?.verdict, 'confirmed', 'an acquired mysql callback connection runs query');
  for (const line of [8, 9, 10]) assert.equal(at(callback, legacy.path, line).length, 0);

  const contexts = source('calendar/contexts.ts',
    'import * as mysql from "mysql2";',
    'import { createConnection as connect } from "mysql2/promise";',
    'import express from "express";',
    'const api = express();',
    'const native = mysql.createPool({});',
    'const promised = native.promise();',
    'const custom = mysql.createConnection({ queryFormat: () => "SELECT 1" });',
    'const preview = { execute(options: unknown) { return options; } };',
    'api.get("/calendar", async (incoming, response) => {',
    '  const text = incoming.query.column;',
    '  promised.execute({ sql: text });',
    '  promised.execute("SELECT ?", [text]);',
    '  custom.query({ sql: text });',
    '  custom.execute({ sql: text });',
    '  const direct = await connect({});',
    '  direct.query({ sql: text });',
    '  direct.query({ sql: text, ...extraOptions });',
    '  preview.execute({ sql: text });',
    '  connect({}).query({ sql: text });',
    '  direct.prepare({ sql: text });',
    '  direct.execute({ text });',
    '  const alternate = mysql.createPool({ Promise: previewPromise }).promise();',
    '  alternate.execute({ sql: text });',
    '  const changed = mysql.createConnection({});',
    '  const wrapped = changed.promise();',
    '  wrapped.connection.execute = preview.execute;',
    '  wrapped.execute({ sql: text });',
    '});');
  const audited = analyse({ files: [contexts] });
  for (const line of [11, 14, 16]) assert.equal(at(audited, contexts.path, line)[0]?.verdict, 'confirmed', `driver boundary at ${line}`);
  for (const line of [12, 13, 17, 18, 19, 20, 21, 23, 27]) assert.equal(at(audited, contexts.path, line).length, 0, `query context at ${line}`);

}

module.exports = { checkSemanticSql };
