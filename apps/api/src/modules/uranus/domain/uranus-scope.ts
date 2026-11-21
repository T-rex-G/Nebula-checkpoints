import type { Token } from './uranus-lex.ts';
import type { Step } from './uranus-cfamily.ts';
import { bothCleared, type SanitisedSink as FlowSinkKind } from './uranus-sanitise.ts';

export interface Guard {
  readonly unverifiedTransform?: true;
  readonly sinks?: ReadonlySet<FlowSinkKind>;
  readonly path: string;
  readonly line: number;
}
/* A tainted value, as the walk carries it; `param` is the position of the parameter it stands for while a helper is summarised. */
export interface FlowValue {
  kind: string;
  weak: boolean;
  whole: boolean;
  param: number | null;
  sql: boolean;
  html: boolean;
  uncertainHtml?: boolean;
  built: boolean;
  guarded: Guard | null;
  cleared: ReadonlySet<FlowSinkKind> | null; /* The sinks a sanitiser has made this value safe for; every other sink still counts. */
  steps: Step[];
  object?: boolean;
  wholeInside?: FlowValue | null;
  spreadKw?: boolean;
}
export type Value = FlowValue | null;

export function merge(a: Value | undefined, b: Value | undefined): Value {
  if (!a) return b ?? null;
  if (!b) return a;
  /* A strong source outranks a weak one, and a real source a parameter placeholder. */
  const rank = (value: FlowValue): number => (value.param !== null ? 0 : value.weak ? 1 : 2);
  const first = rank(b) > rank(a) ? b : a;
  return { ...first, sql: a.sql || b.sql, html: a.html || b.html, uncertainHtml: a.uncertainHtml || b.uncertainHtml, built: a.built || b.built, guarded: first.guarded, cleared: bothCleared(a.cleared, b.cleared) };
}

/* Each binding owns its fields. Rebinding discards them in constant time.
 * A branch copies a parent's fields only on its first write to that binding. */
interface Binding {
  value: Value;
  declaration?: Token;
  fields?: Map<string, Value>;
}

export class Scope {
  readonly parent: Scope | null;
  readonly vars = new Map<string, Binding>();
  readonly writes: Map<string, Binding> | null;

  constructor(parent?: Scope | null, arm = false) {
    this.parent = parent || null;
    this.writes = arm ? new Map() : null;
  }

  private binding(name: string): Binding | undefined {
    for (let scope: Scope | null = this; scope; scope = scope.parent) {
      const binding = scope.vars.get(name) ?? scope.writes?.get(name);
      if (binding) return binding;
    }
    return undefined;
  }

  private target(name: string): Map<string, Binding> {
    for (let scope: Scope | null = this; scope; scope = scope.parent) {
      if (scope.vars.has(name)) return scope.vars;
      if (scope.writes) return scope.writes;
    }
    return this.vars;
  }

  lookup(name: string): Value | undefined { return this.binding(name)?.value; }
  declaration(name: string): Token | null | undefined {
    const binding = this.binding(name);
    return binding ? binding.declaration ?? null : undefined;
  }
  field(name: string, key: string): Value | undefined { return this.binding(name)?.fields?.get(key); }
  declare(name: string, value: Value | undefined, declaration?: Token): void { this.vars.set(name, { value: value ?? null, declaration }); }
  assign(name: string, value: Value | undefined): void { this.target(name).set(name, { value: value ?? null }); }

  setField(name: string, key: string | null, value: Value, aggregate: boolean): void {
    const target = this.target(name);
    let binding = target.get(name);
    if (!binding) {
      const prior = this.binding(name);
      if (!prior) return;
      binding = { value: prior.value };
      if (prior.fields) binding.fields = new Map(prior.fields);
      target.set(name, binding);
    }
    binding.declaration = undefined;
    if (key !== null) {
      binding.fields ??= new Map();
      binding.fields.set(key, value);
    } else if (value) {
      // A computed write could replace any known field.
      for (const [field, old] of binding.fields ?? []) binding.fields?.set(field, merge(old, value));
    }
    if (aggregate && value) binding.value = merge(binding.value, value);
  }

  join(arms: readonly Scope[], covered: boolean): void {
    const names = new Set<string>();
    for (const arm of arms) for (const name of arm.writes?.keys() ?? []) names.add(name);
    for (const name of names) {
      const before = this.binding(name);
      const possible = arms.map(arm => arm.writes?.get(name) ?? before);
      if (!covered) possible.push(before);
      const result: Binding = { value: null };
      const first = possible[0]?.declaration;
      if (first && possible.every(b => b?.declaration === first)) result.declaration = first;
      const keys = new Set<string>();
      for (const binding of possible) {
        result.value = merge(result.value, binding?.value);
        for (const key of binding?.fields?.keys() ?? []) keys.add(key);
      }
      for (const key of keys) {
        let value: Value = null;
        for (const binding of possible) {
          const field = binding?.fields?.get(key);
          value = merge(value, field === undefined ? binding?.value : field);
        }
        result.fields ??= new Map();
        result.fields.set(key, value);
      }
      this.target(name).set(name, result);
    }
  }
}
