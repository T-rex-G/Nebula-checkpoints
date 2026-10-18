# Public Alpha Manual Accessibility Audit

Status: **Not executed**

This record is intentionally incomplete until a human tester executes every item with the named assistive technology. Automated Playwright and axe checks do not replace this audit.

Do not complete or commit an executed copy of this template to the source tree.
The signed result is external release evidence and must bind to the exact frozen
candidate named below. A result for another archive or source commit is not
transferable.

## How to run the two passes

A pass means one person using the product only through the screen reader, eyes
off the layout, and writing down what they heard. Every checkbox below is
something heard or reached, not something seen. Allow about 45 minutes for
each pass and use a disposable sandbox repository and invitation.

Before starting, open `/api/version` on the hosted candidate and keep the
response. Do the same when finished. Both go in the candidate binding.

**iPhone with VoiceOver**

1. Settings → Accessibility → VoiceOver → on. Settings → Accessibility →
   Accessibility Shortcut → VoiceOver, so a triple-click of the side button
   turns it on and off.
2. The gestures used:
   - swipe right or left with one finger to move to the next or previous item;
   - double-tap to activate the item read;
   - two-finger swipe up to read the whole page from the top;
   - rotate two fingers to choose a rotor setting, such as Headings or Form
     Controls, then swipe down or up to jump between them;
   - two-finger scrub (a quick Z) to go back or close a dialog.
3. Open the candidate URL in Safari. With the rotor on Headings, confirm the
   landing reads "Enter the Nebulaverse-X test orbit" first, and that service
   readiness is announced on its own ("Checking service readiness…" and then
   the result) without being touched.
4. Move to the invitation field, paste the invitation, accept the terms and
   enter. Note what is announced for a wrong invitation and for a correct one.
5. On the sign-in screen, move to "GitHub Personal Access Token". VoiceOver
   should read the guidance about the token's permissions with the field,
   before anything is typed. Sign in.
6. On the Overview, use the rotor on Headings: the hidden headings (Workspace
   trust, Security posture, Recent activity, Open pull requests) should each
   be reachable. Open one evidence or "Show the numbers" disclosure, read it,
   close it, and note where focus lands. It should be back on the control that
   opened it.
7. Open a repository, preview a change, and confirm the preview and its
   verification are told apart by words, not by colour alone.
8. Open Settings and find "Alpha privacy and credentials": "Disconnect from
   Nebulaverse-X", "End alpha session" and "Delete alpha data" should each
   announce a different name, and the text around them should say what each
   one does.
9. Turn the phone to landscape and back, and set Safari's text size to its
   largest (aA → larger). Nothing should need horizontal scrolling and every
   control should stay reachable.

**Desktop (VoiceOver for macOS, or NVDA on Windows)**

1. macOS: Cmd+F5 starts VoiceOver; VO means Control+Option. VO+Right moves to
   the next item, VO+Space activates it, VO+U opens the rotor (headings, links,
   form controls), and VO+A reads from the cursor. NVDA: Insert+Down reads
   all, H jumps to the next heading, F to the next form field, and Escape
   closes a dialog.
2. Use only the keyboard (Tab, Shift+Tab, Enter, Space, Escape, arrow keys)
   from the invitation through a verified change and its cleanup. Note any
   control focus skips or cannot leave.
3. Open a dialog, such as the repository picker or a destructive confirmation.
   Focus should stay inside it, Escape should close it, and focus should
   return to the control that opened it.
4. Watch for announcements that repeat. A status read twice, or read on every
   keystroke, is a finding.
5. Set browser zoom to 400% and repeat steps 2 and 3. Then turn on the
   system's Reduce Motion setting and reload: the landing scene and card
   arrivals should hold still.

Write every problem in the findings section with what was heard, where, and
how bad it is. A failure is recorded as a failure, not left blank.

## Candidate binding

- Subject: `Nebulaverse-X-v5.3.0-alpha.17.0`
- Source commit: ____________________
- Release archive filename: ____________________
- Release archive SHA-256: ____________________
- Qualification schema version: ____________________
- Hosted candidate URL: ____________________
- Auditor: ____________________
- Audit start and end (UTC): ____________________
- Start `/api/version` `releaseTreeSha256`: ____________________
- Start `/api/version` response external evidence reference: ____________________
- End `/api/version` `releaseTreeSha256`: ____________________
- End `/api/version` response external evidence reference: ____________________
- 320 CSS-pixel test environment: ____________________
- 400% zoom test environment: ____________________
- [ ] Both responses are retained externally; their release fingerprints are identical and equal the frozen candidate fingerprint.

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
- [ ] Privacy, terms, retention, sandbox-only scope, and provider-revocation responsibilities are reachable and understandable before consent.
  - Evidence/notes: ____________________
- [ ] At a 320 CSS-pixel viewport (or the 400% zoom equivalent), content reflows without horizontal page scrolling and all controls remain reachable.
  - Evidence/notes: ____________________
- [ ] Primary controls and destructive confirmations have usable mobile touch targets without overlap or gesture traps.
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
- [ ] At 400% browser zoom (or a 320 CSS-pixel viewport), content reflows without horizontal page scrolling and all controls remain reachable.
  - Evidence/notes: ____________________
- [ ] Reduced-motion preference suppresses non-essential animation and transitions.
  - Evidence/notes: ____________________
- [ ] Privacy, terms, retention, sandbox-only scope, and provider-revocation responsibilities are reachable and understandable before consent.
  - Evidence/notes: ____________________

## Findings and release evidence

- Issues found, severity, owner, and disposition: ____________________
- Audit date (UTC): ____________________
- Final disposition: [ ] Pass  [ ] Pass with documented exceptions  [ ] Fail
- Signature method and signer identity: ____________________
- 320 CSS-pixel evidence reference: ____________________
- 400% zoom evidence reference: ____________________
- External immutable evidence reference: ____________________
