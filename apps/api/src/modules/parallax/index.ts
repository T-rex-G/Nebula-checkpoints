/*
 * Parallax: a deployed site, from the outside. The anonymous check of what
 * any visitor's browser is sent -- headers, the connection, files that must
 * never be served, the pages and scripts a visitor reaches, the libraries
 * they load and the domain's email policy -- and the rendered audit of one
 * page in an isolated browser, with the disposable process it runs in.
 *
 * Each is one namespace with the names it has always had: the two share
 * `LIMITS`, so they are not spread flat. The rest of the server reaches this
 * module through this file only.
 */
import * as check from './application/site-check.ts';
import * as rendered from './application/rendered-audit.ts';
import * as runner from './application/rendered-runner.ts';
import * as address from './domain/site-address.ts';
import * as markup from './domain/site-markup.ts';
import * as renderedAddress from './domain/rendered-address.ts';
import { PROBES, RULES } from './domain/site-rules.ts';
export { privatePathSegment } from './domain/url-privacy.ts';
export { registerParallaxRoutes, type ParallaxJobs, type ParallaxRouteDeps } from './http/parallax-routes.ts';

/* The deployed-site check. */
export const siteCheck = Object.freeze({
  RULES,
  PROBES,
  LIMITS: check.LIMITS,
  STAGES: check.STAGES,
  SiteCheckError: address.SiteCheckError,
  siteOrigin: address.siteOrigin,
  declaredSite: address.declaredSite,
  checkSite: check.checkSite,
  emailDomain: address.emailDomain,
  libraryFromAddress: markup.libraryFromAddress,
  librariesInText: markup.librariesInText,
  robotsDisallowed: markup.robotsDisallowed,
  displayPath: address.displayPath
});
/* One page in a real browser, and the isolated process it is rendered in. */
export const renderedAudit = Object.freeze({
  auditRenderedSite: rendered.auditRenderedSite,
  renderedUrl: renderedAddress.renderedUrl,
  displayUrl: renderedAddress.displayUrl,
  auditError: renderedAddress.auditError,
  LIMITS: renderedAddress.LIMITS,
  VIEWPORTS: renderedAddress.VIEWPORTS,
  runRenderedSite: runner.runRenderedSite,
  killProcessTree: runner.killProcessTree
});
export type { SiteCheckInput, SiteFinding, SiteLimits, SiteProgress, SiteReport, SiteResponse, SiteStage, SiteTransport } from './application/site-check.ts';
export type { RenderedAuditInput, RenderedFinding, RenderedReport, RenderedTransport } from './application/rendered-audit.ts';
export type { RenderedRun } from './application/rendered-runner.ts';
export type { SiteRule, SiteRuleId } from './domain/site-rules.ts';
