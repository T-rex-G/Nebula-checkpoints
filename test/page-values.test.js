'use strict';

/*
 * How the page reads a value whose shape nothing has promised
 * (apps/web/src/platform/values.ts): a field of something that has fields,
 * or nothing; the items of a list, or none.
 */

const assert = require('node:assert/strict');
const { field, hasFields, items } = require('../apps/web/src/platform/values.ts');

const cases = [];
const check = (name, run) => cases.push([name, run]);

check('a field is read from an object, an array and a function, as the expression would read it', () => {
  assert.equal(field({ name: 'demo' }, 'name'), 'demo');
  assert.equal(field({ name: 'demo' }, 'missing'), undefined);
  assert.equal(field(['a', 'b'], 'length'), 2);
  const fn = () => {};
  fn.label = 'mark';
  assert.equal(field(fn, 'label'), 'mark');
  /* An inherited field is a field, as `value.name` reads it. */
  assert.equal(field(Object.create({ inherited: 1 }), 'inherited'), 1);
});

check('anything without fields answers nothing, where the expression would have thrown or read a string', () => {
  for (const value of [null, undefined, 0, 7, '', 'text', true, false, Symbol('s'), 10n]) {
    assert.equal(hasFields(value), false, String(typeof value));
    assert.equal(field(value, 'length'), undefined, String(typeof value));
  }
});

check('a list gives its items, and anything else gives none', () => {
  const list = [1, 2];
  assert.equal(items(list), list, 'the list itself, not a copy');
  for (const value of [null, undefined, 'ab', { length: 2, 0: 'a', 1: 'b' }, new Set([1]), 3]) {
    assert.deepEqual(items(value), [], String(value));
  }
});

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}\n${error.stack}`);
  }
}
if (failed) {
  console.error(`${failed} of ${cases.length} page value checks failed`);
  process.exit(1);
}
console.log(`page values: ${cases.length} checks passed`);
