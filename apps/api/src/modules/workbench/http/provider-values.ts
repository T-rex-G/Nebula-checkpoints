/*
 * A provider's answer read the way the route code always read it, failures
 * included: a list that is not one, a text that is not one, a field of
 * nothing. Each helper throws the TypeError JavaScript throws for the same
 * expression, named as the engine names it, so a malformed answer fails as
 * it always did and the public error is unchanged.
 */
import { Readable } from 'node:stream';
import type { Request } from 'express';
import { member } from '../../../platform/values/fields.ts';

/* A request body's field, as destructuring `req.body || {}` reads it. */
export function bodyField(req: Request, name: string): unknown {
  return member(req.body || {}, name);
}

/* The repository a request names, as an API path. */
export function repositoryPath(req: Request): string {
  return `/repos/${req.params.owner}/${req.params.repo}`;
}

/* A list read with a method of Array called on it, as `expression` names the call. */
export function listed(value: unknown, expression: string): readonly unknown[] {
  if (value === null || value === undefined) throw new TypeError(`Cannot read properties of ${value} (reading '${expression.slice(expression.lastIndexOf('.') + 1)}')`);
  if (!Array.isArray(value)) throw new TypeError(`${expression} is not a function`);
  return value;
}

/* `value.slice(start)`, as JavaScript calls it: a list or a text can be sliced, anything else cannot. */
export function sliced(value: unknown, start: number, expression: string): unknown {
  if (value === null || value === undefined) throw new TypeError(`Cannot read properties of ${value} (reading 'slice')`);
  if (Array.isArray(value) || typeof value === 'string') return value.slice(start);
  throw new TypeError(`${expression} is not a function`);
}

/* A text read with a method of String called on it, as `expression` names the call. */
export function text(value: unknown, expression: string): string {
  if (value === null || value === undefined) throw new TypeError(`Cannot read properties of ${value} (reading '${expression.slice(expression.lastIndexOf('.') + 1)}')`);
  if (typeof value !== 'string') throw new TypeError(`${expression} is not a function`);
  return value;
}

/* A text's first line, as `value.split('\n')[0]` reads it. */
export function firstLine(value: unknown, expression: string): string {
  return text(value, expression).split('\n')[0] ?? '';
}

/*
 * What `for (const x of (expression))` walks when the expression is not a
 * plain name: anything iterable, and for anything else the TypeError the
 * engine throws, which names the value's type rather than the expression.
 */
export function iterated(value: unknown): Iterable<unknown> {
  if (value !== null && value !== undefined && typeof Reflect.get(Object(value), Symbol.iterator) === 'function') return Object(value);
  const described = typeof value === 'number' || typeof value === 'boolean' ? `${typeof value} ${String(value)}` : typeof value;
  throw new TypeError(`${described} is not iterable (cannot read property Symbol(Symbol.iterator))`);
}

/* `Readable.fromWeb(body)`, called as JavaScript calls it on a provider's body: what is not a web stream, Node refuses. */
export function fromWebBody(body: unknown): Readable {
  const readable: unknown = Reflect.apply(Readable.fromWeb, Readable, [body]);
  if (!(readable instanceof Readable)) throw new TypeError('Readable.fromWeb did not answer a stream');
  return readable;
}
