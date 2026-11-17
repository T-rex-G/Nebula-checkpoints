'use strict';
/*
 * The one way the server reads a value whose shape nothing has promised
 * (apps/api/src/platform/values/fields.ts): each helper's reading, on the
 * values that tell the forms apart -- null and undefined, primitives, arrays,
 * inherited members and names such as `constructor` and `__proto__`.
 */
const assert = require('node:assert/strict');
const fields = require('../apps/api/src/platform/values/fields.ts');

const inherited = Object.create({ inheritedName: 'from the prototype' });
inherited.own = 1;

/* isFields and read: objects alone, arrays included, read by name. */
for (const value of [{}, [], inherited, new Date(0)]) assert.equal(fields.isFields(value), true);
for (const value of [null, undefined, 0, '', 'text', true, Symbol('s')]) assert.equal(fields.isFields(value), false);
assert.equal(fields.read({ a: 1 }, 'a'), 1);
assert.equal(fields.read(inherited, 'inheritedName'), 'from the prototype');
assert.equal(fields.read(['x'], 'length'), 1);
for (const value of [null, undefined, 'text', 7]) assert.equal(fields.read(value, 'length'), undefined, `read(${String(value)})`);

/* property: what JavaScript's value?.[key] finds -- a primitive's members too -- and nothing from null or undefined. */
assert.equal(fields.property({ a: 1 }, 'a'), 1);
assert.equal(fields.property('text', 'length'), 4);
assert.equal(fields.property(7, 'toFixed'), Number.prototype.toFixed);
assert.equal(fields.property(inherited, 'inheritedName'), 'from the prototype');
assert.equal(fields.property(null, 'a'), undefined);
assert.equal(fields.property(undefined, 'a'), undefined);
for (const name of ['toString', 'constructor', 'hasOwnProperty']) assert.equal(fields.property(null, name), undefined, `null has no ${name}`);
{
  /* A getter on a primitive's prototype sees the primitive itself, as `value[key]` would show it. */
  Object.defineProperty(String.prototype, 'nvReceiver', { configurable: true, get() { return typeof this; } });
  try {
    assert.equal(fields.property('x', 'nvReceiver'), (() => { 'use strict'; return 'x'.nvReceiver; })());
  } finally {
    delete String.prototype.nvReceiver;
  }
}

/* member: as `value.key` reads it, a TypeError from null or undefined. */
assert.equal(fields.member('text', 'length'), 4);
assert.throws(() => fields.member(null, 'a'), { name: 'TypeError', message: "Cannot read properties of null (reading 'a')" });
assert.throws(() => fields.member(undefined, 'b'), { name: 'TypeError', message: "Cannot read properties of undefined (reading 'b')" });

/* iterable: what for...of walks, and the engine's TypeError for anything else. */
assert.deepEqual([...fields.iterable('ab', 'x')], ['a', 'b']);
assert.deepEqual([...fields.iterable(new Set([1]), 'x')], [1]);
for (const value of [null, undefined, 5, {}]) assert.throws(() => fields.iterable(value, 'rows.items'), { name: 'TypeError', message: 'rows.items is not iterable' });

/* fieldsOf, listOf and trimmedText: the value when it is one, an empty one when it is not. */
const object = { a: 1 };
assert.equal(fields.fieldsOf(object), object);
for (const value of [null, undefined, 'text', 3]) assert.deepEqual(fields.fieldsOf(value), {});
const list = [1];
assert.equal(fields.listOf(list), list);
for (const value of [null, { length: 1 }, 'ab', new Set([1])]) assert.deepEqual(fields.listOf(value), []);
assert.equal(fields.trimmedText('  spaced \n'), 'spaced');
for (const value of [null, undefined, 5, ['a'], { toString: () => 'x' }]) assert.equal(fields.trimmedText(value), '');

/* lookupTable and ownEntry: names read from data find only the table's own entries. */
const table = fields.lookupTable({ known: 'yes' });
assert(Object.isFrozen(table));
assert.equal(Object.getPrototypeOf(table), null);
assert.equal(table.constructor, undefined);
assert.equal(fields.ownEntry({ known: 1 }, 'known'), 1);
for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal(fields.ownEntry({ known: 1 }, name), undefined, name);

/* dateFrom: new Date(value), as JavaScript reads each kind of value. */
assert.equal(fields.dateFrom('2026-01-02T00:00:00.000Z').toISOString(), '2026-01-02T00:00:00.000Z');
assert.equal(fields.dateFrom(0).getTime(), 0);
assert.equal(fields.dateFrom(true).getTime(), 1);
assert.equal(fields.dateFrom(new Date(5)).getTime(), 5);
assert(Number.isNaN(fields.dateFrom({}).getTime()));
assert(Number.isNaN(fields.dateFrom(undefined).getTime()));

console.log('fields: ok');
