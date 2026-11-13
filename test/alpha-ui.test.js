'use strict';

/*
 * The access page, run against a stand-in for the browser
 * (apps/web/src/features/access/alpha-ui.ts): what it asks the server, in
 * what order, what it shows for each answer, and when it hands the reader
 * over to the workspace. Each scenario runs the module afresh.
 */

const assert = require('node:assert/strict');
const { loadPageModule } = require('./helpers/page-module');

/* A page with the access card's elements, a server that answers as each scenario says, and a clock that only moves when told. */
function page({ search = '', answers }) {
  const classes = {};
  for (const name of ['HTMLElement', 'HTMLInputElement', 'HTMLButtonElement']) classes[name] = class {};
  Object.setPrototypeOf(classes.HTMLInputElement.prototype, classes.HTMLElement.prototype);
  Object.setPrototypeOf(classes.HTMLButtonElement.prototype, classes.HTMLElement.prototype);
  const state = { focusedId: null, events: [], requests: [], waits: [], url: null };
  /* An element of the kind the module asks about (instanceof), with the surface it uses. */
  const make = (id, tag, kind) => {
    const element = Object.create(classes[kind].prototype);
    const listeners = new Map();
    const classes_ = new Set();
    return Object.assign(element, {
      id,
      tagName: tag.toUpperCase(),
      hidden: false,
      textContent: '',
      focused: null,
      classList: { add: name => classes_.add(name), remove: name => classes_.delete(name), has: name => classes_.has(name) },
      addEventListener: (type, listener) => listeners.set(type, [...(listeners.get(type) || []), listener]),
      focus: options => { element.focused = options || {}; state.focusedId = id; },
      fire: (type, event = {}) => { for (const listener of listeners.get(type) || []) listener(event); }
    });
  };
  const elements = {
    'page-alpha-access': make('page-alpha-access', 'section', 'HTMLElement'),
    'page-overview': make('page-overview', 'section', 'HTMLElement'),
    alphaWakeState: make('alphaWakeState', 'p', 'HTMLElement'),
    alphaTermsVersion: make('alphaTermsVersion', 'span', 'HTMLElement'),
    alphaAccessError: make('alphaAccessError', 'p', 'HTMLElement'),
    alphaInviteInput: Object.assign(make('alphaInviteInput', 'input', 'HTMLInputElement'), { value: '' }),
    alphaTermsAccept: Object.assign(make('alphaTermsAccept', 'input', 'HTMLInputElement'), { checked: false }),
    alphaRedeemBtn: Object.assign(make('alphaRedeemBtn', 'button', 'HTMLButtonElement'), { disabled: false }),
    alphaOpenAccess: make('alphaOpenAccess', 'div', 'HTMLElement'),
    alphaOpenNote: make('alphaOpenNote', 'p', 'HTMLElement'),
    alphaPassThrough: Object.assign(make('alphaPassThrough', 'button', 'HTMLButtonElement'), { disabled: false })
  };
  elements['page-overview'].classList.add('active');
  const labels = { alphaInviteInput: make('', 'label', 'HTMLElement'), alphaTermsAccept: make('', 'label', 'HTMLElement') };
  const closingCall = make('', 'a', 'HTMLElement');
  const document = {
    getElementById: id => elements[id] || null,
    querySelectorAll: selector => (selector === '.page' ? [elements['page-alpha-access'], elements['page-overview']] : []),
    querySelector: selector => {
      const label = /^label\[for="(.+)"\]$/.exec(selector);
      if (label) return labels[label[1]] || null;
      return selector === '.lp-cta-btn' ? closingCall : null;
    }
  };
  const location = { search, pathname: '/', hash: '#/overview' };
  const window = {
    location,
    history: { replaceState: (_state, _title, url) => { state.url = url; } },
    scrollTo: () => {},
    dispatchEvent: event => { state.events.push(event.type); }
  };
  class CustomEvent { constructor(type) { this.type = type; } }
  const fetch = (url, options) => new Promise((resolve, reject) => {
    state.requests.push({ url, options, body: options && options.body ? JSON.parse(options.body) : undefined });
    const answer = answers(url, options, state);
    const reply = typeof answer === 'function' ? answer : () => answer;
    Promise.resolve().then(() => {
      const { status = 200, body = {}, throws } = reply();
      if (throws) { reject(new Error(throws)); return; }
      resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
    });
  });
  const setTimeout = (callback, ms) => { state.waits.push(ms); Promise.resolve().then(callback); return state.waits.length; };
  const AlphaUI = loadPageModule('apps/web/src/features/access/alpha-ui.ts', {
    document, window, fetch, setTimeout, CustomEvent, URLSearchParams, Promise, Object, String, Error,
    ...classes
  });
  return { AlphaUI, elements, labels, closingCall, state };
}

