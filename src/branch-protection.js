'use strict';

/*
 * What the provider enforces on a branch, read and never changed.
 *
 * Nebulaverse-X's own safeguards (read-only mode, protected paths) hold only
 * while a change goes through Nebulaverse-X. The provider's branch rules hold
 * for every client -- a laptop's `git push --force`, an automation token, an
 * administrator in the web editor -- so the Safeguards panel shows them beside
 * its own, control by control, in the words a reviewer would use.
 *
 * Each control is `on`, `off` or `unknown`. `unknown` is what a reader
 * without administration access sees for the details a provider hides from
 * it; it is never counted as `on`, so a restricted token never makes a branch
 * look better defended than it is. GitHub's classic protection and its
 * rulesets are both read, and a control is on when either turns it on.
 *
 * The provider is reached only through `read(path)`, which the caller binds
 * to the open repository and its session; this module builds paths relative
 * to that repository and never sees a credential.
 */

const CONTROLS = Object.freeze([
  ['review', 'Pull request review before merging'],
  ['checks', 'Status checks must pass'],
  ['force-push', 'Force pushes blocked'],
  ['deletion', 'Deletion blocked'],
  ['signed', 'Signed commits required'],
  ['linear', 'Linear history'],
  ['conversation', 'Review conversations resolved'],
  ['admins', 'Rules apply to administrators']
]);

/* A control's state, with a short detail when it has one. */
const on = detail => ({ state: 'on', ...(detail ? { detail } : {}) });
const off = detail => ({ state: 'off', ...(detail ? { detail } : {}) });
const unknown = detail => ({ state: 'unknown', ...(detail ? { detail } : {}) });

/* Two readings of one control: on if either says on, off only if one says off and none says on. */
function merge(a, b) {
  if (!a) return b;
  if (!b) return a;
  if (a.state === 'on' && b.state === 'on') return a.detail ? a : b;
  if (a.state === 'on') return a;
  if (b.state === 'on') return b;
  if (a.state === 'off') return a;
  if (b.state === 'off') return b;
  return a;
}

