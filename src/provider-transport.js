'use strict';

const dns = require('dns');
const https = require('https');
const net = require('net');
const zlib = require('zlib');
const { Readable, Transform, pipeline } = require('stream');
const { isPublicAddress } = require('./governance-delivery');

const DEFAULT_MAX_RESPONSE_BYTES = 128 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_REQUEST_BYTES = 160 * 1024 * 1024;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

class ProviderTransportError extends Error {
  constructor(message, code, status = 502) {
    super(message);
    this.name = 'ProviderTransportError';
    this.code = code;
    this.status = status;
  }
}

function refused(message, code = 'PROVIDER_TRANSPORT_REFUSED', status = 400) {
  return new ProviderTransportError(message, code, status);
}

function targetUrl(input) {
  let url;
  try { url = new URL(String(input)); }
  catch { throw refused('Provider URL is invalid'); }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      !hostname || net.isIP(hostname.replace(/^\[|\]$/g, '')) ||
      /(?:^|\.)(?:localhost|local|internal|lan)$/.test(hostname)) {
    throw refused('Provider URL must use HTTPS and a public hostname');
  }
  return url;
}

function validatedAddresses(answers) {
  if (!Array.isArray(answers) || !answers.length || answers.length > 32) {
    throw refused('Provider hostname could not be resolved', 'PROVIDER_DNS_INVALID', 502);
  }
  return answers.map(item => {
    const address = String(item && item.address || '');
    const family = Number(item && item.family);
    if (![4, 6].includes(family) || net.isIP(address) !== family) {
      throw refused('Provider hostname returned an invalid address', 'PROVIDER_DNS_INVALID', 502);
    }
    // IPv6 must be native global unicast. Transition mechanisms can translate
    // a seemingly public address into an IPv4 destination outside this policy.
    const nativeV6 = family !== 6 || (/^[23][0-9a-f]{3}:/i.test(address) &&
      !/^2002:/i.test(address) && !/^2001:(?:0{1,4}:|:)/i.test(address));
    if (!isPublicAddress(address) || !nativeV6) {
      throw refused('Provider hostname must resolve only to public addresses', 'PROVIDER_ADDRESS_BLOCKED');
    }
    return Object.freeze({ address, family });
  });
}

function byteLimit(maxBytes) {
  let received = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) {
        return callback(refused('Provider response exceeded the transport limit', 'PROVIDER_RESPONSE_TOO_LARGE', 502));
      }
      callback(null, chunk);
    }
  });
}

/*
 * Authenticated provider reads and writes have a separate transport from the
 * anonymous audit profiles. Callers still enforce the configured provider
 * allowlist and mutation gateway; this function binds each actual connection
 * to the DNS answers checked for that request.
 *
 * Dependencies are injectable only when constructing a transport, so tests
 * can own the DNS/network boundary without a production environment bypass.
 */
