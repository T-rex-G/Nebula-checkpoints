#!/usr/bin/env node
'use strict';

/*
 * What this deployment is configured for, and what it is missing.
 *
 * The only way to discover what Nebulaverse-X needed was to start it and see
 * which error came first, fix that, and start it again. There are 111
 * environment variables; that loop is a poor way to meet them.
 *
 * Two rules shape this script.
 *
 * It does not re-implement validation. Where the server has a loader --
 * loadGithubAppConfig, loadAlphaAccessConfig, normalizeDatabaseUrl,
 * normalizeGovernanceRuntimeFailureMode -- the doctor calls that same loader
 * and reports what it says. A second implementation would eventually disagree
 * with the first, and the one a person ran would not be the one that decides
 * whether the process boots.
 *
 * It never prints a value. Every answer here is "set" or "not set", with the
 * fallback the code would use. A configuration report that echoes secrets is
 * a secret-disclosure tool, and this one gets run on servers and pasted into
 * issues.
 *
 *   node scripts/doctor.js               runtime configuration for this profile
 *   node scripts/doctor.js --all         including operator, CI and tooling
 *   node scripts/doctor.js --group=ci    one group
 *   node scripts/doctor.js --json        machine-readable
 */

const { ENTRIES, GROUPS } = require('../src/config-registry');
const config = require('../src/config');
const { loadWorkspaceConfig } = require('../src/workspace-identity');

const RUNTIME_GROUPS = Object.freeze([
  'server', 'database', 'oauth', 'github-app',
  'alpha-access', 'workspace', 'limits', 'governance', 'snapshots', 'scanning'
]);

function parseArguments(argv) {
  const options = { all: false, json: false, group: null };
  for (const argument of argv) {
    if (argument === '--all') options.all = true;
    else if (argument === '--json') options.json = true;
    else if (argument.startsWith('--group=')) options.group = argument.slice(8);
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.group && !Object.hasOwn(GROUPS, options.group)) {
    throw new Error(`Unknown group: ${options.group}. Known groups: ${Object.keys(GROUPS).join(', ')}`);
  }
  return options;
}

function isSet(env, name) {
  return String(env[name] ?? '').trim() !== '';
}

/*
 * A few groups are "all or nothing": naming one member commits you to the
 * rest. These are the sets where the server's own loaders enforce it, listed
 * here so the report can say *why* something became required rather than only
 * that it did.
 */
const GROUP_RULES = Object.freeze([
  { group: 'oauth', trigger: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'],
    because: 'GitHub OAuth needs both halves of the credential' },
  { group: 'github-app', trigger: [
      'GITHUB_APP_ID', 'GITHUB_APP_SLUG', 'GITHUB_APP_CLIENT_ID', 'GITHUB_APP_CLIENT_SECRET',
      'GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_BASE64', 'GITHUB_APP_CALLBACK_URL',
      'GITHUB_APP_WEBHOOK_SECRET'],
    because: 'naming any GitHub App value commits the whole App configuration' },
  { group: 'snapshots', trigger: ['NV_SNAPSHOT_SIGNING_KEY_ID', 'NV_SNAPSHOT_SIGNING_SECRET'],
    because: 'a signing secret is unusable without the key id that names it' }
]);

/*
 * Alternatives, where two variables answer the same question and exactly one
 * is needed. Reported as one requirement rather than two, because reporting
 * both as missing is how a reader ends up setting both -- which the GitHub App
 * loader rejects outright.
 */
const ALTERNATIVES = Object.freeze([
  { group: 'github-app', needsActiveGroup: true, exclusive: true,
    of: ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_PRIVATE_KEY_BASE64'],
    label: 'a GitHub App private key' },
  { group: 'github-app', needsActiveGroup: true, exclusive: false,
    of: ['GITHUB_APP_CALLBACK_URL', 'PUBLIC_BASE_URL'],
    label: 'a GitHub App callback, explicitly or derived from the public base URL' },
  { group: 'server', needsActiveGroup: false, exclusive: false,
    of: ['PUBLIC_BASE_URL', 'RENDER_EXTERNAL_URL'],
    label: 'the public origin, which live events require in production' }
]);

/*
 * Only the alternatives that apply. A GitHub App either/or has nothing to say
 * about a deployment with no GitHub App -- reported unconditionally it told a
 * reader to set a callback for an integration they had not configured.
 */
function applicableAlternatives(activeGroups) {
  return ALTERNATIVES.filter(alternative => !alternative.needsActiveGroup || activeGroups.has(alternative.group));
}

function alternativeFor(name, alternatives) {
  return alternatives.find(alternative => alternative.of.includes(name)) || null;
}

