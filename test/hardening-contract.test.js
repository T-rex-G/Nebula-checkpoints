'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
for (const sourceFile of ['apps/api/src/modules/kepler/application/governance-api.ts']) {
  const bytes = fs.readFileSync(path.join(root, sourceFile));
  const forbidden = [...bytes].filter(byte => (byte < 32 && ![9, 10, 13].includes(byte)) || byte === 127);
  assert.strictEqual(forbidden.length, 0, `${sourceFile} must not contain literal control bytes`);
}
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
/* Corona's recovery service and routes, which hold the snapshot, restore, access-surface and evidence code (D12f). */
const corona = ['application/recovery.ts', 'application/evidence-chain.ts', 'http/recovery-routes.ts', 'http/safeguard-routes.ts', 'http/access-surface-routes.ts', 'http/evidence-routes.ts']
  .map(file => fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'corona', file), 'utf8')).join('\n');
const schema = fs.readdirSync(path.join(root, 'db', 'migrations')).filter(name => name.endsWith('.sql')).sort().map(name => fs.readFileSync(path.join(root, 'db', 'migrations', name), 'utf8')).join('\n');

assert(server.includes('protectedPatternsForRepository'), 'Webhook risk must use case-insensitive protected-pattern lookup');
assert(corona.includes('referenceSha'), 'Snapshots must accept GitHub and Gitea reference SHA shapes');
assert(server.includes('MAX_LIVE_CLIENTS_PER_KEY'), 'SSE per-repository connection cap is missing');
assert(server.includes('MAX_LIVE_CLIENTS_TOTAL'), 'SSE global connection cap is missing');
assert(server.includes('createLiveHub({ maxTotal: MAX_LIVE_CLIENTS_TOTAL, maxPerKey: MAX_LIVE_CLIENTS_PER_KEY })'), 'SSE admission is not held to both caps');
assert(server.includes('SNAPSHOT_RETENTION_COUNT'), 'Snapshot retention cap is missing');
assert(/DELETE FROM nv_recovery_snapshots[\s\S]+OFFSET \$5/.test(corona), 'Old snapshot pruning query is missing');
/* Webhook creation cleaning up an orphaned provider hook is held by test/pulsar-live-event-routes.test.js. */

