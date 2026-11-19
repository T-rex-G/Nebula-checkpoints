import type { Step } from './uranus-cfamily.ts';
import { bothCleared, type Contract } from './uranus-sanitise.ts';

export const MAX_STEPS = 6;
export interface Guard {
  readonly path: string;
  readonly line: number;
}
/* A value the walk follows: what kind of request input it came from, the steps it took, and what it became. */
export interface Value {
  kind: string;
  steps: Step[];
  built: boolean;
  sql: boolean;
  html: boolean;
  lead: string | null;
  whole: boolean;
  guarded: Guard | null;
  cleared?: Contract | null;
  via?: string[] | undefined;
  param?: number;
  weakRoute?: boolean;
  conditional?: boolean;
  requires?: string | null;
}
export type Scope = Map<string, Value | null>;

export function taint(kind: string, path: string, line: number, note?: string): Value {
  return { kind, steps: [{ path, line, role: 'entrypoint', note: note || `${kind} enters here` }], built: false, sql: false, html: false, lead: null, whole: false, guarded: null };
}
export function extend(value: Value, path: string, line: number, note: string, patch?: Partial<Value>): Value;
export function extend(value: Value | null, path: string, line: number, note: string, patch?: Partial<Value>): Value | null;
export function extend(value: Value | null, path: string, line: number, note: string, patch: Partial<Value> = {}): Value | null {
  if (!value) return null;
  const last = value.steps[value.steps.length - 1];
  const step: Step = { path, line, role: 'propagation', note };
  const steps = last && last.path === path && last.line === line ? value.steps : [...value.steps, step];
  return { ...value, ...patch, steps: steps.slice(0, MAX_STEPS) };
}
export function merge(a: Value | null, b: Value | null): Value | null {
  if (!a) return b;
  if (!b) return a;
  /* a check on a name settles the merged value only if every tainted part came through that name */
  const bVia = b.via;
  const via = a.via && bVia ? a.via.filter(name => bVia.includes(name)) : undefined;
  return { ...a, conditional: Boolean(a.conditional && b.conditional), built: a.built || b.built, sql: a.sql || b.sql, html: a.html || b.html, whole: a.whole || b.whole, guarded: a.guarded || b.guarded, via, cleared: bothCleared(a.cleared || null, b.cleared || null) };
}

/* Unless every alternative carries input, a trace still needs an explanation
 * of when the branch feeding the sink can execute. Keep the lead visible. */
export function alternatives(values: readonly (Value | null)[]): Value | null {
  const result = values.reduce<Value | null>((joined, value) => merge(joined, value), null);
  return result && values.some(value => !value || value.conditional) ? { ...result, conditional: true } : result;
}

/*
 * What the arms of a branch leave behind. Each arm is read with its own copy
 * of the scope; a name any arm wrote holds, after the branch, what any arm
 * left in it -- or what it held before, when no arm need run.
 */
export function joinArms(scope: Scope, arms: readonly Scope[], covered: boolean): void {
  const names = new Set<string>();
  for (const arm of arms) for (const [name, value] of arm) if (!scope.has(name) || scope.get(name) !== value) names.add(name);
  for (const name of names) {
    const before = scope.get(name) ?? null;
    const left = arms.map(arm => (arm.has(name) ? arm.get(name) ?? null : before));
    scope.set(name, alternatives(covered ? left : [...left, before]));
  }
}
