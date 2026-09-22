'use strict';

const { REASONS: VERIFICATION_REASONS, VERIFICATION_STATES } = require('./credential-verification');
const { REASONS: PROBE_REASONS, PROBE_STATES } = require('./anonymous-readability-probe');

/*
 * Saying what a finding means, in words, without a model.
 *
 * A stored finding is a rule name, a path, a line and four version numbers.
 * That is enough to act on if you already know what `contextual-provider-secret`
 * implies -- and the person who most needs to act is the one least likely to
 * know.
 *
 * So there is one explanation per rule, per verification outcome, per probe
 * outcome and per disposition, and all of it is a lookup table rather than a
 * generator. A generator would be shorter and would drift: the same finding
 * would be worded differently between runs, a reader comparing two scans could
 * not tell whether the wording or the world had changed, and nobody could
 * review the sentences because nobody could enumerate them. A table can be
 * read end to end by a person, and a rule added without an entry fails this
 * module's test rather than producing a finding that explains nothing.
 *
 * Two rules about the words themselves.
 *
 * The consequence comes first, in the reader's terms. "A GitHub personal
 * access token" is what it is; "anyone who has this can act as you on GitHub"
 * is what it means, and only the second tells somebody whether to stop what
 * they are doing.
 *
 * Nothing that could not be read aloud goes in. No credential, no fingerprint,
 * not even a prefix -- a finding should be safe to paste into a ticket and show
 * on a screen in an open-plan office, and the placeholder exists so it is.
 */

/*
 * Moves when the wording changes, so a stored narration can be told from a
 * freshly generated one. The sentences are part of the product's contract with
 * a reader: changing them silently means two people reading the same finding a
 * month apart disagree about what they were told.
 */
const NARRATION_VERSION = 1;

/* Severity is about the credential class, not about liveness. Whether a
   particular one still works is the verifier's answer and is reported
   separately; a private key in a repository is serious whether or not anybody
   has tried it. */
const RULE_NARRATION = Object.freeze({
  'private-key': Object.freeze({
    severity: 'critical',
    consequence: 'A private key is in the repository. Anyone who can read this file can impersonate whatever the key identifies -- a server, a deploy user, a signing identity -- and no password protects it once it is out.',
    action: 'Treat the key as compromised: issue a new one, replace it everywhere it is trusted, and revoke the old one. Removing the file is not enough, because the key is still in the repository history.'
  }),
  'github-token': Object.freeze({
    severity: 'critical',
    consequence: 'A GitHub access token is in the repository. Anyone who has it can act as the account that issued it -- read private repositories, push commits, and in some cases change who else has access.',
    action: 'Revoke the token in GitHub developer settings now; a new one can be issued afterwards. Revoking is what ends the exposure, because the token remains in the repository history.'
  }),
  'gitlab-token': Object.freeze({
    severity: 'critical',
    consequence: 'A GitLab access token is in the repository. Depending on its scopes, anyone who has it can read private projects, push code, or run pipelines as the account that issued it.',
    action: 'Revoke the token in GitLab access-token settings now. Revoking is what ends the exposure; deleting the file does not, because the token remains in the repository history.'
  }),
  'aws-access-key': Object.freeze({
    severity: 'serious',
    consequence: 'An AWS access key identifier is in the repository. On its own it is a name rather than a working credential -- signing also needs the secret access key -- but it tells anyone who finds it which account to attack, and the secret is often committed nearby or later.',
    action: 'Deactivate and delete the key pair in IAM rather than looking for the secret half, and check CloudTrail for use of that key identifier. Rotating is cheap; establishing that the secret was never committed is not.'
  }),
  'slack-token': Object.freeze({
    severity: 'critical',
    consequence: 'A Slack token is in the repository. Anyone who has it can read and post in whatever the workspace granted it, which usually includes channels containing more credentials.',
    action: 'Revoke the token in the Slack app configuration now, then review the channels it could read. Revoking ends the exposure; the token stays in the repository history.'
  }),
  'authenticated-url': Object.freeze({
    severity: 'critical',
    consequence: 'A connection string with an embedded password is in the repository. Anyone who can read it can connect to that service directly as that user, and a database reached this way is usually reachable from anywhere.',
    action: 'Change the password on that account now and check whether the host accepts connections from the internet. A password in a URL also ends up in logs and shell history, so assume it is more widely known than this one file.'
  }),
  'contextual-provider-secret': Object.freeze({
    severity: 'serious',
    consequence: 'A configuration value that names a provider secret has a literal value committed beside it. What it unlocks depends on which secret it is, and the name usually says: a session secret forges sessions, a webhook secret forges webhook deliveries, an OAuth secret impersonates the application.',
    action: 'Rotate that specific secret and move the value into the deployment environment rather than the repository. Check what the name implies before deciding this is minor.'
  }),
  /*
   * The one entry here that does not say "this is a leak", because it is not
   * one. An anonymous key is published in client bundles by design, and a
   * narration that called it critical would make every project in every
   * repository a critical finding -- which is how a reader learns to scroll
   * past a screen of them.
   *
   * What it is instead is a question this server cannot answer by looking:
   * what the anonymous role can read is decided by policies that live in
   * somebody's project, not in their repository. So the consequence says the
   * key is not the problem, and the action is to ask.
   */
  'supabase-anon-key': Object.freeze({
    severity: 'warning',
    consequence: 'A Supabase anonymous key is in the repository. That is normal -- it is meant to be public and it is in the browser bundle of every app that uses one. What it can actually read is decided by the row-level security policies on the project, and those are not visible from here.',
    action: 'Do not rotate it; that fixes nothing and breaks the app. Check what the anonymous role can read instead, which is what the readability check below asks the project directly.'
  }),
  /*
   * The same shape, the opposite finding. This one needs no probe to be
   * serious: a service-role key bypasses row-level security entirely, so
   * asking whether it can read a table would establish nothing except that
   * this server had used an administrator credential to find out.
   */
  'supabase-service-role-key': Object.freeze({
    severity: 'critical',
    consequence: 'A Supabase service-role key is in the repository. It bypasses row-level security completely, so anyone who has it can read and write every table in the project regardless of what the policies say. It looks almost exactly like the anonymous key and is nothing like it.',
    action: 'Rotate the service-role key in the project API settings now, and move it into the deployment environment rather than the repository. Rotating is what ends the exposure; the key stays in the repository history.'
  })
});

