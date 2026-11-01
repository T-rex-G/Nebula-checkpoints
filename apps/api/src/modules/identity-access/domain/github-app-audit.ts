/*
 * What a GitHub App lifecycle record may keep of the details it is handed.
 *
 * Only named fields, as bounded text: the actor, the installation's account
 * type, its repository selection, its status, when a grant expires and why
 * something happened. Never the provider login, a token or anything else a
 * caller happens to pass. An installation's permissions are kept by their
 * names and levels alone -- read, write or admin -- and at most a hundred of
 * them.
 */
import { cleanText } from '../../../platform/values/text.ts';

const AUDIT_FIELDS: readonly string[] = Object.freeze(['actor', 'accountType', 'repositorySelection', 'status', 'expiresAt', 'reasonCode']);
const PERMISSION_LEVELS: readonly string[] = Object.freeze(['read', 'write', 'admin']);

export function safeGithubAppAuditDetails(value: unknown): Record<string, unknown> {
  const source = (value && typeof value === 'object' ? value : {}) as Readonly<Record<string, unknown>>;
  const clean: Record<string, unknown> = {};
  for (const field of AUDIT_FIELDS) {
    if (source[field] != null) clean[field] = cleanText(String(source[field]), field === 'expiresAt' ? 80 : 120);
  }
  const permissions = source.permissions;
  if (permissions && typeof permissions === 'object' && !Array.isArray(permissions)) {
    clean.permissions = Object.fromEntries(Object.entries(permissions)
      .filter(([key, permission]) => /^[a-z_]{1,80}$/.test(key) && PERMISSION_LEVELS.includes(String(permission)))
      .slice(0, 100));
  }
  return clean;
}
