'use strict';
/*
 * The Neural map's graph, built from readings the test writes.
 *
 * features/neural/graph-model.ts turns the repository's readings into nodes,
 * the relations between them and the events in their history. What it is
 * asked here is what a reader of the map relies on: that a large repository
 * says how much it holds rather than pretending to show all of it, that a
 * reading which could not be completed is never drawn as a clean one, that
 * a credential's loudness follows what is known about it, and that a reading
 * missing or malformed costs its own nodes and nothing else.
 */
const assert = require('node:assert/strict');
const { buildGraph, TYPE_STYLE, MODE_TYPES, short } = require('../apps/web/src/features/neural/graph-model.ts');

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);
const context = (over = {}) => ({
  work: { owner: 'acme', repo: 'widget', branch: 'dev' },
  me: { login: 'alice', provider: 'github' },
  now: NOW,
  ruleLabel: rule => `Rule ${rule}`,
  dispositionWords: { open: 'Open', resolved: 'Resolved' },
  ...over
});
const build = (data, over) => buildGraph(data, context(over));
const node = (graph, id) => graph.nodes.find(n => n.id === id);
const edge = (graph, source, target) => graph.edges.find(e => e.source === source && e.target === target);
const iso = day => new Date(Date.UTC(2026, 10, day)).toISOString();

const cases = [];
const check = (name, run) => cases.push([name, run]);

/*
 * Four node types are drawn rather than typed, and the builder once copied
 * only the letter: those four reached the canvas with nothing to draw, and
 * `fillText(undefined)` painted the word on the repository itself.
 */
check('every type offers exactly one thing to draw, and every node carries it', () => {
  for (const [type, style] of Object.entries(TYPE_STYLE)) {
    assert.ok(Boolean(style.mark) !== Boolean(style.glyph), `${type} must offer a drawn mark or a letter, and not both`);
  }
  for (const type of ['repo', 'snapshot', 'safety', 'scan']) assert.ok(TYPE_STYLE[type].mark, `${type} keeps its drawn mark`);
  const graph = build({ safety: { readOnly: true } });
  for (const n of graph.nodes) {
    assert.strictEqual(n.mark, TYPE_STYLE[n.type].mark, `${n.id} carries its type's mark`);
    assert.strictEqual(n.glyph, TYPE_STYLE[n.type].glyph, `${n.id} carries its type's letter`);
    assert.ok(n.mark || n.glyph, `${n.id} has something to draw`);
  }
  assert.ok(['repo:current', 'safety:readonly', 'scan:upload-gate', 'snapshot:missing'].every(id => node(graph, id).mark), 'the drawn types arrive drawn');
});

check('the repository and its reader are always there', () => {
  const graph = build(null, { me: null });
  assert.strictEqual(node(graph, 'repo:current').label, 'acme/widget');
  assert.strictEqual(node(graph, 'user:current').label, 'Current user', 'an unknown reader is named as one');
  assert.ok(edge(graph, 'user:current', 'repo:current'));
  assert.strictEqual(node(graph, 'repo:current').meta.provider, 'github');
  assert.strictEqual(build({}, { me: { name: 'Bob', provider: 'gitlab' } }).nodes[1].label, 'Bob');
});

check('the reader\'s sessions: this one, and the others worth a look', () => {
  const graph = build({ sessions: { sessions: [{ current: false, updated: iso(2) }, { current: true }, ...Array.from({ length: 12 }, () => ({}))] } });
  assert.strictEqual(node(graph, 'session:0').label, 'Active session 1');
  assert.strictEqual(node(graph, 'session:0').severity, 'warning');
  assert.strictEqual(node(graph, 'session:1').label, 'Current session');
  assert.strictEqual(node(graph, 'session:1').severity, 'normal');
  assert.strictEqual(edge(graph, 'user:current', 'session:0').type, 'owns session');
  assert.strictEqual(edge(graph, 'session:0', 'repo:current').severity, 'warning');
  assert.strictEqual(graph.totals.session, 14);
});

