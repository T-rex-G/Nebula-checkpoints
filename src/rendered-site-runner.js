'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
const { fork } = require('child_process');
const { auditError, renderedUrl } = require('./rendered-site-audit');

/* Chromium creates its own process group. Killing only the Node worker's
   group would leave it behind. Snapshot Linux parentage, then stop descendants
   before the worker; reading stat never collects arguments or environment. */
function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const children = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(Number(entry));
    } catch { /* The process exited while the snapshot was read. */ }
  }
  const stop = target => {
    for (const child of children.get(target) || []) stop(child);
    try { process.kill(-target, 'SIGKILL'); } catch { /* not a group leader */ }
    try { process.kill(target, 'SIGKILL'); } catch { /* exited */ }
  };
  stop(pid);
}

/* A disposable process, environment and temporary directory. No provider, session or database
   credentials are passed to Chromium or its JavaScript host. The process group
   is killed on cancellation/timeout, including browser descendants. */
function runRenderedSite({ url, executablePath, signal, onProgress = () => {} }) {
  url = renderedUrl(url);
  if (process.platform !== 'linux') return Promise.reject(auditError('The isolated rendered worker requires a Linux deployment.'));
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(auditError('Audit cancelled.', 'RENDERED_AUDIT_CANCELLED', 499));
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nv-rendered-'));
    let child;
    try { child = fork(path.join(__dirname, 'rendered-site-worker.js'), [], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: directory, LANG: 'C.UTF-8' },
      execArgv: ['--max-old-space-size=256'], detached: process.platform !== 'win32',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    }); } catch {
      fs.rmSync(directory, { recursive: true, force: true });
      return reject(auditError('The isolated audit process could not start.'));
    }
    let settled = false;
    const stop = () => { try { killProcessTree(child.pid); } catch { child.kill('SIGKILL'); } };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', cancel);
      stop();
      fs.rm(directory, { recursive: true, force: true, maxRetries: 3 }, () => {});
      if (error) reject(error); else resolve(result);
    };
    const cancel = () => finish(auditError('Audit cancelled.', 'RENDERED_AUDIT_CANCELLED', 499));
    const timer = setTimeout(() => finish(auditError('The browser exceeded its time limit.', 'RENDERED_AUDIT_TIMEOUT', 504)), 95000);
    if (signal) signal.addEventListener('abort', cancel, { once: true });
    child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      if (message.progress) { try { onProgress(message.progress); } catch { /* advisory only */ } }
      else if (message.result) finish(null, message.result);
      else if (message.error) finish(auditError(message.error.message, message.error.code, message.error.status));
    });
    child.on('error', () => finish(auditError('The isolated audit process could not start.')));
    child.on('exit', () => finish(auditError('The isolated audit process exited before returning a report.')));
    child.send({ url, executablePath }, error => { if (error) finish(auditError('The isolated audit process could not start.')); });
  });
}
module.exports = { runRenderedSite, killProcessTree };