/* A read that answers null for "not there" and "not allowed", and throws for anything else. */
async function optional(read, path) {
  try { return { value: await read(path), status: 200 }; }
  catch (error) {
    const status = Number(error && error.status);
    if (status === 404 || status === 403 || status === 401) return { value: null, status };
    throw error;
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const enabled = value => !!(value && (value === true || value.enabled === true));

/* ---- GitHub ------------------------------------------------------------------------- */

function githubClassic(protection) {
  if (!protection) return {};
  const reviews = protection.required_pull_request_reviews;
  const count = reviews ? Number(reviews.required_approving_review_count || 0) : 0;
  const reviewBits = reviews ? [
    count ? plural(count, 'approval') : 'no approvals counted',
    reviews.require_code_owner_reviews ? 'code owners' : '',
    reviews.dismiss_stale_reviews ? 'stale approvals dismissed' : '',
    reviews.require_last_push_approval ? 'last push approved' : ''
  ].filter(Boolean) : [];
  const checks = protection.required_status_checks;
  const contexts = checks ? [...new Set([...(checks.contexts || []), ...((checks.checks || []).map(item => item && item.context))].filter(Boolean))] : [];
  return {
    review: reviews ? on(reviewBits.join(', ')) : off(),
    checks: checks ? on([contexts.length ? plural(contexts.length, 'check') : '', checks.strict ? 'branch must be up to date' : ''].filter(Boolean).join(', ')) : off(),
    'force-push': enabled(protection.allow_force_pushes) ? off('allowed') : on(),
    deletion: enabled(protection.allow_deletions) ? off('allowed') : on(),
    signed: enabled(protection.required_signatures) ? on() : off(),
    linear: enabled(protection.required_linear_history) ? on() : off(),
    conversation: enabled(protection.required_conversation_resolution) ? on() : off(),
    admins: enabled(protection.enforce_admins) ? on() : off('administrators can bypass')
  };
}

function githubRulesets(rules) {
  if (!Array.isArray(rules)) return {};
  const out = {};
  for (const rule of rules) {
    const parameters = (rule && rule.parameters) || {};
    switch (rule && rule.type) {
      case 'pull_request': {
        const count = Number(parameters.required_approving_review_count || 0);
        out.review = merge(out.review, on([
          count ? plural(count, 'approval') : 'pull request required',
          parameters.require_code_owner_review ? 'code owners' : '',
          parameters.dismiss_stale_reviews_on_push ? 'stale approvals dismissed' : '',
          parameters.require_last_push_approval ? 'last push approved' : ''
        ].filter(Boolean).join(', ')));
        if (parameters.required_review_thread_resolution) out.conversation = on();
        break;
      }
      case 'required_status_checks': {
        const count = (parameters.required_status_checks || []).length;
        out.checks = merge(out.checks, on([count ? plural(count, 'check') : '', parameters.strict_required_status_checks_policy ? 'branch must be up to date' : ''].filter(Boolean).join(', ')));
        break;
      }
      case 'non_fast_forward': out['force-push'] = on(); break;
      case 'deletion': out.deletion = on(); break;
      case 'required_signatures': out.signed = on(); break;
      case 'required_linear_history': out.linear = on(); break;
      default: break;
    }
  }
  return out;
}

async function readGithub({ read, branch }) {
  const summary = await read(`/branches/${encodeURIComponent(branch)}`);
  const [classic, rulesets] = await Promise.all([
    summary && summary.protected ? optional(read, `/branches/${encodeURIComponent(branch)}/protection`) : Promise.resolve({ value: null, status: 404 }),
    optional(read, `/rules/branches/${encodeURIComponent(branch)}`)
  ]);
  const fromClassic = githubClassic(classic.value);
  const fromRules = githubRulesets(rulesets.value);
  const hidden = !!(summary && summary.protected && !classic.value && classic.status !== 404);
  const controls = {};
  /* The branch summary names required checks even to readers who cannot see the rest. */
  const visibleChecks = (summary && summary.protection && summary.protection.required_status_checks
    && summary.protection.required_status_checks.contexts) || [];
  if (visibleChecks.length) fromRules.checks = merge(fromRules.checks, on(plural(visibleChecks.length, 'check')));
  for (const [id] of CONTROLS) {
    const reading = merge(fromClassic[id], fromRules[id]);
    if (reading && reading.state === 'on') controls[id] = reading;
    else if (hidden) controls[id] = unknown('needs administration access to read');
    else controls[id] = reading || off();
  }
  const rulesetCount = Array.isArray(rulesets.value) ? new Set(rulesets.value.map(rule => rule && rule.ruleset_id).filter(Boolean)).size : 0;
  return {
    protected: !!(summary && summary.protected) || rulesetCount > 0,
    access: hidden ? 'partial' : 'full',
    sources: [classic.value ? 'branch protection' : '', rulesetCount ? plural(rulesetCount, 'ruleset') : ''].filter(Boolean),
    controls
  };
}

/* ---- The reading ---------------------------------------------------------------------- */

const READERS = Object.freeze({ github: readGithub });

function settingsUrl({ webBase, owner, repo }) {
  const base = String(webBase || '').replace(/\/+$/, '');
  if (!base) return null;
  const slug = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return `${base}/${slug}/settings/branches`;
}

/*
 * The provider's rules for one branch. `read(path)` fetches a path relative to
 * the repository (`''` is the repository itself) and throws an error carrying
 * `status` on failure. When `branch` is empty the default branch is read.
 */
async function readBranchProtection({ provider = 'github', owner, repo, branch, read, webBase }) {
  const reader = READERS[provider];
  if (!reader) throw Object.assign(new Error('Branch rules are not available for this provider'), { status: 501, code: 'BRANCH_RULES_UNSUPPORTED' });
  if (typeof read !== 'function') throw new TypeError('read is required');
  let name = String(branch || '').trim();
  if (!name) {
    const repository = await read('');
    name = String((repository && repository.default_branch) || '').trim();
    if (!name) throw Object.assign(new Error('The repository has no default branch yet'), { status: 404, code: 'BRANCH_NOT_FOUND' });
  }
  const reading = await reader({ read, branch: name });
  const controls = CONTROLS.map(([id, label]) => ({ id, label, ...reading.controls[id] }));
  const counted = controls.filter(control => control.state !== 'unknown');
  return {
    provider,
    branch: name,
    protected: reading.protected,
    access: reading.access,
    sources: reading.sources,
    controls,
    enforced: controls.filter(control => control.state === 'on').length,
    known: counted.length,
    settingsUrl: settingsUrl({ provider, webBase, owner, repo })
  };
}

module.exports = Object.freeze({ readBranchProtection, CONTROLS });