check('workflow runs, pull requests, issues and releases, and how loud each is', () => {
  const graph = build({
    refs: { refs: [{ name: 'main' }] },
    actions: [
      { id: 1, name: 'CI', status: 'completed', conclusion: 'failure', branch: 'main', created_at: iso(3) },
      { id: 2, status: 'completed', conclusion: 'cancelled', branch: 'gone', number: 12 },
      { id: 3, name: 'Deploy', status: 'queued', branch: 'main' },
      { id: 4, name: 'Lint', status: 'completed', conclusion: 'success' }
    ],
    activity: {
      pulls: [{ number: 5, title: 'Open change', state: 'open', updated: iso(4) }, { number: 6, title: 'Merged', state: 'merged' }],
      issues: [{ number: 9, title: 'Broken', state: 'open' }, { number: 10, title: 'Done', state: 'closed' }],
      releases: [{ tag: 'v1', name: '', published: iso(2) }]
    }
  });
  assert.deepStrictEqual(['workflow:1', 'workflow:2', 'workflow:3', 'workflow:4'].map(id => node(graph, id).severity), ['critical', 'critical', 'warning', 'normal']);
  assert.strictEqual(node(graph, 'workflow:2').label, 'Workflow #12');
  assert.strictEqual(edge(graph, 'branch:main', 'workflow:1').type, 'triggered workflow', 'a run hangs from its branch when the graph has it');
  assert.ok(edge(graph, 'repo:current', 'workflow:2'), 'and from the repository when it does not');
  assert.strictEqual(node(graph, 'workflow:3').meta.conclusion, 'running');
  assert.deepStrictEqual(['pull:5', 'pull:6', 'issue:9', 'issue:10'].map(id => node(graph, id).severity), ['warning', 'normal', 'warning', 'normal']);
  assert.strictEqual(node(graph, 'pull:5').label, '#5 Open change');
  assert.strictEqual(node(graph, 'release:v1').label, 'v1', 'a release without a name is called by its tag');
  assert.strictEqual(graph.events.find(e => e.nodeId === 'workflow:1').detail, 'failure · event');
});

check('a large inventory keeps its most telling members and says how many there were', () => {
  const refs = Array.from({ length: 80 }, (_, i) => ({ name: `b${String(i).padStart(2, '0')}`, sha: `s${i}`, protected: i === 70 }));
  refs.push({ name: 'dev', sha: 'sd' }, { name: 'main', sha: 'sm' });
  const graph = build({ refs: { refs, defaultBranch: 'main', tags: Array.from({ length: 30 }, (_, i) => ({ name: `v${i}` })) } });
  const branches = graph.nodes.filter(n => n.type === 'branch');
  assert.strictEqual(branches.length, 60);
  assert.deepStrictEqual(branches.slice(0, 3).map(n => n.label), ['main', 'dev', 'b70'], 'the default, the working and the protected branches come first');
  assert.strictEqual(graph.totals.branch, 82, 'the panel can say "60 of 82"');
  assert.strictEqual(graph.totals.tag, 30);
  assert.strictEqual(graph.nodes.filter(n => n.type === 'tag').length, 24);
  assert.strictEqual(node(graph, 'branch:main').severity, 'warning', 'an unprotected default branch is worth a look');
  assert.strictEqual(node(graph, 'branch:b70').severity, 'normal');
  assert.strictEqual(edge(graph, 'repo:current', 'branch:b70').type, 'protected ref');
  assert.strictEqual(build({ refs: { refs: refs.slice(0, 5) } }).totals.branch, undefined, 'a list within its limit has no total');
  /* Sixty-one branches, sixty drawn -- and two more the verified events name: the graph holds more than the total, which is then no total. */
  const outgrown = build({ refs: { refs: refs.slice(0, 61) }, intelligence: { events: [
    { eventType: 'create', targetType: 'branch', targetId: 'new-one', createdAt: iso(5) },
    { eventType: 'create', targetType: 'branch', targetId: 'new-two', createdAt: iso(6) }
  ] } });
  assert.strictEqual(outgrown.nodes.filter(n => n.type === 'branch').length, 62);
  assert.strictEqual(outgrown.totals.branch, undefined, 'a total no larger than the graph is not said');
});