function evaluate(env) {
  const production = String(env.NODE_ENV || '').trim() === 'production';
  const profile = String(env.NV_DEPLOYMENT_PROFILE || 'local').trim().toLowerCase();
  const problems = [];
  const notes = [];

  const activeGroups = new Set();
  for (const rule of GROUP_RULES) {
    if (rule.trigger.some(name => isSet(env, name))) activeGroups.add(rule.group);
  }
  if (String(env.NV_ALPHA_ACCESS_MODE || 'off').trim().toLowerCase() === 'invite') {
    activeGroups.add('alpha-access');
  }
  if (isSet(env, 'NV_YARA_RULES_PATH')) activeGroups.add('scanning');

  /*
   * Alternatives are judged as a set, never one variable at a time. Reporting
   * both halves of an either/or as individually missing is how a reader ends
   * up setting both -- and setting both GitHub App private keys is rejected
   * outright by the loader, so the report would have caused the next failure.
   */
  const alternatives = applicableAlternatives(activeGroups);
  const answeredByAlternative = new Set();
  for (const alternative of alternatives) {
    const present = alternative.of.filter(name => isSet(env, name));
    if (present.length) for (const name of alternative.of) answeredByAlternative.add(name);
    if (alternative.exclusive && present.length > 1) {
      problems.push({
        severity: 'error', kind: 'detail', group: alternative.group,
        detail: `${present.join(' and ')} are both set, and only one may be: ${alternative.label}.`
      });
    }
  }

  const rows = [];
  for (const entry of ENTRIES) {
    const set = isSet(env, entry.name);
    let required = false;
    let because = '';
    if (entry.requirement === 'always') { required = true; because = 'always required'; }
    else if (entry.requirement === 'production' && production) { required = true; because = 'NODE_ENV=production'; }
    else if (entry.requirement === 'hosted-alpha' && profile === 'hosted-alpha') {
      required = true; because = 'NV_DEPLOYMENT_PROFILE=hosted-alpha';
    } else if (entry.requirement === 'group' && activeGroups.has(entry.group)) {
      required = true;
      const rule = GROUP_RULES.find(candidate => candidate.group === entry.group);
      because = rule ? rule.because : `the ${entry.group} group is in use`;
    }

    const alternative = alternativeFor(entry.name, alternatives);
    const satisfied = set || answeredByAlternative.has(entry.name);
    rows.push({ ...entry, set, required, because, satisfied, alternative: alternative ? alternative.label : null });
    /* One-of members are reported by their set below, not individually. */
    if (required && !satisfied && !alternative) {
      problems.push({
        severity: 'error', kind: 'requirement', name: entry.name, group: entry.group,
        detail: `${entry.name} is required (${because}).`
      });
    }
  }

  /* Each unanswered either/or, once, naming the choice rather than the halves. */
  for (const alternative of alternatives) {
    if (alternative.of.some(name => isSet(env, name))) continue;
    const requiredHere = alternative.of.some(name => {
      const row = rows.find(candidate => candidate.name === name);
      return row && row.required;
    });
    if (!requiredHere) continue;
    problems.push({
      severity: 'error', kind: 'requirement', group: alternative.group,
      detail: `Set one of ${alternative.of.join(' or ')} — ${alternative.label}.`
    });
  }

  /*
   * The authoritative checks, run rather than reimplemented. Each of these is
   * the same call the server makes at startup, so a pass here means the server
   * will get the same answer.
   */
  const check = (label, group, run) => {
    try { run(); }
    catch (error) { problems.push({ severity: 'error', kind: 'detail', group, detail: `${label}: ${error.message}` }); }
  };
  check('DATABASE_URL', 'database', () => config.normalizeDatabaseUrl(env.DATABASE_URL || '', {
    production, insecure: env.NV_DB_INSECURE === '1'
  }));
  check('Governance failure mode', 'governance', () => config.normalizeGovernanceRuntimeFailureMode(env.NV_GOVERNANCE_RUNTIME_FAILURE_MODE));
  check('GitHub App', 'github-app', () => config.loadGithubAppConfig(env, { production }));
  check('Alpha access', 'alpha-access', () => config.loadAlphaAccessConfig(env, { databaseUrl: env.DATABASE_URL || '' }));
  check('Workspace foundation', 'workspace', () => loadWorkspaceConfig(env, { databaseUrl: env.DATABASE_URL || '' }));

  /*
   * Production rules that live in server.js rather than in a loader. These are
   * mirrored, not shared, which is a seam: server.js remains the authority and
   * test/doctor-startup-agreement.test.js pins the thresholds so the two
   * cannot drift apart silently.
   */
  if (production) {
    const secret = String(env.SESSION_SECRET || '');
    if (!secret || secret === 'dev-secret-change-me') {
      problems.push({ severity: 'error', kind: 'detail', name: 'SESSION_SECRET', detail: 'SESSION_SECRET is still the development default; production refuses to start.' });
    } else if (Buffer.byteLength(secret, 'utf8') < 32) {
      problems.push({ severity: 'error', kind: 'detail', name: 'SESSION_SECRET', detail: 'SESSION_SECRET must contain at least 32 bytes in production.' });
    }
    const audit = String(env.NV_GOVERNANCE_AUDIT_SECRET || '');
    if (audit && Buffer.byteLength(audit, 'utf8') < 32) {
      problems.push({ severity: 'error', kind: 'detail', name: 'NV_GOVERNANCE_AUDIT_SECRET', detail: 'NV_GOVERNANCE_AUDIT_SECRET must contain at least 32 bytes in production.' });
    }
    if (!isSet(env, 'NV_GIT_HOST_ALLOWLIST')) {
      /*
       * A note, not a problem. This is checked when a server URL is connected
       * rather than at startup, and only for self-hosted Git servers -- an
       * empty allowlist is the correct configuration for a deployment that
       * uses the hosted providers. Reported as missing, it sent a reader
       * hunting for a value they did not need, which is how a checker earns
       * being ignored.
       */
      notes.push('NV_GIT_HOST_ALLOWLIST is empty. That is fine for hosted providers; a self-hosted Git server will be refused in production until its host is listed.');
    }
    if (profile === 'hosted-alpha'
      && String(env.NV_DATABASE_MIGRATION_MODE || 'apply').trim().toLowerCase() !== 'verify') {
      problems.push({ severity: 'error', kind: 'detail', name: 'NV_DATABASE_MIGRATION_MODE', detail: 'hosted-alpha in production requires NV_DATABASE_MIGRATION_MODE=verify.' });
    }
  }

  /*
   * A precise problem supersedes the generic one. "SESSION_SECRET is required"
   * beside "SESSION_SECRET is still the development default" is two lines for
   * one fact, and the reader has to work out they are the same fact.
   */
  const detailed = new Set(problems.filter(problem => problem.kind === 'detail')
    .map(problem => problem.name).filter(Boolean));
  const detailedGroups = new Set(problems.filter(problem => problem.kind === 'detail' && problem.group)
    .map(problem => problem.group));
  const reported = problems.filter(problem => problem.kind !== 'requirement'
    || (!detailed.has(problem.name) && !detailedGroups.has(problem.group)));

  return { production, profile, rows, problems: reported, notes };
}