/*
 * One sentence per verification outcome. The unverifiable ones are written
 * carefully: none of them may read as safety, because "we could not tell" and
 * "it is harmless" are different sentences and only one of them is true.
 */
const VERIFICATION_NARRATION = Object.freeze({
  [VERIFICATION_STATES.VERIFIED]: 'The provider confirmed this credential is live: it was used to identify its own account, and it worked.',
  [VERIFICATION_STATES.REJECTED]: 'The provider refused this credential, so it no longer works. The exposure is over for this credential, though it remains in the repository history.',
  [VERIFICATION_REASONS.AUTHORIZATION_MISSING]: 'Nobody authorised a check, so the credential was not used. Whether it still works is unknown.',
  [VERIFICATION_REASONS.AUTHORIZATION_INVALID]: 'The authorisation to check this credential did not validate, so the credential was not used. Whether it still works is unknown.',
  [VERIFICATION_REASONS.AUTHORIZATION_EXPIRED]: 'The authorisation to check this credential had expired, so the credential was not used. Whether it still works is unknown.',
  [VERIFICATION_REASONS.AUTHORIZATION_MISMATCH]: 'The authorisation was for a different credential, repository or target, so this one was not used. Whether it still works is unknown.',
  [VERIFICATION_REASONS.UNSUPPORTED_CREDENTIAL_CLASS]: 'There is no way to ask this kind of credential whether it works without using it against a service it was not issued for, so nothing was asked. Assume it works.',
  [VERIFICATION_REASONS.UNSUPPORTED_TOKEN_CLASS]: 'This token class authenticates differently from the one this checker understands, so asking would have been a guess. Nothing was asked; assume it works.',
  [VERIFICATION_REASONS.INCOMPLETE_CREDENTIAL]: 'This is half a credential -- an identifier without its secret -- so there is nothing to test. That is not reassurance: the other half is often committed nearby.',
  [VERIFICATION_REASONS.IDENTITY_CONFIRMED]: 'The provider identified the account this credential belongs to, which means it is live.',
  [VERIFICATION_REASONS.CREDENTIAL_REFUSED]: 'The provider refused this credential, so it no longer works.',
  [VERIFICATION_REASONS.MALFORMED_IDENTITY_RESPONSE]: 'The provider answered, but not with an identity this checker could read, so the answer proves nothing either way.',
  [VERIFICATION_REASONS.PROVIDER_THROTTLED]: 'The provider was rate-limiting us and did not answer the question. Being throttled means the request reached a working service, not that the credential is dead.',
  [VERIFICATION_REASONS.PROVIDER_POLICY_RESTRICTED]: 'The provider blocked the request on policy grounds rather than rejecting the credential. A credential blocked by policy from one endpoint usually still works elsewhere.',
  [VERIFICATION_REASONS.PROVIDER_AMBIGUOUS_REJECTION]: 'The provider gave an answer that means either "this credential is gone" or "this credential is fine but you may not ask from here". It cannot be read as the first.',
  [VERIFICATION_REASONS.PROVIDER_UNEXPECTED_STATUS]: 'The provider answered in a way this checker has not been reviewed against, so the answer was not interpreted.',
  [VERIFICATION_REASONS.TRANSPORT_REFUSED]: 'The request could not be completed, so the question was never answered.',
  [VERIFICATION_REASONS.TRANSPORT_TIMEOUT]: 'The provider did not answer within the time allowed, so the question was never answered.',
  [VERIFICATION_REASONS.RUN_LIMIT_REACHED]: 'This scan had already made as many checks as it is allowed, so this credential was not checked.'
});

