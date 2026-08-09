# Orphan provider-resource cleanup

## Trigger

Use this runbook when disconnect, revocation, deletion, or shutdown leaves a cleanup task pending or blocked.

## Containment

Freeze further mutations for the affected tester and provider identity. Do not close the task until webhook and disposable-branch absence or ownership has been verified.

```bash
node scripts/alpha-privacy.js cleanup-status
node scripts/alpha-privacy.js retry-cleanup --cleanup "$NV_CLEANUP_ID"
```

## Verification

Check the provider directly with an authorized operator account. Verify absence of the owned webhook and disposable branch, then rerun cleanup status. A missing credential is a blocker, not proof of absence.

```bash
node scripts/alpha-privacy.js cleanup-status
```

## Recovery

Supply a valid provider credential through the approved environment, retry once, and verify the immutable cleanup report. Escalate repeated failures without creating a second task.

## Evidence

Record the hashed cleanup reference, provider, attempt count, safe status/code, absence proof timestamp, and immutable report digest. Exclude raw resource identifiers and credentials.

```bash
date -u +%Y-%m-%dT%H:%M:%SZ
git rev-parse HEAD
```
