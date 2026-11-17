/*
 * The rules a tracked file is refused for: credentials whose shape alone says
 * what they are. The release gate scans with them, and Quasar's exposure
 * detection starts from them and adds its own. Pure data, so a decision that
 * uses the rules does not load the scanner that walks a tree for them.
 */
export interface SecretRule {
  readonly rule: string;
  readonly regex: RegExp;
}

export const RULES: readonly SecretRule[] = Object.freeze([
  Object.freeze({
    rule: 'private-key',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/
  }),
  Object.freeze({
    rule: 'github-token',
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/
  }),
  Object.freeze({
    rule: 'gitlab-token',
    regex: /\b(?:glpat|gloas|gldt|glrt|glrtr|glcbt|glptt|glft|glimt|glagent|glwt|glsoat|glffct)-[A-Za-z0-9_-]{12,}\b/
  }),
  Object.freeze({
    rule: 'aws-access-key',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/
  }),
  Object.freeze({
    rule: 'slack-token',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/
  }),
  Object.freeze({
    rule: 'authenticated-url',
    regex: /\b(?:https?|postgres(?:ql)?):\/\/[^\s/:@]+:[^\s@/]{16,}@[^\s]+/i
  }),
  Object.freeze({
    /*
     * A secret does not stop being one because it is serialized on the way
     * out, so the first alternative steps over a JSON.stringify( prefix. It
     * admits only a quoted literal, which is the whole distinction worth
     * drawing: stringifying process.env, a variable, or an object expression
     * exposes nothing and is ordinary code, and flagging it would turn this
     * gate into noise operators learn to scroll past.
     */
    rule: 'contextual-provider-secret',
    regex: /\b(?:GITEA_(?:TOKEN|API_KEY)|GITHUB_APP_(?:CLIENT_SECRET|PRIVATE_KEY_BASE64|WEBHOOK_SECRET)|NPM_TOKEN|NEON_(?:API_KEY|TOKEN)|NV_SNAPSHOT_(?:SIGNING_SECRET|RETIRED_KEYS_JSON|LEGACY_KEYS_JSON)|OAUTH_(?:CLIENT_)?SECRET|SESSION_SECRET)\b[ \t]*[:=][ \t]*(?:JSON\.stringify\([ \t]*["'][A-Za-z0-9_~.+\/-]{20,}["']|["']?(?!process\.env\b|\$\{)(?:[A-Za-z0-9_~.+\/-]{20,}|[\[{][^\r\n]{20,})["']?)/i
  })
]);