function render(result, options) {
  const scope = options.group ? [options.group]
    : options.all ? Object.keys(GROUPS)
      : RUNTIME_GROUPS;
  const lines = [];
  lines.push('');
  lines.push(`Nebulaverse-X configuration  ·  profile ${result.profile}  ·  ${result.production ? 'production' : 'development'}`);
  if (!options.all && !options.group) {
    lines.push('Runtime configuration only. Use --all for operator, CI and tooling groups.');
  }
  lines.push('');

  for (const group of scope) {
    const rows = result.rows.filter(row => row.group === group);
    if (!rows.length) continue;
    const missing = rows.filter(row => row.required && !row.satisfied).length;
    lines.push(`${GROUPS[group]}  (${rows.filter(row => row.set).length}/${rows.length} set${missing ? `, ${missing} missing` : ''})`);
    for (const row of rows) {
      const mark = row.set ? 'set'
        : row.required && !row.satisfied ? (row.alternative ? 'one of' : 'MISSING')
          : '—';
      const trailer = row.set ? ''
        : row.required && !row.satisfied
          ? (row.alternative ? `  ${row.alternative}` : `  required: ${row.because}`)
          : row.fallback ? `  falls back to ${row.fallback}` : '';
      lines.push(`  ${mark.padEnd(8)} ${row.name.padEnd(44)}${trailer}`);
    }
    lines.push('');
  }

  if (result.notes.length) {
    lines.push('Notes');
    for (const note of result.notes) lines.push(`  · ${note}`);
    lines.push('');
  }
  if (result.problems.length) {
    lines.push(`Problems (${result.problems.length})`);
    for (const problem of result.problems) lines.push(`  · ${problem.detail}`);
    lines.push('');
    lines.push('This deployment will not start correctly until these are resolved.');
  } else {
    lines.push('No problems found for this profile.');
  }
  lines.push('');
  return lines.join('\n');
}

function main(argv, env) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`\nnode scripts/doctor.js [--all] [--group=NAME] [--json]\n\n`
      + `Groups: ${Object.keys(GROUPS).join(', ')}\n\n`);
    return 0;
  }
  const result = evaluate(env);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      profile: result.profile,
      production: result.production,
      problems: result.problems,
      notes: result.notes,
      variables: result.rows.map(row => ({
        name: row.name, group: row.group, requirement: row.requirement,
        set: row.set, required: row.required, satisfied: row.satisfied
      }))
    }, null, 2)}\n`);
  } else {
    process.stdout.write(render(result, options));
  }
  return result.problems.length ? 1 : 0;
}

if (require.main === module) {
  try { process.exit(main(process.argv.slice(2), process.env)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exit(2); }
}

module.exports = { evaluate, main, RUNTIME_GROUPS };
