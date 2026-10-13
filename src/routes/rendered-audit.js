'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { createAuditJobs } = require('../code-audit-jobs');
const { renderedUrl } = require('../rendered-site-audit');
const { runRenderedSite } = require('../rendered-site-runner');

function registerRenderedAudit(app, { providerSessionAccess, capabilityAccess, auth, identityKey, fail,
  enabled = process.env.NV_RENDERED_AUDIT_ENABLED === 'true', executablePath = process.env.NV_RENDERED_AUDIT_BROWSER_PATH || chromium.executablePath(),
  runner = runRenderedSite } = {}) {
  const jobs = createAuditJobs({ kind: 'rendered' });
  const recent = new Map();
  const installed = () => {
    try { if (process.platform !== 'linux' || !path.isAbsolute(executablePath)) return false; fs.accessSync(executablePath, fs.constants.X_OK); return true; } catch { return false; }
  };
  const status = () => ({ enabled, available: enabled && installed(),
    message: !enabled ? 'Rendered audits are disabled on this deployment. An operator can enable the isolated Chromium worker.'
      : !installed() ? 'An executable Chromium browser on Linux is required on this deployment.' : 'Ready to launch an isolated browser. OS sandbox support is checked at launch.' });
  const access = [providerSessionAccess, capabilityAccess('site-check'), auth];
  app.get('/api/site-rendered/status', ...access, (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(status()); });
  const handle = (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const who = identityKey(req.gh);
      const run = req.method === 'POST' ? '' : String(req.query.run || '');
      if (req.method !== 'POST' && !run) return res.status(400).json({ code: 'RENDERED_RUN_REQUIRED', error: 'A run identifier is required.' });
      const target = req.method === 'POST' ? null : jobs.target({ identity: who, run });
      if (req.method !== 'POST' && !target) return res.status(404).json({ code: 'RENDERED_RUN_GONE', error: 'This audit is no longer available.' });
      const url = req.method === 'POST' ? renderedUrl(req.body && req.body.url) : target.repo;
      if (req.method !== 'POST' && req.query.url !== undefined && renderedUrl(req.query.url) !== url) {
        return res.status(404).json({ code: 'RENDERED_RUN_GONE', error: 'This audit is no longer available.' });
      }
      if (req.method === 'DELETE') {
        if (!jobs.cancel({ identity: who, owner: 'site', repo: url, ref: '', run })) return res.status(404).json({ code: 'RENDERED_RUN_GONE', error: 'This audit is no longer available.' });
        return res.json({ state: 'cancelled' });
      }
      if (!run) {
        const readiness = status();
        if (!readiness.available) return res.status(503).json({ code: 'RENDERED_AUDIT_UNAVAILABLE', error: readiness.message });
        const keys = [`viewer:${who}`, `origin:${new URL(url).origin}`];
        if (keys.some(key => Date.now() - (recent.get(key) || 0) < 30000)) {
          res.setHeader('Retry-After', '30');
          return res.status(429).json({ code: 'RENDERED_AUDIT_THROTTLED', error: 'An audit ran moments ago. Wait 30 seconds before starting another.' });
        }
      }
      const answer = jobs.request({ identity: who, owner: 'site', repo: url, ref: '', run,
        launch: ({ signal, onProgress }) => {
          for (const key of [`viewer:${who}`, `origin:${new URL(url).origin}`]) recent.set(key, Date.now());
          while (recent.size > 5000) recent.delete(recent.keys().next().value);
          return runner({ url, executablePath, signal, onProgress });
        } });
      if (answer.error) return fail(res, answer.error);
      if (answer.status === 202) res.setHeader('Retry-After', '1');
      return res.status(answer.status).json(answer.body);
    } catch (error) { return fail(res, error); }
  };
  app.post('/api/site-rendered', ...access, handle);
  app.get('/api/site-rendered', ...access, handle);
  app.delete('/api/site-rendered', ...access, handle);
  return jobs;
}
module.exports = { registerRenderedAudit };
