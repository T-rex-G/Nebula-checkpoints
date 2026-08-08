#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { AlphaPrivacyStore } = require('../src/alpha-privacy-store');
const { alphaRetentionPolicy } = require('../src/alpha-privacy');

const CLEANUP_ID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMANDS = new Set(['retention', 'cleanup-status', 'retry-cleanup', 'cohort-close']);

function cliError(message, code = 'ALPHA_PRIVACY_CLI_INVALID') {
  return Object.assign(new Error(message), { code });
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? [...argv] : [];
  const command = String(args.shift() || '');
  if (!COMMANDS.has(command)) {
    throw cliError('Command must be retention, cleanup-status, retry-cleanup or cohort-close');
  }
  const parsed = { command };
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (!flag || !flag.startsWith('--') || value === undefined) {
      throw cliError('Command arguments are unsupported or incomplete');
    }
    const key = flag.slice(2);
    if (Object.hasOwn(parsed, key)) throw cliError(`Duplicate ${flag} argument`);
    parsed[key] = value;
  }
  const expected = command === 'retry-cleanup'
    ? new Set(['command', 'cleanup'])
    : command === 'cohort-close'
      ? new Set(['command', 'confirm'])
      : new Set(['command']);
  if (Object.keys(parsed).some(key => !expected.has(key))) {
    throw cliError('Command contains an unsupported argument');
  }
  if (command === 'retry-cleanup' && !CLEANUP_ID_RX.test(String(parsed.cleanup || ''))) {
    throw cliError('retry-cleanup requires --cleanup UUID');
  }
  if (command === 'cohort-close' && parsed.confirm !== 'CLOSE-ALPHA') {
    throw cliError('cohort-close requires --confirm CLOSE-ALPHA');
  }
  return parsed;
}

function hashTaskReference(cleanupId) {
  if (!CLEANUP_ID_RX.test(String(cleanupId || ''))) throw cliError('cleanup task id is invalid');
  return crypto.createHash('sha256')
    .update(`nv-alpha-cleanup-reference-v1\0${String(cleanupId).toLowerCase()}`, 'utf8')
    .digest('hex');
}

function safeCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function safeIso(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function safeCounts(value) {
  const input = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(Object.entries(input)
    .filter(([key]) => /^[a-z][A-Za-z0-9]{0,79}$/.test(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => [key, safeCount(count)]));
}

function retentionReport(raw) {
  const result = raw && raw.result || {};
  return {
    status: 'complete',
    policy: alphaRetentionPolicy(),
    counts: safeCounts(Object.fromEntries(Object.entries(result).filter(([, value]) => (
      Number.isSafeInteger(Number(value)) && !String(value).includes('-')
    )))),
    cohortMetadataPreserved: result.cohortMetadataPreserved !== false,
    completedAt: safeIso(result.completedAt)
  };
}

function cleanupStatusReport(raw) {
  const ids = Array.isArray(raw && raw.cleanupIds) ? raw.cleanupIds : [];
  return {
    counts: safeCounts(raw && raw.counts),
    pendingTaskRefs: ids.filter(id => CLEANUP_ID_RX.test(String(id)))
      .map(hashTaskReference).sort()
  };
}

function retryReport(raw, fallbackId) {
  const cleanupId = CLEANUP_ID_RX.test(String(raw && raw.cleanupId || ''))
    ? raw.cleanupId
    : fallbackId;
  return {
    taskRef: hashTaskReference(cleanupId),
    status: raw && raw.status === 'verified' ? 'verified' : 'pending',
    verifiedAt: safeIso(raw && raw.verifiedAt)
  };
}

function cohortReport(raw) {
  const pendingCleanup = safeCount(raw && raw.pendingCleanup);
  const activeSessions = safeCount(raw && raw.activeSessions);
  const complete = pendingCleanup === 0 && activeSessions === 0
    && raw && raw.status === 'complete';
  const report = {
    status: complete ? 'complete' : 'blocked',
    pendingCleanup,
    activeSessions,
    testersRevoked: safeCount(raw && raw.testersRevoked),
    testersPurged: safeCount(raw && raw.testersPurged),
    completedAt: safeIso(raw && raw.completedAt)
  };
  if (complete) {
    report.closedAt = safeIso(raw.closedAt);
    report.purgeAfter = safeIso(raw.purgeAfter);
    if (/^[0-9a-f]{64}$/.test(String(raw.reportDigest || ''))) {
      report.reportDigest = raw.reportDigest;
    }
  }
  return report;
}

async function runCli(argv, operator) {
  const parsed = parseArgs(argv);
  if (!operator || typeof operator !== 'object') throw cliError('operator is required');
  if (parsed.command === 'retention') {
    const raw = await operator.retention();
    return { exitCode: 0, report: retentionReport(raw) };
  }
  if (parsed.command === 'cleanup-status') {
    const raw = await operator.cleanupStatus();
    return { exitCode: 0, report: cleanupStatusReport(raw) };
  }
  if (parsed.command === 'retry-cleanup') {
    const raw = await operator.retryCleanup(parsed.cleanup);
    const report = retryReport(raw, parsed.cleanup);
    return { exitCode: report.status === 'verified' ? 0 : 1, report };
  }
  const raw = await operator.cohortClose();
  const report = cohortReport(raw);
  return { exitCode: report.status === 'complete' ? 0 : 1, report };
}

function credentialForProvider(provider, env) {
  const names = {
    github: 'NV_ALPHA_GITHUB_TOKEN',
    gitlab: 'NV_ALPHA_GITLAB_TOKEN',
    gitea: 'NV_ALPHA_GITEA_TOKEN'
  };
  const name = names[provider];
  const credential = name && String(env[name] || '');
  if (!credential) {
    throw cliError(`retry-cleanup requires ${name || 'a supported provider credential'}`,
      'ALPHA_PROVIDER_CREDENTIAL_REQUIRED');
  }
  return credential;
}

function providerEndpoint(task) {
  const owner = encodeURIComponent(task.owner);
  const repo = encodeURIComponent(task.repo);
  const hook = encodeURIComponent(String(task.provider_hook_id));
  if (task.provider === 'github') {
    return `https://api.github.com/repos/${owner}/${repo}/hooks/${hook}`;
  }
  const authority = String(task.authority || '');
  if (!/^[a-z0-9.-]+(?::[1-9][0-9]{0,4})?$/i.test(authority)) {
    throw cliError('provider authority is invalid', 'ALPHA_PROVIDER_AUTHORITY_INVALID');
  }
  if (task.provider === 'gitlab') {
    return `https://${authority}/api/v4/projects/${encodeURIComponent(`${task.owner}/${task.repo}`)}/hooks/${hook}`;
  }
  if (task.provider === 'gitea') {
    return `https://${authority}/api/v1/repos/${owner}/${repo}/hooks/${hook}`;
  }
  throw cliError('cleanup task provider is unsupported', 'ALPHA_PROVIDER_UNSUPPORTED');
}

async function verifyProviderWebhookAbsent(task, credential, fetchImpl) {
  const url = providerEndpoint(task);
  const headers = task.provider === 'gitlab'
    ? { 'PRIVATE-TOKEN': credential }
    : { Authorization: task.provider === 'gitea' ? `token ${credential}` : `Bearer ${credential}` };
  const removed = await fetchImpl(url, { method: 'DELETE', headers, redirect: 'error' });
  if (removed.status === 404) return true;
  if (!removed.ok) throw cliError('provider webhook deletion failed', 'ALPHA_PROVIDER_DELETE_FAILED');
  const inspected = await fetchImpl(url, { method: 'GET', headers, redirect: 'error' });
  if (inspected.status === 404) return true;
  if (!inspected.ok) throw cliError('provider webhook verification failed', 'ALPHA_PROVIDER_VERIFY_FAILED');
  return false;
}

function reportDigest(value) {
  return crypto.createHash('sha256')
    .update(`nv-alpha-cohort-report-v1\0${JSON.stringify(value)}`, 'utf8')
    .digest('hex');
}

function createPostgresOperator(options = {}) {
  const env = options.env || process.env;
  const databaseUrl = String(env.DATABASE_URL || '');
  if (!databaseUrl) throw cliError('DATABASE_URL is required', 'ALPHA_DATABASE_REQUIRED');
  const { Pool } = require('pg');
  const db = options.pool || new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    enableChannelBinding: true
  });
  const store = options.store || new AlphaPrivacyStore({ pool: db });
  const fetchImpl = options.fetch || globalThis.fetch;

  return {
    async retention() {
      return { result: await store.runRetention() };
    },

    async cleanupStatus() {
      const countsResult = await db.query(
        `SELECT status,count(*)::int AS count
           FROM nv_alpha_cleanup_tasks GROUP BY status ORDER BY status`
      );
      const pendingResult = await db.query(
        `SELECT cleanup_id FROM nv_alpha_cleanup_tasks
          WHERE status<>'verified' ORDER BY cleanup_id LIMIT 1000`
      );
      return {
        counts: Object.fromEntries(countsResult.rows.map(row => [row.status, Number(row.count)])),
        cleanupIds: pendingResult.rows.map(row => row.cleanup_id)
      };
    },

    async retryCleanup(cleanupId) {
      const taskResult = await db.query(
        `SELECT task.cleanup_id,task.tester_id,task.identity_key,task.provider,
                task.resource_type,task.resource_key_hash,task.status,task.verified_at,
                binding.authority,webhook.owner,webhook.repo,webhook.provider_hook_id
           FROM nv_alpha_cleanup_tasks task
           JOIN nv_alpha_provider_bindings binding
             ON binding.tester_id=task.tester_id
            AND binding.identity_key=task.identity_key AND binding.provider=task.provider
           LEFT JOIN nv_webhooks webhook
             ON webhook.identity_key=task.identity_key AND webhook.provider=task.provider
            AND webhook.alpha_resource_key_hash=task.resource_key_hash
          WHERE task.cleanup_id=$1`,
        [cleanupId]
      );
      if (taskResult.rows.length !== 1) {
        throw cliError('cleanup task is unavailable', 'ALPHA_CLEANUP_TASK_UNAVAILABLE');
      }
      const task = taskResult.rows[0];
      if (task.status === 'verified') {
        return { cleanupId, status: 'verified', verifiedAt: task.verified_at };
      }
      if (task.resource_type !== 'provider-webhook') {
        throw cliError('only provider-webhook cleanup can be retried safely from operator credentials',
          'ALPHA_CLEANUP_RETRY_UNSUPPORTED');
      }
      const credential = credentialForProvider(task.provider, env);
      const inspection = await store.inspectProviderWebhookCleanup({
        testerId: task.tester_id,
        identityKey: task.identity_key,
        provider: task.provider,
        cleanupId,
        resourceKeyHash: task.resource_key_hash
      });
      let verifiedAbsent = false;
      if (!inspection.shared) {
        if (!task.owner || !task.repo || task.provider_hook_id == null) {
          throw cliError('provider webhook reference is unavailable', 'ALPHA_PROVIDER_REFERENCE_REQUIRED');
        }
        verifiedAbsent = await verifyProviderWebhookAbsent(task, credential, fetchImpl);
        if (!verifiedAbsent) {
          return { cleanupId, status: 'pending', verifiedAt: null };
        }
      }
      await store.completeProviderWebhookCleanup({
        testerId: task.tester_id,
        identityKey: task.identity_key,
        provider: task.provider,
        cleanupId,
        resourceKeyHash: task.resource_key_hash,
        providerVerifiedAbsent: verifiedAbsent
      });
      return { cleanupId, status: 'verified', verifiedAt: new Date() };
    },

    async cohortClose() {
      const now = new Date();
      const pendingResult = await db.query(
        `SELECT count(*)::int AS count FROM nv_alpha_cleanup_tasks WHERE status<>'verified'`
      );
      const activeResult = await db.query(
        `SELECT
           (SELECT count(*) FROM nv_alpha_sessions WHERE revoked_at IS NULL)
           + (SELECT count(*) FROM nv_alpha_provider_session_ownership WHERE released_at IS NULL)
           AS count`
      );
      const testersResult = await db.query(
        `SELECT tester_id FROM nv_alpha_testers
          WHERE metadata_purged_at IS NULL ORDER BY tester_id`
      );
      const pendingCleanup = safeCount(pendingResult.rows[0] && pendingResult.rows[0].count);
      const activeSessions = safeCount(activeResult.rows[0] && activeResult.rows[0].count);
      if (pendingCleanup || activeSessions) {
        const revoked = await db.query(
          `UPDATE nv_alpha_testers
              SET revoked_at=COALESCE(revoked_at,$1),revocation_reason='COHORT_CLOSED'
            WHERE metadata_purged_at IS NULL`,
          [now]
        );
        await db.query(
          `UPDATE nv_alpha_sessions SET revoked_at=COALESCE(revoked_at,$1)
            WHERE revoked_at IS NULL`,
          [now]
        );
        return {
          status: 'blocked', pendingCleanup, activeSessions,
          testersRevoked: revoked.rowCount, testersPurged: 0, completedAt: now
        };
      }
      let testersPurged = 0;
      for (const row of testersResult.rows) {
        const deletion = await store.createDeletionRequest({ testerId: row.tester_id });
        if (deletion.status !== 'requested' && deletion.status !== 'complete') {
          return {
            status: 'blocked', pendingCleanup: 1, activeSessions: 0,
            testersRevoked: testersPurged, testersPurged, completedAt: new Date()
          };
        }
        const purged = await store.purgeTester({ testerId: row.tester_id });
        if (purged.status !== 'complete') {
          return {
            status: 'blocked', pendingCleanup: 1, activeSessions: 0,
            testersRevoked: testersPurged, testersPurged, completedAt: new Date()
          };
        }
        testersPurged += 1;
      }
      const closed = await store.cohortClose({ closedAt: now });
      const digestInput = {
        testersRevoked: testersResult.rows.length,
        testersPurged,
        closedAt: closed.closedAt,
        purgeAfter: closed.purgeAfter
      };
      return {
        status: 'complete', pendingCleanup: 0, activeSessions: 0,
        ...digestInput, completedAt: new Date(), reportDigest: reportDigest(digestInput)
      };
    },

    async close() {
      if (!options.pool && typeof db.end === 'function') await db.end();
    }
  };
}

async function main() {
  let operator;
  try {
    operator = createPostgresOperator();
    const result = await runCli(process.argv.slice(2), operator);
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      error: 'Alpha privacy command failed',
      code: /^[A-Z][A-Z0-9_]{1,79}$/.test(String(error && error.code || ''))
        ? error.code
        : 'ALPHA_PRIVACY_COMMAND_FAILED'
    })}\n`);
    process.exitCode = 1;
  } finally {
    if (operator && typeof operator.close === 'function') await operator.close().catch(() => {});
  }
}

module.exports = Object.freeze({
  parseArgs,
  hashTaskReference,
  runCli,
  createPostgresOperator,
  verifyProviderWebhookAbsent
});

if (require.main === module) void main();