/*
 * One sentence per probe outcome, and the two careful ones are the reason this
 * table exists. An empty result and a refusal are both easy to report as
 * "protected", and a reader told that stops looking.
 */
const PROBE_NARRATION = Object.freeze({
  [PROBE_STATES.READABLE]: 'A row came back. That projection of that table was readable by an anonymous stranger at that moment, with no sign-in of any kind.',
  [PROBE_REASONS.ROWS_VISIBLE]: 'A row came back, so those columns of that table were readable by an anonymous stranger. Other columns and other tables were not tested.',
  [PROBE_REASONS.NO_VISIBLE_ROWS]: 'No rows came back. That is not evidence of protection: an empty table, a filter that matched nothing, and a policy that permits the read while hiding every row look identical from outside.',
  [PROBE_REASONS.ACCESS_DENIED_FOR_TESTED_REQUEST]: 'The service refused this exact request -- these columns of this table for an anonymous caller. It says nothing about the rest of the table, the rest of the schema, or whether row-level security is switched on.',
  [PROBE_REASONS.KEY_NOT_ANONYMOUS]: 'The key found is not an anonymous public key, so it was not used. A stronger key would bypass the policies this check is about, and using one would prove nothing.',
  [PROBE_REASONS.PROJECT_REFUSED]: 'The project reference was not a shape this checker will connect to, so nothing was contacted.',
  [PROBE_REASONS.RELATION_REFUSED]: 'The table name was not a plain table name, so nothing was requested. Only named tables are read, never functions.',
  [PROBE_REASONS.PROJECTION_REFUSED]: 'The columns requested were not a confirmed list of named columns, so nothing was requested. Selecting everything is never done.',
  [PROBE_REASONS.AUTHORIZATION_MISSING]: 'Nobody authorised this read, so nothing was contacted.',
  [PROBE_REASONS.AUTHORIZATION_INVALID]: 'The authorisation for this read did not validate, so nothing was contacted.',
  [PROBE_REASONS.AUTHORIZATION_EXPIRED]: 'The authorisation for this read had expired, so nothing was contacted.',
  [PROBE_REASONS.AUTHORIZATION_MISMATCH]: 'The authorisation was for a different project, table or set of columns, so nothing was contacted.',
  [PROBE_REASONS.PROVIDER_THROTTLED]: 'The service was rate-limiting us and did not answer, so nothing is known about readability.',
  [PROBE_REASONS.PROVIDER_UNEXPECTED_RESPONSE]: 'The service answered in a way this checker does not interpret, so nothing is known about readability.',
  [PROBE_REASONS.TRANSPORT_REFUSED]: 'The request could not be completed, so nothing is known about readability.'
});

const DISPOSITION_NARRATION = Object.freeze({
  open: 'This finding is open: the credential is in the tree and nothing has established that it stopped working.',
  'credential-rejected': 'The issuing provider refused this credential, so it no longer works. This is the only outcome that means the exposure is actually over.',
  'accepted-risk': 'Somebody reviewed this finding and accepted the risk. It is recorded against their name and the credential is still in the repository.',
  'removed-from-tree': 'A complete scan of the same branch no longer finds this credential in the tree. It is still in the repository history and still reachable by anyone with a clone, so it needs revoking unless it has already been revoked.'
});

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function narrationForRule(rule) {
  const name = typeof rule === 'string' ? rule : '';
  return RULE_NARRATION[name] || null;
}