/* Where the provider session is kept is identity and access's; the server says whether a database is configured. */
const sessions = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'identity-access', 'application', 'provider-sessions.ts'), 'utf8');
assert(server.includes('databaseConfigured: Boolean(DB_URL), ready: dbReady, pool,'), 'The provider sessions must know a database is configured, not whether it is reachable');
assert(/async function setSession\(req: SessionRequest, res: unknown, input: unknown\b[\s\S]+if \(databaseConfigured\)[\s\S]+Session database is temporarily unavailable/.test(sessions), 'Configured Neon sessions must fail closed instead of downgrading to a long-lived cookie');
assert(sessions.includes('if (databaseConfigured && !s.sid) return null'), 'Database mode must reject legacy full-session cookies');
assert(/async function destroySession[\s\S]+if \(sid && databaseConfigured\)[\s\S]+sign-out was not completed/.test(sessions), 'Configured database logout must not pretend server-side revocation succeeded during an outage');
assert(/if \(s\.sid\)[\s\S]+Session database is temporarily unavailable/.test(sessions) && /catch \(e\) \{\s*res\.status\(e\.status \|\| 500\)/.test(server), 'Authenticated requests must report a configured session-store outage as 503');
/* The account routes are identity and access's. */
const accountRoutes = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'identity-access', 'http', 'account-routes.ts'), 'utf8');
for (const [route, nextRoute] of [
  ["/api/accounts/switch-idx", "/api/accounts/remove"],
  ["/api/accounts/remove", "/api/accounts/switch"],
  ["/api/accounts/switch", "/* Signing out"]
]) {
  const start = accountRoutes.indexOf(`app.post('${route}'`);
  const end = accountRoutes.indexOf(nextRoute, start + 1);
  const block = accountRoutes.slice(start, end);
  assert(start >= 0 && end > start && block.includes('try {') && block.includes('catch (e) { return fail(res, e); }'), `Async account route ${route} must handle database failures`);
}
assert(corona.includes('tagsAvailable') && corona.includes('tagsError'), 'Snapshots must disclose an unavailable tag inventory');
assert(schema.includes('identity_keys text[]') && schema.includes('nv_sessions_identity_keys_idx'), 'Session containment must index identity ownership instead of scanning an arbitrary global window');
assert(/SELECT sid, data, updated FROM nv_sessions WHERE identity_keys @> ARRAY\[\$1\]::text\[\]/.test(server), 'Session inventory must query the active identity directly');
assert(/kind: 'nebulaverse-evidence'[\s\S]+records: evidenceRecords/.test(corona), 'Evidence export must include the bounded chain records it verifies');
assert(/async function appendEvidence[\s\S]+WHERE repo_key=\$1 AND kind=\$2 AND record_id=\$3[\s\S]+deduplicated: true/.test(corona), 'Evidence append must be idempotent across webhook retries');
assert(server.includes('const { appendEvidence, verifyEvidenceChain } = createEvidenceChain({'), 'the server appends evidence through Corona\'s chain');
const webhookStart = server.indexOf('async function receiveGithubWebhook');
const webhookEnd = server.indexOf('const SAFETY_EXEMPT', webhookStart);
const webhookBlock = server.slice(webhookStart, webhookEnd);
assert(webhookBlock.includes("const sf = await pool().query('SELECT state FROM nv_security_state WHERE identity_key=$1', [hook.identity_key]);"), 'Webhook scoring must fail rather than silently discard protected-path policy context');
assert(/await appendEvidence\(scopedEvidenceKey\('github'[\s\S]+storedEventId, enriched\);/.test(server), 'Webhook acceptance must require an evidence append that can complete on retry');
assert(server.includes('evidence.deduplicated') && server.includes('stored.rowCount || !evidence.deduplicated'), 'A retried delivery must broadcast after its missing evidence record is completed');

assert(corona.includes('/access-surface') && corona.includes('riskForAccessSurface'), 'Shadow Access Radar endpoint or deterministic access risk is missing');
assert(corona.includes('/snapshot-compare') && corona.includes('compareSnapshots'), 'Snapshot comparison endpoint is missing');
assert(corona.includes('/restore-preview'), 'Restore preview endpoint is missing');
assert(/const canRestore = [^;]+!deps\.protectedPatternsForReq\(req\)\.length[^;]+!deps\.safetyOf\(req\)\.readOnly/.test(corona), 'Restore preview must fail closed while protected paths or read-only mode are active');
assert(corona.includes('/emergency-manifest'), 'Signed emergency manifest endpoint is missing');
assert(server.includes('scanUploadFile') && server.includes('MALWARE_DETECTED'), 'Upload malware signature gate is not enforced');
assert(fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'identity-access', 'http', 'security-routes.ts'), 'utf8').includes("app.get('/api/security/scanner-status'"), 'Scanner status endpoint is missing');
/*
 * FONT_ASSET_RX bounded the font-file proxy's path. That proxy is gone --
 * typefaces are served from this origin -- so the surviving outbound path is
 * the vendor CDN fallback, which must stay allowlisted and size-bounded.
 */
/* The vendor proxy is the platform's own route (apps/api/src/http/routes/vendor.ts). */
const vendor = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'http', 'routes', 'vendor.ts'), 'utf8');
assert(/await readBoundedResponse\(r, 2 \* MB\)/.test(vendor), 'Outbound vendor responses must be size-bounded');
assert(vendor.includes('!VENDOR_ALLOWLIST.has(p)) return res.status(404).end();'), 'The vendor proxy must serve allowlisted paths only');
assert(!server.includes('FONT_ASSET_RX'), 'The font-file proxy must stay removed');

assert(/restore-paths[\s\S]+deps\.enforceProtectedPaths\(req, matches\.map\(item => member\(item, 'path'\)\)\)/.test(corona), 'Restore-paths must enforce policies against every restored child path');
const folderMove = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'workbench', 'http', 'folder-move-route.ts'), 'utf8');
assert(/move-dir[\s\S]+deps\.enforceProtectedPaths\(req, affectedPaths\)/.test(folderMove), 'Folder moves must enforce policies against source and destination child paths');

const neural = fs.readFileSync(require('path').join(__dirname, '..', 'apps', 'web', 'src', 'visualizations', 'neural.js'), 'utf8');
const app = fs.readFileSync(require('path').join(__dirname, '..', 'apps', 'web', 'src', 'legacy', 'app.js'), 'utf8');
const exportSafety = fs.readFileSync(require('path').join(__dirname, '..', 'apps', 'web', 'src', 'features', 'workbench', 'export-safety.js'), 'utf8');

