/*
 * Reading a value whose shape nothing has promised: a row, a provider's
 * answer, a parsed body, an argument from code that is not typed yet.
 *
 * Any object can be read by name, and what comes back is `unknown` until the
 * caller has checked it, so these helpers claim nothing the language does not
 * already guarantee. A primitive, null or undefined has no fields: reading one
 * answers undefined, as reading a missing field does.
 */
export type Fields = Readonly<Record<string, unknown>>;

export function isFields(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null;
}

/* One field of a value, or undefined when the value is not an object. */
export function read(value: unknown, key: string): unknown {
  return isFields(value) ? value[key] : undefined;
}

/*
 * A property as JavaScript reads `value?.[key]`: nothing from null or
 * undefined, and from anything else what the language finds there -- a
 * primitive's members and inherited ones included. For values that may be
 * anything; `read` is the form that reads objects alone.
 */
export function property(value: unknown, key: string): unknown {
  return value === null || value === undefined ? undefined : Reflect.get(Object(value), key, value);
}

/*
 * A member, read as JavaScript reads `value.key`: reading one off null or
 * undefined is a TypeError, and anything else is boxed and read, inherited
 * members included. For code whose failures on such a value are part of what
 * it does; `read` is the forgiving form.
 */
export function member(value: unknown, key: string): unknown {
  if (value === null || value === undefined) throw new TypeError(`Cannot read properties of ${value} (reading '${key}')`);
  return Reflect.get(Object(value), key);
}

/*
 * What `for...of` and a spread walk: anything iterable, and for anything else
 * the TypeError they throw, naming the expression as the engine names it.
 */
export function iterable(value: unknown, expression: string): Iterable<unknown> {
  if (value !== null && value !== undefined && typeof Reflect.get(Object(value), Symbol.iterator) === 'function') return Object(value);
  throw new TypeError(`${expression} is not iterable`);
}

/* The value as an object to read fields from; an empty one when it is not an object. */
export function fieldsOf(value: unknown): Fields {
  return isFields(value) ? value : {};
}

/* A text without its surrounding space, or an empty one when the value is not a text. */
export function trimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/* The entries of an array, or none when the value is not one. */
export function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/*
 * A frozen lookup table with no prototype, for names read from data: a key
 * such as `constructor` or `__proto__` finds only what the table itself holds.
 */
export function lookupTable<T extends object>(entries: T): Readonly<T> {
  return Object.freeze(Object.assign(Object.create(null), entries));
}

/* A table's own entry for a key: a name inherited from Object.prototype is not an entry. */
export function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/*
 * `new Date(value)` for a value of unknown type, as JavaScript reads it: a
 * Date, a number or a text as they are, a boolean as its number, anything
 * else as its text. Invalid input gives an invalid Date, as it always has.
 */
export function dateFrom(value: unknown): Date {
  if (value instanceof Date || typeof value === 'number' || typeof value === 'string') return new Date(value);
  return new Date(typeof value === 'boolean' ? Number(value) : String(value));
}
