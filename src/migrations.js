'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MIGRATION_FILE_RX = /^\d{3}_[a-z0-9_-]+\.sql$/i;
const ADVISORY_LOCK_ID = 562935221; // stable project-specific PostgreSQL advisory lock id

function checksum(sql) {
  return crypto.createHash('sha256').update(String(sql).replace(/\r\n/g, '\n')).digest('hex');
}

function loadMigrations(directory) {
  const files = fs.readdirSync(directory)
    .filter(file => MIGRATION_FILE_RX.test(file))
    .sort((a, b) => a.localeCompare(b));
  const ids = new Set();
  return files.map(file => {
    const id = file.replace(/\.sql$/i, '');
    if (ids.has(id)) throw new Error(`Duplicate migration id: ${id}`);
    ids.add(id);
    const sql = fs.readFileSync(path.join(directory, file), 'utf8').replace(/\r\n/g, '\n');
    if (!sql.trim()) throw new Error(`Migration ${id} is empty`);
    return { id, file, sql, checksum: checksum(sql) };
  });
}

async function runMigrations(client, options = {}) {
  const directory = options.directory || path.join(__dirname, '..', 'db', 'migrations');
  const logger = options.logger || console;
  const migrations = loadMigrations(directory);
  const applied = [];
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS nv_schema_migrations (
      migration_id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const existingResult = await client.query('SELECT migration_id, checksum FROM nv_schema_migrations ORDER BY migration_id');
    const existing = new Map((existingResult.rows || []).map(row => [row.migration_id, row.checksum]));

    for (const migration of migrations) {
      const previous = existing.get(migration.id);
      if (previous) {
        if (previous !== migration.checksum) {
          throw new Error(`Migration checksum mismatch for ${migration.id}; applied migrations are immutable`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO nv_schema_migrations(migration_id, checksum) VALUES($1,$2)',
          [migration.id, migration.checksum]
        );
        await client.query('COMMIT');
        applied.push(migration.id);
        if (logger && typeof logger.info === 'function') logger.info(`Applied database migration ${migration.id}`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }
    return { applied, total: migrations.length };
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]).catch(() => {});
  }
}

async function verifyMigrations(client, options = {}) {
  const directory = options.directory || path.join(__dirname, '..', 'db', 'migrations');
  const migrations = loadMigrations(directory);
  await client.query(`CREATE TABLE IF NOT EXISTS nv_schema_migrations (
    migration_id text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const result = await client.query(
    'SELECT migration_id, checksum FROM nv_schema_migrations ORDER BY migration_id'
  );
  const applied = new Map((result.rows || []).map(row => [row.migration_id, row.checksum]));
  const expected = new Set(migrations.map(item => item.id));
  const missing = migrations.filter(item => !applied.has(item.id)).map(item => item.id);
  const changed = migrations
    .filter(item => applied.has(item.id) && applied.get(item.id) !== item.checksum)
    .map(item => item.id);
  const unknown = [...applied.keys()].filter(id => !expected.has(id));
  return Object.freeze({
    ok: missing.length === 0 && changed.length === 0 && unknown.length === 0,
    expectedLatest: migrations.at(-1)?.id || '',
    missing,
    changed,
    unknown
  });
}

module.exports = {
  ADVISORY_LOCK_ID,
  checksum,
  loadMigrations,
  runMigrations,
  verifyMigrations
};
