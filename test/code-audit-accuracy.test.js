'use strict';

/* Accuracy regressions use the real scanner/watch/store with synthetic provider responses. */
const assert = require('node:assert/strict');
const audit = require('../src/code-audit');
const { watchComponents, LIMITS: WATCH_LIMITS } = require('../src/code-audit-watch');
const { CodeAuditHistory } = require('../src/code-audit-history');
const { KEV_URL, createIntelCache } = require('../src/exploit-intel');

const base = [{ path: 'README.md', text: '# fixture' }];
function readerFor(files) {
  const entries = files.map((file, index) => ({ path: file.path, size: file.size ?? Buffer.byteLength(file.text), sha: String(index).padStart(40, '0') }));
  const bySha = new Map(entries.map((entry, index) => [entry.sha, files[index]]));
  const byPath = new Map(files.map(file => [file.path, file]));
  return {
    resolveCommit: async ({ ref }) => ({ ref, commitSha: 'a'.repeat(40) }),
    readTree: async () => ({ truncated: false, skipped: [], entries }),
    readBlob: async ({ sha }) => ({ text: bySha.get(sha).text }),
    readBlobTexts: async ({ paths }) => new Map(paths.map(path => [path, { text: byPath.get(path).text }]))
  };
}
const inspect = files => audit.analyse({ files: [...base, ...files] });
const dbRules = result => result.findings.filter(finding => /^SEC-01[456]$/.test(finding.rule));
const sql = (name, text) => ({ path: `supabase/migrations/${name}.sql`, text });
const changes = result => result.findings.filter(finding => finding.rule === 'SEC-005').map(finding => finding.id).sort();

