/*
 * NEBULAVERSE-X: the server.
 *
 * Visual Git operations and repository intelligence: one process serving the
 * page, its API and the workers behind them. The application is put together
 * in composition/application.ts, in an order that is itself policy; this file
 * listens with it, then starts the work that runs beside requests --
 * governance's webhook delivery and exposure scanning. A signal stops all of
 * it once (platform/lifecycle/graceful-shutdown.ts).
 *
 * The modules own what each part does; the platform owns what they share.
 * Natively this file runs as written (ADR-088); the compiled fallback runs
 * the same from dist/server.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { APP_VERSION, PRODUCT_NAME } from './platform/release/version.ts';
import { registerApplication } from './composition/application.ts';

/* The tree the server runs from: the checkout natively, dist/server when compiled, laid out alike. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const app = express();
const { settings, core, work } = registerApplication(app, ROOT, { httpServer: () => httpServer });

work.startTempMaintenance();
const { port } = settings.secrets;
const httpServer = app.listen(port, () => console.log(`${PRODUCT_NAME} v${APP_VERSION} orbiting on :${port}`));
void core.governance.bootstrapGovernanceDelivery();
core.exposure.ensureExposureWorker();
process.once('SIGTERM', () => core.shutdown('SIGTERM'));
process.once('SIGINT', () => core.shutdown('SIGINT'));
