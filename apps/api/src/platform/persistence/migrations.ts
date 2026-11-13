import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Queryable } from './queryable.ts';

const MIGRATION_FILE_RX = /^\d{3}_[a-z0-9_-]+\.sql$/i;
export const ADVISORY_LOCK_ID = 562935221; // stable project-specific PostgreSQL advisory lock id

export interface Migration {
  readonly id: string;
  readonly file: string;
  readonly sql: string;
  readonly checksum: string;
}

/*
 * Where the migrations are is the caller's to say: the server and the operator
 * tools name their own release's db/migrations, and a test names a fixture. A
 * call without one is refused rather than resolved against wherever this
 * module happens to sit -- and that refusal is what catches the easy slip of
 * passing loadMigrations()'s list where these options belong, which used to
 * be read as "no options" and apply every migration in the default directory.
 */
export interface MigrationOptions {
  readonly directory: string;
  readonly logger?: { readonly info?: (message: string) => void } | null;
}

export interface MigrationVerification {
  readonly ok: boolean;
  readonly expectedLatest: string;
  readonly missing: string[];
  readonly changed: string[];
  readonly unknown: unknown[];
}

export function checksum(sql: unknown): string {
  return createHash('sha256').update(String(sql).replace(/\r\n/g, '\n')).digest('hex');
}

export function loadMigrations(directory: string): Migration[] {
  const files = readdirSync(directory)
    .filter(file => MIGRATION_FILE_RX.test(file))
    .sort((a, b) => a.localeCompare(b));
  const ids = new Set<string>();
  return files.map(file => {
    const id = file.replace(/\.sql$/i, '');
    if (ids.has(id)) throw new Error(`Duplicate migration id: ${id}`);
    ids.add(id);
    const sql = readFileSync(join(directory, file), 'utf8').replace(/\r\n/g, '\n');
    if (!sql.trim()) throw new Error(`Migration ${id} is empty`);
    return { id, file, sql, checksum: checksum(sql) };
  });
}

/* Keyed by the id exactly as the database returned it. */
function appliedChecksums(rows: readonly Record<string, unknown>[] | undefined): Map<unknown, unknown> {
  return new Map((rows || []).map(row => [row.migration_id, row.checksum]));
}

function migrationsDirectory(options: unknown): string {
  const directory = options && typeof options === 'object' && !Array.isArray(options)
    ? (options as { readonly directory?: unknown }).directory
    : undefined;
  if (typeof directory !== 'string' || !directory) {
    throw new TypeError('Migrations need options naming their directory: { directory }');
  }
  return directory;
}

export async function runMigrations(client: Queryable, options: MigrationOptions): Promise<{ applied: string[]; total: number }> {
  const directory = migrationsDirectory(options);
  const logger = options.logger || console;
  const migrations = loadMigrations(directory);
  const applied: string[] = [];
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS nv_schema_migrations (
      migration_id text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const existingResult = await client.query('SELECT migration_id, checksum FROM nv_schema_migrations ORDER BY migration_id');
    const existing = appliedChecksums(existingResult.rows);

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

export async function verifyMigrations(client: Queryable, options: MigrationOptions): Promise<MigrationVerification> {
  const directory = migrationsDirectory(options);
  const migrations = loadMigrations(directory);
  await client.query(`CREATE TABLE IF NOT EXISTS nv_schema_migrations (
    migration_id text PRIMARY KEY,
    checksum text NOT NULL,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const result = await client.query(
    'SELECT migration_id, checksum FROM nv_schema_migrations ORDER BY migration_id'
  );
  const applied = appliedChecksums(result.rows);
  const expected = new Set<unknown>(migrations.map(item => item.id));
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
