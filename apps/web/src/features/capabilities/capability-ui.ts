/*
 * Server-projected provider capabilities, for truthful client presentation.
 *
 * The server decides, per provider and authority, which capabilities are
 * Supported, Experimental or Unavailable, with the evidence and the reason.
 * This module holds that projection and applies it to every control that
 * declares a feature (`data-feature`): only what is Supported is offered.
 */
import { APP_HEADER, APP_HEADER_VALUE } from '../../../../../packages/contracts/src/api-envelope.ts';
import { CAPABILITY_STATUSES } from '../../../../../packages/contracts/src/capability.ts';
import type { CapabilityStatus } from '../../../../../packages/contracts/src/capability.ts';
import { field, hasFields } from '../../platform/values.ts';

export type { CapabilityStatus };

export interface Decision {
  readonly feature: string;
  readonly provider: string;
  readonly authority: string;
  readonly deployment: string;
  readonly status: CapabilityStatus;
  readonly evidenceState: string;
  readonly reason: string;
}

export interface Projection {
  readonly provider: string;
  readonly authority: string;
  readonly deployment: string;
  /*
   * Whether the server has given its verdict. Until it has -- or when asking
   * failed -- nothing is hidden: an outage is shown as refused controls that
   * say so, never as a page that quietly lost its features.
   */
  readonly answered: boolean;
  readonly features: Readonly<Record<string, Decision>>;
}

const FALLBACK_REASON = 'Capability status could not be loaded. Retry after the service is ready.';
let noteSequence = 0;
let loadSequence = 0;

let projection: Projection = Object.freeze({
  provider: 'github',
  authority: 'github.com',
  deployment: 'hosted-alpha',
  answered: false,
  features: Object.freeze({})
});

function statusOf(value: unknown): CapabilityStatus {
  return CAPABILITY_STATUSES.find(status => status === value) ?? 'Unavailable';
}

/* A word of the answer, or the fallback when it is missing or empty. */
function word(input: unknown, name: string, fallback: string): string {
  const value = field(input, name);
  return value ? String(value) : fallback;
}

function freezeDecision(input: unknown): Decision {
  return Object.freeze({
    feature: word(input, 'feature', ''),
    provider: word(input, 'provider', projection.provider || ''),
    authority: word(input, 'authority', projection.authority || ''),
    deployment: word(input, 'deployment', 'hosted-alpha'),
    status: statusOf(field(input, 'status')),
    evidenceState: word(input, 'evidenceState', 'Unavailable'),
    reason: word(input, 'reason', FALLBACK_REASON)
  });
}

export function decision(feature: unknown): Decision {
  const name = String(feature || '');
  const resolved = Object.hasOwn(projection.features, name) ? projection.features[name] : undefined;
  return freezeDecision(resolved || {
    feature: name,
    provider: projection.provider,
    authority: projection.authority,
    deployment: projection.deployment,
    status: 'Unavailable',
    evidenceState: 'Unavailable',
    reason: FALLBACK_REASON
  });
}

export function explain(feature: unknown): string {
  const resolved = decision(feature);
  return `${resolved.status}: ${resolved.reason}`;
}

function capabilityNote(element: HTMLElement): HTMLElement {
  const existing = element.dataset.capabilityNoteId;
  const found = existing ? document.getElementById(existing) : null;
  if (found) return found;
  const id = `nv-capability-${++noteSequence}`;
  const note = document.createElement('span');
  note.id = id;
  note.className = 'capability-state';
  element.dataset.capabilityNoteId = id;
  element.insertAdjacentElement('afterend', note);
  return note;
}

/*
 * One note per feature per screen.
 *
 * Six elements declare the recovery feature and three declare
 * repository.read, and several more are siblings sharing one feature, so a
 * single unavailable capability announced itself six times over. The first
 * control carrying a feature owns the note; every other control with that
 * feature is described by the same note, so each is still explained without
 * the screen repeating itself.
 *
 * The screen is found by walking upward by hand rather than through
 * closest(): the behaviour tests run this against a stand-in document whose
 * elements carry only the surface the module uses.
 */
function screenOf(element: HTMLElement): HTMLElement | null {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const tag = String(node.tagName || '').toLowerCase();
    if (tag === 'main' || tag === 'body') return node;
  }
  return null;
}

