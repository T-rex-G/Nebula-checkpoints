/*
 * Whether anyone may send email as a domain, read from the TXT records it
 * publishes: the SPF policy at the domain, the DMARC policy at `_dmarc.`.
 */
export type SpfState = 'invalid' | 'missing' | 'open' | 'strict' | 'soft' | 'neutral';
export type DmarcState = 'missing' | 'invalid' | 'none' | 'quarantine' | 'reject';

/* One SPF record, every term well formed; its `all` says what happens to mail from anyone else. */
export function spfState(records: readonly string[]): SpfState {
  const policies = records.filter(record => /^v=spf1(?:\s|$)/i.test(record.trim()));
  const policy = policies[0];
  const terms = policy ? policy.trim().split(/\s+/).slice(1) : [];
  const valid = terms.every(term => /^(?:[+?~-]?(?:all|(?:include|exists):[^\s]+|(?:a|mx)(?::[^/\s]+)?(?:\/\d{1,3})?(?:\/\/\d{1,3})?|ptr(?::[^\s]+)?|ip[46]:[0-9a-f:./]+)|[a-z][a-z0-9_.-]*=[^\s]+)$/i.test(term));
  const all = terms.find(term => /^[+?~-]?all$/i.test(term));
  return policies.length > 1 || !valid ? 'invalid' : !policy ? 'missing' : /^\+?all$/i.test(all || '') ? 'open' : /^-all$/i.test(all || '') ? 'strict' : /^~all$/i.test(all || '') ? 'soft' : 'neutral';
}

/* One DMARC record, its version first, no tag twice and one policy: the policy, in lower case. */
export function dmarcState(records: readonly string[]): DmarcState {
  const policies = records.filter(record => /^v=DMARC1(?:\s*;|\s*$)/i.test(record.trim()));
  const tags = policies.length === 1 ? (policies[0] ?? '').split(';').map(value => value.trim()).filter(Boolean) : [];
  const parsed = tags.map(value => /^([a-z][a-z0-9_-]*)\s*=\s*(.+)$/i.exec(value));
  const names = parsed.flatMap(match => (match && match[1] !== undefined ? [match[1].toLowerCase()] : []));
  const modes = parsed.flatMap(match => (match && match[1] !== undefined && match[1].toLowerCase() === 'p' ? [match] : []));
  const first = parsed[0];
  const mode = modes[0]?.[2];
  const valid = parsed.every(Boolean) && first && /^v$/i.test(first[1] ?? '') && /^DMARC1$/i.test(first[2] ?? '') && new Set(names).size === names.length && modes.length === 1 && mode !== undefined && /^(?:none|quarantine|reject)$/i.test(mode);
  if (!policies.length) return 'missing';
  if (policies.length !== 1 || !valid || mode === undefined) return 'invalid';
  const policy = mode.toLowerCase();
  return policy === 'none' || policy === 'quarantine' || policy === 'reject' ? policy : 'invalid';
}
