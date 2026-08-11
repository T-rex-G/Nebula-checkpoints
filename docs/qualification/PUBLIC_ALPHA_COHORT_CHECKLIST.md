# Public Alpha Cohort Checklist

Status: **Not executed**

Execute this checklist only for an explicitly authorized, exact frozen
candidate. Record operator, UTC time, source commit, archive filename, archive
SHA-256, qualification-record hash, and external evidence reference for every
completed section. Do not commit an executed copy, secrets, provider targets,
backup manifests, or tester identifiers to source.

## Opening checklist

- [ ] Freeze and independently verify the source commit, archive, and checksum.
- [ ] Verify the complete qualification record and artifact references for the
  same source commit and archive SHA-256.
- [ ] Verify the deployed `/api/version` release-tree SHA-256 exactly matches
  the digest independently computed from the frozen candidate before hosted
  smoke, load, or mutation traffic begins.
- [ ] Confirm every selected live job and exact target identity is present in
  the fresh signed authorization envelope; provider repositories are
  pre-created `nvx-alpha17-` sandboxes and are not themselves deletion targets.
- [ ] Verify encrypted pre-deploy backup and an isolated restore through the
  latest migration; retain both outside source and ephemeral hosting storage.
- [ ] Confirm production/development dependency classification, secret scan,
  security-boundary suite, live-provider, hosted, rollback, cleanup, purge, and
  both manual accessibility gates.
- [ ] Publish the exact privacy notice, terms, retention schedule, sandbox rule,
  support route, and known limitations.
- [ ] Start with no more than five invitations; confirm each canonical repository
  allowlist before invitation issuance.
- [ ] Enable bounded monitoring, correlation IDs, incident ownership, support
  response, revocation, and stop-cohort procedures without logging secrets or
  repository content.
- [ ] Confirm enforced client, repository, upload, push, snapshot, and Free-tier
  limits match the published limitations.
- [ ] Record the signed go decision and immutable external evidence reference.

## Closing checklist

- [ ] Stop issuing invitations and reject unused, expired, and revoked codes.
- [ ] Revoke all application sessions and complete provider-side revocation
  guidance without claiming provider revocation that was not verified.
- [ ] Remove temporary branches, proof files, webhooks, uploads, and other
  approved temporary resources, then verify their absence. Retain the
  pre-created qualification repositories unless a separate deletion is
  explicitly authorized.
- [ ] Create and verify the final encrypted backup in approved external storage;
  do not retain it in source, workflow artifacts, or Render local storage.
- [ ] Purge tester token-bearing state, browser/session state, and data scheduled
  for deletion while retaining only permitted pseudonymous integrity metadata.
- [ ] Run the closeout gate for the exact candidate and preserve its immutable
  external evidence references.
- [ ] Publish corrections to limitations, privacy/retention statements, and
  capability labels discovered during the cohort.
- [ ] Expand beyond five testers only after reviewing stability and security
  evidence; never exceed ten testers or two weeks under this alpha scope.
- [ ] Record the signed close decision, unresolved issues, owners, and immutable
  evidence reference.
