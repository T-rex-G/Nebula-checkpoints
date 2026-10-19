import { createHmac, timingSafeEqual } from 'node:crypto';
import { isSha256Hex } from '../../../../../../packages/contracts/src/ids.ts';
import { PROFILES, guardedFetch, type GuardedFetchInput } from '../../../platform/network/guarded-fetch.ts';
import { KEY_KINDS, classifyKey } from '../domain/supabase-key-kinds.ts';
import { PROBE_STATES, REASONS, type ProbeReason, type ProbeState } from '../domain/readability-outcomes.ts';

export { KEY_KINDS, PROBE_STATES, REASONS, classifyKey };
export type { ProbeReason, ProbeState };

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

/* Minutes, like every other grant here. */
export const MAX_AUTHORIZATION_LIFETIME_MS = 10 * 60 * 1000;

/*
 * One row is the whole question. Asking for more would establish nothing
 * further and would move more of somebody's data across the network.
 */
export const MAX_ROWS = 1;
export const MAX_RESPONSE_BYTES = 8 * 1024;
export const MAX_PROJECTION_COLUMNS = 8;
export const MAX_DESCRIBED_RELATIONS = 200;
const DESCRIBE_MAX_RESPONSE_BYTES = 256 * 1024;

const PROJECT_REF_PATTERN = /^[a-z]{20}$/;
const RELATION_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const COLUMN_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

/* The two operations a grant can authorise, and they are not interchangeable. */
export const OPERATIONS = Object.freeze({
  PROBE: 'probe-readability',
  DESCRIBE: 'describe-service'
} as const);
export type ProbeOperation = (typeof OPERATIONS)[keyof typeof OPERATIONS];

type Fields = Readonly<Record<string, unknown>>;

/* A field of something that may not be an object, read as plain JavaScript would. */
function read(value: unknown, key: string): unknown {
  return value == null ? undefined : (value as Fields)[key];
}

/* An object's fields, or none when it is not an object. */
function fieldsOf(value: unknown): Fields {
  return value && typeof value === 'object' ? value as Fields : {};
}

/* A list from an input, or none. */
function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
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
export function discoverProject(source: unknown): { readonly projectRef: string; readonly origin: string } | null {
  const candidate = typeof source === 'string' ? source : '';
  const match = candidate.match(/https:\/\/([a-z]{20})\.supabase\.co(?![a-z0-9.-])/);
  if (!match) return null;
  const projectRef = match[1];
  if (!projectRef || !PROJECT_REF_PATTERN.test(projectRef)) return null;
  return Object.freeze({ projectRef, origin: `https://${projectRef}.supabase.co` });
}

/* ---- Keys -------------------------------------------------------------- */

/*
 * Telling the kinds apart lives in `domain/supabase-key-kinds.ts`, because the
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
function relationRefused(relation: unknown): boolean {
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
function projectionRefused(projection: unknown): boolean {
  const list = listOf(projection);
  if (!list.length || list.length > MAX_PROJECTION_COLUMNS) return true;
  if (new Set(list).size !== list.length) return true;
  return list.some(column => !COLUMN_PATTERN.test(typeof column === 'string' ? column : ''));
}

/* ---- The grant --------------------------------------------------------- */

