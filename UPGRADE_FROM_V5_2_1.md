# Upgrade Nebulaverse-X v5.2.1 to v5.2.2

This is a stabilization release. It preserves the existing Render Free web service, optional Neon database, providers, Neural Command Center, SmartPush, Git LFS, recovery, safeguards, and security features.

## Before deployment

1. Keep the Render Blueprint service name exactly `Nebulaverse-X`.
2. Confirm `SESSION_SECRET` is present in Render.
3. Keep the existing Neon pooled `DATABASE_URL`; do not create a Render database.
4. Export recent activity/evidence when the current deployment is important.
5. Deploy to a disposable or staging repository first when live GitHub webhooks are enabled.

## Database behavior

On startup, v5.2.2 applies ordered SQL files from `db/migrations/` under a PostgreSQL advisory lock. The migration runner:

- creates `nv_schema_migrations` when absent;
- records each migration ID and SHA-256 checksum;
- uses `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, and `CREATE INDEX IF NOT EXISTS` for compatibility with v5.2.1 tables;
- runs each unapplied migration in a transaction;
- aborts startup when an already-applied migration file has been modified.

Do not edit a migration after it has been applied. Add a new numbered migration instead.

## PWA cache migration

v5.2.2 keeps the offline application shell. On service-worker activation it deletes the legacy unscoped `nv-api-perm` and `nv-api` caches introduced by earlier releases.

Private repository reads are network-only by default. A user may explicitly enable offline access for the currently open repository. Eligible small text/JSON responses are then stored in a schema-versioned cache bound to an opaque account/session scope.

The private cache is purged during login, account switch/removal, logout, remote session revocation, and Emergency Shield containment. A fully offline browser cannot be erased remotely.

## Deployment

```bash
npm ci
npm test
npm run check:syntax
npm audit --omit=dev --audit-level=high
npm start
```

Render uses `npm ci --omit=dev` and `npm start`. Node major 22 is pinned through `package.json` and `.nvmrc`.

## Post-deployment checks

```text
GET /healthz
GET /readyz
GET /api/version
```

Expected version response:

```json
{
  "version": "5.2.2",
  "product": "Nebulaverse-X"
}
```

Then verify:

1. login and logout;
2. account switching;
3. repository browsing and editing;
4. optional offline access for one test repository;
5. protected paths;
6. Neural verified-event reconnect;
7. Emergency Shield on a disposable repository;
8. snapshot preview without executing a restore.

## Rollback

Redeploy the previous application commit. The additive v5.2.2 migration tables/columns can remain; v5.2.1 ignores `nv_schema_migrations`. Do not delete evidence, snapshot, webhook, or session tables during an emergency rollback.
