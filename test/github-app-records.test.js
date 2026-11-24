'use strict';
/*
 * A GitHub App installation's record and its audit trail (identity and
 * access's GitHub App records): what an audit detail may keep, the actor the
 * alpha names, the log line and the row, and an installation kept and removed
 * -- against a recording pool.
 */
const assert = require('assert');
const { createGithubAppRecords, safeGithubAppAuditDetails, alphaActorLabel } = require('../apps/api/src/modules/identity-access/index.ts');

const TESTER = '0b5e3c6a-1d2f-4a3b-8c4d-5e6f7a8b9c0d';
const KEY = 'k'.repeat(64);

function harness({ alphaEnabled = false, ready = [true], rows = [], fails = false } = {}) {
  const queries = [];
  const readiness = ready.slice();
  const records = createGithubAppRecords({
    alphaEnabled,
    ready: async () => (readiness.length > 1 ? readiness.shift() : readiness[0]),
    pool: () => ({
      async query(text, values) {
        queries.push([String(text).replace(/\s+/g, ' ').trim(), values]);
        if (fails) throw new Error('database unavailable');
        return { rows: text.includes('nv_alpha_provider_bindings') ? rows.map(tester => ({ tester_id: tester })) : [] };
      }
    })
  });
  return { ...records, queries };
}
async function logged(fn) {
  const lines = [];
  const real = console.log;
  console.log = line => { lines.push(JSON.parse(line)); };
  try { return { result: await fn(), lines }; } finally { console.log = real; }
}

let finished = false;
process.on('exit', code => { if (!finished && code === 0) { console.error('the GitHub App records tests did not finish'); process.exitCode = 1; } });

