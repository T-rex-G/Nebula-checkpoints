'use strict';
/*
 * The shared contracts (packages/contracts/src), held three ways.
 *
 *  1. Versions. Every contract declares a `…_CONTRACT_VERSION`, and its shape
 *     -- its types, vocabularies and signatures, without implementation -- is
 *     recorded with that version in test/oracles/contract-shapes.json. A shape
 *     that changes under the same version fails here: bump the version and
 *     re-record (NV_CONTRACT_SHAPES_WRITE=1), which refuses an unbumped change.
 *  2. Behaviour. The guards are ported validators: they refuse through the
 *     caller's own refusal with the original messages, codes and statuses,
 *     freeze what they return, and need no platform.
 *  3. Adoption. A pattern or header name a contract owns may not be written
 *     out again anywhere else, and every export has a consumer. What is still
 *     written out in server.js and the classic page, and what is still waiting
 *     for its consumer, is recorded in test/oracles/contract-adoption.json.
 *     Both lists may only shrink (NV_CONTRACT_ADOPTION_WRITE=1 records a
 *     shrink, never growth); Phase D and Phase E empty them.
 */
const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const rel = file => path.relative(root, file).split(path.sep).join('/');
const CONTRACTS = path.join(root, 'packages', 'contracts', 'src');
const SHAPES = path.join(root, 'test', 'oracles', 'contract-shapes.json');
const ADOPTION = path.join(root, 'test', 'oracles', 'contract-adoption.json');

const contractFiles = fs.readdirSync(CONTRACTS).filter(name => name.endsWith('.ts')).sort();
const load = name => require(path.join(CONTRACTS, name));

