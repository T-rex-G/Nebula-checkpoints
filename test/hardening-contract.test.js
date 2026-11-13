'use strict';
/*
 * The hardening contract, now the page's half alone. The server's half --
 * once read from its source -- is asked of the code that does it:
 *   - webhook risk scored against the identity's protected paths, matched in
 *     any case, and a failed read of them the caller's failure
 *     (test/pulsar-webhook-intake.test.js, test/corona-safety-state.test.js);
 *   - a delivery retried after its evidence was missed is streamed, and
 *     evidence appended once whatever the retries
 *     (test/pulsar-webhook-intake.test.js, test/corona-evidence-chain.test.js);
 *   - a provider session kept in the database fails closed: never written to
 *     the cookie while the store is down, a carried session refused, a
 *     sign-out during an outage not pretended (test/provider-sessions.test.js);
 *     a refusal answered with its own status (test/request-guards.test.js); and
 *     every account route that writes or ends the session answers the store's
 *     refusal (test/identity-account-routes.test.js);
 *   - snapshots: refs read as the provider's reference shapes, an unavailable
 *     tag inventory disclosed, the evidence export with its records, a path
 *     restore checked at every path it writes (test/corona-routes.test.js);
 *     only the product's own snapshot kinds recovered, a preview that grants
 *     nothing while read-only mode or a protected path is on, a grant spent
 *     once and awaited, and a stale preview refused (test/corona-recovery.test.js);
 *     snapshots kept to the deployment's count, and stored events paged without
 *     repeat or gap (test/composition-postgres.test.js);
 *   - a folder move checked at both ends (test/workbench-collaboration-routes.test.js);
 *     the vendor fallback allowlisted and bounded (test/platform-routes.test.js);
 *     the scanner status served (test/identity-security-routes.test.js);
 *   - and no control byte in the server's code: the release scan refuses one
 *     (test/secret-scanner.test.js).
 * What is left reads the page's source, which Phase E dissolves, and the
 * migrations' schema.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const schema = fs.readdirSync(path.join(root, 'db', 'migrations')).filter(name => name.endsWith('.sql')).sort().map(name => fs.readFileSync(path.join(root, 'db', 'migrations', name), 'utf8')).join('\n');
assert(schema.includes('identity_keys text[]') && schema.includes('nv_sessions_identity_keys_idx'), 'Session containment must index identity ownership instead of scanning an arbitrary global window');
/* That an identity's sessions are listed to each other, and another person's are not, is test/composition-postgres.test.js's. */

const neural = fs.readFileSync(require('path').join(__dirname, '..', 'apps', 'web', 'src', 'visualizations', 'neural.js'), 'utf8');
const app = fs.readFileSync(require('path').join(__dirname, '..', 'apps', 'web', 'src', 'legacy', 'app.js'), 'utf8');

assert(neural.includes('catchUpIntelligence'), 'Neural SSE reconnect must catch up missed persisted events');
assert(neural.includes('after=${encodeURIComponent(after)}') && neural.includes('hasMore'), 'Neural catch-up must page from a persisted event cursor');
assert(neural.includes('/emergency-manifest'), 'Emergency Shield must use the signed server-side containment transaction');
assert(neural.includes('/access-surface'), 'Neural Shadow Access Radar data source is missing');
assert(neural.includes('/api/security/scanner-status'), 'Neural dependency/security view must read the upload scanner posture');
/* What the map makes of the readings is its graph model's: asked, not read. */
const neuralGraph = require('../apps/web/src/features/neural/graph-model.ts');
const graphOf = data => neuralGraph.buildGraph(data, { work: { owner: 'o', repo: 'r', branch: 'main' }, me: null, now: 0, ruleLabel: String, dispositionWords: {} });
assert(/^Upload malware gate/.test(graphOf({ scanner: { builtin: { available: true } } }).nodes.find(n => n.id === 'scan:upload-gate').label), 'Neural dependency/security view must expose upload scanner posture');
assert(app.includes('function activityCsv'), 'Activity export must support CSV');
assert(app.includes("snap.kind !== 'nebulaverse-snapshot' && snap.kind !== 'nebulaverse-emergency-manifest'"), 'Recovery must accept signed emergency manifests as snapshot inputs');
assert(app.includes('/snapshot-compare') && app.includes('/restore-preview'), 'Recovery workflow must compare snapshots and preview ref changes');
assert(app.includes("authorization: preview.authorization") && app.includes("confirm: 'RESTORE'"), 'Client restore must submit only the preview authorization and typed confirmation');
assert(graphOf({ deps: { scanned: 9, vulnerable: [], osv: { available: false } } }).nodes.some(n => n.id === 'scan:unavailable')
  && !graphOf({ deps: { scanned: 9, vulnerable: [], osv: { available: false } } }).nodes.some(n => n.id === 'scan:clean'), 'Neural graph must distinguish an unavailable vulnerability scan from a clean result');
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
