'use strict';
/*
 * The provider requests a capability is made of: what the product's routes
 * send GitHub, and what the qualification's probes send it to earn the claim
 * that the capability works.
 *
 * A probe that reached GitHub by another request would prove GitHub works and
 * leave the product's request unproven, while the capability registry said
 * otherwise. So both are held to this one table, each by what it actually
 * sends: the product's routes by test/workbench-collaboration-routes.test.js
 * and test/workbench-repository-routes.test.js, which record every request
 * the routes make; the probes by test/capability-probes.test.js, which
 * records every request a qualification run makes. A change to either that
 * the other does not share fails one of them.
 */

const crypto = require('node:crypto');

/* Each request by its method, its path and the fields of its body (none, for a request without one). */
const PROVIDER_REQUESTS = Object.freeze([
  { capability: 'issue.create', method: 'POST', path: /^\/?repos\/[^/]+\/[^/]+\/issues$/, body: ['body', 'title'] },
  { capability: 'issue.comment', method: 'POST', path: /^\/?repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/, body: ['body'] },
  { capability: 'issue.update', method: 'PATCH', path: /^\/?repos\/[^/]+\/[^/]+\/issues\/\d+$/, body: ['state'] },
  { capability: 'pull.create', method: 'POST', path: /^\/?repos\/[^/]+\/[^/]+\/pulls$/, body: ['base', 'body', 'draft', 'head', 'title'] },
  { capability: 'pull.merge', method: 'PUT', path: /^\/?repos\/[^/]+\/[^/]+\/pulls\/\d+\/merge$/, body: ['merge_method', 'sha'] },
  { capability: 'release.create', method: 'POST', path: /^\/?repos\/[^/]+\/[^/]+\/releases$/, body: ['body', 'name', 'prerelease', 'tag_name', 'target_commitish'] },
  { capability: 'repository.star', method: 'PUT', path: /^\/?user\/starred\/[^/]+\/[^/]+$/, body: null },
  { capability: 'workflow.rerun', method: 'POST', path: /^\/?repos\/[^/]+\/[^/]+\/actions\/runs\/\d+\/rerun$/, body: null }
]);

/* The fields a body sends: a field left undefined is not sent. */
function fieldsOf(body) {
  if (body === undefined || body === null) return null;
  return Object.keys(body).filter(key => body[key] !== undefined).sort();
}

/*
 * Whether some request among those made is the one a capability is made of.
 * A request is { method, path, body }; the path without the API's origin.
 */
function sent(expectation, requests) {
  return requests.some(request => request.method === expectation.method && expectation.path.test(request.path)
    && JSON.stringify(fieldsOf(request.body)) === JSON.stringify(expectation.body));
}

/* A code search is held to the repository it was asked about, by GitHub's own qualifier. */
const scopedToRepository = (query, repository) => typeof query === 'string' && query.endsWith(` repo:${repository}`);

/*
 * A Git tree that moves a path: the new path written with the old one's
 * object, and the old one removed, each entry naming its mode and type.
 */
function moves(tree, from, to) {
  const entry = path => (tree || []).find(item => item.path === path);
  const written = entry(to);
  const removed = entry(from);
  return Boolean(written && removed && typeof written.sha === 'string' && written.sha && removed.sha === null
    && written.mode && written.type && removed.mode && removed.type);
}

/*
 * The Git LFS upload of one object to one branch by one account, as the store
 * receives it:
 *   - the negotiation, POSTed to <repository>.git/info/lfs/objects/batch on
 *     the web host, authenticated Basic with the account's login and token, in
 *     the git-lfs media type, asking to upload the object to the branch over
 *     the basic transfer;
 *   - the object's bytes, PUT where the negotiation said, as octet-stream of
 *     their size, with the headers it handed back;
 *   - and, when the negotiation offers one, the verification of the object,
 *     in the git-lfs media type with the headers handed back for it, signed
 *     with the account's credentials only on the web host and only when it
 *     brings none of its own.
 * None follows a redirect. A header handed back replaces one of the same name
 * in any case. Each request is described as lfsRequest records it, so both
 * the workbench's upload and the qualification's probe can be held to this one
 * description (test/lfs-probe-contract.test.js).
 */
const LFS_MEDIA_TYPE = 'application/vnd.git-lfs+json';
const lowered = header => Object.fromEntries(Object.entries(header || {}).map(([name, value]) => [name.toLowerCase(), String(value)]));
function lfsUpload({ repository, branch, oid, size, login, token, upload, verify }) {
  const credentials = `Basic ${Buffer.from(`${login}:${token}`).toString('base64')}`;
  const requests = [{
    method: 'POST',
    url: `https://github.com/${repository}.git/info/lfs/objects/batch`,
    headers: { accept: LFS_MEDIA_TYPE, authorization: credentials, 'content-type': LFS_MEDIA_TYPE },
    body: { operation: 'upload', transfers: ['basic'], ref: { name: `refs/heads/${branch}` }, objects: [{ oid, size }] },
    redirect: 'error'
  }];
  if (!upload) return requests;
  requests.push({
    method: 'PUT',
    url: upload.href,
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(size), ...lowered(upload.header) },
    body: { sha256: oid },
    redirect: 'error'
  });
  if (!verify) return requests;
  const headers = { accept: LFS_MEDIA_TYPE, 'content-type': LFS_MEDIA_TYPE, ...lowered(verify.header) };
  if (new URL(verify.href).hostname === 'github.com' && !headers.authorization) headers.authorization = credentials;
  requests.push({ method: 'POST', url: verify.href, headers, body: { oid, size }, redirect: 'error' });
  return requests;
}

/*
 * A request to the LFS store as lfsUpload describes it: its header names
 * lowercased, without the client's name, which is not the request's shape; a
 * JSON body parsed, and the bytes of any other by their digest.
 */
function lfsRequest({ method, url, headers, body, redirect }) {
  /* Headers as the transport sends them: two names that differ only in case are one header, both values joined. */
  const named = {};
  for (const [name, value] of new Headers(headers || {})) if (name !== 'user-agent') named[name] = value;
  const bytes = Buffer.isBuffer(body) ? body : null;
  return {
    method: String(method || 'GET').toUpperCase(),
    url: String(url),
    headers: named,
    body: bytes ? { sha256: crypto.createHash('sha256').update(bytes).digest('hex') } : body == null ? null : JSON.parse(String(body)),
    redirect
  };
}

module.exports = { PROVIDER_REQUESTS, fieldsOf, sent, scopedToRepository, moves, lfsUpload, lfsRequest };
