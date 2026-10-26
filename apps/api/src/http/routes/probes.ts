/*
 * Liveness and readiness, answered to anyone with no session and no
 * invitation.
 *
 * Health says only that the process is up, and in which mode, with an opaque
 * id fresh at each start so a restart can be seen; it names no release, which
 * would make it the cheapest place to read the build number off. Readiness is
 * what a load balancer drains on: during maintenance it is deliberately not
 * ready, while health stays green so the host does not recycle the instance
 * under the operator; a hosted deployment without its database is not ready;
 * otherwise it is ready when the database answers.
 */
import type { Application, Request, Response } from 'express';
import { member } from '../../platform/values/fields.ts';

export interface ProbeRouteDeps {
  /* Maintenance mode and the process's boot id, both fixed at startup. */
  readonly maintenance: boolean;
  readonly bootId: string;
  readonly hostedAlpha: boolean;
  /* Whether a database is configured: read when asked, since the server reads its configuration after registering these. */
  databaseConfigured(): boolean;
  /* Whether the database has been reached and migrated; the check retries on its own schedule. */
  databaseReady(): Promise<unknown>;
  /* One round trip to the database. */
  selectOne(): Promise<unknown>;
  /* The database's readiness and latest migration as they stand now. */
  readiness(): unknown;
  migration(): string;
  /* Marks the database as needing a fresh readiness check. */
  invalidateDatabaseReady(state: string): void;
}

export function registerProbeRoutes(app: Application, deps: ProbeRouteDeps): void {
  app.get('/healthz', (req: Request, res: Response) => res.json({
    ok: true,
    service: deps.maintenance ? 'maintenance' : 'alive',
    maintenance: deps.maintenance,
    bootId: deps.bootId
  }));

  app.get('/readyz', async (req: Request, res: Response) => {
    if (deps.maintenance) {
      res.setHeader('Retry-After', '120');
      return res.status(503).json({ ok: false, service: 'maintenance', maintenance: true });
    }
    if (!deps.databaseConfigured()) {
      if (deps.hostedAlpha) {
        return res.status(503).json({
          ok: false,
          database: 'unavailable',
          migration: deps.migration()
        });
      }
      return res.json({ ok: true, database: 'optional-not-configured' });
    }
    try {
      const ready = await deps.databaseReady();
      if (!ready) return res.status(503).json({
        ok: false,
        database: member(deps.readiness(), 'state'),
        migration: deps.migration()
      });
      await deps.selectOne();
      return res.json({
        ok: member(deps.readiness(), 'ok'),
        database: member(deps.readiness(), 'state'),
        migration: deps.migration()
      });
    } catch {
      deps.invalidateDatabaseReady('unavailable');
      return res.status(503).json({
        ok: false,
        database: member(deps.readiness(), 'state'),
        migration: deps.migration()
      });
    }
  });
}
