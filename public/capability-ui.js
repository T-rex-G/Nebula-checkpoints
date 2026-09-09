/* Server-projected provider capabilities for truthful client presentation. */
'use strict';

(function capabilityUiModule(global) {
  const VALID_STATUS = new Set(['Supported', 'Experimental', 'Unavailable']);
  const FALLBACK_REASON = 'Capability status could not be loaded. Retry after the service is ready.';
  let noteSequence = 0;
  let projection = Object.freeze({
    provider: 'github',
    authority: 'github.com',
    deployment: 'hosted-alpha',
    features: Object.freeze({})
  });

  function freezeDecision(input) {
    return Object.freeze({
      feature: String(input && input.feature || ''),
      provider: String(input && input.provider || projection.provider || ''),
      authority: String(input && input.authority || projection.authority || ''),
      deployment: String(input && input.deployment || 'hosted-alpha'),
      status: VALID_STATUS.has(input && input.status) ? input.status : 'Unavailable',
      evidenceState: String(input && input.evidenceState || 'Unavailable'),
      reason: String(input && input.reason || FALLBACK_REASON)
    });
  }

  function decision(feature) {
    const name = String(feature || '');
    const resolved = projection.features && projection.features[name];
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

  function explain(feature) {
    const resolved = decision(feature);
    return `${resolved.status}: ${resolved.reason}`;
  }

  function capabilityNote(element) {
    let id = element.dataset.capabilityNoteId;
    let note = id ? document.getElementById(id) : null;
    if (note) return note;
    id = `nv-capability-${++noteSequence}`;
    note = document.createElement('span');
    note.id = id;
    note.className = 'capability-state';
    element.dataset.capabilityNoteId = id;
    element.insertAdjacentElement('afterend', note);
    return note;
  }

  /*
   * One note per feature, on the outermost control that carries it.
   *
   * Six elements declare the recovery feature and three declare
   * repository.read, so a single unavailable capability printed the same
   * sentence six times beside six controls. A note on an element whose
   * ancestor already carries the same feature says nothing the ancestor's
   * note has not already said.
   */
  /*
   * One note per feature per screen.
   *
   * Six elements declare the recovery feature and three declare
   * repository.read, and several more are siblings sharing one feature, so a
   * single unavailable capability announced itself six times over. The first
   * control carrying a feature owns the note; every other control with that
   * feature is described by the same note, so each is still explained without
   * the screen repeating itself.
   */
  function screenOf(element) {
    /*
     * Walks upward by hand rather than through closest(), because this runs
     * against a stubbed document in the behaviour tests where elements carry
     * only the surface the module actually uses.
     */
    for (let node = element; node; node = node.parentElement) {
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
   * accessible description of the reason with it. What the reader is left with
   * is a dimmed control that does nothing, forever. The same action drawn as a
   * palette entry has always explained itself, for no better reason than that
   * a div has no `disabled` property to set.
   *
   * So a refused button stays a button -- focusable, pressable -- and the
   * press is intercepted below and answered out loud.
   *
   * A text field is not the same case. Accepting typing it will discard is a
   * worse answer than refusing the keystroke, so inputs, selects and textareas
   * keep the native property.
   */
  function refusesOutLoud(element) {
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

  function ancestorWith(node, read) {
    for (let current = node; current; current = current.parentElement) {
      const found = current.dataset ? read(current.dataset) : undefined;
      if (found) return found;
    }
    return '';
  }

  function refuse(event) {
    if (!ancestorWith(event.target, data => data.capabilityBlocked === 'true')) return;
    if ((event.type === 'keydown' || event.type === 'keyup') && !ACTIVATION_KEYS.has(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    /*
     * One announcement per press. A keyboard activation arrives as a keydown,
     * a keyup and -- had the default not been prevented -- a click; the
     * keydown is the one that carries the reader's intent.
     */
    if (event.type === 'keyup') return;
    global.dispatchEvent(new CustomEvent('nebula:capability-refused', {
      detail: decision(ancestorWith(event.target, data => data.feature))
    }));
  }

  /*
   * Guarded because the behaviour tests run this module against a document
   * that models only the surface it uses. There is nothing to listen to there.
   */
  if (typeof document.addEventListener === 'function') {
    for (const type of ['click', 'keydown', 'keyup']) document.addEventListener(type, refuse, true);
  }

  const noteOwners = new Map();
  function apply(root = document) {
    const controls = [...root.querySelectorAll('[data-feature]')];
    for (const [key, owner] of noteOwners) if (owner.isConnected === false) noteOwners.delete(key);
    for (const element of controls) {
      const resolved = decision(element.dataset.feature);
      const experimentalAllowed = element.dataset.allowExperimental === 'true';
      const unavailable = resolved.status === 'Unavailable';
      const experimentalBlocked = resolved.status === 'Experimental' && !experimentalAllowed;
      const blocked = unavailable || experimentalBlocked;
      element.dataset.capabilityStatus = resolved.status;
      element.dataset.capabilityReason = resolved.reason;
      element.setAttribute('data-capability-reason', resolved.reason);
      element.setAttribute('aria-disabled', blocked ? 'true' : 'false');
      const targets = [
        element,
        ...element.querySelectorAll('button, input, select, textarea, [role="button"]')
      ];
      for (const target of targets) {
        target.setAttribute('aria-disabled', blocked ? 'true' : 'false');
        target.setAttribute('data-capability-blocked', blocked ? 'true' : 'false');
        if ('disabled' in target && !(blocked && refusesOutLoud(target))) {
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
      const owner = noteOwners.get(screenKey);
      if (owner && owner !== element) {
        const stale = element.dataset.capabilityNoteId
          && document.getElementById(element.dataset.capabilityNoteId);
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
      /*
       * Sighted readers get the status; the accessible name carries the reason
       * as well, so the explanation reaches a screen reader without printing a
       * sentence beside every disabled control.
       */
      note.setAttribute('aria-label', resolved.status === 'Supported'
        ? 'Supported'
        : `${resolved.status} — ${resolved.reason}`);
      note.title = resolved.reason;
      note.dataset.feature = resolved.feature;
      for (const target of targets) target.setAttribute('aria-describedby', note.id);
    }
    return controls.map(element => decision(element.dataset.feature));
  }

  async function load(provider, authority, options = {}) {
    const normalizedProvider = ['github', 'gitlab', 'gitea'].includes(String(provider || '').toLowerCase())
      ? String(provider).toLowerCase()
      : 'github';
    const normalizedAuthority = String(authority || (normalizedProvider === 'github' ? 'github.com' : '')).toLowerCase();
    const query = new URLSearchParams({ provider: normalizedProvider, authority: normalizedAuthority });
    try {
      const response = options.request ? null : await fetch(`/api/capabilities?${query}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-nv': '1' }
      });
      const body = options.request ? await options.request() : await response.json().catch(() => ({}));
      if ((response && !response.ok) || !body || body.provider !== normalizedProvider || !body.features) {
        throw new Error('Capability projection is unavailable');
      }
      const features = Object.fromEntries(Object.entries(body.features).map(([feature, value]) => [
        feature,
        freezeDecision({ ...value, feature })
      ]));
      projection = Object.freeze({
        provider: normalizedProvider,
        authority: String(body.authority || normalizedAuthority),
        deployment: String(body.deployment || 'hosted-alpha'),
        features: Object.freeze(features)
      });
    } catch {
      projection = Object.freeze({
        provider: normalizedProvider,
        authority: normalizedAuthority,
        deployment: 'hosted-alpha',
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
  function features() {
    return projection.features || Object.freeze({});
  }

  global.NebulaCapabilityUI = Object.freeze({ load, decision, apply, explain, features });
})(window);
