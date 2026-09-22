'use strict';

const crypto = require('crypto');

const { PROFILES, guardedFetch } = require('./guarded-fetch');
const { KEY_KINDS, classifyKey } = require('./supabase-key-kinds');

/*
 * Whether a discovered project is actually readable by a stranger, rather than
 * whether its configuration looks wrong.
 *
 * The temptation with a leaked project URL and public key is to reason about
 * it: the key is anonymous, that table probably has no policy, therefore the
 * data is exposed. Every step of that is a guess, and a security feature built
 * on guesses is one whose findings a reader learns to ignore. The only thing
 * that settles it is asking the service the way an anonymous stranger would.
 *
 * What that proves is narrower than it looks, and this file is mostly about
 * saying so precisely.
 *
 *   A row came back. Then that projection of that relation was readable by the
 *   anonymous role at that moment. Not the rest of the table, not the rest of
 *   the schema, not tomorrow.
 *
 *   No rows came back. Then nothing is known. An empty table, a row filter
 *   that matched nothing, and a policy that permits the select but hides every
 *   row are indistinguishable from outside.
 *
 *   The request was refused. Then that request was refused. This is the
 *   conclusion it is most tempting to overstate, and the vocabulary here has no
 *   word for "protected" precisely so that nobody can: a 403 on two columns of
 *   one table says nothing about whether row-level security is switched on.
 *
 * The probe also has to be safe to run at all. A read transfers somebody
 * else's data and consumes their quota even though it changes nothing, so it
 * happens only under a grant naming the exact project, relation and columns;
 * it asks for one row; it never asks for `*`; it never follows a page; it uses
 * the anonymous role and refuses anything stronger; and it brings back a count
 * and no values whatsoever.
 */

const PROBE_STATES = Object.freeze({
  READABLE: 'readable',
  DENIED: 'denied',
  UNVERIFIABLE: 'unverifiable'
});

const REASONS = Object.freeze({
  AUTHORIZATION_MISSING: 'authorization-missing',
  AUTHORIZATION_INVALID: 'authorization-invalid',
  AUTHORIZATION_EXPIRED: 'authorization-expired',
  AUTHORIZATION_MISMATCH: 'authorization-mismatch',
  KEY_NOT_ANONYMOUS: 'key-not-anonymous',
  PROJECT_REFUSED: 'project-refused',
  RELATION_REFUSED: 'relation-refused',
  PROJECTION_REFUSED: 'projection-refused',
  ROWS_VISIBLE: 'rows-visible',
  NO_VISIBLE_ROWS: 'no-visible-rows',
  ACCESS_DENIED_FOR_TESTED_REQUEST: 'access-denied-for-tested-request',
  PROVIDER_THROTTLED: 'provider-throttled',
  PROVIDER_UNEXPECTED_RESPONSE: 'provider-unexpected-response',
  TRANSPORT_REFUSED: 'transport-refused'
});

/* Minutes, like every other grant here. */
const MAX_AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000;

/*
 * One row is the whole question. Asking for more would establish nothing
 * further and would move more of somebody's data across the network.
 */
const MAX_ROWS = 1;
const MAX_RESPONSE_BYTES = 8 * 1024;
const MAX_PROJECTION_COLUMNS = 8;
const MAX_DESCRIBED_RELATIONS = 200;
const DESCRIBE_MAX_RESPONSE_BYTES = 256 * 1024;

const PROJECT_REF_PATTERN = /^[a-z]{20}$/;
const RELATION_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const COLUMN_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