function createProviderTransport(dependencies = {}) {
  const lookup = dependencies.lookup || ((host, options) => dns.promises.lookup(host, options));
  const request = dependencies.request || ((options, callback) => https.request(options, callback));

  return async function providerFetch(input, options = {}, timeoutMs = 20_000) {
    const target = targetUrl(input);
    const method = String(options.method || 'GET').toUpperCase();
    if (!METHODS.has(method)) throw refused('Provider request method is unsupported');
    if (options.redirect && options.redirect !== 'error') {
      throw refused('Provider requests must refuse redirects');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60 * 1000) {
      throw refused('Provider request deadline is invalid');
    }
    const maxBytes = options.maxResponseBytes == null ? DEFAULT_MAX_RESPONSE_BYTES : options.maxResponseBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BYTES) {
      throw refused('Provider response limit is invalid');
    }
    let body;
    if (options.body != null) {
      if (typeof options.body === 'string') body = Buffer.from(options.body);
      else if (ArrayBuffer.isView(options.body)) {
        body = Buffer.from(options.body.buffer, options.body.byteOffset, options.body.byteLength);
      } else if (options.body instanceof ArrayBuffer) body = Buffer.from(options.body);
      else throw refused('Provider request body must be text or bytes');
      if (method === 'GET' || method === 'HEAD') throw refused('This provider request method cannot carry a body');
      if (body.length > MAX_REQUEST_BYTES) throw refused('Provider request body exceeded the transport limit', 'PROVIDER_REQUEST_TOO_LARGE', 413);
    }
    const headers = new Headers(options.headers || {});
    if (headers.has('host') && headers.get('host').toLowerCase() !== target.host.toLowerCase()) {
      throw refused('Provider Host header must match its URL');
    }
    if (headers.has('transfer-encoding') || headers.has('proxy-authorization')) {
      throw refused('Provider request contains an unsupported transport header');
    }
    headers.set('host', target.host);
    if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate, br');
    if (body != null) headers.set('content-length', String(body.length));
    else headers.delete('content-length');
    const signal = options.signal;
    if (signal && signal.aborted) throw refused('Provider request was cancelled', 'PROVIDER_REQUEST_ABORTED', 499);

    return new Promise((resolve, reject) => {
      let req;
      let incoming;
      let output;
      let ended = false;
      const cleanup = () => {
        clearTimeout(deadline);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      const fail = error => {
        if (ended) return;
        ended = true;
        cleanup();
        const safeError = error instanceof ProviderTransportError ? error :
          refused('Provider connection failed', 'PROVIDER_CONNECTION_FAILED', 502);
        // Errors after headers reject the Response body as well as closing the
        // socket. A caller must never receive a truncated successful document.
        if (output) output.destroy(safeError);
        if (incoming) incoming.destroy(safeError);
        if (req) req.destroy(safeError);
        reject(safeError);
      };
      const onAbort = () => fail(refused('Provider request was cancelled', 'PROVIDER_REQUEST_ABORTED', 499));
      const deadline = setTimeout(() => fail(refused(
        'Provider request exceeded its deadline', 'PROVIDER_REQUEST_TIMEOUT', 504
      )), timeoutMs);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (signal && signal.aborted) return onAbort();

      Promise.resolve().then(() => lookup(target.hostname, { all: true, verbatim: true })).then(answers => {
        if (ended) return;
        const addresses = validatedAddresses(answers);
        req = request({
          protocol: 'https:',
          hostname: target.hostname,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method,
          headers: Object.fromEntries(headers),
          servername: target.hostname,
          rejectUnauthorized: true,
          // A connection pool must never reuse a socket resolved independently
          // of these validated answers. No secondary DNS lookup is performed.
          agent: false,
          lookup: (_host, lookupOptions, callback) => {
            if (typeof lookupOptions === 'function') callback = lookupOptions;
            if (lookupOptions && lookupOptions.all) return callback(null, addresses.map(address => ({ ...address })));
            const family = typeof lookupOptions === 'number' ? lookupOptions : lookupOptions && lookupOptions.family;
            const address = addresses.find(item => !family || item.family === family);
            if (!address) return callback(refused('Provider hostname has no address for this connection', 'PROVIDER_DNS_INVALID', 502));
            callback(null, address.address, address.family);
          }
        }, response => {
          incoming = response;
          if (ended) { incoming.destroy(); return; }
          incoming.on('error', fail);
          try {
            const status = Number(response.statusCode);
            if (REDIRECTS.has(status)) throw refused('Provider redirects are not permitted', 'PROVIDER_REDIRECT_BLOCKED', 502);
            const responseHeaders = new Headers();
            for (const [name, value] of Object.entries(response.headers)) {
              for (const item of Array.isArray(value) ? value : [value]) {
                if (item != null) responseHeaders.append(name, String(item));
              }
            }
            if (method === 'HEAD' || [204, 205, 304].includes(status)) {
              const result = new Response(null, { status, statusText: response.statusMessage, headers: responseHeaders });
              ended = true;
              cleanup();
              incoming.destroy();
              resolve(result);
              return;
            }
            if (Number(responseHeaders.get('content-length')) > maxBytes) {
              throw refused('Provider response exceeded the transport limit', 'PROVIDER_RESPONSE_TOO_LARGE', 502);
            }
            const encoding = String(responseHeaders.get('content-encoding') || 'identity').trim().toLowerCase();
            const streams = [incoming, byteLimit(maxBytes)];
            if (encoding === 'gzip' || encoding === 'x-gzip') streams.push(zlib.createGunzip());
            else if (encoding === 'deflate') streams.push(zlib.createInflate());
            else if (encoding === 'br') streams.push(zlib.createBrotliDecompress());
            else if (encoding !== 'identity') throw refused('Provider response encoding is unsupported', 'PROVIDER_ENCODING_REFUSED', 502);
            if (encoding !== 'identity') {
              responseHeaders.delete('content-encoding');
              responseHeaders.delete('content-length');
            }
            output = byteLimit(maxBytes);
            streams.push(output);
            const webBody = Readable.toWeb(output, {
              strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength }
            });
            const result = new Response(webBody, { status, statusText: response.statusMessage, headers: responseHeaders });
            pipeline(...streams, error => {
              if (error) fail(error);
              else { ended = true; cleanup(); }
            });
            resolve(result);
          } catch (error) { fail(error); }
        });
        req.on('error', fail);
        req.end(body);
      }).catch(fail);
      return undefined;
    });
  };
}

module.exports = Object.freeze({
  providerFetch: createProviderTransport(),
  createProviderTransport,
  ProviderTransportError,
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_RESPONSE_BYTES,
  MAX_REQUEST_BYTES
});
