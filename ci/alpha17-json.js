'use strict';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isNonzeroSha256(value) {
  return SHA256_PATTERN.test(String(value || '')) && !/^0{64}$/.test(value);
}

module.exports = Object.freeze({
  cloneJson,
  hasExactKeys,
  isNonzeroSha256,
  isPlainObject,
  stableJson
});
