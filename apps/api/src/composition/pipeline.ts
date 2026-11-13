/*
 * The global pipeline and the routes that stand outside the session: the
 * steps every request passes, in the order the route policy records, with the
 * probes, the public files, the browser's libraries, GitHub's webhook intake,
 * the page and the static files in their places among them. Each step is built
 * in http/pipeline; where it is installed is policy, so it is installed here.
 */
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { Application } from 'express';
import { securityContact } from './commonjs.ts';
import { scopedEvidenceKey } from '../modules/corona/index.ts';
import { createWebhookIntake, createWebhookLimiter } from '../modules/pulsar/index.ts';
import {
  apiMaintenance, apiNoStore, apiRateAdmission, apiSameOrigin, correlationId, jsonBody, maintenanceMode, retireLegacyCookies,
  securityHeaders, staticFiles, structuredLogging
} from '../http/pipeline/index.ts';
import { registerProbeRoutes, registerPublicFileRoutes, registerVendorRoute, registerWebhookIntakeRoute, registerWebShellRoutes } from '../http/routes/index.ts';
import { readCookie } from '../platform/authorization/session-cookie.ts';
import { fetchWithDeadline } from '../platform/network/timed-fetch.ts';
import { rateLimitIdentity } from '../platform/rate-limit/rate-limit-identity.ts';
import type { Release, Settings } from './configuration.ts';
import type { Core } from './core.ts';

export function registerPipeline(app: Application, release: Release, settings: Settings, core: Core) {
  const { secrets, databaseConfigured } = settings;
  app.disable('x-powered-by');
  app.use(retireLegacyCookies(process.env));
  app.use(correlationId());
  app.use(structuredLogging());
  app.use(securityHeaders(process.env));
  app.use('/api', apiNoStore(core.security.offlineCacheResponseBinding));
  app.use('/api', apiSameOrigin(process.env));
  /*
   * Per-session rate limit: 300 API req/min. The bucket key is derived from
   * the unsealed session rather than from the cookie as it arrived. A caller
   * cannot forge a sealed payload without SESSION_SECRET, so it cannot mint
   * bucket identities, and the fields the derivation reads survive a reseal,
   * so writing a session back no longer returns it to zero.
   * platform/rate-limit/rate-limit-identity.ts records what the previous key
   * did instead.
   */
  app.use('/api', apiRateAdmission({
    identify: req => rateLimitIdentity({
      session: core.unseal(readCookie(req, 'nv_session') || ''),
      address: req.ip,
      hmacKey: secrets.keys.rateLimitIdentity,
      namespace: 'api'
    }).key,
    counter: core.apiRateLimitStore
  }));
  /* Maintenance mode, read once at startup (http/pipeline/maintenance.ts says why). */
  const maintenance = maintenanceMode(process.env);
  /*
   * Opaque and fresh each time the process starts: a restart is something an
   * operator has to be able to see happen, without the process saying how long
   * it has been up.
   */
  const bootId = randomUUID();
  registerProbeRoutes(app, {
    maintenance, bootId, hostedAlpha: secrets.hostingProfile === 'hosted-alpha',
    databaseConfigured: () => databaseConfigured, databaseReady: () => core.ready(), selectOne: () => core.pool().query('SELECT 1'),
    readiness: core.database.readiness, migration: core.database.migration, invalidateDatabaseReady: core.database.invalidate
  });
  registerPublicFileRoutes(app, {
    securityContact: () => securityContact(process.env.NV_SECURITY_CONTACT),
    configuredOrigin: () => String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || ''),
    webRoot: release.webRoot
  });
  registerVendorRoute(app, { fetch: fetchWithDeadline, vendorRoot: path.join(release.root, 'public', 'vendor') });
  /* GitHub's webhook deliveries: the sender's rate, then the delivery, read raw for their signature before the JSON parser. */
  const { allowWebhookRequest } = createWebhookLimiter({ counter: core.apiRateLimitStore });
  const { receiveGithubWebhook } = createWebhookIntake({
    allow: allowWebhookRequest, ready: core.ready, pool: core.pool, unseal: core.unseal,
    protectedPatternsForIdentity: core.safety.protectedPatternsForIdentity,
    evidenceKey: scopedEvidenceKey, appendEvidence: core.evidenceChain.appendEvidence, liveHub: core.liveHub
  });
  registerWebhookIntakeRoute(app, { receiveGithubWebhook });
  app.use(jsonBody());
  registerWebShellRoutes(app, { webBuild: release.webBuild });
  app.use('/api', apiMaintenance(maintenance));
  app.use(staticFiles(release.webRoot));
  return { maintenance };
}
