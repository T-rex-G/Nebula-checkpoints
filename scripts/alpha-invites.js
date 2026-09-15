'use strict';

const {
  parseRepositoryScope
} = require('../src/alpha-access');
const {
  normalizeDatabaseUrl,
  loadAlphaAccessConfig
} = require('../src/config');
const { AlphaAccessStore } = require('../src/alpha-access-store');
const { runMigrations } = require('../src/migrations');

const ISSUE_WARNING =
  'This plaintext invitation is shown once. Store and transmit it securely.';
const OPERATIONAL_FAILURE =
  'Alpha invitation operation could not be completed.';
const INVITE_ID_RX = /^[0-9a-z]{20,40}$/;
const TESTER_ID_RX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIST_LIMIT = 100;

function inputError(message) {
  return new TypeError(message);
}

function requireValue(args, index, flag) {
  const value = args[index + 1];
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.startsWith('--')
  ) {
    throw inputError(`${flag} requires a value`);
  }
  return value;
}

function parseIssueArgs(args) {
  let label = null;
  const repos = [];
  const seenRepos = new Set();

  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    if (flag !== '--label' && flag !== '--repo') {
      throw inputError('issue accepts only --label and --repo');
    }
    const value = requireValue(args, index, flag);
    if (flag === '--label') {
      if (label !== null) throw inputError('--label may be provided only once');
      label = value.trim();
      if (label.length > 120) {
        throw inputError('--label must contain 1-120 characters');
      }
      continue;
    }

    if (repos.length >= 20) {
      throw inputError('issue accepts at most 20 --repo values');
    }
    let canonical;
    try {
      canonical = parseRepositoryScope(value).canonical;
    } catch {
      throw inputError('--repo must be a valid repository scope');
    }
    if (seenRepos.has(canonical)) {
      throw inputError('--repo values must be unique');
    }
    seenRepos.add(canonical);
    repos.push(canonical);
  }

  if (label === null) throw inputError('issue requires --label');
  /*
   * --repo is optional now. Issued without one the invitation is unbound and
   * the tester may work against anything their own credentials reach, which
   * is the point: a tester asked to try the product should not first have to
   * be told which repositories they are allowed to try it on.
   */
  return { command: 'issue', label, repos };
}

function parseRevokeArgs(args) {
  let tester = null;
  let reason = null;

  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    if (flag !== '--tester' && flag !== '--reason') {
      throw inputError('revoke accepts only --tester and --reason');
    }
    const value = requireValue(args, index, flag);
    if (flag === '--tester') {
      if (tester !== null) {
        throw inputError('--tester may be provided only once');
      }
      tester = value.trim().toLowerCase();
      if (!TESTER_ID_RX.test(tester)) {
        throw inputError('--tester must be a valid UUID');
      }
      continue;
    }
    if (reason !== null) throw inputError('--reason may be provided only once');
    reason = value.trim();
    if (reason.length > 240) {
      throw inputError('--reason must contain 1-240 characters');
    }
  }

  if (tester === null) throw inputError('revoke requires --tester');
  if (reason === null) throw inputError('revoke requires --reason');
  return { command: 'revoke', tester, reason };
}

/*
 * `revoke` needs a tester, which an unredeemed invitation does not have, so an
 * exposed code needs its own command rather than an extra flag on that one --
 * two mutually exclusive flags on one command is the wrong thing to hand an
 * operator working an incident.
 *
 * It takes the invitation id, never the code. The id is the public half: `list`
 * prints it, and it is legible inside an exposed code, so requiring it keeps
 * the secret out of shell history and process listings at the moment the
 * secret is already known to have leaked.
 *
 * There is no --reason. The invitations table has no column to hold one, and
 * adding it would move the migration head that qualification evidence pins.
 * Accepting a reason and discarding it would be worse than not taking one: the
 * incident record is where it belongs.
 */
function parseRevokeInviteArgs(args) {
  let invite = null;

  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    if (flag !== '--invite') {
      throw inputError('revoke-invite accepts only --invite');
    }
    const value = requireValue(args, index, flag);
    if (invite !== null) {
      throw inputError('--invite may be provided only once');
    }
    invite = value.trim().toLowerCase();
    if (!INVITE_ID_RX.test(invite)) {
      throw inputError('--invite must be an invitation id, not an invitation code');
    }
  }

  if (invite === null) throw inputError('revoke-invite requires --invite');
  return { command: 'revoke-invite', invite };
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) {
    throw inputError('command arguments must be strings');
  }
  const args = [...argv];
  const command = args[0];
  if (command === 'issue') return parseIssueArgs(args);
  if (command === 'revoke') return parseRevokeArgs(args);
  if (command === 'revoke-invite') return parseRevokeInviteArgs(args);
  if (command === 'list' || command === 'purge') {
    if (args.length !== 1) {
      throw inputError(`${command} does not accept flags`);
    }
    return { command };
  }
  throw inputError('command must be issue, list, revoke, revoke-invite, or purge');
}

function publicInviteView(invitation) {
  return {
    inviteId: invitation.inviteId,
    code: invitation.code,
    expiresAt: invitation.expiresAt,
    repositoryScopes: [...invitation.repositoryScopes],
    warning: ISSUE_WARNING
  };
}

function toNullableIso(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError('database returned an invalid invitation timestamp');
  }
  return date.toISOString();
}

