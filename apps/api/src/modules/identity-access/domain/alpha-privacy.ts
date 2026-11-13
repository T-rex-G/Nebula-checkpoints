const clean = (value: unknown, max: number): string => String(value || '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .trim()
  .slice(0, max);

export interface AlphaRetentionPolicy {
  readonly alphaSessionsDays: number;
  readonly verifiedEventsDays: number;
  readonly operationalLogsDays: number;
  readonly snapshotsDays: number;
  readonly evidenceExportsDays: number;
  readonly inviteMetadataDaysAfterClose: number;
}

export function alphaRetentionPolicy(): AlphaRetentionPolicy {
  return Object.freeze({
    alphaSessionsDays: 7,
    verifiedEventsDays: 30,
    operationalLogsDays: 14,
    snapshotsDays: 30,
    evidenceExportsDays: 30,
    inviteMetadataDaysAfterClose: 30
  });
}

export function alphaActorLabel(alpha: unknown): string {
  const compact = String((alpha as { readonly testerId?: unknown } | null | undefined)?.testerId || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(compact)) throw new TypeError('alpha testerId is invalid');
  return `alpha:${compact.slice(0, 12)}`;
}

/* What a tester's support request may carry: bounded text, no free-form content. */
export interface SupportBundle {
  readonly releaseVersion: string;
  readonly correlationId: string;
  readonly provider: string;
  readonly feature: string;
  readonly capabilityStatus: string;
  readonly errorCode: string;
  readonly timestamp: string;
  readonly runtime: string;
}

export interface SupportBundleInput {
  readonly releaseVersion?: unknown;
  readonly correlationId?: unknown;
  readonly provider?: unknown;
  readonly feature?: unknown;
  readonly capabilityStatus?: unknown;
  readonly errorCode?: unknown;
  readonly timestamp?: unknown;
  readonly runtime?: unknown;
}

export function buildSupportBundle(input: SupportBundleInput): SupportBundle {
  return Object.freeze({
    releaseVersion: clean(input.releaseVersion, 80),
    correlationId: clean(input.correlationId, 80),
    provider: clean(input.provider, 20),
    feature: clean(input.feature, 80),
    capabilityStatus: clean(input.capabilityStatus, 20),
    errorCode: clean(input.errorCode, 80),
    timestamp: new Date(input.timestamp as string | number | Date).toISOString(),
    runtime: clean(input.runtime, 200)
  });
}

export function sanitizeFeedback(input: { readonly feature?: unknown }, context: SupportBundleInput): SupportBundle {
  return buildSupportBundle({
    ...context,
    feature: input.feature
  });
}

export interface RevocationGuidance {
  readonly label: string;
  readonly url: string | null;
  readonly automatic: false;
}

export function providerRevocationGuidance(account: unknown): RevocationGuidance {
  const fields = account as { readonly provider?: unknown; readonly authMethod?: unknown } | null | undefined;
  const provider = String(fields?.provider || 'github').trim().toLowerCase();
  if (provider === 'github') {
    return Object.freeze({
      label: fields?.authMethod === 'github-app'
        ? 'Manage or uninstall the GitHub App'
        : 'Revoke the token on GitHub',
      url: fields?.authMethod === 'github-app'
        ? 'https://github.com/settings/installations'
        : 'https://github.com/settings/tokens',
      automatic: false
    });
  }
  // Retired account records remain eligible for local privacy cleanup. Never
  // construct or contact a URL from their saved provider configuration.
  if (!['gitlab', 'gitea'].includes(provider)) throw new TypeError('provider is unsupported');
  return Object.freeze({
    label: 'Revoke this retired provider credential manually in its account settings',
    url: null,
    automatic: false
  });
}
