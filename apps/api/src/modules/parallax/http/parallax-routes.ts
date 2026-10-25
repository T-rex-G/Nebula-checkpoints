/*
 * Parallax's routes: the rendered audit of one page in an isolated browser,
 * and the anonymous site check -- from a repository's Audit tab or on its own,
 * for any address. Each is a bounded job that belongs to the viewer who
 * started it, and each is throttled per viewer and per site, so neither
 * control can be leaned on to hammer somebody's site. Both read only what
 * every visitor can.
 *
 * The guards are handed in under the names the route policy records, and
 * the routes are registered in its order (test/oracles/route-policy.json).
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import type { Application, Request, RequestHandler, Response } from 'express';
import { createAuditJobs, type AuditJobs } from '../../../platform/jobs/audit-jobs.ts';
import { guardedFetch, guardedTxt } from '../../../platform/network/guarded-fetch.ts';
import { checkSite, type SiteCheckInput, type SiteReport } from '../application/site-check.ts';
import { runRenderedSite, type RenderedRun } from '../application/rendered-runner.ts';
import { renderedUrl } from '../domain/rendered-address.ts';
import { siteOrigin } from '../domain/site-address.ts';

/* The process environment, or a fixture of it. Each variable is read by its literal name, so the configuration registry sees every one. */
type Environment = Readonly<Record<string, string | undefined>>;

export interface ParallaxRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  /* The signed-in identity a job belongs to. */
  readonly viewer: (req: Request) => string;
  /* The server's public error answer. */
  readonly fail: (res: Response, error: unknown) => unknown;
  readonly env?: Environment;
  /* The rendered audit's switch, browser and runner; the environment decides them unless a test does. */
  readonly renderedEnabled?: boolean;
  readonly executablePath?: string;
  readonly runner?: (run: RenderedRun) => Promise<unknown>;
  /* The site check itself; `checkSite` unless a test supplies one. */
  readonly siteCheck?: (input: SiteCheckInput) => Promise<SiteReport>;
}

export interface ParallaxJobs {
  readonly site: AuditJobs<unknown>;
  readonly rendered: AuditJobs<unknown>;
}

/* Recent launches remembered per viewer and per site, at most. */
const RECENT_LIMIT = 5000;

/* A map trimmed to its oldest entries, as each check has always kept it. */
function trimOldest(map: Map<string, number>, limit: number, all: boolean): void {
  if (all) {
    while (map.size > limit) {
      const oldest = map.keys().next();
      if (oldest.done) return;
      map.delete(oldest.value);
    }
  } else if (map.size > limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
}

export function registerParallaxRoutes(app: Application, deps: ParallaxRouteDeps): ParallaxJobs {
  const rendered = registerRenderedAudit(app, deps);
  const site = registerSiteCheck(app, deps);
  return Object.freeze({ site, rendered });
}

function registerRenderedAudit(app: Application, deps: ParallaxRouteDeps): AuditJobs<unknown> {
  const { providerSessionAccess, capabilityAccess, auth, viewer, fail, env = process.env } = deps;
  const enabled = deps.renderedEnabled ?? env.NV_RENDERED_AUDIT_ENABLED === 'true';
  const executablePath = deps.executablePath ?? (env.NV_RENDERED_AUDIT_BROWSER_PATH || chromium.executablePath());
  const runner = deps.runner ?? runRenderedSite;
  const jobs = createAuditJobs<unknown>({ kind: 'rendered' });
  const recent = new Map<string, number>();
  const installed = (): boolean => {
    try {
      if (process.platform !== 'linux' || !path.isAbsolute(executablePath)) return false;
      fs.accessSync(executablePath, fs.constants.X_OK);
      return true;
    } catch { return false; }
  };
  const status = (): { enabled: boolean; available: boolean; message: string } => ({
    enabled, available: enabled && installed(),
    message: !enabled ? 'Rendered audits are disabled on this deployment. An operator can enable the isolated Chromium worker.'
      : !installed() ? 'An executable Chromium browser on Linux is required on this deployment.' : 'Ready to launch an isolated browser. OS sandbox support is checked at launch.'
  });
  const access = [providerSessionAccess, capabilityAccess('site-check'), auth];
  app.get('/api/site-rendered/status', ...access, (_req: Request, res: Response) => { res.setHeader('Cache-Control', 'no-store'); res.json(status()); });
  const handle = (req: Request, res: Response): void => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const who = viewer(req);
      const run = req.method === 'POST' ? '' : String(req.query.run || '');
      if (req.method !== 'POST' && !run) { res.status(400).json({ code: 'RENDERED_RUN_REQUIRED', error: 'A run identifier is required.' }); return; }
      const target = req.method === 'POST' ? null : jobs.target({ identity: who, run });
      if (req.method !== 'POST' && !target) { res.status(404).json({ code: 'RENDERED_RUN_GONE', error: 'This audit is no longer available.' }); return; }
      const url = req.method === 'POST' || !target ? renderedUrl(req.body && req.body.url) : String(target.repo);
      if (req.method !== 'POST' && req.query.url !== undefined && renderedUrl(req.query.url) !== url) {
        res.status(404).json({ code: 'RENDERED_RUN_GONE', error: 'This audit is no longer available.' });
        return;
      }
      if (req.method === 'DELETE') {
        if (!jobs.cancel({ identity: who, owner: 'site', repo: url, ref: '', run })) { res.status(404).json({ code: 'RENDERED_RUN_GONE', error: 'This audit is no longer available.' }); return; }
        res.json({ state: 'cancelled' });
        return;
      }
      if (!run) {
        const readiness = status();
        if (!readiness.available) { res.status(503).json({ code: 'RENDERED_AUDIT_UNAVAILABLE', error: readiness.message }); return; }
        const keys = [`viewer:${who}`, `origin:${new URL(url).origin}`];
        if (keys.some(key => Date.now() - (recent.get(key) || 0) < 30000)) {
          res.setHeader('Retry-After', '30');
          res.status(429).json({ code: 'RENDERED_AUDIT_THROTTLED', error: 'An audit ran moments ago. Wait 30 seconds before starting another.' });
          return;
        }
      }
      const answer = jobs.request({
        identity: who, owner: 'site', repo: url, ref: '', run,
        launch: ({ signal, onProgress }) => {
          for (const key of [`viewer:${who}`, `origin:${new URL(url).origin}`]) recent.set(key, Date.now());
          trimOldest(recent, RECENT_LIMIT, true);
          /* The worker's progress crosses a process boundary untyped; the jobs ignore anything that is not an update. */
          return runner({ url, executablePath, signal, onProgress: progress => onProgress(progress && typeof progress === 'object' ? progress : null) });
        }
      });
      if ('error' in answer) { fail(res, answer.error); return; }
      if (answer.status === 202) res.setHeader('Retry-After', '1');
      res.status(answer.status).json(answer.body);
    } catch (error) { fail(res, error); }
  };
  app.post('/api/site-rendered', ...access, handle);
  app.get('/api/site-rendered', ...access, handle);
  app.delete('/api/site-rendered', ...access, handle);
  return jobs;
}

