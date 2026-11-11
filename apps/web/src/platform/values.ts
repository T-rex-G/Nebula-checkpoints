/*
 * Reading a value whose shape nothing has promised.
 *
 * The page reads answers from the server, records the browser kept, files a
 * reader chose and entries an archive lists. Their types are what was sent,
 * not what was declared, so every module reads them one way: a field of
 * something that has fields, or nothing. `record.name` on a value that may
 * be null, a number or a string is what this replaces, and what it answers
 * is what that expression answered for an object, and `undefined` for
 * anything else.
 */

/* Something whose properties can be read: an object of any kind, an array, or a function. */
export type Fields = { readonly [name: string]: unknown };

export function hasFields(value: unknown): value is Fields {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/* One field of `value`, or undefined when `value` has no fields to read. */
export function field(value: unknown, name: string): unknown {
  return hasFields(value) ? value[name] : undefined;
}

/* The items of `value` when it is a list, and none when it is not. */
export function items(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
