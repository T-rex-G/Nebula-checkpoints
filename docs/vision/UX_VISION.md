# Nebulaverse-X UX Vision

This intent is bounded by the generated [project state](../current/PROJECT_STATE.md)
and [release security gates](../release/RELEASE_SECURITY_GATES.md). A designed
state is not a claim that the current successor has qualified it.

## Identity

Preserve the dark, technical Nebulaverse-X visual identity, blue/cyan accents,
and Neural Command Centre. Improve clarity and confidence without replacing the
product with a generic administration template.

## Information hierarchy

Each primary workspace answers, in order:

1. Is the provider/repository connection current?
2. Is the application and evidence pipeline healthy?
3. Is a risk or governance issue present?
4. What is the recommended next action?
5. What evidence supports it?

The intended golden path reaches one evidence-backed, provider-supported,
verified and cleaned-up action within five minutes after provider access,
excluding Render/Neon wake delay.

## State and action rules

Golden-path screens must distinguish cold start, loading, empty, current, stale,
partial, degraded, recoverable error, blocked, verified success, unavailable
capability, access revoked, and session expired. Success appears only after
verification and required cleanup complete.

Capability status and evidence state are separate. Unavailable actions are
disabled before interaction with an exact reason; experimental actions are
labelled with their limitation. Provider differences are visible before
connection and inside feature surfaces.

Consequential actions show scope and preview, never imply authority from a
visible control, and return a bounded error with safe-state guidance and a
copyable correlation ID.

## Accessibility and responsive behavior

The target is WCAG 2.2 AA behavior for supported golden paths: semantic
landmarks, labelled controls, full keyboard operation, visible and restored
focus, focus-contained dialogs, screen-reader announcements, non-colour-only
states, verified contrast, reduced motion, 320 CSS-pixel/400% reflow, and mobile layouts.

Automated public-alpha accessibility qualification passes on the supported
desktop and mobile golden-path screens, including axe serious/critical checks,
keyboard completion, focus behavior, announcements, reduced motion and 200%
reflow. Manual VoiceOver on iOS and one desktop screen-reader pass remain
required before cohort opening. This is qualification evidence, not an
accessibility certification claim.