function publicListView(row) {
  return {
    inviteId: row.invite_id,
    testerId: row.tester_id || null,
    testerLabel: row.tester_label,
    repositoryScopes: Array.isArray(row.repository_scopes)
      ? [...row.repository_scopes]
      : [],
    termsVersion: row.terms_version,
    createdAt: toNullableIso(row.created_at),
    expiresAt: toNullableIso(row.expires_at),
    redeemedAt: toNullableIso(row.redeemed_at),
    revokedAt: toNullableIso(row.revoked_at),
    testerRevokedAt: toNullableIso(row.tester_revoked_at)
  };
}

async function migrate(pool, migrationRunner) {
  const client = await pool.connect();
  try {
    await migrationRunner(client, { logger: { info() {} } });
  } finally {
    client.release();
  }
}

async function listInvitations(pool) {
  const result = await pool.query(
    `SELECT
       invite.invite_id,
       tester.tester_id,
       invite.tester_label,
       invite.repository_scopes,
       invite.terms_version,
       invite.created_at,
       invite.expires_at,
       invite.redeemed_at,
       invite.revoked_at,
       tester.revoked_at AS tester_revoked_at
     FROM nv_alpha_invites invite
     LEFT JOIN nv_alpha_testers tester
       ON tester.invite_id = invite.invite_id
     ORDER BY invite.created_at DESC, invite.invite_id DESC
     LIMIT $1`,
    [LIST_LIMIT]
  );
  return {
    invitations: (result.rows || []).map(publicListView)
  };
}

async function executeCommand(command, context) {
  const {
    pool,
    config,
    Store
  } = context;
  if (command.command === 'list') return listInvitations(pool);

  const store = new Store({
    pool,
    pepper: config.pepper,
    inviteTtlMs: config.inviteTtlMs,
    sessionTtlMs: config.sessionAbsoluteTtlMs,
    idleTtlMs: config.sessionIdleTtlMs
  });
  if (command.command === 'issue') {
    const invitation = await store.issueInvite({
      testerLabel: command.label,
      repositoryScopes: command.repos,
      termsVersion: config.termsVersion
    });
    return publicInviteView(invitation);
  }
  if (command.command === 'revoke-invite') {
    return store.revokeInvite(command.invite);
  }
  if (command.command === 'revoke') {
    const result = await store.revokeTester(command.tester, command.reason);
    return {
      testerId: command.tester,
      sessionsRevoked: result.sessionsRevoked
    };
  }
  const result = await store.purgeExpired();
  return {
    purged: {
      invites: result.invites,
      sessions: result.sessions,
      locks: result.locks
    }
  };
}

async function main(options = {}) {
  const argv = options.argv === undefined
    ? process.argv.slice(2)
    : options.argv;
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const setExitCode = options.setExitCode
    || (code => { process.exitCode = code; });
  const dependencies = options.dependencies || {};

  let command;
  try {
    command = parseArgs(argv);
  } catch (error) {
    stderr.write(`Input error: ${error.message}\n`);
    setExitCode(2);
    return 2;
  }

  const normalizeUrl =
    dependencies.normalizeDatabaseUrl || normalizeDatabaseUrl;
  const loadConfig =
    dependencies.loadAlphaAccessConfig || loadAlphaAccessConfig;
  const migrationRunner = dependencies.runMigrations || runMigrations;
  const Store = dependencies.AlphaAccessStore || AlphaAccessStore;
  let pool = null;
  let serializedOutput = null;
  let refusedRevocation = '';
  let status = 0;

  try {
    const production = env.NODE_ENV === 'production';
    const databaseUrl = normalizeUrl(env.DATABASE_URL, { production });
    const config = loadConfig(
      { ...env, NV_ALPHA_ACCESS_MODE: 'invite' },
      { production, databaseUrl }
    );
    const Pool = dependencies.Pool || require('pg').Pool;
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool, migrationRunner);
    const output = await executeCommand(command, {
      pool,
      config,
      Store
    });
    serializedOutput = `${JSON.stringify(output)}\n`;
    if (command.command === 'revoke-invite' && output.revoked !== true) {
      refusedRevocation = String(output.state || 'unknown');
    }
  } catch {
    status = 1;
    stderr.write(`${OPERATIONAL_FAILURE}\n`);
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        if (status === 0) {
          status = 1;
          stderr.write(`${OPERATIONAL_FAILURE}\n`);
        }
      }
    }
  }

  if (status === 0) {
    try {
      stdout.write(serializedOutput);
    } catch {
      status = 1;
      stderr.write(`${OPERATIONAL_FAILURE}\n`);
    }
  }
  /*
   * A refusal is not a success. revoke-invite reports the state it found --
   * redeemed, already revoked, unknown, purged -- and every one of those means
   * the exposed code was not revoked by this call. Exiting zero would let a
   * containment block under `set -euo pipefail` continue as though it had been,
   * during the incident where that belief is most costly. The payload is still
   * printed first, so the operator sees which state to act on.
   */
  if (status === 0 && command.command === 'revoke-invite' && refusedRevocation) {
    status = 1;
    stderr.write(`Invitation was not revoked: ${refusedRevocation}\n`);
  }
  if (status !== 0) setExitCode(status);
  return status;
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write(`${OPERATIONAL_FAILURE}\n`);
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  parseArgs,
  publicInviteView,
  main
});
