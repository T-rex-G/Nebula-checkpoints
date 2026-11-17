/*
 * The platform's own routes, which belong to no module: the probes, the
 * public files and the page, the vendor libraries, the webhook intake, the
 * deployment's configuration and capabilities, the account's API budget and
 * the build's identity. Each is registered where the route policy records it
 * among the pipeline's steps, so the order lives in the server, not here.
 */
export { registerProbeRoutes, type ProbeRouteDeps } from './probes.ts';
export { registerPublicFileRoutes, registerShellFallback, registerWebShellRoutes, type PublicFileRouteDeps, type WebBuildFiles } from './public-files.ts';
export { registerVendorRoute, type GuardedFetch, type VendorRouteDeps } from './vendor.ts';
export { registerWebhookIntakeRoute, type WebhookIntakeRouteDeps } from './webhook-intake.ts';
export { registerConfigRoutes, type ConfigRouteDeps, type UploadCeilings } from './config.ts';
export { registerProviderRateRoute, type ProviderRateRouteDeps } from './provider-rate.ts';
export { registerVersionRoute, type VersionRouteDeps } from './release.ts';