/*
 * Which refused controls the browser is allowed to silence.
 *
 * Setting `disabled` on a refused button looks tidy and says nothing. The
 * browser stops the press before any handler runs, so no code is left to
 * explain the refusal, and the control leaves the tab order, which takes the
 * accessible description of the reason with it. So a refused button stays a
 * button -- focusable, pressable -- and the press is intercepted below and
 * answered out loud.
 *
 * A text field is not the same case. Accepting typing it will discard is a
 * worse answer than refusing the keystroke, so inputs, selects and textareas
 * keep the native property.
 */
function refusesOutLoud(element: Element): boolean {
  const tag = String(element.tagName || '').toLowerCase();
  return tag === 'button' || element.getAttribute('role') === 'button';
}

/*
 * The refusal is stopped here, in the capture phase, before the control's
 * own handlers -- so a refused action cannot run whatever a caller happened
 * to bind to it, whichever way the control was pressed. Saying why belongs
 * to whoever owns the interface's voice, so this announces and no more.
 */
const ACTIVATION_KEYS = new Set(['Enter', ' ', 'Spacebar']);

/* The nearest value of a data attribute up the tree from `node` that `accept` takes, or nothing. */
function ancestorWith(node: unknown, name: string, accept: (value: string) => boolean = Boolean): string {
  for (let current = node; hasFields(current); current = field(current, 'parentElement')) {
    const value = field(field(current, 'dataset'), name);
    if (typeof value === 'string' && accept(value)) return value;
  }
  return '';
}

/* A control the browser can disable: a button, a field, a select, a fieldset. */
function disableable(target: Element): target is Element & { disabled: boolean } {
  return 'disabled' in target && typeof target.disabled === 'boolean';
}