/* The two operations a grant can authorise, and they are not interchangeable. */
const OPERATIONS = Object.freeze({
  PROBE: 'probe-readability',
  DESCRIBE: 'describe-service'
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/* ---- Discovery --------------------------------------------------------- */

/*
 * Reading text, and nothing else. At the point a project is discovered nobody
 * has agreed to anything, so discovery must be free -- the whole consent model
 * rests on it.
 *
 * The origin is rebuilt from the reference rather than copied out of the text.
 * A URL found in a repository is a URL an attacker chose, and this is the one
 * place a discovered string could otherwise become an address this server
 * connects to. Twenty lowercase letters and a fixed suffix is the only shape
 * that becomes a host.
 */
function discoverProject(source) {
  const candidate = typeof source === 'string' ? source : '';
  const match = candidate.match(/https:\/\/([a-z]{20})\.supabase\.co(?![a-z0-9.-])/);
  if (!match) return null;
  const projectRef = match[1];
  if (!PROJECT_REF_PATTERN.test(projectRef)) return null;
  return Object.freeze({ projectRef, origin: `https://${projectRef}.supabase.co` });
}

/* ---- Keys -------------------------------------------------------------- */

/*
 * Telling the kinds apart lives in `src/supabase-key-kinds.js`, because the
 * scanner needs the same answer and must not acquire this module's transport
 * to get it. It is re-exported here so a caller holding the probe has the
 * whole vocabulary in one place.
 */

/* ---- What may be asked for -------------------------------------------- */

/*
 * A relation is a plain table name: lower-case letters, digits and
 * underscores, and that single pattern does all the work here.
 *
 * It excludes a schema-qualified path into `auth`, a name carrying its own
 * query string, a traversal, and an `rpc/` function -- and calling a function
 * matters most of all, because executing somebody's code is not a read. All of
 * them are excluded because they contain a character a table name cannot.
 *
 * An earlier version also refused any name beginning `rpc`, which was wrong in
 * both directions: `rpc/do_thing` was already excluded by the pattern, and a
 * table legitimately named `rpc_helpers` was refused for its prefix. Excluding
 * by shape rather than by prefix is the whole point -- a name is dangerous
 * because of what it contains, not what it starts with.
 */
function relationRefused(relation) {
  const value = text(relation);
  return !value || !RELATION_PATTERN.test(value);
}

/*
 * The projection is a finite list of columns an operator confirmed. `*` is
 * refused outright: selecting every column of a table somebody may not have
 * meant to expose is the difference between establishing that a relation is
 * readable and pulling out whatever is in it. Embedded resources, aliases,
 * casts and function calls are refused for the same reason -- each one reaches
 * past the columns that were agreed.
 */
function projectionRefused(projection) {
  const list = Array.isArray(projection) ? projection : [];
  if (!list.length || list.length > MAX_PROJECTION_COLUMNS) return true;
  if (new Set(list).size !== list.length) return true;
  return list.some(column => !COLUMN_PATTERN.test(typeof column === 'string' ? column : ''));
}

/* ---- The grant --------------------------------------------------------- */

function authorizationMessage(grant) {
  const projection = Array.isArray(grant.projection) ? grant.projection : [];
  const parts = [
    'nvexpread.v1',
    text(grant.operation),
    text(grant.authorizationId),
    text(grant.actorLogin),
    text(grant.scope && grant.scope.provider),
    text(grant.scope && grant.scope.authority),
    text(grant.scope && grant.scope.owner),
    text(grant.scope && grant.scope.repo),
    text(grant.commit),
    text(grant.candidateFingerprint),
    text(grant.projectRef),
    text(grant.relation),
    /*
     * The projection is signed in order and as one part with its own length
     * prefix, so a grant for `id,title` is not a grant for `title,id` and a
     * column containing the separator cannot forge another field.
     */
    projection.map(column => text(column)).join(','),
    text(grant.issuedAt),
    text(grant.expiresAt)
  ];
  return parts.map(part => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
}

function signReadabilityAuthorization(input = {}) {
  if (!Buffer.isBuffer(input.hmacKey) && typeof input.hmacKey !== 'string') {
    throw new TypeError('A readability authorization requires a derived HMAC key');
  }
  const grant = {
    operation: text(input.operation) || OPERATIONS.PROBE,
    authorizationId: text(input.authorizationId),
    actorLogin: text(input.actorLogin),
    scope: Object.freeze({
      provider: text(input.scope && input.scope.provider),
      authority: text(input.scope && input.scope.authority),
      owner: text(input.scope && input.scope.owner),
      repo: text(input.scope && input.scope.repo)
    }),
    commit: text(input.commit),
    candidateFingerprint: text(input.candidateFingerprint),
    projectRef: text(input.projectRef),
    relation: text(input.relation),
    projection: Object.freeze((Array.isArray(input.projection) ? input.projection : []).map(column => text(column))),
    issuedAt: text(input.issuedAt),
    expiresAt: text(input.expiresAt)
  };
  const signature = crypto.createHmac('sha256', input.hmacKey)
    .update(authorizationMessage(grant), 'utf8')
    .digest('hex');
  return Object.freeze({ ...grant, signature });
}

function authorizationRefusal({ authorization, hmacKey, operation, projectRef, relation, projection, candidate, actorLogin, now }) {
  if (!authorization || typeof authorization !== 'object') return REASONS.AUTHORIZATION_MISSING;
  const signature = text(authorization.signature);
  if (!signature && !text(authorization.authorizationId)) return REASONS.AUTHORIZATION_MISSING;
  if (!SIGNATURE_PATTERN.test(signature)) return REASONS.AUTHORIZATION_INVALID;

  const expected = crypto.createHmac('sha256', hmacKey)
    .update(authorizationMessage(authorization), 'utf8')
    .digest();
  const presented = Buffer.from(signature, 'hex');
  if (presented.length !== expected.length) return REASONS.AUTHORIZATION_INVALID;
  if (!crypto.timingSafeEqual(presented, expected)) return REASONS.AUTHORIZATION_INVALID;

  const issuedAt = Date.parse(text(authorization.issuedAt));
  const expiresAt = Date.parse(text(authorization.expiresAt));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return REASONS.AUTHORIZATION_INVALID;
  if (expiresAt <= issuedAt) return REASONS.AUTHORIZATION_INVALID;
  if (expiresAt - issuedAt > MAX_AUTHORIZATION_LIFETIME_MS) return REASONS.AUTHORIZATION_INVALID;
  if (issuedAt > now) return REASONS.AUTHORIZATION_INVALID;
  if (expiresAt <= now) return REASONS.AUTHORIZATION_EXPIRED;
  if (!text(authorization.actorLogin)) return REASONS.AUTHORIZATION_INVALID;

  const granted = Array.isArray(authorization.projection) ? authorization.projection.map(text) : [];
  const required = Array.isArray(projection) ? projection.map(text) : [];
  const bound = [
    [text(authorization.operation), operation],
    [text(authorization.scope && authorization.scope.provider), text(candidate.scope && candidate.scope.provider)],
    [text(authorization.scope && authorization.scope.authority), text(candidate.scope && candidate.scope.authority)],
    [text(authorization.scope && authorization.scope.owner), text(candidate.scope && candidate.scope.owner)],
    [text(authorization.scope && authorization.scope.repo), text(candidate.scope && candidate.scope.repo)],
    [text(authorization.commit), text(candidate.commit)],
    [text(authorization.candidateFingerprint), text(candidate.fingerprint)],
    [text(authorization.projectRef), text(projectRef)],
    /* Order included: a grant for two columns is a grant for those two
       columns in that order, because the request is built from it. */
    [granted.join(','), required.join(',')]
  ];
  if (operation === OPERATIONS.PROBE) bound.push([text(authorization.relation), text(relation)]);
  if (actorLogin != null) bound.push([text(authorization.actorLogin), text(actorLogin)]);
  for (const [supplied, needed] of bound) {
    if (supplied !== needed) return REASONS.AUTHORIZATION_MISMATCH;
  }
  return null;
}

/* ---- Requests ---------------------------------------------------------- */

function headersFor(anonKey) {
  return {
    /*
     * The key in both headers, which is what the service expects, and in
     * neither the path nor the query. The transport refuses a credential that
     * appears in the URL on any profile, so that combination is enforced
     * rather than remembered.
     */
    apikey: anonKey,
    authorization: `Bearer ${anonKey}`,
    accept: 'application/json',
    /* One row at the provider as well as in bytes here, and no count: a count
       is a second question nobody authorised. */
    range: '0-0',
    prefer: 'count=none'
  };
}

async function send({ url, anonKey, transport, maxResponseBytes }) {
  const request = typeof transport === 'function' ? transport : guardedFetch;
  return request({
    url,
    /*
     * The provider-read profile. This request needs a query string -- the
     * projection and the row limit are the query -- and carries its key in
     * headers, which is exactly the combination that profile is for. The
     * origin is built from a validated project reference rather than from a
     * URL found in a repository, so the profile's promise still holds.
     */
    profile: PROFILES.PROVIDER_READ,
    method: 'GET',
    headers: headersFor(anonKey),
    maxResponseBytes
  });
}

function observation(input) {
  return Object.freeze({
    state: input.state,
    reason: input.reason,
    projectRef: input.projectRef || null,
    relation: input.relation || null,
    projection: Object.freeze(Array.isArray(input.projection) ? [...input.projection] : []),
    rowCount: Number.isInteger(input.rowCount) ? input.rowCount : 0,
    testedRole: input.testedRole || null,
    observedAt: new Date(input.now).toISOString()
  });
}

/*
 * The probe. Returns a sanitized observation: what was tested, how many rows
 * the anonymous role could see, and nothing from inside them.
 */
async function probeAnonymousReadability(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const candidate = input.candidate && typeof input.candidate === 'object' ? input.candidate : {};
  const projectRef = text(input.projectRef);
  const relation = text(input.relation);
  const projection = (Array.isArray(input.projection) ? input.projection : []).map(text);
  const base = { now, projectRef, relation, projection };

  /*
   * Shape first, and none of these reaches the network. Answering "that is not
   * a project reference" or "that projection is not one we will ask for" is
   * static knowledge about this repository, and a caller learns it without
   * anybody's service being touched.
   */
  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    return observation({ ...base, state: PROBE_STATES.UNVERIFIABLE, reason: REASONS.PROJECT_REFUSED });
  }
  if (relationRefused(relation)) {
    return observation({ ...base, state: PROBE_STATES.UNVERIFIABLE, reason: REASONS.RELATION_REFUSED });
  }
  if (projectionRefused(projection)) {
    return observation({ ...base, state: PROBE_STATES.UNVERIFIABLE, reason: REASONS.PROJECTION_REFUSED });
  }

  const key = classifyKey(input.anonKey);
  if (!key.usable) {
    return observation({ ...base, state: PROBE_STATES.UNVERIFIABLE, reason: REASONS.KEY_NOT_ANONYMOUS });
  }

  if (!Buffer.isBuffer(input.authorizationKey) && typeof input.authorizationKey !== 'string') {
    throw new TypeError('A readability probe requires a derived authorization key');
  }
  const refusal = authorizationRefusal({
    authorization: input.authorization,
    hmacKey: input.authorizationKey,
    operation: OPERATIONS.PROBE,
    projectRef, relation, projection, candidate,
    actorLogin: input.actorLogin,
    now
  });
  if (refusal) {
    return observation({ ...base, state: PROBE_STATES.UNVERIFIABLE, reason: refusal });
  }

  const url = `https://${projectRef}.supabase.co/rest/v1/${relation}`
    + `?select=${encodeURIComponent(projection.join(','))}&limit=${MAX_ROWS}`;

  let response;
  try {
    response = await send({ url, anonKey: text(input.anonKey), transport: input.transport, maxResponseBytes: MAX_RESPONSE_BYTES });
  } catch {
    /* No message crosses this boundary: a transport error can quote the
       request, and the request carries the key. */
    return observation({ ...base, state: PROBE_STATES.UNVERIFIABLE, reason: REASONS.TRANSPORT_REFUSED });
  }

  const statusCode = Number(response && response.statusCode) || 0;
  const tested = { ...base, testedRole: key.kind === KEY_KINDS.PUBLISHABLE ? 'publishable' : 'anon' };

  if (statusCode === 429) {
    return observation({ ...tested, state: PROBE_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_THROTTLED });
  }
  /*
   * A refusal, and the record says only that: this request was refused. Not
   * that the relation is protected, not that row-level security is on. A 403
   * on two columns of one table under one role is evidence about that
   * request -- and a reader told "protected" would stop looking.
   */
  if ([401, 403, 404].includes(statusCode)) {
    return observation({ ...tested, state: PROBE_STATES.DENIED, reason: REASONS.ACCESS_DENIED_FOR_TESTED_REQUEST });
  }
  if (statusCode !== 200) {
    return observation({ ...tested, state: PROBE_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_UNEXPECTED_RESPONSE });
  }

  const body = typeof response.body === 'string' ? response.body : '';
  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    return observation({ ...tested, state: PROBE_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_UNEXPECTED_RESPONSE });
  }
  if (!Array.isArray(rows)) {
    return observation({ ...tested, state: PROBE_STATES.UNVERIFIABLE, reason: REASONS.PROVIDER_UNEXPECTED_RESPONSE });
  }
  if (!rows.length) {
    /*
     * The case this whole module exists to get right. An empty table, a row
     * filter that matched nothing and a policy that permits the select while
     * hiding every row are indistinguishable from out here, so the answer is
     * that nothing is known.
     */
    return observation({ ...tested, state: PROBE_STATES.UNVERIFIABLE, reason: REASONS.NO_VISIBLE_ROWS, rowCount: 0 });
  }
  /* A count, bounded by what was asked for. Never a value. */
  return observation({
    ...tested,
    state: PROBE_STATES.READABLE,
    reason: REASONS.ROWS_VISIBLE,
    rowCount: Math.min(rows.length, MAX_ROWS)
  });
}

/*
 * The service description, which is how a relation list is found without an
 * operator typing one. It is a read like any other: its own grant, its own
 * operation, and names only -- no column names, no types, no values. When it
 * is unavailable the coverage says so, because an operator confirming a
 * relation list from a partial description is confirming less than they think.
 */
async function describeService(input = {}) {
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const candidate = input.candidate && typeof input.candidate === 'object' ? input.candidate : {};
  const projectRef = text(input.projectRef);
  const empty = { relations: Object.freeze([]), observedAt: new Date(now).toISOString() };

  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    return Object.freeze({ ...empty, coverage: 'refused', reason: REASONS.PROJECT_REFUSED });
  }
  const key = classifyKey(input.anonKey);
  if (!key.usable) {
    return Object.freeze({ ...empty, coverage: 'refused', reason: REASONS.KEY_NOT_ANONYMOUS });
  }
  if (!Buffer.isBuffer(input.authorizationKey) && typeof input.authorizationKey !== 'string') {
    throw new TypeError('A service description requires a derived authorization key');
  }
  const refusal = authorizationRefusal({
    authorization: input.authorization,
    hmacKey: input.authorizationKey,
    operation: OPERATIONS.DESCRIBE,
    projectRef, relation: '', projection: [], candidate,
    actorLogin: input.actorLogin,
    now
  });
  if (refusal) return Object.freeze({ ...empty, coverage: 'refused', reason: refusal });

  let response;
  try {
    response = await send({
      url: `https://${projectRef}.supabase.co/rest/v1/`,
      anonKey: text(input.anonKey),
      transport: input.transport,
      maxResponseBytes: DESCRIBE_MAX_RESPONSE_BYTES
    });
  } catch {
    return Object.freeze({ ...empty, coverage: 'partial', reason: REASONS.TRANSPORT_REFUSED });
  }
  if (Number(response && response.statusCode) !== 200) {
    return Object.freeze({ ...empty, coverage: 'partial', reason: REASONS.PROVIDER_UNEXPECTED_RESPONSE });
  }
  let document;
  try {
    document = JSON.parse(typeof response.body === 'string' ? response.body : '');
  } catch {
    return Object.freeze({ ...empty, coverage: 'partial', reason: REASONS.PROVIDER_UNEXPECTED_RESPONSE });
  }
  const paths = document && document.paths && typeof document.paths === 'object' ? document.paths : null;
  if (!paths) return Object.freeze({ ...empty, coverage: 'partial', reason: REASONS.PROVIDER_UNEXPECTED_RESPONSE });

  const relations = [];
  for (const key of Object.keys(paths)) {
    const name = key.replace(/^\//, '');
    /* The root is the description itself, and an `rpc/` path is a function:
       calling one is executing somebody's code, which is not a read. */
    if (!name || name.startsWith('rpc/')) continue;
    if (!RELATION_PATTERN.test(name)) continue;
    if (relations.length >= MAX_DESCRIBED_RELATIONS) break;
    relations.push(name);
  }
  return Object.freeze({
    coverage: 'complete',
    reason: null,
    relations: Object.freeze(relations.sort()),
    observedAt: new Date(now).toISOString()
  });
}

module.exports = Object.freeze({
  DEFAULT_TRANSPORT: guardedFetch,
  KEY_KINDS,
  MAX_AUTHORIZATION_LIFETIME_MS,
  MAX_DESCRIBED_RELATIONS,
  MAX_PROJECTION_COLUMNS,
  MAX_RESPONSE_BYTES,
  MAX_ROWS,
  OPERATIONS,
  PROBE_STATES,
  REASONS,
  classifyKey,
  describeService,
  discoverProject,
  probeAnonymousReadability,
  signReadabilityAuthorization
});
