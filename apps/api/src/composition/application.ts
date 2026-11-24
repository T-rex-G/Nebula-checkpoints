/*
 * The application, put together: what main.ts listens with, and what a test
 * builds in its own process to ask the composed server how it behaves. One
 * function, so the order the parts are put together in -- itself policy --
 * is written once:
 *
 *   1. What the tree is -- the capability document, the release's identity
 *      and the built page -- then the proxies to trust, then the secrets and
 *      settings (configuration.ts). A deployment configured wrong is refused
 *      before anything is built.
 *   2. The services everything stands on (core.ts), and who may do what
 *      (access.ts). Building one starts nothing.
 *   3. The routes, in the order the route policy records: the global pipeline
 *      and the public routes, the alpha's boundary and the signed-in person,
 *      working on a repository, and what is kept about one, with the page's
 *      fallback last (pipeline.ts, *-routes.ts).
 *
 * Everything is read from process.env, as the pipeline's own steps read it.
 * Nothing here listens or starts work beside requests: main.ts does both.
 */
import type { Server } from 'node:http';
import type { Application } from 'express';
import { loadTrustedProxies } from '../platform/config/config.ts';
import { loadRelease, loadSettings } from './configuration.ts';
import { composeCore } from './core.ts';
import { composeAccess } from './access.ts';
import { registerPipeline } from './pipeline.ts';
import { registerSessionSurface } from './session-routes.ts';
import { registerRepositoryWork } from './repository-routes.ts';
import { registerRepositoryRecords } from './record-routes.ts';

/* What is only known once the application listens, reached by the shutdown when it runs. */
export interface Listening {
  readonly httpServer: () => Server;
}

export function registerApplication(app: Application, root: string, listening: Listening) {
  const release = loadRelease(root, process.env);
  app.set('trust proxy', loadTrustedProxies(process.env.NV_TRUSTED_PROXIES));
  const settings = loadSettings(process.env);

  /*
   * Parallax's job queues are built by its routes; the shutdown and an
   * account's removal reach them once they exist.
   */
  const core = composeCore(release, settings, { parallaxJobs: () => records.jobs, httpServer: listening.httpServer });
  const access = composeAccess(settings, core, { parallaxJobs: () => records.jobs });

  const { maintenance } = registerPipeline(app, release, settings, core);
  registerSessionSurface(app, release, settings, core, access, maintenance);
  const work = registerRepositoryWork(app, settings, core, access);
  const records = registerRepositoryRecords(app, release, settings, core, access, work.listRepositories);
  return { release, settings, core, access, work, records };
}

export type ComposedApplication = ReturnType<typeof registerApplication>;