check('commits: the head of the working branch, suspicious messages, and ancestry only inside the graph', () => {
  const graph = build({
    refs: { refs: [{ name: 'dev', sha: 'aaaa1111' }] },
    activity: { commits: [
      { sha: 'aaaa1111', message: 'force push to fix things', author: 'bob', date: iso(3), parentShas: ['bbbb2222', 'cccc3333'] },
      { sha: 'bbbb2222', message: 'Add feature', date: iso(2) }
    ] }
  });
  assert.strictEqual(edge(graph, 'branch:dev', 'commit:aaaa1111').type, 'head commit');
  assert.strictEqual(node(graph, 'commit:aaaa1111').severity, 'warning');
  assert.strictEqual(node(graph, 'commit:bbbb2222').severity, 'normal');
  assert.strictEqual(edge(graph, 'repo:current', 'commit:bbbb2222').type, 'observed commit');
  assert.ok(edge(graph, 'commit:aaaa1111', 'commit:bbbb2222'), 'a parent in the graph is linked');
  assert.ok(!graph.edges.some(e => e.target === 'commit:cccc3333'), 'a parent outside it is not invented');
  assert.strictEqual(graph.events.find(e => e.nodeId === 'commit:aaaa1111').detail, 'bob · aaaa1111');
});

check('a verified event reaches its target, and a push names the commit it brought', () => {
  const graph = build({ intelligence: { events: [
    { id: 'e1', actor: 'mallory', eventType: 'push', targetType: 'branch', targetId: 'main', afterSha: 'dddd4444', severity: 'critical', summary: 'Force push', score: 90, reasons: [{ message: 'force push' }], metadata: { headMessage: 'wipe' }, createdAt: iso(5) },
    { id: 'e2', actor: 'alice', eventType: 'pull_request', action: 'opened', targetType: 'pull_request', targetId: '7', metadata: { title: 'Change' }, createdAt: iso(6) },
    { id: 'e3', eventType: 'push', targetType: 'branch', targetId: 'dev', afterSha: '0000000000000000000000000000000000000000', createdAt: iso(7) }
  ] } });
  assert.strictEqual(node(graph, 'actor:mallory').severity, 'critical');
  assert.ok(edge(graph, 'actor:mallory', 'commit:dddd4444'), 'the push is the actor\'s');
  assert.strictEqual(edge(graph, 'commit:dddd4444', 'branch:main').type, 'updated ref');
  assert.strictEqual(node(graph, 'commit:dddd4444').meta.riskReasons, 'force push');
  assert.strictEqual(edge(graph, 'user:current', 'pull:7').type, 'pull_request · opened', 'the reader\'s own event is theirs');
  assert.ok(!node(graph, 'commit:0000000000000000000000000000000000000000'), 'a branch deleted by a push brings no commit');
  const verified = graph.events.find(e => e.nodeId === 'commit:dddd4444');
  assert.strictEqual(verified.detail, 'mallory · risk 90 · force push');
  /* The map's severity filters know three severities; one they do not would hide its node whatever they were set to. */
  const unknown = build({ intelligence: { events: [{ actor: 'mallory', eventType: 'issues', targetType: 'issue', targetId: '3', severity: 'high', createdAt: iso(5) }] } });
  assert.strictEqual(node(unknown, 'actor:mallory').severity, 'warning');
  assert.strictEqual(node(unknown, 'issue:3').severity, 'warning');
  assert.ok(unknown.edges.every(e => ['normal', 'warning', 'critical'].includes(e.severity)), 'every relation has a severity the filters know');
});