/*
 * The deployed site, anonymously: a few dozen bounded requests through the
 * guarded transport's anonymous site profile, the libraries it finds asked
 * of OSV through the advisory profile, and the domain's email policy looked
 * up in public DNS. Every rule is in this module. It is a job like the audit
 * (platform/jobs/audit-jobs.ts): the first request starts it and answers 202
 * with a run id, and the page asks again with `run` and hears the stage.
 *
 * One check per identity at a time and a new one at most every fifteen
 * seconds; and any one site is checked at most once every thirty seconds,
 * whoever asks.
 */
function registerSiteCheck(app: Application, deps: ParallaxRouteDeps): AuditJobs<unknown> {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, viewer, fail, siteCheck = checkSite } = deps;
  const siteJobs = createAuditJobs<unknown>({ kind: 'site' });
  const siteCheckLast = new Map<string, number>();
  const siteOriginLast = new Map<string, number>();
  function siteCheckRequest(req: Request, res: Response): void {
    res.setHeader('Cache-Control', 'no-store');
    const who = viewer(req);
    const run = String(req.query.run || '').trim();
    let origin: string;
    try { origin = siteOrigin(req.query.url); } catch (error) { fail(res, error); return; }
    if (!run) {
      const now = Date.now();
      const mine = siteCheckLast.get(who) || 0;
      const theirs = siteOriginLast.get(origin) || 0;
      if (now - mine < 15000 || now - theirs < 30000) {
        res.setHeader('Retry-After', String(Math.ceil(Math.max(15000 - (now - mine), 30000 - (now - theirs), 1000) / 1000)));
        res.status(429).json({ error: now - theirs < 30000 && now - mine >= 15000
          ? 'This site was checked moments ago. Wait a few seconds and try again.'
          : 'A site check ran moments ago. Wait a few seconds and try again.', code: 'SITE_CHECK_THROTTLED' });
        return;
      }
    }
    const answer = siteJobs.request({
      identity: who, owner: 'site', repo: origin, ref: '', run,
      launch: ({ onProgress, signal }) => {
        siteCheckLast.set(who, Date.now());
        siteOriginLast.set(origin, Date.now());
        for (const map of [siteCheckLast, siteOriginLast]) trimOldest(map, RECENT_LIMIT, false);
        return siteCheck({
          url: origin,
          signal,
          transport: input => guardedFetch(input),
          advisoryTransport: input => guardedFetch(input),
          txt: (name, budget) => guardedTxt(name, budget),
          onProgress
        }).then(result => ({ ...result, checkedAt: new Date().toISOString() }));
      }
    });
    if ('error' in answer) { fail(res, answer.error); return; }
    if (answer.status === 202) res.setHeader('Retry-After', '1');
    res.status(answer.status).json(answer.body);
  }
  app.get('/api/site-check', providerSessionAccess, capabilityAccess('site-check'), auth, siteCheckRequest);
  app.get('/api/repo/:owner/:repo/site-check', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('site-check'), auth, siteCheckRequest);
  return siteJobs;
}