function authorizationMessage(grant: unknown): string {
  const projection = listOf(read(grant, 'projection'));
  const scope = read(grant, 'scope');
  const parts = [
    'nvexpread.v1',
    text(read(grant, 'operation')),
    text(read(grant, 'authorizationId')),
    text(read(grant, 'actorLogin')),
    text(scope && read(scope, 'provider')),
    text(scope && read(scope, 'authority')),
    text(scope && read(scope, 'owner')),
    text(scope && read(scope, 'repo')),
    text(read(grant, 'commit')),
    text(read(grant, 'candidateFingerprint')),
    text(read(grant, 'projectRef')),
    text(read(grant, 'relation')),
    /*
     * The projection is signed in order and as one part with its own length
     * prefix, so a grant for `id,title` is not a grant for `title,id` and a
     * column containing the separator cannot forge another field.
     */
    projection.map(column => text(column)).join(','),
    text(read(grant, 'issuedAt')),
    text(read(grant, 'expiresAt'))
  ];
  return parts.map(part => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
}

export interface ReadabilityAuthorizationInput {
  readonly hmacKey?: unknown;
  readonly operation?: unknown;
  readonly authorizationId?: unknown;
  readonly actorLogin?: unknown;
  readonly scope?: unknown;
  readonly commit?: unknown;
  readonly candidateFingerprint?: unknown;
  readonly projectRef?: unknown;
  readonly relation?: unknown;
  readonly projection?: unknown;
  readonly issuedAt?: unknown;
  readonly expiresAt?: unknown;
}

/* A grant to read one relation of one project, bound to everything that names it. */
export interface ReadabilityAuthorization {
  readonly operation: string;
  readonly authorizationId: string;
  readonly actorLogin: string;
  readonly scope: { readonly provider: string; readonly authority: string; readonly owner: string; readonly repo: string };
  readonly commit: string;
  readonly candidateFingerprint: string;
  readonly projectRef: string;
  readonly relation: string;
  readonly projection: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signature: string;
}

export function signReadabilityAuthorization(input: ReadabilityAuthorizationInput = {}): ReadabilityAuthorization {
  const hmacKey = input.hmacKey;
  if (!Buffer.isBuffer(hmacKey) && typeof hmacKey !== 'string') {
    throw new TypeError('A readability authorization requires a derived HMAC key');
  }
  const scope = input.scope;
  const grant = {
    operation: text(input.operation) || OPERATIONS.PROBE,
    authorizationId: text(input.authorizationId),
    actorLogin: text(input.actorLogin),
    scope: Object.freeze({
      provider: text(scope && read(scope, 'provider')),
      authority: text(scope && read(scope, 'authority')),
      owner: text(scope && read(scope, 'owner')),
      repo: text(scope && read(scope, 'repo'))
    }),
    commit: text(input.commit),
    candidateFingerprint: text(input.candidateFingerprint),
    projectRef: text(input.projectRef),
    relation: text(input.relation),
    projection: Object.freeze(listOf(input.projection).map(column => text(column))),
    issuedAt: text(input.issuedAt),
    expiresAt: text(input.expiresAt)
  };
  const signature = createHmac('sha256', hmacKey)
    .update(authorizationMessage(grant), 'utf8')
    .digest('hex');
  return Object.freeze({ ...grant, signature });
}

interface RefusalInput {
  readonly authorization: unknown;
  readonly hmacKey: Buffer | string;
  readonly operation: ProbeOperation;
  readonly projectRef: string;
  readonly relation: string;
  readonly projection: readonly string[];
  readonly candidate: Fields;
  readonly actorLogin: unknown;
  readonly now: number;
}

function authorizationRefusal({ authorization, hmacKey, operation, projectRef, relation, projection, candidate, actorLogin, now }: RefusalInput): ProbeReason | null {
  if (!authorization || typeof authorization !== 'object') return REASONS.AUTHORIZATION_MISSING;
  const signature = text(read(authorization, 'signature'));
  if (!signature && !text(read(authorization, 'authorizationId'))) return REASONS.AUTHORIZATION_MISSING;
  if (!isSha256Hex(signature)) return REASONS.AUTHORIZATION_INVALID;

  const expected = createHmac('sha256', hmacKey)
    .update(authorizationMessage(authorization), 'utf8')
    .digest();
  const presented = Buffer.from(signature, 'hex');
  if (presented.length !== expected.length) return REASONS.AUTHORIZATION_INVALID;
  if (!timingSafeEqual(presented, expected)) return REASONS.AUTHORIZATION_INVALID;

  const issuedAt = Date.parse(text(read(authorization, 'issuedAt')));
  const expiresAt = Date.parse(text(read(authorization, 'expiresAt')));
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) return REASONS.AUTHORIZATION_INVALID;
  if (expiresAt <= issuedAt) return REASONS.AUTHORIZATION_INVALID;
  if (expiresAt - issuedAt > MAX_AUTHORIZATION_LIFETIME_MS) return REASONS.AUTHORIZATION_INVALID;
  if (issuedAt > now) return REASONS.AUTHORIZATION_INVALID;
  if (expiresAt <= now) return REASONS.AUTHORIZATION_EXPIRED;
  if (!text(read(authorization, 'actorLogin'))) return REASONS.AUTHORIZATION_INVALID;

  const granted = listOf(read(authorization, 'projection')).map(column => text(column));
  const required = listOf(projection).map(column => text(column));
  const scope = read(authorization, 'scope');
  const asked = candidate.scope;
  const bound: [string, string][] = [
    [text(read(authorization, 'operation')), operation],
    [text(scope && read(scope, 'provider')), text(asked && read(asked, 'provider'))],
    [text(scope && read(scope, 'authority')), text(asked && read(asked, 'authority'))],
    [text(scope && read(scope, 'owner')), text(asked && read(asked, 'owner'))],
    [text(scope && read(scope, 'repo')), text(asked && read(asked, 'repo'))],
    [text(read(authorization, 'commit')), text(candidate.commit)],
    [text(read(authorization, 'candidateFingerprint')), text(candidate.fingerprint)],
    [text(read(authorization, 'projectRef')), text(projectRef)],
    /* Order included: a grant for two columns is a grant for those two
       columns in that order, because the request is built from it. */
    [granted.join(','), required.join(',')]
  ];
  if (operation === OPERATIONS.PROBE) bound.push([text(read(authorization, 'relation')), text(relation)]);
  if (actorLogin != null) bound.push([text(read(authorization, 'actorLogin')), text(actorLogin)]);
  for (const [supplied, needed] of bound) {
    if (supplied !== needed) return REASONS.AUTHORIZATION_MISMATCH;
  }
  return null;
}