function describeVerification(record) {
  if (!record || typeof record !== 'object') return null;
  const reason = text(record.reason);
  const state = text(record.state);
  /*
   * The reason is more specific than the state, so it wins when there is one.
   * A verified credential and a rejected one also have a sentence keyed by
   * state, for a record that carries no reason.
   */
  return VERIFICATION_NARRATION[reason] || VERIFICATION_NARRATION[state] || null;
}

function describeProbe(record) {
  if (!record || typeof record !== 'object') return null;
  const reason = text(record.reason);
  const state = text(record.state);
  return PROBE_NARRATION[reason] || PROBE_NARRATION[state] || null;
}

function describeDisposition(disposition) {
  const name = typeof disposition === 'string' ? disposition : '';
  return DISPOSITION_NARRATION[name] || null;
}

/*
 * Where a credential is, in a sentence. The path is quoted because a reader
 * needs it, and a path can contain anything a repository chose to name a file
 * -- including something shaped like a credential. So the path is trimmed to
 * its directory and its last segment is described rather than quoted whenever
 * the last segment looks like it might be a secret itself.
 */
function describeLocation(finding) {
  const occurrences = Array.isArray(finding.occurrences) ? finding.occurrences : [];
  const count = Number.isInteger(finding.occurrenceCount) ? finding.occurrenceCount : occurrences.length;
  const where = safeDisplayPath(text(finding.path));
  if (!occurrences.length) return `In ${where}.`;
  const first = occurrences[0];
  const at = `line ${first.line}`;
  if (count <= 1) return `In ${where}, at ${at}.`;
  if (finding.truncated) {
    return `In ${where}, in ${count} places. The first ${occurrences.length} are recorded, starting at ${at}.`;
  }
  return `In ${where}, in ${count} places, starting at ${at}.`;
}

/*
 * A file name that is itself credential-shaped is described rather than
 * quoted. It is an unusual case and it is the only way a secret could reach a
 * sentence that is meant to be safe to read aloud, so it is handled rather
 * than reasoned about.
 */
function safeDisplayPath(filePath) {
  if (!filePath) return 'an unnamed file';
  const segments = filePath.split('/');
  const name = segments.pop() || '';
  const looksLikeCredential = name.length >= 20 && /[A-Za-z0-9_-]{20,}/.test(name.replace(/\.[a-z0-9]+$/i, ''));
  if (!looksLikeCredential) return filePath;
  const directory = segments.join('/');
  return directory
    ? `${directory}/ (a file whose name is not shown, because it is itself credential-shaped)`
    : 'a file whose name is not shown, because it is itself credential-shaped';
}

/*
 * The whole description of one finding: what it is, what it means, where it
 * is, and what to do. A pure function of the record -- no clock, no
 * randomness, no environment -- so the same finding reads the same way every
 * time anybody looks at it.
 */
function describeFinding(finding) {
  if (!finding || typeof finding !== 'object') return null;
  const rule = text(finding.rule);
  const narration = narrationForRule(rule);
  const placeholder = text(finding.placeholder) || `<${rule || 'credential'}>`;

  if (!narration) {
    /*
     * A rule with no entry is described as unexplained rather than omitted,
     * and is not downgraded: an unexplained credential in a repository is not
     * less serious for being unexplained.
     */
    return Object.freeze({
      narrationVersion: NARRATION_VERSION,
      severity: 'serious',
      what: `${placeholder} matched the rule "${rule}", which has no written explanation yet.`,
      consequence: 'What this credential unlocks is not described here, so treat it as live and as capable of whatever its kind normally permits.',
      action: 'Rotate it, and add an explanation for this rule so the next reader is not left guessing.',
      where: describeLocation(finding)
    });
  }

  return Object.freeze({
    narrationVersion: NARRATION_VERSION,
    severity: narration.severity,
    what: `${placeholder} is a credential this scan recognised.`,
    consequence: narration.consequence,
    action: narration.action,
    where: describeLocation(finding)
  });
}

module.exports = Object.freeze({
  DISPOSITION_NARRATION,
  NARRATION_VERSION,
  PROBE_NARRATION,
  RULE_NARRATION,
  VERIFICATION_NARRATION,
  describeDisposition,
  describeFinding,
  describeLocation,
  describeProbe,
  describeVerification,
  narrationForRule
});