/*
 * Everything the stand-ins answer is answered in a microtask -- the server, and
 * the clock -- so the page has settled once the queue is empty: one turn of
 * the event loop, however many awaits the module's own realm adds between them.
 */
const settle = () => new Promise(resolve => { setImmediate(resolve); });

const ready = { body: { ok: true } };
const gate = (extra = {}) => ({ body: { mode: 'invite', termsVersion: '2026-10', authenticated: false, ...extra } });

const scenarios = [];
const scenario = (name, run) => scenarios.push([name, run]);

scenario('the gate asks readiness and its setting at once, and shows the invitation form when entry is by invitation', async () => {
  const order = [];
  let askedByFirstAnswer = 0;
  const { AlphaUI, elements, labels, closingCall, state } = page({
    answers: (url, _options, asked) => {
      order.push(url);
      return url === '/readyz' ? () => { askedByFirstAnswer = asked.requests.length; return ready; } : gate();
    }
  });
  const result = await AlphaUI.boot();
  assert.deepEqual(order, ['/readyz', '/api/alpha/status']);
  assert.equal(askedByFirstAnswer, 2, 'both asked before either answered: the setting does not wait out the readiness ladder');
  for (const request of state.requests) {
    assert.deepEqual(JSON.parse(JSON.stringify(request.options)), { credentials: 'same-origin', cache: 'no-store', headers: { 'x-nv': '1' } }, request.url);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { allowed: false, reason: 'access-required', status: gate().body });
  assert.ok(Object.isFrozen(result));
  assert.ok(elements['page-alpha-access'].classList.has('active') && !elements['page-overview'].classList.has('active'), 'the access page is the one page shown');
  for (const id of ['alphaInviteInput', 'alphaTermsAccept', 'alphaRedeemBtn']) assert.equal(elements[id].hidden, false, id);
  assert.equal(labels.alphaInviteInput.hidden, false);
  assert.equal(elements.alphaOpenAccess.hidden, true);
  assert.equal(elements.alphaTermsVersion.textContent, 'Terms 2026-10');
  assert.equal(elements.alphaWakeState.textContent, 'Ready');
  assert.equal(closingCall.textContent, 'Request entry');
  assert.equal(state.focusedId, 'alphaInviteInput');
  assert.deepEqual(JSON.parse(JSON.stringify(elements.alphaInviteInput.focused)), { preventScroll: true }, 'focused without scrolling the landing away');
  assert.deepEqual(state.events, ['nebula:alpha-access-gated']);
  assert.equal(AlphaUI.gateEnabled(), true);
});

scenario('an invitation is redeemed only with the terms accepted and a code, against the terms shown, and the code leaves the field at once', async () => {
  const { AlphaUI, elements, state } = page({
    answers: url => (url === '/readyz' ? ready : url === '/api/alpha/status' ? gate() : { status: 200, body: { ok: true } })
  });
  await AlphaUI.boot();
  const press = async () => { elements.alphaRedeemBtn.fire('click'); await settle(); };
  await press();
  assert.equal(elements.alphaAccessError.textContent, 'Accept the current alpha terms before continuing.');
  assert.equal(elements.alphaAccessError.hidden, false);
  assert.equal(state.focusedId, 'alphaTermsAccept');
  elements.alphaTermsAccept.checked = true;
  elements.alphaInviteInput.value = '   ';
  await press();
  assert.equal(elements.alphaAccessError.textContent, 'Invitation could not be redeemed. Check the invitation and try again.');
  assert.equal(state.requests.filter(request => request.url === '/api/alpha/redeem').length, 0, 'nothing is sent without a code');
  elements.alphaInviteInput.value = '  nv-invite-123  ';
  elements.alphaRedeemBtn.fire('click');
  assert.equal(elements.alphaInviteInput.value, '', 'the one-time code is cleared the moment it is sent');
  assert.equal(elements.alphaRedeemBtn.disabled, true, 'and cannot be sent twice while it is on its way');
  await settle();
  const redeem = state.requests.find(request => request.url === '/api/alpha/redeem');
  assert.deepEqual(redeem.body, { code: 'nv-invite-123', acceptedTermsVersion: '2026-10' });
  assert.equal(redeem.options.method, 'POST');
  assert.deepEqual(JSON.parse(JSON.stringify(redeem.options.headers)), { 'x-nv': '1', 'Content-Type': 'application/json' });
  assert.equal(elements.alphaRedeemBtn.disabled, false);
  assert.deepEqual(state.events, ['nebula:alpha-access-gated', 'nebula:alpha-access-granted']);
  assert.equal(elements.alphaAccessError.hidden, true);
});

