# Public Alpha Manual Accessibility Audit

Status: **Not executed**

This record is intentionally incomplete until a human tester executes every item with the named assistive technology. Automated Playwright and axe checks do not replace this audit.

## iOS and VoiceOver

- [ ] iOS version: ____________________
- [ ] Device model: ____________________
- [ ] Browser and version: ____________________
- [ ] VoiceOver enabled and version recorded: ____________________
- [ ] Invitation entry, terms acceptance, validation, and service-readiness announcement completed without touch-only gestures.
  - Evidence/notes: ____________________
- [ ] Provider permission guidance read in a logical order before credential entry.
  - Evidence/notes: ____________________
- [ ] Repository trust summary read in this order: connection, evidence pipeline, risk, next safe action, supporting evidence.
  - Evidence/notes: ____________________
- [ ] Evidence detail opened, read, and closed with focus returned to its invoking control.
  - Evidence/notes: ____________________
- [ ] Controlled-action preview and verification states distinguished without relying on color.
  - Evidence/notes: ____________________
- [ ] Disconnect, provider-revocation guidance, session end, and delete-alpha-data controls announced distinctly.
  - Evidence/notes: ____________________

## Desktop screen reader and keyboard

- [ ] Operating system and version: ____________________
- [ ] Browser and version: ____________________
- [ ] Screen reader and version: ____________________
- [ ] Keyboard-only golden path completed from invitation through verified mutation and cleanup.
  - Evidence/notes: ____________________
- [ ] Visible focus present on every interactive control reached during the path.
  - Evidence/notes: ____________________
- [ ] Modal and safe-error dialogs contain focus, close with Escape, and restore focus.
  - Evidence/notes: ____________________
- [ ] Status and error announcements are understandable and are not duplicated excessively.
  - Evidence/notes: ____________________
- [ ] At 200% browser zoom, content reflows without horizontal page scrolling and all controls remain reachable.
  - Evidence/notes: ____________________
- [ ] Reduced-motion preference suppresses non-essential animation and transitions.
  - Evidence/notes: ____________________

## Findings and release evidence

- Issues found, severity, owner, and disposition: ____________________
- Release commit: ____________________
- Release archive filename: ____________________
- Release archive SHA-256: ____________________
- Auditor: ____________________
- Audit date (UTC): ____________________
- Final disposition: [ ] Pass  [ ] Pass with documented exceptions  [ ] Fail
