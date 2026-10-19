import { fieldsOf, listOf, read } from '../../../platform/values/fields.ts';

/*
 * What GitHub's branch rules mean, control by control: its classic branch
 * protection and its rulesets, each read into the same eight controls, and
 * two readings of one control merged. Pure: the reading itself, and the
 * reader it goes through, are in application/branch-protection.ts.
 */

export type ControlId = 'review' | 'checks' | 'force-push' | 'deletion' | 'signed' | 'linear' | 'conversation' | 'admins';

export const CONTROLS: readonly (readonly [ControlId, string])[] = Object.freeze([
  ['review', 'Pull request review before merging'],
  ['checks', 'Status checks must pass'],
  ['force-push', 'Force pushes blocked'],
  ['deletion', 'Deletion blocked'],
  ['signed', 'Signed commits required'],
  ['linear', 'Linear history'],
  ['conversation', 'Review conversations resolved'],
  ['admins', 'Rules apply to administrators']
]);

export interface ControlReading {
  readonly state: 'on' | 'off' | 'unknown';
  readonly detail?: string;
}

export type ControlReadings = Partial<Record<ControlId, ControlReading>>;

/* A control's state, with a short detail when it has one. */
export const on = (detail?: string): ControlReading => ({ state: 'on', ...(detail ? { detail } : {}) });
export const off = (detail?: string): ControlReading => ({ state: 'off', ...(detail ? { detail } : {}) });
export const unknown = (detail?: string): ControlReading => ({ state: 'unknown', ...(detail ? { detail } : {}) });

/* Two readings of one control: on if either says on, off only if one says off and none says on. */
export function merge(a: ControlReading | undefined, b: ControlReading | undefined): ControlReading | undefined {
  if (!a) return b;
  if (!b) return a;
  if (a.state === 'on' && b.state === 'on') return a.detail ? a : b;
  if (a.state === 'on') return a;
  if (b.state === 'on') return b;
  if (a.state === 'off') return a;
  if (b.state === 'off') return b;
  return a;
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
const enabled = (value: unknown): boolean => !!(value && (value === true || read(value, 'enabled') === true));

/* The names of a list's entries, as GitHub lists required checks: a text, or an object's `context`. */
function checkContexts(checks: unknown): unknown[] {
  return [...listOf(read(checks, 'contexts')), ...listOf(read(checks, 'checks')).map(item => item && read(item, 'context'))];
}

export function githubClassic(protection: unknown): ControlReadings {
  if (!protection) return {};
  const reviews = read(protection, 'required_pull_request_reviews');
  const count = reviews ? Number(read(reviews, 'required_approving_review_count') || 0) : 0;
  const reviewBits = reviews ? [
    count ? plural(count, 'approval') : 'no approvals counted',
    read(reviews, 'require_code_owner_reviews') ? 'code owners' : '',
    read(reviews, 'dismiss_stale_reviews') ? 'stale approvals dismissed' : '',
    read(reviews, 'require_last_push_approval') ? 'last push approved' : ''
  ].filter(Boolean) : [];
  const checks = read(protection, 'required_status_checks');
  const contexts = checks ? [...new Set(checkContexts(checks).filter(Boolean))] : [];
  return {
    review: reviews ? on(reviewBits.join(', ')) : off(),
    checks: checks ? on([contexts.length ? plural(contexts.length, 'check') : '', read(checks, 'strict') ? 'branch must be up to date' : ''].filter(Boolean).join(', ')) : off(),
    'force-push': enabled(read(protection, 'allow_force_pushes')) ? off('allowed') : on(),
    deletion: enabled(read(protection, 'allow_deletions')) ? off('allowed') : on(),
    signed: enabled(read(protection, 'required_signatures')) ? on() : off(),
    linear: enabled(read(protection, 'required_linear_history')) ? on() : off(),
    conversation: enabled(read(protection, 'required_conversation_resolution')) ? on() : off(),
    admins: enabled(read(protection, 'enforce_admins')) ? on() : off('administrators can bypass')
  };
}

export function githubRulesets(rules: unknown): ControlReadings {
  if (!Array.isArray(rules)) return {};
  const out: ControlReadings = {};
  for (const rule of rules) {
    const parameters = fieldsOf((rule && read(rule, 'parameters')) || {});
    switch (rule && read(rule, 'type')) {
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
        const count = listOf(parameters.required_status_checks).length;
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
