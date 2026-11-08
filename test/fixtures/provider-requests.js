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

module.exports = { PROVIDER_REQUESTS, fieldsOf, sent, scopedToRepository, moves };
