'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadMigrations, runMigrations, verifyMigrations } = require('../src/migrations');

const projectMigrations = loadMigrations(path.join(__dirname, '..', 'db', 'migrations'));
assert.strictEqual(projectMigrations.at(-1).id, '019_unbound_alpha_invites');
assert.strictEqual(new Set(projectMigrations.map(item => item.id)).size, projectMigrations.length);


const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-migrations-'));
fs.writeFileSync(path.join(dir, '002_second.sql'), 'CREATE TABLE second(id int);\n');
fs.writeFileSync(path.join(dir, '001_first.sql'), 'CREATE TABLE first(id int);\n');
const migrations = loadMigrations(dir);
assert.deepStrictEqual(migrations.map(m => m.id), ['001_first', '002_second']);
assert(migrations.every(m => /^[0-9a-f]{64}$/.test(m.checksum)));

class FakeClient {
  constructor(applied = new Map()) { this.applied = applied; this.calls = []; }
  async query(sql, params = []) {
    this.calls.push({ sql: String(sql), params });
    if (/SELECT migration_id, checksum/.test(sql)) {
      return { rows: [...this.applied].map(([migration_id, checksum]) => ({ migration_id, checksum })) };
    }
    if (/INSERT INTO nv_schema_migrations/.test(sql)) this.applied.set(params[0], params[1]);
    return { rows: [] };
  }
}

(async () => {
  const client = new FakeClient();
  const result = await runMigrations(client, { directory: dir, logger: { info() {} } });
  assert.deepStrictEqual(result.applied, ['001_first', '002_second']);
  assert(client.calls.some(c => /pg_advisory_lock/.test(c.sql)));
  assert(client.calls.some(c => /pg_advisory_unlock/.test(c.sql)));
  assert(client.calls.some(c => /CREATE TABLE first/.test(c.sql)));

  const second = new FakeClient(new Map(migrations.map(m => [m.id, m.checksum])));
  const unchanged = await runMigrations(second, { directory: dir, logger: { info() {} } });
  assert.deepStrictEqual(unchanged.applied, []);

  const changed = new FakeClient(new Map([['001_first', '0'.repeat(64)]]));
  await assert.rejects(
    () => runMigrations(changed, { directory: dir, logger: { info() {} } }),
    /checksum mismatch/i
  );
  assert(changed.calls.some(c => /pg_advisory_unlock/.test(c.sql)), 'lock must be released after failure');

  const verified = await verifyMigrations(
    new FakeClient(new Map(migrations.map(migration => [migration.id, migration.checksum]))),
    { directory: dir }
  );
  assert.deepStrictEqual(verified, {
    ok: true,
    expectedLatest: '002_second',
    missing: [],
    changed: [],
    unknown: []
  });
  assert(Object.isFrozen(verified));

  const mismatch = await verifyMigrations(new FakeClient(new Map([
    ['001_first', '0'.repeat(64)],
    ['999_unknown', 'f'.repeat(64)]
  ])), { directory: dir });
  assert.deepStrictEqual(mismatch, {
    ok: false,
    expectedLatest: '002_second',
    missing: ['002_second'],
    changed: ['001_first'],
    unknown: ['999_unknown']
  });
  console.log('migration tests passed');
})().finally(() => fs.rmSync(dir, { recursive: true, force: true })).catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