check('who can reach the repository, and with what', () => {
  const graph = build({ access: { available: true, collaborators: [
    { login: 'alice', permission: 'admin' }, { login: 'eve', permission: 'Write' }, { login: 'sam', permission: 'read' }
  ], deployKeys: [{ id: 1, readOnly: false }, { id: 2, verified: false }, { id: 3 }],
  webhooks: [{ id: 9, host: 'hooks.example.invalid', insecureSsl: true }, { id: 10, active: false }],
  risk: { score: 70, severity: 'critical', reasons: [{ message: 'write key' }] } } });
  assert.strictEqual(node(graph, 'user:current').severity, 'normal', 'the reader keeps the node they already have');
  assert.strictEqual(edge(graph, 'user:current', 'repo:current').type, 'authenticated access');
  assert.strictEqual(edge(graph, 'access:user:eve', 'repo:current').type, 'can modify repository');
  assert.strictEqual(edge(graph, 'access:user:sam', 'repo:current').type, 'can read repository');
  assert.strictEqual(node(graph, 'credential:1').severity, 'critical', 'a deploy key that can write');
  assert.strictEqual(node(graph, 'credential:2').severity, 'warning', 'an unverified one');
  assert.strictEqual(node(graph, 'credential:3').severity, 'normal');
  assert.strictEqual(node(graph, 'integration:9').severity, 'critical', 'a webhook that skips TLS verification');
  assert.strictEqual(node(graph, 'integration:10').severity, 'warning');
  assert.strictEqual(node(graph, 'safety:access-risk').label, 'Access risk 70/100');
  assert.strictEqual(build({ access: { available: true, risk: { score: 0 } } }).nodes.some(n => n.id === 'safety:access-risk'), false, 'no risk, no node');
});

/*
 * A credential's loudness follows what is known about it: confirmed live by
 * its provider, or of a critical kind, it is critical; refused by its
 * provider, it no longer works and is quiet.
 */
check('a leaked credential is as loud as what is known about it, and never shows the secret', () => {
  const graph = build({
    activity: { commits: [{ sha: 'abcdef1234567890', message: 'add config' }] },
    exposure: { findings: [
      { fingerprint: 'f1', rule: 'aws-key', displayPath: 'src/keys.env', occurrences: [{ line: 12 }], introducedCommit: 'abcdef1' },
      { fingerprint: 'f2', rule: 'token', narration: { severity: 'critical', what: 'A deploy token' }, inTree: false, introducedCommit: 'feedface00' },
      { fingerprint: 'f3', rule: 'token', disposition: 'credential-rejected' },
      { fingerprint: 'f4', rule: 'token', decodedFrom: 'base64', disposition: 'resolved' },
      { rule: 'no fingerprint' }
    ], verifications: { f1: { state: 'verified', narration: 'Live key' }, f4: { state: 'rejected' } } }
  });
  assert.strictEqual(node(graph, 'leak:f1').severity, 'critical');
  assert.strictEqual(node(graph, 'leak:f1').label, 'Rule aws-key · keys.env');
  assert.strictEqual(node(graph, 'leak:f1').meta.where, 'src/keys.env:12');
  assert.strictEqual(node(graph, 'leak:f1').meta.providerCheck, 'Live key');
  assert.strictEqual(node(graph, 'leak:f1').meta.status, 'Open');
  assert.ok(edge(graph, 'commit:abcdef1234567890', 'leak:f1'), 'the commit that brought it is linked');
  assert.strictEqual(node(graph, 'leak:f2').severity, 'critical');
  assert.strictEqual(node(graph, 'leak:f2').meta.foundIn, 'History only · feedfac');
  assert.strictEqual(node(graph, 'leak:f3').severity, 'normal');
  assert.strictEqual(node(graph, 'leak:f4').severity, 'normal');
  assert.strictEqual(node(graph, 'leak:f4').meta.encoding, 'Base64-encoded');
  assert.strictEqual(graph.nodes.filter(n => n.type === 'leak').length, 4, 'a finding without a fingerprint is not drawn');
  assert.strictEqual(build({ exposure: { findings: [{ fingerprint: 'f9', disposition: 'constructor' }] } }).nodes.find(n => n.id === 'leak:f9').meta.status, 'constructor',
    'a disposition is looked up among the words for one, not among what every object has');
});