/* ---- Requests ---------------------------------------------------------- */

function headersFor(anonKey: string): Readonly<Record<string, string>> {
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

/* What a probe is answered with; either part may be missing. */
export interface ProbeResponse {
  readonly statusCode?: unknown;
  readonly body?: unknown;
}

/* The guarded transport, or a stand-in with its shape. */
export type ProbeTransport = (input: GuardedFetchInput) => Promise<ProbeResponse | null | undefined>;

interface SendInput {
  readonly url: string;
  readonly anonKey: string;
  readonly transport: ProbeTransport | undefined;
  readonly maxResponseBytes: number;
}

async function send({ url, anonKey, transport, maxResponseBytes }: SendInput): Promise<ProbeResponse | null | undefined> {
  const request: ProbeTransport = typeof transport === 'function' ? transport : guardedFetch;
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

/* What was tested and how many rows the anonymous role could see; nothing from inside them. */
export interface ReadabilityObservation {
  readonly state: ProbeState;
  readonly reason: ProbeReason;
  readonly projectRef: string | null;
  readonly relation: string | null;
  readonly projection: readonly string[];
  readonly rowCount: number;
  readonly testedRole: 'publishable' | 'anon' | null;
  readonly observedAt: string;
}

interface ObservationInput {
  readonly now: number;
  readonly state: ProbeState;
  readonly reason: ProbeReason;
  readonly projectRef: string;
  readonly relation: string;
  readonly projection: readonly string[];
  readonly rowCount?: number;
  readonly testedRole?: 'publishable' | 'anon';
}

function observation(input: ObservationInput): ReadabilityObservation {
  return Object.freeze({
    state: input.state,
    reason: input.reason,
    projectRef: input.projectRef || null,
    relation: input.relation || null,
    projection: Object.freeze(Array.isArray(input.projection) ? [...input.projection] : []),
    rowCount: typeof input.rowCount === 'number' && Number.isInteger(input.rowCount) ? input.rowCount : 0,
    testedRole: input.testedRole || null,
    observedAt: new Date(input.now).toISOString()
  });
}

/*
 * The probe. Returns a sanitized observation: what was tested, how many rows
 * the anonymous role could see, and nothing from inside them.
 */
export interface ProbeInput {
  readonly now?: unknown;
  readonly candidate?: unknown;
  readonly projectRef?: unknown;
  readonly relation?: unknown;
  readonly projection?: unknown;
  readonly anonKey?: unknown;
  readonly authorization?: unknown;
  readonly authorizationKey?: unknown;
  readonly actorLogin?: unknown;
  readonly transport?: ProbeTransport | undefined;
}

export async function probeAnonymousReadability(input: ProbeInput = {}): Promise<ReadabilityObservation> {
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  const candidate = fieldsOf(input.candidate);
  const projectRef = text(input.projectRef);
  const relation = text(input.relation);
  const projection = listOf(input.projection).map(column => text(column));
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

  const authorizationKey = input.authorizationKey;
  if (!Buffer.isBuffer(authorizationKey) && typeof authorizationKey !== 'string') {
    throw new TypeError('A readability probe requires a derived authorization key');
  }
  const refusal = authorizationRefusal({
    authorization: input.authorization,
    hmacKey: authorizationKey,
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

  let response: ProbeResponse | null | undefined;
  try {
    response = await send({ url, anonKey: text(input.anonKey), transport: input.transport, maxResponseBytes: MAX_RESPONSE_BYTES });
  } catch {
    /* No message crosses this boundary: a transport error can quote the
       request, and the request carries the key. */
    return observation({ ...base, state: PROBE_STATES.UNVERIFIABLE, reason: REASONS.TRANSPORT_REFUSED });
  }

  const statusCode = Number(response && response.statusCode) || 0;
  const testedRole: 'publishable' | 'anon' = key.kind === KEY_KINDS.PUBLISHABLE ? 'publishable' : 'anon';
  const tested = { ...base, testedRole };

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

  const answered = response && response.body;
  const body = typeof answered === 'string' ? answered : '';
  let rows: unknown;
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
/* The relations a service names, and how much of its description was read. */
export interface ServiceDescription {
  readonly coverage: 'complete' | 'partial' | 'refused';
  readonly reason: ProbeReason | null;
  readonly relations: readonly string[];
  readonly observedAt: string;
}

export async function describeService(input: Omit<ProbeInput, 'relation' | 'projection'> = {}): Promise<ServiceDescription> {
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now();
  const candidate = fieldsOf(input.candidate);
  const projectRef = text(input.projectRef);
  const empty = { relations: Object.freeze<string[]>([]), observedAt: new Date(now).toISOString() };

  if (!PROJECT_REF_PATTERN.test(projectRef)) {
    return Object.freeze({ ...empty, coverage: 'refused', reason: REASONS.PROJECT_REFUSED });
  }
  const key = classifyKey(input.anonKey);
  if (!key.usable) {
    return Object.freeze({ ...empty, coverage: 'refused', reason: REASONS.KEY_NOT_ANONYMOUS });
  }
  const authorizationKey = input.authorizationKey;
  if (!Buffer.isBuffer(authorizationKey) && typeof authorizationKey !== 'string') {
    throw new TypeError('A service description requires a derived authorization key');
  }
  const refusal = authorizationRefusal({
    authorization: input.authorization,
    hmacKey: authorizationKey,
    operation: OPERATIONS.DESCRIBE,
    projectRef, relation: '', projection: [], candidate,
    actorLogin: input.actorLogin,
    now
  });
  if (refusal) return Object.freeze({ ...empty, coverage: 'refused', reason: refusal });

  let response: ProbeResponse | null | undefined;
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
  const answered = response && response.body;
  let document: unknown;
  try {
    document = JSON.parse(typeof answered === 'string' ? answered : '');
  } catch {
    return Object.freeze({ ...empty, coverage: 'partial', reason: REASONS.PROVIDER_UNEXPECTED_RESPONSE });
  }
  const found = document && read(document, 'paths');
  const paths = found && typeof found === 'object' ? found : null;
  if (!paths) return Object.freeze({ ...empty, coverage: 'partial', reason: REASONS.PROVIDER_UNEXPECTED_RESPONSE });

  const relations: string[] = [];
  for (const key of Object.keys(paths)) {
    const name = key.replace(/^\//, '');
    /* The root is the description itself, and an `rpc/` path is a function:
       calling one is executing somebody's code, which is not a read. */
    if (!name || name.startsWith('rpc/')) continue;
    if (!RELATION_PATTERN.test(name)) continue;
    if (relations.length >= MAX_DESCRIBED_RELATIONS) break;
    relations.push(name);
  }
  return Object.freeze<ServiceDescription>({
    coverage: 'complete',
    reason: null,
    relations: Object.freeze(relations.sort()),
    observedAt: new Date(now).toISOString()
  });
}

export const DEFAULT_TRANSPORT = guardedFetch;
