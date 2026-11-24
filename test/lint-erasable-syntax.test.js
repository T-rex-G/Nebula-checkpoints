'use strict';

/*
 * The TypeScript areas are erasable syntax only (ADR-088): Node strips the
 * types and runs what is left, so nothing may need compiling into code. The
 * compiler holds that (erasableSyntaxOnly); lint holds it too, in every
 * spelling a namespace has -- `namespace X` or `module X`, declared or not,
 * dotted or not -- and for enums. A module's types may still be added to, as
 * the page adds custom properties to React's style properties, and so may the
 * global scope's: both are types only, and nothing of them is left to run.
 */
const assert = require('assert');
const path = require('path');
const { Linter } = require('eslint');
const config = require('../eslint.config.js');

const ROOT = path.resolve(__dirname, '..');
const typescript = config.find(block => block.name === 'nebulaverse/typescript');
assert.ok(typescript, 'the TypeScript areas are linted by the block named nebulaverse/typescript');
const linter = new Linter({ configType: 'flat', cwd: ROOT });
const restricted = (code, file) => linter.verify(code, [typescript], { filename: path.join(ROOT, file) })
  .map(message => message.fatal ? `parse: ${message.message}` : message.ruleId === 'no-restricted-syntax' ? message.message : null)
  .filter(Boolean);

const NAMESPACE = 'Erasable syntax only: no namespaces (ADR-088).';
const ENUM = 'Erasable syntax only: an enum is code, not a type (ADR-088).';
const banned = [
  'export namespace Shapes { export const round = 1; }',
  'export declare namespace Shapes { const round: number; }',
  'export module Shapes { export const round = 1; }',
  'declare module Shapes { const round: number; }',
  'export namespace Outer.Inner { export const round = 1; }'
];
const allowed = [
  "import 'react';\ndeclare module 'react' {\n  interface CSSProperties { [property: `--${string}`]: string | undefined; }\n}",
  "declare module '*.svg' { const href: string; export default href; }",
  'export {};\ndeclare global { interface Window { readonly probe: number } }'
];
const places = ['apps/web/src/platform/probe.ts', 'apps/web/src/platform/probe.d.ts', 'apps/web/src/features/probe.tsx', 'apps/api/src/probe.ts', 'packages/contracts/src/probe.ts'];
for (const file of places) {
  for (const code of banned) assert.deepStrictEqual(restricted(code, file), [NAMESPACE], `${file} lets a namespace through: ${code}`);
  for (const code of allowed) assert.deepStrictEqual(restricted(code, file), [], `${file} refuses types only: ${code}`);
  assert.deepStrictEqual(restricted('export enum Tone { Calm }', file), [ENUM], `${file} lets an enum through`);
}
console.log('erasable syntax lint tests passed');
