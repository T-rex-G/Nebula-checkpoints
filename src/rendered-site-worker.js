'use strict';
const { auditRenderedSite } = require('./rendered-site-audit');
process.once('message', async message => {
  try {
    const result = await auditRenderedSite({ url: message.url, executablePath: message.executablePath,
      onProgress: progress => { if (process.connected) process.send({ progress }); } });
    if (process.connected) process.send({ result }, () => process.exit(0));
  } catch (error) {
    if (process.connected) process.send({ error: { message: error.message, code: error.code || 'RENDERED_AUDIT_FAILED', status: error.status || 502 } }, () => process.exit(1));
  }
});
process.on('disconnect', () => require('./rendered-site-runner').killProcessTree(process.pid));
