/*
 * The rendered audit's child process: the `rendered-site-worker` entry in
 * entrypoint.ts, forked by the runner with an IPC channel and nothing else.
 * It audits the one address it is sent, posts its progress and then its
 * report or its error, and exits; a parent that goes away takes the browser
 * with it. It starts only where there is a parent to answer.
 */
import { read } from '../../../platform/values/fields.ts';
import { auditRenderedSite } from './rendered-audit.ts';
import { killProcessTree } from './rendered-runner.ts';

const send = (message: unknown, done?: () => void): void => {
  if (process.connected && process.send) process.send(message, undefined, undefined, done);
};

if (process.send) {
  process.once('message', async (message: unknown) => {
    try {
      const executablePath = read(message, 'executablePath');
      const result = await auditRenderedSite({ url: read(message, 'url'), executablePath: typeof executablePath === 'string' ? executablePath : null,
        onProgress: progress => { if (process.connected) send({ progress }); } });
      if (process.connected) send({ result }, () => process.exit(0));
    } catch (error) {
      if (process.connected) send({ error: { message: read(error, 'message'), code: read(error, 'code') || 'RENDERED_AUDIT_FAILED', status: read(error, 'status') || 502 } }, () => process.exit(1));
    }
  });
  process.on('disconnect', () => killProcessTree(process.pid));
}