function walk(directory, out = []) {
  if (!fs.existsSync(directory)) return out;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (/\.(?:js|ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function parse(file, text = fs.readFileSync(file, 'utf8')) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
}

/* ------------------------------------------------------------- 1. versions */

/* A contract's shape: the file with every function body emptied and every comment gone. */
function shapeOf(file) {
  const source = parse(file);
  const empty = () => ts.factory.createBlock([]);
  const hollow = context => node => {
    const f = ts.factory;
    const visit = child => {
      if (ts.isFunctionDeclaration(child)) {
        return f.updateFunctionDeclaration(child, child.modifiers, child.asteriskToken, child.name, child.typeParameters, child.parameters, child.type, child.body && empty());
      }
      if (ts.isMethodDeclaration(child)) {
        return f.updateMethodDeclaration(child, child.modifiers, child.asteriskToken, child.name, child.questionToken, child.typeParameters, child.parameters, child.type, child.body && empty());
      }
      if (ts.isConstructorDeclaration(child)) return f.updateConstructorDeclaration(child, child.modifiers, child.parameters, child.body && empty());
      if (ts.isFunctionExpression(child)) {
        return f.updateFunctionExpression(child, child.modifiers, child.asteriskToken, child.name, child.typeParameters, child.parameters, child.type, empty());
      }
      if (ts.isArrowFunction(child)) {
        return f.updateArrowFunction(child, child.modifiers, child.typeParameters, child.parameters, child.type, child.equalsGreaterThanToken, empty());
      }
      return ts.visitEachChild(child, visit, context);
    };
    return ts.visitNode(node, visit);
  };
  const [shaped] = ts.transform(source, [hollow]).transformed;
  const text = ts.createPrinter({ removeComments: true }).printFile(shaped);
  return crypto.createHash('sha256').update(text).digest('hex');
}

function versionOf(name) {
  const exported = Object.entries(load(name)).filter(([key]) => key.endsWith('_CONTRACT_VERSION'));
  assert.equal(exported.length, 1, `${name} must declare exactly one …_CONTRACT_VERSION`);
  const [[key, value]] = exported;
  assert(Number.isSafeInteger(value) && value >= 1, `${name} ${key} must be a positive integer`);
  return value;
}

const shapes = Object.fromEntries(contractFiles.map(name => [name, { version: versionOf(name), shape: shapeOf(path.join(CONTRACTS, name)) }]));
const recordedShapes = fs.existsSync(SHAPES) ? JSON.parse(fs.readFileSync(SHAPES, 'utf8')) : {};
if (process.env.NV_CONTRACT_SHAPES_WRITE === '1') {
  for (const [name, now] of Object.entries(shapes)) {
    const before = recordedShapes[name];
    assert(!before || before.shape === now.shape || now.version > before.version,
      `${name} changed shape without a new version: bump its …_CONTRACT_VERSION before recording`);
  }
  fs.writeFileSync(SHAPES, `${JSON.stringify(shapes, null, 2)}\n`);
}
const shapesNow = fs.existsSync(SHAPES) ? JSON.parse(fs.readFileSync(SHAPES, 'utf8')) : {};
assert.deepEqual(Object.keys(shapesNow).sort(), contractFiles, 'every contract has a recorded shape, and no recorded shape is gone');
for (const [name, now] of Object.entries(shapes)) {
  const before = shapesNow[name];
  assert(now.version >= before.version, `${name} went back from version ${before.version} to ${now.version}`);
  if (now.version === before.version) {
    assert.equal(now.shape, before.shape, `${name} changed shape at version ${now.version}: bump its …_CONTRACT_VERSION and re-record`);
  } else {
    assert.fail(`${name} is at version ${now.version}, recorded at ${before.version}: re-record with NV_CONTRACT_SHAPES_WRITE=1`);
  }
}

/* ------------------------------------------------------------ 2. behaviour */

const guards = load('guards.ts');
const ids = load('ids.ts');
const scope = load('scope.ts');
const actor = load('actor.ts');
const capability = load('capability.ts');
const evidence = load('evidence.ts');
const jobs = load('jobs.ts');
const mutation = load('mutation.ts');
const envelope = load('api-envelope.ts');

/* The caller's refusal is the one used: message, code and status pass through untouched. */
const refusals = [];
const capture = (message, code, status) => { refusals.push({ message, code, status }); throw new Error('refused'); };
assert.throws(() => scope.normalizePolicyScope({ provider: 'gitlab', owner: 'a', repo: 'b' }, capture));
assert.deepEqual(refusals.pop(), { message: 'Policy provider is unsupported', code: 'GOVERNANCE_SCOPE_INVALID', status: undefined });
assert.throws(() => scope.normalizePolicyScope({ provider: 'github', owner: '', repo: 'b' }, capture));
assert.deepEqual(refusals.pop(), { message: 'Policy owner is invalid', code: 'GOVERNANCE_INPUT_INVALID', status: undefined });
assert.throws(() => mutation.normalizeMutationMetadata({ token: 'x' }, capture));
assert.deepEqual(refusals.pop(), { message: 'Sensitive or invalid mutation metadata field: token', code: 'MUTATION_SENSITIVE_FIELD', status: 400 });

/* With no refusal given, a ContractError carries the code and the status. */
assert.throws(() => scope.normalizePolicyScope(null), error =>
  error instanceof guards.ContractError && error.name === 'ContractError' && error.code === 'GOVERNANCE_SCOPE_INVALID' && error.status === undefined);
assert.throws(() => mutation.normalizeMutationMetadata({ big: 'x'.repeat(2048), more: Array.from({ length: 100 }, () => 'y'.repeat(200)) }),
  error => error instanceof guards.ContractError && error.code === 'MUTATION_METADATA_TOO_LARGE' && error.status === 413);

/* The scope reads the authority with the platform's own URL parser, typed but not imported. */
assert.deepEqual(scope.normalizePolicyScope({ provider: 'GitHub', owner: 'Acme', repo: 'Demo', baseUrl: 'https://api.github.com' }),
  { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' });
for (const baseUrl of ['http://github.com', 'https://github.com:8443', 'https://user@github.com', 'https://evil.example', 'https://github.com/x', 'not a url']) {
  assert.throws(() => scope.normalizePolicyScope({ provider: 'github', owner: 'a', repo: 'b', baseUrl }), /authority/);
}
for (const repo of ['.', '..', 'a b', 'x/y']) {
  assert.throws(() => scope.normalizePolicyScope({ provider: 'github', owner: 'a', repo }), /scope is invalid/);
}

/* utf8ByteLength counts what Buffer.byteLength counts, lone surrogates included. */
const samples = ['', 'a', 'é', '€', '😀', '\ud800', '\udc00', '\ud800x', 'x\udfff', '😀\ud800', 'ascii and ünïcødé 漢字 🚀'];
const random = crypto.createHash('sha256');
for (let index = 0; index < 400; index += 1) {
  random.update(String(index));
  const bytes = random.copy().digest();
  samples.push(String.fromCharCode(...Array.from(bytes, (byte, at) => (byte << 8 | bytes[(at + 1) % bytes.length]) % 0x10000)));
}
for (const text of samples) assert.equal(guards.utf8ByteLength(text), Buffer.byteLength(text, 'utf8'), JSON.stringify(text));

/* Identifier formats. */
assert(ids.isIdentityKey('a'.repeat(64)) && !ids.isIdentityKey('A'.repeat(64)) && !ids.isIdentityKey('a'.repeat(63)));
assert(ids.isRecordId('00000000-0000-8000-8000-000000000000') && !ids.isMutationId('00000000-0000-8000-8000-000000000000'));
assert(ids.isMutationId(crypto.randomUUID()) && ids.isCorrelationId('nvx-0123456789abcdef') && !ids.isCorrelationId('nvx-0123'));

/* The authorization snapshot: frozen, credential-free, and its scope refused as governance's own. */
const identity = 'b'.repeat(64);
const now = Date.parse('2026-10-18T12:00:00.000Z');
const snapshot = (overrides = {}) => ({
  schemaVersion: 1,
  scope: { provider: 'github', authority: 'github.com', owner: 'Acme', repo: 'Demo', scopeKey: 'github:github.com:acme/demo' },
  executionPrincipal: { kind: 'user', identityKey: identity, login: 'alice', authMethod: 'token' },
  governanceActor: { kind: 'human', identityKey: identity, login: 'alice', verified: true },
  repositoryAccess: { baseRole: 'admin', providerRole: 'admin', level: 50, source: 'github.collaborator.permission', complete: true },
  governanceRoles: actor.rolesForLevel(50),
  installationCapabilities: null,
  evidence: { status: 'resolved', fetchedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString(), reasonCode: null },
  ...overrides
});
const resolved = actor.normalizeAuthorizationSnapshot(snapshot());
assert(Object.isFrozen(resolved) && Object.isFrozen(resolved.evidence) && Object.isFrozen(resolved.governanceRoles));
assert.throws(() => actor.normalizeAuthorizationSnapshot(snapshot({ evidence: { status: 'resolved', accessToken: 'x' } })),
  error => error.code === 'AUTHORIZATION_SENSITIVE_FIELD');
let scopeRefusedBy = null;
assert.throws(() => actor.normalizeAuthorizationSnapshot(snapshot({ scope: { provider: 'gitlab', owner: 'a', repo: 'b' } }), {
  refuse: (message, code) => { throw Object.assign(new Error(message), { code, by: 'resolver' }); },
  normalizeScope: input => scope.normalizePolicyScope(input, (message, code) => { scopeRefusedBy = code; throw new Error(message); })
}));
assert.equal(scopeRefusedBy, 'GOVERNANCE_SCOPE_INVALID', 'a bad scope is refused by the scope guard the caller supplies');

/* An inherited name is not an action, anywhere an action is looked up. */
for (const name of ['constructor', '__proto__', 'tostring', 'hasownproperty', 'valueof']) {
  assert.equal(mutation.MUTATION_ACTIONS[name], undefined, `${name} is not an action`);
  assert.equal(mutation.isMutationAction(name), false);
}
assert.equal(Object.getPrototypeOf(mutation.MUTATION_ACTIONS), null);
assert(Object.isFrozen(mutation.MUTATION_ACTIONS));
const descriptorDependencies = { executionContract: () => ({}), newMutationId: () => crypto.randomUUID() };
for (const action of ['constructor', '__proto__']) {
  assert.throws(() => mutation.normalizeMutationDescriptor({ action }, descriptorDependencies), error => error.code === 'MUTATION_ACTION_UNKNOWN');
}
const { normalizeMutationDescriptor } = require('../apps/api/src/platform/mutation-gateway/mutation-gateway.ts');
assert.throws(() => normalizeMutationDescriptor({ action: 'constructor' }), error => error.name === 'MutationGatewayError' && error.code === 'MUTATION_ACTION_UNKNOWN' && error.status === 400);
const { executionContractForAction } = require('../apps/api/src/platform/mutation-gateway/mutation-coverage.ts');
assert.throws(() => executionContractForAction('constructor'), error => error.code === 'MUTATION_EXECUTION_UNKNOWN');
const exceptions = require('../apps/api/src/modules/kepler/index.ts');
const exceptionRequest = Object.values(exceptions).find(value => typeof value === 'function' && value.name === 'normalizeExceptionRequest');
assert(exceptionRequest, 'governance-exceptions exports normalizeExceptionRequest');
for (const action of ['constructor', '__proto__']) {
  assert.throws(() => exceptionRequest({ kind: 'exception', action }, {}), error => error.code === 'GOVERNANCE_EXCEPTION_ACTION_INVALID');
}
const { normalizeSimulationRequest } = require('../apps/api/src/modules/kepler/index.ts');
for (const action of ['constructor', '__proto__']) {
  assert.throws(() => normalizeSimulationRequest({ schemaVersion: 1, scenarios: [{ id: 'one', action }] }),
    error => error.code === 'SIMULATION_ACTION_UNKNOWN');
}

/* A step-up action is required where the catalogue says, and its timestamp must be real. */
assert.throws(() => mutation.normalizeMutationSecurity({}, mutation.MUTATION_ACTIONS['pull.merge']), error => error.code === 'MUTATION_STEP_UP_REQUIRED');
assert.deepEqual(mutation.normalizeMutationSecurity({ stepUpAction: 'pull.merge', assurance: 'credential', authorizedAt: 5 }, mutation.MUTATION_ACTIONS['pull.merge']),
  { stepUpAction: 'pull.merge', assurance: 'credential', authorizedAt: 5 });
assert.deepEqual(mutation.normalizeMutationSecurity(null, mutation.MUTATION_ACTIONS['file.write']), { stepUpAction: null, assurance: null, authorizedAt: null });

/* The capability document refuses through its caller, with the original messages. */
assert.throws(() => capability.validateCapabilityDocument({ schemaVersion: '2' }, message => { throw new TypeError(message); }),
  error => error instanceof TypeError && error.message === 'capability schemaVersion must be 1.0.0');

/* Completeness: one scale, every declared word on it, and a combination that never invents a reading. */
const { COMPLETENESS, COMPLETENESS_OF, combineCompleteness, completenessOf } = evidence;
for (const vocabulary of Object.values(COMPLETENESS_OF)) for (const word of Object.values(vocabulary)) assert(COMPLETENESS.includes(word));
assert.deepEqual(Object.keys(COMPLETENESS_OF.exposureCoverage).sort(), [...evidence.EXPOSURE_COVERAGE].sort());
assert.deepEqual(Object.keys(COMPLETENESS_OF.probeCoverage).sort(), [...evidence.PROBE_COVERAGE].sort());
assert.deepEqual(Object.keys(COMPLETENESS_OF.auditWatch).sort(), [...evidence.AUDIT_WATCH_STATES].sort());
assert.deepEqual(Object.keys(COMPLETENESS_OF.source).sort(), [...evidence.SOURCE_STATES].sort());
assert.deepEqual(Object.keys(COMPLETENESS_OF.authorizationEvidence).sort(), [...actor.AUTHORIZATION_EVIDENCE_STATUSES].sort());
for (const [parts, expected] of [
  [[], 'unknown'], [['complete'], 'complete'], [['complete', 'complete'], 'complete'],
  [['complete', 'unavailable'], 'partial'], [['partial'], 'partial'], [['unknown', 'partial'], 'partial'],
  [['unknown'], 'unknown'], [['unknown', 'unavailable'], 'unknown'], [['unavailable', 'unavailable'], 'unavailable']
]) assert.equal(combineCompleteness(parts), expected, JSON.stringify(parts));
for (const word of [undefined, null, '', 'constructor', '__proto__', 'measured ']) assert.equal(completenessOf(COMPLETENESS_OF.source, word), 'unknown');

/* The job vocabularies are the ones the server's jobs and scans use. */
const { createAuditJobs } = require('../src/code-audit-jobs');
for (const kind of jobs.JOB_KINDS) {
  const queue = createAuditJobs({ kind });
  const gone = queue.request({ identity: 'i', owner: 'o', repo: 'r', ref: 'main', run: 'missing', launch: () => null });
  assert.equal(gone.error.code, jobs.JOB_ERROR_CODES[kind].RUN_GONE);
  queue.close();
}
const exposureStore = require('../apps/api/src/modules/quasar/index.ts');
assert.deepEqual([...exposureStore.SCAN_STATES], [...jobs.SCAN_STATES]);
assert.deepEqual([...exposureStore.TERMINAL_STATES], [...jobs.TERMINAL_SCAN_STATES]);
assert.deepEqual([...exposureStore.COVERAGE], [...evidence.EXPOSURE_COVERAGE]);

/* The public error body, unchanged: a secret-shaped message is replaced, an unknown code becomes the generic one. */
const mint = () => 'nvx-00000000000000aa';
assert.deepEqual(envelope.publicErrorBody({ message: 'token=abc', code: 'X_FAILED' }, {}, mint), {
  error: 'Operation could not be completed', code: 'X_FAILED', correlationId: 'nvx-00000000000000aa', providerChanged: 'unknown',
  safeState: 'The final provider state is not yet confirmed.', nextAction: 'Retry once. If the problem remains, copy the support correlation ID.'
});
assert.equal(envelope.publicErrorBody({ message: 'Plain', code: 'lowercase' }, { correlationId: 'nvx-0123456789abcdef' }, mint).code, 'OPERATION_FAILED');
assert.equal(envelope.publicErrorBody({ providerChanged: false }, { correlationId: 'nvx-0123456789abcdef' }, mint).correlationId, 'nvx-0123456789abcdef');
assert.equal(require('../apps/api/src/http/errors.ts').publicErrorBody({}, {}).correlationId.length, 20);

/* ------------------------------------------------------------- 3. adoption */

/* The patterns and header names a contract owns, as the literal text a copy would carry. */
const ownedPatterns = new Map(Object.entries(ids.ID_FORMATS).map(([name, pattern]) => [`/${pattern.source}/${pattern.flags}`, name]));
const ownedHeaders = new Set([envelope.APP_HEADER, envelope.CSRF_HEADER, envelope.STEP_UP_HEADER, envelope.CORRELATION_HEADER,
  load('offline-cache-policy.ts').OFFLINE_SCOPE_HEADER, load('offline-cache-policy.ts').OFFLINE_REPO_HEADER]);
const consumers = [path.join(root, 'server.js'), ...walk(path.join(root, 'src')), ...walk(path.join(root, 'apps'))];
const copies = {};
for (const file of consumers) {
  let count = 0;
  const visit = node => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral && ownedPatterns.has(node.getText())) count += 1;
    if (ts.isStringLiteral(node) && ownedHeaders.has(node.text.toLowerCase())) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(parse(file));
  if (count) copies[rel(file)] = count;
}

/*
 * Every value a contract exports, and whether anything outside its own file
 * uses it: the product, another contract, or a test of the product. These two
 * contract tests prove the contracts; they are not a reason for an export.
 */
const SELF = new Set([__filename, path.join(root, 'test', 'codes.test.js')]);
const tests = walk(path.join(root, 'test')).filter(file => !SELF.has(file));
const outside = [...consumers, ...walk(CONTRACTS), ...tests].map(file => [file, fs.readFileSync(file, 'utf8')]);
const unconsumed = [];
for (const name of contractFiles) {
  const own = path.join(CONTRACTS, name);
  for (const key of Object.keys(load(name)).filter(key => !key.endsWith('_CONTRACT_VERSION'))) {
    const word = new RegExp(`\\b${key.replace(/\$/g, '\\$')}\\b`);
    if (!outside.some(([file, text]) => file !== own && word.test(text))) unconsumed.push(`${name} ${key}`);
  }
}
unconsumed.sort();

const firstRecord = !fs.existsSync(ADOPTION);
const recorded = firstRecord ? { copies: {}, unconsumed: [] } : JSON.parse(fs.readFileSync(ADOPTION, 'utf8'));
const grew = firstRecord ? [] : [
  ...Object.entries(copies).filter(([file, count]) => count > (recorded.copies[file] || 0)).map(([file, count]) => `${file}: ${count} copies, recorded ${recorded.copies[file] || 0}`),
  ...unconsumed.filter(entry => !recorded.unconsumed.includes(entry)).map(entry => `${entry} has no consumer`)
];
assert.deepEqual(grew, [], 'write the contract\'s name instead of a copy, and give every export a consumer');
if (process.env.NV_CONTRACT_ADOPTION_WRITE === '1') {
  fs.writeFileSync(ADOPTION, `${JSON.stringify({ copies, unconsumed }, null, 2)}\n`);
} else {
  assert.deepEqual({ copies, unconsumed }, { copies: recorded.copies, unconsumed: recorded.unconsumed },
    'the adoption record is out of date: a copy or a waiting export is gone, so record the shrink with NV_CONTRACT_ADOPTION_WRITE=1');
}

console.log(`contracts tests passed (${contractFiles.length} contracts, ${Object.values(copies).reduce((sum, count) => sum + count, 0)} copies and ${unconsumed.length} waiting exports recorded)`);