async function main() {
  const create = sql('001', 'CREATE TABLE public.customer (id int);');
  const disable = sql('002', 'ALTER TABLE public.customer DISABLE ROW LEVEL SECURITY;');
  const enable = sql('003', 'ALTER TABLE public.customer ENABLE ROW LEVEL SECURITY;');
  const force = sql('004', 'ALTER TABLE public.customer FORCE ROW LEVEL SECURITY;');
  assert(dbRules(inspect([create, force])).some(finding => finding.rule === 'SEC-015'), 'FORCE alone never enables RLS');
  assert(dbRules(inspect([create, disable, force])).some(finding => finding.rule === 'SEC-014'), 'FORCE never cancels DISABLE');
  assert.equal(dbRules(inspect([create, enable, force])).length, 0);

  const files = [...base, { path: 'package.json', text: '{"name":"fixture"}' }, create, disable];
  const expected = dbRules(inspect([create, disable]));
  const overflow = await audit.auditRepository({ reader: readerFor(files), ref: 'main', scope: {}, queryTransport: async () => ({}), limits: { ...audit.LIMITS, maxFiles: 1, scanBatchBytes: 1, queryBatchBytes: 1, queryConcurrency: 1 } });
  assert.deepEqual(dbRules(overflow), expected, 'RLS state survives separate overflow batches');
  assert.equal(overflow.coverage.complete, true);
  const split = audit.analyse({ files: [...base, create], paths: [...files, enable].map(file => file.path), extra: audit.mergeScans(audit.scanRules([disable]), audit.scanRules([enable, force])) });
  assert.equal(dbRules(split).length, 0, 'a later overflow ENABLE resolves a traced DISABLE');
  const reversed = audit.analyse({ files: [...base, enable], paths: files.map(file => file.path), extra: audit.mergeScans(audit.scanRules([disable]), audit.scanRules([create])) });
  assert.equal(dbRules(reversed).length, 0, 'migration state is ordered by path across the traced/batch boundary');
  const waived = sql('001', '-- nv-audit-ignore SEC-015 -- exposed fixture table\nCREATE TABLE public.fixture (id int);');
  const waiver = audit.analyse({ files: base, paths: [waived.path], extra: audit.scanRules([waived]) });
  assert(waiver.suppressed.some(finding => finding.rule === 'SEC-015'), 'SQL waivers survive rules-only scanning');
  const crossing = JSON.stringify(audit.scanRules([create, disable]));
  assert(!crossing.includes('public.customer') && !crossing.includes('CREATE TABLE'), 'SQL batch state carries no source text or table identifiers');

  const defaultFiles = Array.from({ length: 600 }, (_, index) => ({ path: `packages/p${String(index).padStart(3, '0')}/package.json`, text: '{"name":"fixture"}' }));
  const defaultLimit = await audit.auditRepository({ reader: readerFor([...defaultFiles, sql('last', `${create.text}\n${disable.text}`)]), ref: 'main', scope: {}, queryTransport: async () => ({}) });
  assert.equal(defaultLimit.coverage.read, 601);
  assert.equal(defaultLimit.coverage.rulesOnly, 1);
  assert(dbRules(defaultLimit).some(finding => finding.rule === 'SEC-014'), 'default 600-file boundary retains database analysis');

  const oversized = await audit.auditRepository({ reader: readerFor([...base, { path: 'supabase/migrations/oversize.sql', text: disable.text, size: audit.LIMITS.maxFileBytes + 1 }]), ref: 'main', scope: {} });
  assert.equal(oversized.coverage.complete, false, 'oversized eligible files prevent completion');
  assert.equal(oversized.coverage.eligible, 1, 'oversized eligible files stay in the coverage denominator');
  assert(!/database rules (?:were )?read/.test(oversized.ledger.find(row => row.id === 'access').detail), 'unread SQL is not described as read');

  const auth = text => ({ path: 'src/auth.js', text });
  const before = inspect([auth('const resetToken = Math.random();\nconst inviteToken = crypto.randomUUID();')]);
  const after = inspect([auth('const resetToken = crypto.randomUUID();\nconst inviteToken = Math.random();')]);
  assert.notDeepEqual(changes(before), changes(after), 'replacing the vulnerable operation is a new finding');
  const moved = inspect([auth('// explanation\n\nconst resetToken  =  Math.random(); // comment')]);
  assert.deepEqual(changes(moved), changes(before), 'line movement, whitespace and comments preserve identity');
  const two = inspect([auth('const anotherToken = Math.random();\nconst resetToken = Math.random();')]);
  assert(two.findings.some(finding => finding.id === changes(before)[0]), 'adding a different occurrence does not renumber an existing finding');
  const secretA = inspect([auth('const resetToken = Math.random() + "secret-canary-A";')]);
  const secretB = inspect([auth('const resetToken = Math.random() + "secret-canary-B";')]);
  assert.deepEqual(changes(secretA), changes(secretB), 'literal values are excluded from identity material');
  assert(!JSON.stringify(secretA).includes('secret-canary'), 'no literal or source is returned');

  const components = [{ ecosystem: 'npm', name: 'jquery', version: '3.4.1', direct: true, dev: false, advisoryIds: [], cves: ['CVE-2020-11023'], exploitedCves: [] }];
  const advisories = async input => ({ statusCode: 200, body: JSON.stringify({ results: JSON.parse(input.body).queries.map(() => ({})) }) });
  const down = async () => { throw new Error('synthetic outage'); };
  const kev = async input => input.url === KEV_URL
    ? { statusCode: 200, body: JSON.stringify({ catalogVersion: '2026.09.30', vulnerabilities: [{ cveID: 'CVE-2020-11023', dateAdded: '2026-09-01', dueDate: '2026-10-01' }] }) }
    : { statusCode: 200, body: JSON.stringify({ status: 'OK', data: [] }) };
  const unavailable = await watchComponents({ components, advisoryTransport: advisories, intelTransport: down, intelCache: createIntelCache() });
  assert.equal(unavailable.state, 'partial', 'a KEV outage cannot yield a complete watch');
  assert.deepEqual(unavailable.sources, { advisories: 'ok', exploited: 'unavailable' });
  const bothDown = await watchComponents({ components, advisoryTransport: down, intelTransport: down, intelCache: createIntelCache() });
  assert.equal(bothDown.state, 'unavailable');
  const advisoryDown = await watchComponents({ components, advisoryTransport: down, intelTransport: kev, intelCache: createIntelCache() });
  assert.equal(advisoryDown.state, 'partial', 'KEV may answer while advisories are unavailable');
  const truncated = await watchComponents({ components, advisoryTransport: advisories, intelTransport: kev, intelCache: createIntelCache(), limits: { ...WATCH_LIMITS, maxAlerts: 0 } });
  assert.equal(truncated.state, 'partial', 'truncation is incomplete');
  assert.equal(truncated.truncated, 1);

  const calls = [];
  const client = { query: async (query, params) => { calls.push({ query, params }); return { rowCount: 1, rows: [] }; }, release() {} };
  const history = new CodeAuditHistory({ pool: { query: client.query, connect: async () => client } });
  const save = outcome => history.saveWatch({ scope: { provider: 'github', authority: 'github.com', owner: 'fixture', repo: 'fixture' }, identityKey: 'b'.repeat(64), auditId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', outcome });
  await save(unavailable);
  const removal = calls.find(call => /DELETE FROM nv_code_audit_alerts/.test(call.query));
  assert(removal && removal.query.includes('kind = ANY'), 'source-specific deletion is constrained by alert kind');
  assert.deepEqual(removal.params[3], ['advisory'], 'a KEV outage preserves existing exploitation alerts');
  calls.length = 0;
  await save({ ...truncated, state: 'ok' });
  assert(!calls.some(call => /DELETE FROM nv_code_audit_alerts/.test(call.query)), 'store independently refuses pruning truncated outcomes');
  calls.length = 0;
  await save({ state: 'ok', checked: 1, total: 1, kev: 'unavailable', alerts: [] });
  assert(!calls.some(call => /DELETE FROM nv_code_audit_alerts/.test(call.query)), 'legacy falsely-ok unavailable results cannot erase alerts');
  console.log('code audit accuracy regression tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