check('protected assets are found under the repository\'s name in any case', () => {
  const graph = build({ safety: { protected: { 'ACME/Widget': ['deploy/prod.yml', '.github/workflows/release.yml'] } } });
  assert.deepStrictEqual(graph.nodes.filter(n => n.type === 'protected').map(n => n.meta.path), ['deploy/prod.yml', '.github/workflows/release.yml']);
});

check('containment is drawn and dated by the clock the map is given', () => {
  const graph = build({ safety: { readOnly: true, freezeSync: true } });
  assert.strictEqual(node(graph, 'safety:readonly').severity, 'critical');
  assert.strictEqual(node(graph, 'safety:freeze').severity, 'warning');
  const times = graph.events.filter(e => e.type === 'safety').map(e => e.time);
  assert.deepStrictEqual(times, [new Date(NOW).toISOString(), new Date(NOW).toISOString()]);
});

/* A scan that could not reach the vulnerability database is never drawn as a clean one. */
check('a dependency scan the database did not answer is incomplete, not clean', () => {
  const incomplete = build({ deps: { scanned: 40, sources: [{ file: 'package-lock.json' }], vulnerable: [], osv: { available: false, error: 'timed out' } } });
  assert.strictEqual(node(incomplete, 'scan:unavailable').label, 'Dependency scan incomplete');
  assert.strictEqual(node(incomplete, 'scan:unavailable').meta.error, 'timed out');
  assert.ok(!node(incomplete, 'scan:clean'));
  const clean = build({ deps: { scanned: 40, vulnerable: [], osv: { available: true } } });
  assert.strictEqual(node(clean, 'scan:clean').label, '40 packages checked');
  assert.ok(!node(clean, 'scan:unavailable'));
  assert.ok(!build({ deps: { scanned: 0, osv: { available: false } } }).nodes.some(n => n.id.startsWith('scan:') && n.id !== 'scan:upload-gate'), 'nothing scanned, nothing said');
});

check('vulnerabilities: each advisory once, the critical ones critical, and the count of all of them', () => {
  const vulnerable = Array.from({ length: 42 }, (_, i) => ({ ecosystem: 'npm', name: `p${i}`, version: '1.0.0', ids: [`GHSA-${i}`, `GHSA-${i}-b`] }));
  const graph = build({ deps: { scanned: 400, vulnerable, details: { 'GHSA-0': { severity: 'CRITICAL', summary: 'Prototype pollution' }, 'GHSA-1': { severity: '9.8' } }, dependabot: { alerts: [{ package: 'q', severity: 'high' }, { severity: 'low' }] } } });
  assert.strictEqual(node(graph, 'repo:current').severity, 'warning');
  assert.strictEqual(graph.nodes.filter(n => n.type === 'package').length, 40);
  assert.strictEqual(node(graph, 'vulnerability:GHSA-0').severity, 'critical');
  assert.strictEqual(node(graph, 'vulnerability:GHSA-1').severity, 'critical');
  assert.strictEqual(node(graph, 'vulnerability:GHSA-2').severity, 'warning');
  assert.strictEqual(node(graph, 'vulnerability:dependabot:0').severity, 'critical');
  assert.strictEqual(node(graph, 'vulnerability:dependabot:1').label, 'package alert');
  assert.strictEqual(graph.totals.vulnerability, 86, 'every advisory the scan found, and every alert');
  assert.strictEqual(graph.totals.package, 42);
});

check('the upload gate says whether it is whole', () => {
  assert.strictEqual(node(build({ scanner: { builtin: { available: true } } }), 'scan:upload-gate').label, 'Upload malware gate active');
  assert.strictEqual(node(build({ scanner: { builtin: { available: true }, yara: { required: true, configured: false } } }), 'scan:upload-gate').label, 'Upload malware gate incomplete');
  assert.strictEqual(node(build({}), 'scan:upload-gate').severity, 'warning', 'a scanner nobody reported on is not taken as whole');
});