assert(neural.includes('catchUpIntelligence'), 'Neural SSE reconnect must catch up missed persisted events');
assert(neural.includes('after=${encodeURIComponent(after)}') && neural.includes('hasMore'), 'Neural catch-up must page from a persisted event cursor');
{
  /* The stored-events route is Pulsar's since D12 (its paging is exercised by test/pulsar-live-event-routes.test.js). */
  const liveEvents = fs.readFileSync(path.join(root, 'apps', 'api', 'src', 'modules', 'pulsar', 'http', 'live-event-routes.ts'), 'utf8');
  assert(liveEvents.includes('encodeEventCursor') && liveEvents.includes('decodeEventCursor') && liveEvents.includes('created_at =') && liveEvents.includes('event_id >'), 'Event pagination must use a stable timestamp and event-id cursor');
}
assert(neural.includes('/emergency-manifest'), 'Emergency Shield must use the signed server-side containment transaction');
assert(neural.includes('/access-surface'), 'Neural Shadow Access Radar data source is missing');
assert(neural.includes('/api/security/scanner-status') && neural.includes('Upload malware gate'), 'Neural dependency/security view must expose upload scanner posture');
assert(app.includes('function activityCsv'), 'Activity export must support CSV');
assert(exportSafety.includes('intelligenceEvents') && exportSafety.includes('verified_event'), 'JSON/CSV activity export must include verified intelligence events when available');
assert(exportSafety.includes('/^\\s*[=+\\-@]/') || exportSafety.includes('/^\s*[=+\-@]/'), 'CSV export must neutralize spreadsheet formulas');
assert(app.includes("snap.kind !== 'nebulaverse-snapshot' && snap.kind !== 'nebulaverse-emergency-manifest'"), 'Recovery must accept signed emergency manifests as snapshot inputs');
assert(/SNAPSHOT_KINDS: ReadonlySet<string> = new Set\(\['nebulaverse-snapshot', 'nebulaverse-emergency-manifest'\]\)/.test(corona) && corona.includes('SNAPSHOT_KIND_INVALID'), 'Server-side recovery must explicitly accept only trusted Nebulaverse snapshot kinds');
assert(app.includes('/snapshot-compare') && app.includes('/restore-preview'), 'Recovery workflow must compare snapshots and preview ref changes');
/* The write route claims the authorization rather than checking it and
   recording it later: those two sat either side of an awaited preflight, so
   one process was enough for two requests to spend one authorization. The
   await is part of the contract, not an implementation detail. */
assert(corona.includes('createRestoreAuthorization') && corona.includes('await recovery.claimRestoreAuthorization('), 'Restore preview must issue a short-lived server authorization claimed exactly once by the write route');
assert(corona.includes('RESTORE_PREVIEW_STALE') && corona.includes('preflightRestoreActions'), 'Restore must verify branch heads still match the preview before changing refs');
assert(app.includes("authorization: preview.authorization") && app.includes("confirm: 'RESTORE'"), 'Client restore must submit only the preview authorization and typed confirmation');
assert(neural.includes("osv && data.deps.osv.available === false"), 'Neural graph must distinguish an unavailable vulnerability scan from a clean result');
assert(app.includes('Dependency scan incomplete'), 'Dependency scan dialog must not report a clean result when OSV is unavailable');
assert(app.includes('/api/security/scanner-status') && app.includes('Upload malware gate'), 'Security scan dialog must disclose built-in and optional YARA upload protection');
assert(app.includes("k.startsWith('nv_draft:')") && app.includes("k.startsWith('nv_recent:')"), 'Sign-out/account switching must clear repository drafts and recent-file history');
const purgeStart = app.indexOf('async function purgeLocalData');
const purgeEnd = app.indexOf('async function doLogout', purgeStart);
const purgeBlock = app.slice(purgeStart, purgeEnd);
assert(purgeBlock.includes("tx.objectStore('queue').clear()") && purgeBlock.indexOf("tx.objectStore('queue').clear()") < purgeBlock.indexOf('if (full)'), 'Offline writes must be cleared on every account boundary, not only full logout');
assert(app.includes('function escAttr') && app.includes('function safeHexColor'), 'Provider-controlled avatar URLs and label colors must be constrained before HTML insertion');
assert(app.includes('const entriesOnDisk = dv.getUint16(eocd + 8, true)') && app.includes('entriesOnDisk !== count'), 'ZIP parsing must reject inconsistent multi-disk entry counts');
assert(app.includes('flags & 0x41') && app.includes('localFlags & 0x41'), 'ZIP parsing must reject encrypted and strong-encryption flags');
assert(app.includes('const out = Object.create(null)'), 'ZIP output must not expose Object prototype setter keys');
assert(/visibilitychange[\s\S]+closeLiveStream\(\)/.test(neural), 'Hidden Neural tabs must close their SSE stream');

console.log('hardening contract tests passed');
