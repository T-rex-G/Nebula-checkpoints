'use strict';
// Synthetic provider streams for exercising the real HTTP response boundary.
// No request in this process reaches an external provider.
function json(value) { return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }); }
function stream(mode) {
  let timer;
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(1024).fill(65));
      if (mode === 'ok') controller.close();
      else if (mode !== 'cancel') timer = setTimeout(() => controller.error(Object.assign(new Error('synthetic upstream body failure'), {
        code: 'PROVIDER_RESPONSE_TOO_LARGE', status: 502
      })), 100);
    },
    cancel() { clearTimeout(timer); process.stdout.write('STREAM_FIXTURE_CANCELLED\n'); }
  }));
}
async function providerFetch(input) {
  process.stdout.write('STREAM_FIXTURE_REQUEST\n');
  const url = new URL(input);
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/user')) return json({ id: 41, login: 'tester', username: 'tester', name: 'Stream Tester', avatar_url: '' });
  if (pathname.endsWith('/permission')) return json({ permission: 'admin', user: { login: 'tester' } });
  if (/\/(raw|contents|archive|zipball)(\/|$)/.test(pathname)) {
    return stream(pathname.includes('ok.bin') ? 'ok' : pathname.includes('cancel.bin') ? 'cancel' : 'broken');
  }
  throw new Error('Unexpected synthetic provider stream request');
}
global.fetch = providerFetch;
