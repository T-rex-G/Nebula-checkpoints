/*
 * NEBULAVERSE-X: the server.
 *
 * Visual Git operations and repository intelligence: one process serving the
 * page, its API and the workers behind them. This file only puts the parts
 * together, in an order that is itself policy:
 *
 *   1. What the tree is -- the capability document, the release's identity
 *      and the built page -- then the proxies to trust, then the secrets and
 *      settings (composition/configuration.ts). A deployment configured wrong
 *      is refused before anything is built.
 *   2. The services everything stands on (composition/core.ts), and who may
 *      do what (composition/access.ts). Building one starts nothing.
 *   3. The routes, in the order the route policy records: the global pipeline
 *      and the public routes, the alpha's boundary and the signed-in person,
 *      working on a repository, and what is kept about one, with the page's
 *      fallback last (composition/*-routes.ts, composition/pipeline.ts).
 *   4. Listening, then the work that runs beside requests: governance's
 *      webhook delivery and exposure scanning. A signal stops all of it once
 *      (platform/lifecycle/graceful-shutdown.ts).
 *
 * The modules own what each part does; the platform owns what they share.
 * Natively this file runs as written (ADR-088); the compiled fallback runs
 * the same from dist/server.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { loadTrustedProxies } from './platform/config/config.ts';
import { APP_VERSION, PRODUCT_NAME } from './platform/release/version.ts';
import { loadRelease, loadSettings } from './composition/configuration.ts';
import { composeCore } from './composition/core.ts';
import { composeAccess } from './composition/access.ts';
import { registerPipeline } from './composition/pipeline.ts';
import { registerSessionSurface } from './composition/session-routes.ts';
import { registerRepositoryWork } from './composition/repository-routes.ts';
import { registerRepositoryRecords } from './composition/record-routes.ts';

/* The tree the server runs from: the checkout natively, dist/server when compiled, laid out alike. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const release = loadRelease(ROOT, process.env);
const app = express();
app.set('trust proxy', loadTrustedProxies(process.env.NV_TRUSTED_PROXIES));
const settings = loadSettings(process.env);

/*
 * Parallax's job queues are built by its routes and the HTTP server by
 * listening; the shutdown and an account's removal reach them once they exist.
 */
const core = composeCore(release, settings, { parallaxJobs: () => records.jobs, httpServer: () => httpServer });
const access = composeAccess(settings, core, { parallaxJobs: () => records.jobs });

const { maintenance } = registerPipeline(app, release, settings, core);
registerSessionSurface(app, release, settings, core, access, maintenance);
const work = registerRepositoryWork(app, settings, core, access);
const records = registerRepositoryRecords(app, release, settings, core, access, work.listRepositories);

work.startTempMaintenance();
const { port } = settings.secrets;
const httpServer = app.listen(port, () => console.log(`${PRODUCT_NAME} v${APP_VERSION} orbiting on :${port}`));
void core.governance.bootstrapGovernanceDelivery();
core.exposure.ensureExposureWorker();
process.once('SIGTERM', () => core.shutdown('SIGTERM'));
process.once('SIGINT', () => core.shutdown('SIGINT'));