scenario('a refused invitation says so in the same words whatever the server said, and returns the reader to the field', async () => {
  const { AlphaUI, elements, state } = page({
    answers: url => (url === '/readyz' ? ready : url === '/api/alpha/status' ? gate() : { status: 403, body: { error: 'Invitation INV-42 was already used by maya', code: 'ALPHA_INVITE_USED' } })
  });
  await AlphaUI.boot();
  elements.alphaTermsAccept.checked = true;
  elements.alphaInviteInput.value = 'used';
  elements.alphaInviteInput.fire('keydown', { key: 'Enter' });
  await settle();
  assert.equal(elements.alphaAccessError.textContent, 'Invitation could not be redeemed. Check the invitation and try again.');
  assert.equal(state.focusedId, 'alphaInviteInput');
  assert.deepEqual(JSON.parse(JSON.stringify(elements.alphaInviteInput.focused)), { preventScroll: true }, 'returned to the field without scrolling the landing away');
  assert.ok(!state.events.includes('nebula:alpha-access-granted'));
  elements.alphaInviteInput.fire('keydown', { key: 'a' });
  await settle();
  assert.equal(state.requests.filter(request => request.url === '/api/alpha/redeem').length, 1, 'only Enter sends');
});

scenario('a sleeping service is waited for on a ladder of 1, 2, 4 and 8 seconds, and then said to be unavailable', async () => {
  const { AlphaUI, elements, state } = page({ answers: url => (url === '/readyz' ? { status: 503, body: { database: 'unavailable' } } : gate()) });
  const result = await AlphaUI.boot();
  assert.deepEqual(state.waits, [1000, 2000, 4000, 8000]);
  assert.equal(state.requests.filter(request => request.url === '/readyz').length, 4);
  assert.equal(elements.alphaWakeState.textContent, 'Temporarily unavailable');
  assert.equal(result.reason, 'unavailable', 'no invitation field is offered that the database cannot honour');
  assert.equal(elements.alphaInviteInput.hidden, false, 'the form was never raised');
  assert.ok(!state.events.includes('nebula:alpha-access-gated'));
});

scenario('a status that cannot be read while the store wakes is asked once more when the database answers', async () => {
  let statusAsked = 0;
  const { AlphaUI, state } = page({
    answers: url => {
      if (url === '/readyz') return ready;
      statusAsked += 1;
      return statusAsked === 1 ? { status: 503, body: { code: 'ALPHA_ACCESS_UNAVAILABLE' } } : gate({ authenticated: true });
    }
  });
  const result = await AlphaUI.boot();
  assert.equal(statusAsked, 2);
  assert.deepEqual([result.allowed, result.reason], [true, undefined]);
  assert.deepEqual(state.events, []);
});

scenario('entry that is open says so, and offers the way through that fits who is asking', async () => {
  for (const [authenticated, way] of [[false, 'Get started'], [true, 'Open your workspace']]) {
    const { AlphaUI, elements, closingCall, state } = page({ answers: url => (url === '/readyz' ? ready : { body: { mode: 'off', authenticated } }) });
    const result = await AlphaUI.boot();
    assert.deepEqual([result.allowed, result.reason], [false, 'open']);
    for (const id of ['alphaInviteInput', 'alphaTermsAccept', 'alphaRedeemBtn']) assert.equal(elements[id].hidden, true, id);
    assert.equal(elements.alphaOpenAccess.hidden, false);
    assert.equal(elements.alphaPassThrough.textContent, way);
    assert.equal(closingCall.textContent, way);
    assert.match(elements.alphaOpenNote.textContent, authenticated ? /already signed in/ : /No invitation is needed/);
    assert.equal(elements.alphaTermsVersion.textContent, 'Current alpha terms');
    assert.equal(AlphaUI.gateEnabled(), false);
    elements.alphaPassThrough.fire('click');
    assert.deepEqual(state.events, ['nebula:alpha-access-gated', 'nebula:alpha-access-granted']);
  }
});