(async () => {
  /* ---- What an audit detail may keep ------------------------------------------------- */
  {
    assert.deepStrictEqual(safeGithubAppAuditDetails({
      actor: 'alice', accountType: 'Organization', repositorySelection: 'all', status: 'connected', expiresAt: '2026-11-01T00:00:00Z', reasonCode: 'X',
      accountLogin: 'org-login', token: 'ghs_secret', installationId: 41
    }), { actor: 'alice', accountType: 'Organization', repositorySelection: 'all', status: 'connected', expiresAt: '2026-11-01T00:00:00Z', reasonCode: 'X' },
    'only the named fields, never a login or a credential');
    const long = `a\u0001b\n${'x'.repeat(300)}`;
    const bounded = safeGithubAppAuditDetails({ status: long, expiresAt: long });
    assert.strictEqual(bounded.status, `a b ${'x'.repeat(116)}`, 'as bounded text');
    assert.strictEqual(bounded.expiresAt.length, 80, 'an expiry more tightly');
    assert.deepStrictEqual(safeGithubAppAuditDetails({ actor: null, status: undefined, reasonCode: 0, accountType: false }), { reasonCode: '0', accountType: 'false' }, 'an absent field is not kept');
    assert.deepStrictEqual(safeGithubAppAuditDetails({ permissions: { contents: 'read', pull_requests: 'write', administration: 'admin', Bad: 'read', issues: 'none', 'x-y': 'read' } }),
      { permissions: { contents: 'read', pull_requests: 'write', administration: 'admin' } }, 'permissions by their names and levels alone');
    const many = Object.fromEntries(Array.from({ length: 130 }, (unused, i) => [`p_${String.fromCharCode(97 + (i % 26))}${'a'.repeat(1 + Math.floor(i / 26))}`, 'read']));
    assert.strictEqual(Object.keys(safeGithubAppAuditDetails({ permissions: many }).permissions).length, 100, 'at most a hundred');
    for (const value of [null, undefined, 'text', 7]) assert.deepStrictEqual(safeGithubAppAuditDetails(value), {});
    assert.deepStrictEqual(safeGithubAppAuditDetails({ permissions: ['read'] }), {}, 'a list is not a permission set');
  }

  /* ---- The audit, outside the alpha ------------------------------------------------------ */
  {
    const h = harness();
    const { result, lines } = await logged(() => h.recordGithubAppAudit(KEY, 'installation.connected', '41', { actor: 'alice', accountLogin: 'org' }));
    assert.strictEqual(result, true);
    assert.deepStrictEqual(lines.map(line => ({ ...line, t: typeof line.t })), [{
      t: 'string', event: 'github-app-lifecycle', type: 'installation.connected', identityKey: KEY, installationId: 41, details: { actor: 'alice' }
    }], 'the event is logged with its installation');
    const [[sql, values]] = h.queries;
    assert.strictEqual(sql, 'INSERT INTO nv_github_app_audit(event_id,identity_key,event_type,installation_id,details,created_at) VALUES($1,$2,$3,$4,$5::jsonb,now())');
    assert.match(values[0], /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'each row its own id');
    assert.deepStrictEqual(values.slice(1), [KEY, 'installation.connected', 41, '{"actor":"alice"}'], 'and kept with only the allowed details');
    await logged(() => h.recordGithubAppAudit(KEY, 'x', 41));
    assert.notStrictEqual(h.queries[1][1][0], values[0]);
  }
  {
    const h = harness();
    const { lines } = await logged(() => h.recordGithubAppAudit(undefined, undefined, undefined));
    assert.deepStrictEqual([lines[0].identityKey, lines[0].type, lines[0].installationId, lines[0].details], ['system:github-app', 'github-app.event', null, {}], 'an event without a name or an identity is the system\'s');
    for (const id of [0, -1, 1.5, 2 ** 60, 'x']) {
      const { lines: more } = await logged(() => h.recordGithubAppAudit(KEY, 'y', id));
      assert.strictEqual(more[0].installationId, null, `no installation id from ${id}`);
    }
    const { lines: bounded } = await logged(() => h.recordGithubAppAudit('i'.repeat(300), `t\n${'y'.repeat(300)}`, 1));
    assert.deepStrictEqual([bounded[0].identityKey.length, bounded[0].type.length, bounded[0].type.slice(0, 3)], [128, 100, 't y'], 'bounded text');
  }
  {
    const h = harness({ ready: [false] });
    const { result, lines } = await logged(() => h.recordGithubAppAudit(KEY, 'z', 3));
    assert.strictEqual(result, false, 'without a database the event is only logged');
    assert.strictEqual(lines.length, 1);
    assert.strictEqual(h.queries.length, 0);
  }

  /* ---- The audit, in the alpha ----------------------------------------------------------- */
  {
    const h = harness({ alphaEnabled: true, rows: [TESTER] });
    const { lines } = await logged(() => h.recordGithubAppAudit(KEY, 'installation.disconnected', 41, { actor: 'alice' }));
    assert.strictEqual(lines[0].installationId, null, 'the alpha keeps no installation id');
    assert.strictEqual(lines[0].details.actor, alphaActorLabel({ testerId: TESTER }), 'and names the tester the identity is bound to');
    assert.deepStrictEqual(h.queries[0], ['SELECT DISTINCT tester_id FROM nv_alpha_provider_bindings WHERE identity_key=$1 AND disconnected_at IS NULL ORDER BY tester_id LIMIT 2', [KEY]],
      'among the bindings still connected');
    assert.strictEqual(h.queries[1][1][3], null);
    const supplied = harness({ alphaEnabled: true, rows: [TESTER] });
    const { lines: own } = await logged(() => supplied.recordGithubAppAudit(KEY, 'x', 41, { actor: 'alpha:abcdef012345' }));
    assert.strictEqual(own[0].details.actor, 'alpha:abcdef012345', 'a supplied tester label is kept');
    assert.strictEqual(supplied.queries.length, 1, 'without looking the tester up');
    const shared = harness({ alphaEnabled: true, rows: [TESTER, 'ffffffff-1d2f-4a3b-8c4d-5e6f7a8b9c0d'] });
    const { lines: neither } = await logged(() => shared.recordGithubAppAudit(KEY, 'x', 41, { actor: 'Alpha:ABCDEF012345' }));
    assert.strictEqual('actor' in neither[0].details, false, 'an identity two testers share names neither, and a label out of shape is not one');
    const offline = harness({ alphaEnabled: true, ready: [false], rows: [TESTER] });
    const { lines: none } = await logged(() => offline.recordGithubAppAudit(KEY, 'x', 41, {}));
    assert.strictEqual('actor' in none[0].details, false);
    assert.strictEqual(offline.queries.length, 0);
    const outside = harness({ rows: [TESTER] });
    const { lines: plain } = await logged(() => outside.recordGithubAppAudit(KEY, 'x', 41, {}));
    assert.strictEqual('actor' in plain[0].details, false, 'outside the alpha no tester is looked up');
    assert.strictEqual(await outside.retainedProviderActor(KEY), '', 'or named');
    assert.strictEqual(outside.queries.length, 1);
    assert.strictEqual(await harness({ alphaEnabled: true, rows: [TESTER] }).retainedProviderActor(KEY), alphaActorLabel({ testerId: TESTER }));
  }

  /* ---- An installation kept and removed ---------------------------------------------------- */
  const installation = { id: 41, account: { login: 'org', id: 9, type: 'Organization' }, repositorySelection: 'selected', permissions: { contents: 'read' }, suspendedAt: '2026-10-01' };
  {
    const h = harness();
    assert.strictEqual(await h.persistGithubAppInstallation(KEY, installation, { login: 'alice', id: 3 }), true);
    const [[sql, values]] = h.queries;
    assert(sql.startsWith('INSERT INTO nv_github_app_installations( identity_key,installation_id,account_login,account_id,account_type,authorized_by_login,authorized_by_id, repository_selection,permissions,status,suspended_at,connected_at,updated_at )'));
    assert(sql.includes('ON CONFLICT(identity_key,installation_id) DO UPDATE SET') && sql.includes('suspended_at=EXCLUDED.suspended_at,updated_at=now()'), 'kept once per identity and installation, its suspension as it now is');
    assert.deepStrictEqual(values, [KEY, 41, 'org', 9, 'Organization', 'alice', 3, 'selected', '{"contents":"read"}', 'connected', '2026-10-01']);
    await h.persistGithubAppInstallation(KEY, { ...installation, permissions: undefined, suspendedAt: '' }, { login: 'alice', id: 3 }, 'suspended');
    assert.deepStrictEqual(h.queries[1][1].slice(8), ['{}', 'suspended', null]);
    assert.strictEqual(await h.removeGithubAppInstallation(KEY, 41), true);
    assert.deepStrictEqual(h.queries[2], ['DELETE FROM nv_github_app_installations WHERE identity_key=$1 AND installation_id=$2', [KEY, 41]]);
  }
  {
    const alpha = harness({ alphaEnabled: true });
    assert.strictEqual(await alpha.persistGithubAppInstallation(KEY, installation, { login: 'alice', id: 3 }), false, 'the alpha keeps no installation metadata here');
    assert.strictEqual(alpha.queries.length, 0);
    const offline = harness({ ready: [false] });
    assert.strictEqual(await offline.persistGithubAppInstallation(KEY, installation, { login: 'alice', id: 3 }), false);
    assert.strictEqual(await offline.removeGithubAppInstallation(KEY, 41), false);
    assert.strictEqual(offline.queries.length, 0, 'nothing is written without a database');
    const failing = harness({ fails: true });
    await assert.rejects(failing.removeGithubAppInstallation(KEY, 41), /database unavailable/);
  }

  finished = true;
  console.log('GitHub App records tests passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
