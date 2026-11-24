'use strict';
/*
 * A page module, run against a stand-in for the browser.
 *
 * The page's modules are ES modules that close over the browser's globals:
 * window, document, matchMedia, fetch. A test that needs one of them to meet
 * a particular page -- a document without a canvas, a device that refuses
 * WebGL, a server that answers one way -- runs the whole module in a context
 * whose globals are the stand-ins it chooses. The module is compiled from ES
 * module syntax to the CommonJS form a script context can run (TypeScript's
 * transpiler, which also strips a .ts module's types), and each module it
 * imports is either the test's stand-in for that specifier or the page module
 * itself, run in the same context. A package is Node's own copy.
 *
 * Running a module is asking it, as require() is: no text of it is inspected,
 * so test/page-reads.test.js counts nothing here.
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');

const COMPILE = Object.freeze({
  module: ts.ModuleKind.CommonJS,
  target: ts.ScriptTarget.ES2022,
  jsx: ts.JsxEmit.ReactJSX,
  esModuleInterop: true
});

/* A stand-in as an import sees it: its members by name, and itself as the default. */
function asModule(stub) {
  if (stub && stub.__esModule) return stub;
  return Object.freeze({ ...stub, default: stub, __esModule: true });
}

/*
 * Run `file` (relative to the repository) in a context whose globals are
 * `globals`, and answer what it exports. `options.imports` maps an import
 * specifier, as the module writes it, to the stand-in it receives instead.
 */
function loadPageModule(file, globals = {}, options = {}) {
  const context = vm.isContext(globals) ? globals : vm.createContext(globals);
  const stubs = options.imports || {};
  const loaded = new Map();

  function load(absolute) {
    if (loaded.has(absolute)) return loaded.get(absolute).exports;
    const output = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), { fileName: absolute, compilerOptions: COMPILE }).outputText;
    const module = { exports: {} };
    loaded.set(absolute, module);
    const run = vm.runInContext(`(function (exports, require, module) {${output}\n})`, context, { filename: absolute });
    run(module.exports, specifier => resolve(absolute, specifier), module);
    return module.exports;
  }

  function resolve(from, specifier) {
    if (Object.prototype.hasOwnProperty.call(stubs, specifier)) return asModule(stubs[specifier]);
    if (specifier.startsWith('.')) return load(path.resolve(path.dirname(from), specifier));
    return require(specifier);
  }

  return load(path.resolve(ROOT, file));
}

module.exports = { loadPageModule };