scenario('open entry with no database behind it says the workspace is unavailable rather than offering the trip', async () => {
  const { AlphaUI, elements } = page({ answers: url => (url === '/readyz' ? { status: 503 } : { body: { mode: 'off' } }) });
  await AlphaUI.boot();
  await settle();
  assert.equal(elements.alphaPassThrough.disabled, true);
  assert.equal(elements.alphaPassThrough.textContent, 'Workspace unavailable');
  assert.match(elements.alphaOpenNote.textContent, /temporarily unavailable/);
});

scenario('a sign-in that came back says why it did not finish, and leaves the address as it was otherwise', async () => {
  const { AlphaUI, elements, state } = page({ search: '?oauth=state_mismatch&ref=mail', answers: url => (url === '/readyz' ? ready : { body: { mode: 'off' } }) });
  await AlphaUI.boot();
  assert.equal(elements.alphaAccessError.textContent, 'Could not finish signing in with GitHub — that sign-in did not match this browser session. Start it again from this page.');
  assert.equal(elements.alphaAccessError.hidden, false, 'kept through the open card being drawn');
  assert.equal(state.url, '/?ref=mail#/overview');
  const unknown = page({ search: '?oauth=rate_limited', answers: url => (url === '/readyz' ? ready : { body: { mode: 'off' } }) });
  await unknown.AlphaUI.boot();
  assert.equal(unknown.elements.alphaAccessError.textContent, 'Could not finish signing in with GitHub — it failed (rate limited).');
  assert.equal(unknown.state.url, '/#/overview');
});

scenario('a reader back from a finished sign-in is handed over, not shown the door again', async () => {
  const { AlphaUI, state } = page({ search: '?entered=1', answers: url => (url === '/readyz' ? ready : { body: { mode: 'off' } }) });
  const result = await AlphaUI.boot();
  assert.deepEqual([result.allowed, result.reason], [true, 'entered']);
  assert.deepEqual(state.events, []);
  assert.equal(state.url, '/#/overview');
});

scenario('a revoked or expired session is returned to the gate saying which', async () => {
  for (const [body, reason, words] of [
    [{ mode: 'invite', access: 'revoked' }, 'revoked', 'This alpha access was revoked. Request a new invitation from the operator.'],
    [{ mode: 'invite', code: 'ALPHA_ACCESS_REVOKED' }, 'revoked', 'This alpha access was revoked. Request a new invitation from the operator.'],
    [{ mode: 'invite', access: 'expired' }, 'expired', 'This alpha session expired. Redeem a new invitation to continue.'],
    [{ mode: 'invite', code: 'ALPHA_SESSION_EXPIRED' }, 'expired', 'This alpha session expired. Redeem a new invitation to continue.']
  ]) {
    const { AlphaUI, elements } = page({ answers: url => (url === '/readyz' ? ready : { body }) });
    /* Terms ticked in the session that ended are not ticked for the next one. */
    elements.alphaTermsAccept.checked = true;
    const result = await AlphaUI.boot();
    assert.equal(result.reason, reason);
    assert.equal(elements.alphaTermsAccept.checked, false, 'the gate asks for the terms afresh');
    assert.equal(elements.alphaAccessError.textContent, words);
    assert.equal(elements.alphaInviteInput.hidden, false);
    assert.equal(elements.alphaWakeState.textContent, 'Ready');
  }
});

scenario('a status that never answers is unavailable, and the gate is taken as off', async () => {
  const { AlphaUI, elements } = page({ answers: url => (url === '/readyz' ? ready : { throws: 'network' }) });
  const result = await AlphaUI.boot();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { allowed: false, reason: 'unavailable' });
  assert.equal(elements.alphaWakeState.textContent, 'Temporarily unavailable');
  assert.equal(AlphaUI.gateEnabled(), false);
});

(async () => {
  let failed = 0;
  for (const [name, run] of scenarios) {
    try {
      await run();
      console.log(`ok - ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`not ok - ${name}\n${error.stack}`);
    }
  }
  if (failed) {
    console.error(`${failed} of ${scenarios.length} access page scenarios failed`);
    process.exit(1);
  }
  console.log(`access page: ${scenarios.length} scenarios passed`);
})();
