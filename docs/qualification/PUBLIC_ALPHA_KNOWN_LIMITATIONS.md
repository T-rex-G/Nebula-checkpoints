# Public Alpha Known Limitations

Status: **Release-blocking publication draft; qualification pending**

These limitations apply to the controlled `5.3.0-alpha.17.0` cohort. They must
be published without dilution if the exact candidate qualifies. A limitation
cannot conceal a failed gate, failed cleanup, or known critical/high defect.

## Service and cohort limits

- The cohort is invitation-only, lasts no more than two weeks, and is limited
  to 5–10 testers.
- Sandbox repositories are required. Production, irreplaceable, regulated, or
  materially sensitive repositories and data are prohibited.
- Render Free may stop after inactivity and can take time to wake. Availability,
  memory, CPU, and ephemeral filesystem behavior are Free-tier constraints.
- Neon Free may scale to zero, take time to wake, and is constrained by its Free
  storage, compute, and usage quotas.
- This is an evaluation service with no production availability, durability,
  performance, support-response, or recovery-time SLA.

## Provider and feature limits

- GitHub is the complete intended golden path. GitLab and Gitea expose narrower,
  registry-qualified supported subsets; complete provider parity is not claimed.
- GitLab and Gitea installations with a provider URL path prefix are unavailable
  for this cohort.
- Verified live events are GitHub-only for this cohort.
- Optional YARA scanning is unavailable unless it is explicitly configured and
  qualifies against the exact candidate. Its absence is not represented as a
  completed scan.

## Resource limits

- Git data and native push are limited to 16 MB.
- Direct uploads are limited to 25 MB.
- Only one upload may run at a time.
- At most 10 live clients and two clients per repository are allowed; hosted
  qualification may lower these limits.
- Repository creation/deletion, global search, and unconstrained global
  notifications are unavailable.

Any critical/high defect, capability-label mismatch, unsafe or unverified
mutation, credential/session exposure, cleanup failure, restore failure, or
failed go/no-go criterion closes the cohort. It is not an accepted limitation.
