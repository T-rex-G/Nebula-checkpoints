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

/* The value as an object to read fields from; an empty one when it is not an object. */
export function fieldsOf(value: unknown): Fields {
  return isFields(value) ? value : {};
}

/* The entries of an array, or none when the value is not one. */
export function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
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
