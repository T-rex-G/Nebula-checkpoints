'use strict';
/*
 * A database of a test's own, on the PostgreSQL test service that
 * NV_TEST_DATABASE_URL names: created empty, reached by its own URL, and
 * dropped -- with whatever still holds a connection to it -- once the test is
 * done. The name says what it is for, so one left behind by a killed run can
 * be told apart.
 */
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Client } = require('pg');

async function onAdmin(adminUrl, work) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    return await work(admin);
  } finally {
    await admin.end();
  }
}

async function disposableDatabase(purpose) {
  const adminUrl = process.env.NV_TEST_DATABASE_URL;
  assert(adminUrl, 'NV_TEST_DATABASE_URL must name a disposable local PostgreSQL test service');
  assert.match(purpose, /^[a-z][a-z0-9_]{0,30}$/, 'a test database is named for its purpose in lower-case letters, digits and underscores');
  const name = `nv_${purpose}_${crypto.randomBytes(6).toString('hex')}`;
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  url.searchParams.set('sslmode', 'disable');
  await onAdmin(adminUrl, admin => admin.query(`CREATE DATABASE ${name}`));
  return Object.freeze({
    name,
    url: url.toString(),
    /* A connection of the test's own, to read what the application stored; the caller ends it. */
    async client() {
      const client = new Client({ connectionString: url.toString() });
      await client.connect();
      return client;
    },
    drop: () => onAdmin(adminUrl, admin => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`))
  });
}

module.exports = { disposableDatabase };