check('recovery: signed, unverified, kept by this browser, or missing', () => {
  const signed = build({ signedSnapshots: { snapshots: [{ signatureValid: true, createdAt: iso(4), signature: '0123456789abcdef0123', snapshot: { refs: [{}, {}], tags: [{}], manifest: { files: [{}, {}, {}] } } }] } });
  assert.strictEqual(node(signed, 'snapshot:stored').label, 'Signed recovery evidence');
  assert.deepStrictEqual([node(signed, 'snapshot:stored').meta.refs, node(signed, 'snapshot:stored').meta.files, node(signed, 'snapshot:stored').meta.signature], [2, 3, '0123456789abcdef…']);
  assert.strictEqual(edge(signed, 'snapshot:stored', 'repo:current').type, 'cryptographically protects');
  const unverified = build({ signedSnapshots: { snapshots: [{ signatureValid: false, snapshot: { refs: [] } }] } });
  assert.strictEqual(node(unverified, 'snapshot:stored').severity, 'warning');
  const local = build({ storedSnapshot: { refs: [{}], capturedAt: iso(1) } });
  assert.strictEqual(node(local, 'snapshot:stored').meta.signature, 'local-only');
  assert.strictEqual(node(build({}), 'snapshot:missing').severity, 'warning');
});

check('the history is in time order, and only its last eighty', () => {
  const pulls = Array.from({ length: 10 }, (_, i) => ({ number: i, title: `PR ${i}`, state: 'open', updated: iso(20 - i) }));
  const issues = Array.from({ length: 8 }, (_, i) => ({ number: 50 + i, title: `I ${i}`, state: 'closed', updated: iso(1 + i) }));
  const verified = Array.from({ length: 90 }, (_, i) => ({ id: `v${i}`, eventType: 'issues', targetType: 'issue', targetId: String(i), createdAt: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() }));
  const graph = build({ activity: { pulls, issues, commits: [{ sha: 'x', date: 'not a date' }] }, intelligence: { events: verified } });
  const times = graph.events.map(e => Date.parse(e.time));
  assert.strictEqual(graph.events.length, 80);
  assert.deepStrictEqual(times, [...times].sort((a, b) => a - b));
  assert.ok(!graph.events.some(e => e.nodeId === 'commit:x'), 'a time that is no time makes no event');
  assert.strictEqual(graph.events[graph.events.length - 1].nodeId, 'pull:0', 'the latest is last');
});

check('a reading missing or malformed costs its own nodes and nothing else', () => {
  const weird = { refs: 'nope', activity: { commits: { length: 3 }, pulls: 7 }, deps: { vulnerable: 'x', dependabot: { alerts: 'y' } }, access: { collaborators: 5, webhooks: { 0: 'a' } }, intelligence: { events: 'z' }, exposure: { findings: {} }, sessions: { sessions: true }, signedSnapshots: { snapshots: 'q' } };
  const graph = build(weird);
  assert.deepStrictEqual(graph.nodes.map(n => n.id).sort(), ['repo:current', 'scan:upload-gate', 'snapshot:missing', 'user:current'].sort());
  assert.strictEqual(build(undefined).nodes.length, 4);
});

check('the map\'s modes and a short label', () => {
  assert.ok(MODE_TYPES.dependencies.has('vulnerability') && !MODE_TYPES.dependencies.has('session'));
  assert.ok(Object.values(MODE_TYPES).every(types => types.has('repo')), 'every mode keeps the repository');
  assert.strictEqual(short('abcdefghij', 5), 'abcd…');
  assert.strictEqual(short(undefined), '');
});

let failed = 0;
for (const [name, run] of cases) {
  try { run(); console.log(`ok - ${name}`); } catch (error) { failed += 1; console.error(`not ok - ${name}\n${error.stack}`); }
}
if (failed) { console.error(`${failed} of ${cases.length} graph model checks failed`); process.exit(1); }
console.log(`neural graph model: ${cases.length} checks passed`);