function refuse(event: Event): void {
  if (!ancestorWith(event.target, 'capabilityBlocked', value => value === 'true')) return;
  const key = event instanceof KeyboardEvent ? event.key : '';
  if ((event.type === 'keydown' || event.type === 'keyup') && !ACTIVATION_KEYS.has(key)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  /*
   * One announcement per press. A keyboard activation arrives as a keydown,
   * a keyup and -- had the default not been prevented -- a click; the
   * keydown is the one that carries the reader's intent.
   */
  if (event.type === 'keyup') return;
  window.dispatchEvent(new CustomEvent('nebula:capability-refused', {
    detail: decision(ancestorWith(event.target, 'feature'))
  }));
}

/* Guarded because the behaviour tests run this module against a document that models only the surface it uses. */
if (typeof document.addEventListener === 'function') {
  for (const type of ['click', 'keydown', 'keyup']) document.addEventListener(type, refuse, true);
}

const noteOwners = new Map<string, HTMLElement>();

function dropNote(element: HTMLElement): void {
  const id = element.dataset.capabilityNoteId;
  const note = id ? document.getElementById(id) : null;
  if (note && typeof note.remove === 'function') note.remove();
  delete element.dataset.capabilityNoteId;
}

function featureControls(root: ParentNode): HTMLElement[] {
  return [...root.querySelectorAll('[data-feature]')].filter((element): element is HTMLElement => hasFields(field(element, 'dataset')));
}

/* Applies the projection to every control under `root` that declares a feature, and answers each one's decision. */
export function apply(root: ParentNode = document): Decision[] {
  const controls = featureControls(root);
  for (const [key, owner] of noteOwners) if (owner.isConnected === false) noteOwners.delete(key);
  for (const element of controls) {
    const resolved = decision(element.dataset.feature);
    /* Only what is Supported is offered. There is no opt-in for anything less. */
    const blocked = resolved.status !== 'Supported';
    /*
     * Once the server has answered, a control for anything that is not
     * Supported is not rendered at all: no dimmed button, no Experimental or
     * Unavailable badge. A control hidden here, and only here, comes back
     * when its capability becomes Supported.
     */
    const withheld = blocked && projection.answered;
    if (withheld) {
      if (element.hidden !== true) element.dataset.capabilityHidden = 'true';
      element.hidden = true;
    } else if (element.dataset.capabilityHidden === 'true') {
      element.hidden = false;
      delete element.dataset.capabilityHidden;
    }
    element.dataset.capabilityStatus = resolved.status;
    element.dataset.capabilityReason = resolved.reason;
    element.setAttribute('data-capability-reason', resolved.reason);
    element.setAttribute('aria-disabled', blocked ? 'true' : 'false');
    const targets: HTMLElement[] = [
      element,
      ...[...element.querySelectorAll<HTMLElement>('button, input, select, textarea, [role="button"]')]
    ];
    for (const target of targets) {
      target.setAttribute('aria-disabled', blocked ? 'true' : 'false');
      target.setAttribute('data-capability-blocked', blocked ? 'true' : 'false');
      if (disableable(target) && !(blocked && refusesOutLoud(target))) {
        if (blocked) {
          if (!target.disabled) target.dataset.capabilityDisabled = 'true';
          target.disabled = true;
        } else if (target.dataset.capabilityDisabled === 'true') {
          target.disabled = false;
          delete target.dataset.capabilityDisabled;
        }
      }
    }
    const screen = screenOf(element);
    const screenKey = `${(screen && screen.id) || 'root'}::${element.dataset.feature}`;
    if (withheld) {
      dropNote(element);
      for (const target of targets) if (typeof target.removeAttribute === 'function') target.removeAttribute('aria-describedby');
      if (noteOwners.get(screenKey) === element) noteOwners.delete(screenKey);
      continue;
    }
    const owner = noteOwners.get(screenKey);
    if (owner && owner !== element) {
      const staleId = element.dataset.capabilityNoteId;
      const stale = staleId ? document.getElementById(staleId) : null;
      if (stale) stale.remove();
      delete element.dataset.capabilityNoteId;
      const shared = owner.dataset.capabilityNoteId;
      if (shared) for (const target of targets) target.setAttribute('aria-describedby', shared);
      continue;
    }
    noteOwners.set(screenKey, element);
    const note = capabilityNote(element);
    note.className = `capability-state capability-${resolved.status.toLowerCase()}`;
    /*
     * The status is shown; the reason is carried as text a screen reader
     * reads and a pointer reveals. Printing the whole sentence inline put a
     * paragraph of prose beside every disabled control, which crowded the
     * top bar and told a reader the same thing several times over.
     */
    note.textContent = resolved.status;
    note.setAttribute('aria-label', resolved.status === 'Supported' ? 'Supported' : `${resolved.status} — ${resolved.reason}`);
    note.title = resolved.reason;
    note.dataset.feature = resolved.feature;
    for (const target of targets) target.setAttribute('aria-describedby', note.id);
  }
  return controls.map(element => decision(element.dataset.feature));
}

export interface LoadOptions {
  /* Whether to ask for the signed-in account's projection rather than the provider's. */
  readonly connected?: boolean;
}

export async function load(provider: unknown, authority: unknown, options: LoadOptions = {}): Promise<Projection> {
  const sequence = ++loadSequence;
  const normalizedProvider = String(provider || 'github').toLowerCase();
  const normalizedAuthority = String(authority || 'github.com').toLowerCase();
  if (normalizedProvider !== 'github' || normalizedAuthority !== 'github.com') {
    projection = Object.freeze({
      provider: normalizedProvider, authority: normalizedAuthority,
      deployment: 'hosted-alpha', answered: true, features: Object.freeze({})
    });
    return projection;
  }
  const query = new URLSearchParams({ provider: normalizedProvider, authority: normalizedAuthority });
  try {
    const endpoint = options.connected ? '/api/account/capabilities' : '/api/capabilities';
    const response = await fetch(`${endpoint}?${query}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { [APP_HEADER]: APP_HEADER_VALUE }
    });
    const body: unknown = await response.json().catch(() => ({}));
    const listed = field(body, 'features');
    if (!response.ok || !hasFields(body) || field(body, 'provider') !== normalizedProvider || !hasFields(listed)) {
      throw new Error('Capability projection is unavailable');
    }
    const features = Object.fromEntries(Object.entries(listed).map(([feature, value]) => [
      feature,
      freezeDecision({ ...(hasFields(value) ? value : {}), feature })
    ]));
    if (sequence !== loadSequence) return projection;
    projection = Object.freeze({
      provider: normalizedProvider,
      authority: word(body, 'authority', normalizedAuthority),
      deployment: word(body, 'deployment', 'hosted-alpha'),
      answered: true,
      features: Object.freeze(features)
    });
  } catch {
    if (sequence !== loadSequence) return projection;
    projection = Object.freeze({
      provider: normalizedProvider,
      authority: normalizedAuthority,
      deployment: 'hosted-alpha',
      answered: false,
      features: Object.freeze({})
    });
  }
  return projection;
}

/*
 * The projection itself, for callers that need to report on the whole set
 * rather than ask about one feature. Frozen on the way in, so a reader
 * cannot become a writer.
 */
export function features(): Readonly<Record<string, Decision>> {
  return projection.features;
}

/* Whether a feature's controls are left out entirely: the server answered, and not with Supported. */
export function withheld(feature: unknown): boolean {
  return projection.answered && decision(feature).status !== 'Supported';
}

const CapabilityUI = Object.freeze({ load, decision, apply, explain, features, withheld });
export default CapabilityUI;
