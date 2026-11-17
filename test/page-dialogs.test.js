'use strict';

/*
 * The page's notices and its dialog, asked directly: the toasts
 * (components/toasts.ts), where a layer grows from
 * (components/overlay-origin.ts), the dialog (components/modal.ts), step-up
 * (features/security/step-up.ts), Safe Passage as the page offers it
 * (features/governance/safe-passage.ts), and the escaping their markup uses
 * (platform/html.ts). The page using them is test/e2e/page-dialogs.spec.js.
 */

const assert = require('assert');
const { createToasts, toneOf, TOAST_SHOWN_MS, TOAST_FADE_MS } = require('../apps/web/src/components/toasts.ts');
const { anchorOverlayOrigin, originOf } = require('../apps/web/src/components/overlay-origin.ts');
const { createModal } = require('../apps/web/src/components/modal.ts');
const { createStepUp, stepUpBody, mismatchMessage, STEP_UP_HEADER } = require('../apps/web/src/features/security/step-up.ts');
const { createSafePassage, offerOf, offerBody, pullBody, MOVED_ON } = require('../apps/web/src/features/governance/safe-passage.ts');
const { escapeHtml, escapeAttribute } = require('../apps/web/src/platform/html.ts');

const checks = [];
const check = (name, run) => checks.push([name, run]);

/* ---- A small stand-in for the page ------------------------------------------------ */

function element(tag = 'div') {
  const node = {
    tag, className: '', textContent: null, children: [], removed: false, hidden: false, innerHTML: '', scrollTop: 7, isConnected: true, focused: 0,
    style: { opacity: '', transition: '', props: new Map(), setProperty(name, value) { this.props.set(name, value); }, removeProperty(name) { this.props.delete(name); } },
    classes: new Set(),
    classList: { toggle(name, on) { if (on) node.classes.add(name); else node.classes.delete(name); } },
    listeners: {},
    appendChild(child) { node.children.push(child); return child; },
    remove() { node.removed = true; },
    addEventListener(type, listener) { (node.listeners[type] = node.listeners[type] || []).push(listener); },
    fire(type, event = {}) { for (const listener of node.listeners[type] || []) listener(event); },
    focus(options) { node.focused += 1; node.focusOptions = options; page.active = node; },
    contains(other) { return other === node || node.inside.includes(other); },
    inside: [],
    querySelector() { return node.found || null; }
  };
  return node;
}
const page = { active: null };

function clock() {
  const timers = [];
  return {
    setTimeout(run, ms) { timers.push({ run, ms }); return timers.length; },
    requestAnimationFrame(run) { timers.push({ run, ms: 16 }); return timers.length; },
    flush() { while (timers.length) timers.shift().run(); },
    timers
  };
}

/* ---- Escaping ---------------------------------------------------------------------- */

check('text between tags is escaped as the browser writes a text node', () => {
  assert.strictEqual(escapeHtml('<b>&"\'\u00a0x'), '&lt;b&gt;&amp;"\'&nbsp;x');
  assert.strictEqual(escapeHtml(null), '');
  assert.strictEqual(escapeHtml(undefined), '');
  assert.strictEqual(escapeHtml(0), '0');
  assert.strictEqual(escapeAttribute('a"b\'c<&>'), 'a&quot;b&#39;c&lt;&amp;&gt;');
  assert.strictEqual(escapeAttribute(null), '');
});

/* ---- Toasts ------------------------------------------------------------------------- */

function toastPage(stack = element('section')) {
  const time = clock();
  const buzzes = [];
  const document = { createElement: element, createTextNode: text => ({ text }) };
  return { stack, time, buzzes, toast: createToasts({ document, stack: () => stack, setTimeout: time.setTimeout, vibrate: ms => buzzes.push(ms) }) };
}

check('a toast says its tone in words before the message, and leaves after its time', () => {
  const { stack, time, buzzes, toast } = toastPage();
  const shown = toast('Saved', 'ok');
  assert.strictEqual(shown.className, 'toast ok');
  assert.deepStrictEqual(shown.children.map(child => child.textContent ?? child.text), ['Success: ', 'Saved']);
  assert.strictEqual(shown.children[0].className, 'sr-only');
  assert.strictEqual(stack.children[0], shown);
  assert.deepStrictEqual(buzzes, [10], 'a success is felt');
  assert.strictEqual(time.timers[0].ms, 3600, 'shown for 3.6 seconds');
  assert.strictEqual(TOAST_SHOWN_MS, 3600);
  time.timers.shift().run();
  assert.deepStrictEqual([shown.style.opacity, shown.style.transition, shown.removed], ['0', 'opacity .4s', false], 'it fades before it goes');
  assert.strictEqual(time.timers[0].ms, 400, 'faded over 0.4 seconds');
  assert.strictEqual(TOAST_FADE_MS, 400);
  time.flush();
  assert.strictEqual(shown.removed, true);
  const error = toast('Refused', 'err');
  assert.deepStrictEqual(error.children.map(child => child.textContent ?? child.text), ['Error: ', 'Refused']);
  assert.deepStrictEqual(buzzes, [10], 'only a success buzzes');
  const plain = toast('Preparing archive…');
  assert.strictEqual(plain.className, 'toast ');
  assert.deepStrictEqual(plain.children.map(child => child.text), ['Preparing archive…'], 'a plain notice has no tone to say');
});

check('a tone is only one of the page\'s own kinds', () => {
  assert.strictEqual(toneOf('ok'), 'Success');
  assert.strictEqual(toneOf('err'), 'Error');
  for (const kind of ['', 'constructor', 'toString', '__proto__', 'warn']) assert.strictEqual(toneOf(kind), null, kind);
});

check('a toast with no stack to show it in is dropped, and a buzz the device refuses is skipped', () => {
  const time = clock();
  const document = { createElement: element, createTextNode: text => ({ text }) };
  const toast = createToasts({ document, stack: () => null, setTimeout: time.setTimeout, vibrate: () => { throw new Error('refused'); } });
  assert.strictEqual(toast('Saved', 'ok'), null);
  assert.strictEqual(time.timers.length, 0);
  const quiet = createToasts({ document, stack: () => element(), setTimeout: time.setTimeout });
  assert(quiet('Saved', 'ok'), 'no buzz to give is no reason not to show it');
});

/* ---- Where a layer grows from ----------------------------------------------------- */

function boxed(left, top, width, height, connected = true) {
  const node = element();
  node.isConnected = connected;
  node.getBoundingClientRect = () => ({ left, top, width, height });
  return node;
}

check('a panel grows from the centre of the control that opened it, held near its own box', () => {
  const panel = boxed(100, 100, 400, 300);
  anchorOverlayOrigin(panel, boxed(100, 100, 20, 20));
  assert.strictEqual(panel.style.props.get('--nv-origin'), '2.5% 3.3%');
  anchorOverlayOrigin(panel, boxed(480, 380, 20, 20));
  assert.strictEqual(panel.style.props.get('--nv-origin'), '97.5% 96.7%');
  anchorOverlayOrigin(panel, boxed(-4000, 9000, 20, 20));
  assert.strictEqual(panel.style.props.get('--nv-origin'), '-35.0% 135.0%', 'a distant opener is held 35% beyond either edge');
  assert.deepStrictEqual(originOf({ left: 0, top: 0, width: 100, height: 100 }, { left: 40, top: 40, width: 20, height: 20 }), [0.5, 0.5]);
});

check('with no opener to grow from, the panel keeps no origin from the last one', () => {
  const panel = boxed(0, 0, 400, 300);
  for (const opener of [null, undefined, {}, boxed(10, 10, 20, 20, false), boxed(10, 10, 0, 0)]) {
    anchorOverlayOrigin(panel, boxed(10, 10, 20, 20));
    assert(panel.style.props.has('--nv-origin'));
    anchorOverlayOrigin(panel, opener);
    assert(!panel.style.props.has('--nv-origin'), `an opener of ${JSON.stringify(opener && opener.getBoundingClientRect ? opener.getBoundingClientRect() : opener)} leaves the last origin`);
  }
  const sizeless = boxed(0, 0, 0, 0);
  anchorOverlayOrigin(sizeless, boxed(10, 10, 20, 20));
  assert(!sizeless.style.props.has('--nv-origin'), 'a panel with no size yet has no origin');
  anchorOverlayOrigin(null, boxed(10, 10, 20, 20));
  assert.strictEqual(originOf({ left: 0, top: 0, width: 0, height: 10 }, { left: 0, top: 0, width: 5, height: 5 }), null);
  assert.deepStrictEqual(originOf({ left: 0, top: 0, width: 10, height: 10 }, { left: 0, top: 0, width: 0, height: 4 }), [0, 0.2], 'an opener with height alone is an opener');
});

/* ---- The dialog -------------------------------------------------------------------- */

function dialogPage() {
  const parts = { scrim: element(), modal: element(), title: element(), body: element(), ok: element('button'), cancel: element('button'), close: element('button') };
  parts.scrim.inside = [parts.modal, parts.ok, parts.cancel, parts.close];
  const time = clock();
  const world = { epoch: 1, identity: { login: 'ada' }, open: false, closed: 0, anchored: [] };
  const opener = element('button');
  page.active = opener;
  const dialog = createModal({
    elements: () => parts,
    overlay: { openOverlay: () => { world.open = true; }, closeOverlay: () => { world.open = false; }, overlayOpen: () => world.open },
    anchor: (panel, from) => world.anchored.push([panel, from]),
    epoch: () => world.epoch,
    identity: () => world.identity,
    activeElement: () => page.active,
    setTimeout: time.setTimeout,
    requestAnimationFrame: time.requestAnimationFrame,
    onClosed: () => { world.closed += 1; }
  });
  dialog.wire();
  return { parts, time, world, opener, dialog };
}

check('a dialog is filled, raised and grown from its opener, and answers how it was left', async () => {
  const { parts, time, world, opener, dialog } = dialogPage();
  parts.modal.scrollTop = 120;
  const answer = dialog.open({ title: 'Delete branch', bodyHTML: '<p>Sure?</p>', okText: 'Delete', danger: true, wide: true });
  assert.deepStrictEqual([parts.title.textContent, parts.body.innerHTML, parts.ok.textContent, parts.modal.scrollTop, parts.cancel.hidden], ['Delete branch', '<p>Sure?</p>', 'Delete', 0, false]);
  assert(parts.ok.classes.has('danger') && parts.modal.classes.has('modal-wide'));
  assert.strictEqual(world.open, true);
  assert.deepStrictEqual(world.anchored, [[parts.modal, opener]], 'it grows from what had focus when it was asked for');
  time.flush();
  assert.strictEqual(page.active, parts.cancel, 'a question with no field focuses its Cancel');
  parts.ok.fire('click');
  assert.strictEqual(await answer, true);
  assert.strictEqual(world.open, false);
  assert.strictEqual(world.closed, 1, 'the page hears the dialog close');
  page.active = null;
  time.flush();
  assert.strictEqual(page.active, opener, 'focus goes back to what opened it');
  for (const [control, event] of [[parts.cancel, {}], [parts.close, {}], [parts.scrim, { target: parts.scrim }]]) {
    const next = dialog.open({ title: 'Again', bodyHTML: '' });
    control.fire('click', event);
    assert.strictEqual(await next, false, 'Cancel, the corner and the scrim all answer no');
  }
  const kept = dialog.open({ title: 'Again', bodyHTML: '' });
  parts.scrim.fire('click', { target: parts.modal });
  assert.strictEqual(world.open, true, 'a press inside the dialog is not a press on the scrim');
  dialog.close(false);
  assert.strictEqual(await kept, false);
});

check('a dialog asked for over another answers the first no; a closed one cannot be owned', async () => {
  const { dialog, world } = dialogPage();
  const first = dialog.open({ title: 'One', bodyHTML: '' });
  const ownsFirst = dialog.owner();
  assert.strictEqual(ownsFirst(), true);
  const second = dialog.open({ title: 'Two', bodyHTML: '' });
  assert.strictEqual(await first, false);
  assert.strictEqual(ownsFirst(), false, 'the first flow no longer owns the dialog on screen');
  const ownsSecond = dialog.owner();
  world.epoch += 1;
  assert.strictEqual(ownsSecond(), false, 'another screen of the page has taken it');
  world.epoch -= 1;
  world.identity = { login: 'grace' };
  assert.strictEqual(ownsSecond(), false, 'another account has taken it');
  world.identity = { login: 'ada' };
  assert.strictEqual(ownsSecond(), false, 'another account of the same name is another account');
  const third = dialog.open({ title: 'Three', bodyHTML: '' });
  assert.strictEqual(await second, false);
  const ownsThird = dialog.owner();
  world.open = false;
  assert.strictEqual(ownsThird(), false, 'a scrim closed by something else is no dialog to own');
  world.open = true;
  const generation = dialog.generation();
  dialog.close(true);
  assert.strictEqual(await third, true);
  assert.strictEqual(dialog.generation(), generation + 1, 'closing is a generation of its own');
});

check('focus goes to the first field, or to the way out of a panel, and only while the dialog is the same', () => {
  const { parts, time, dialog } = dialogPage();
  const input = element('input');
  parts.body.found = input;
  dialog.open({ title: 'Name', bodyHTML: '<input>' });
  time.flush();
  assert.strictEqual(page.active, input, 'a field takes focus');
  assert.deepStrictEqual(input.focusOptions, { preventScroll: true }, 'without scrolling it into view while the dialog still rises');
  dialog.open({ title: 'Settings', bodyHTML: '<input>', autofocus: false, cancel: false });
  assert.strictEqual(parts.cancel.hidden, true, 'a panel with nothing to confirm has no Cancel');
  page.active = null;
  time.flush();
  assert.strictEqual(page.active, parts.close, 'a panel of controls opens on its way out, not in a field');
  parts.body.found = null;
  dialog.open({ title: 'Later', bodyHTML: '' });
  dialog.close(false);
  page.active = null;
  const before = parts.cancel.focused;
  time.timers.splice(0).filter(timer => timer.ms === 60).forEach(timer => timer.run());
  assert.strictEqual(parts.cancel.focused, before, 'a dialog already closed does not take focus');
  dialog.open({ title: 'Inside', bodyHTML: '' });
  page.active = parts.ok;
  const okFocus = parts.ok.focused;
  time.flush();
  assert.strictEqual(page.active, parts.ok, 'focus already inside the dialog is left where the reader put it');
  assert.strictEqual(parts.ok.focused, okFocus);
});

check('focus is handed back only if the dialog left it behind', () => {
  const { parts, time, opener, dialog } = dialogPage();
  dialog.open({ title: 'Stage', bodyHTML: '' });
  time.flush();
  dialog.close(true);
  const commit = element('button');
  page.active = commit;
  time.flush();
  assert.strictEqual(page.active, commit, 'the flow moved focus on; it stays');
  dialog.open({ title: 'Again', bodyHTML: '' });
  time.flush();
  page.active = parts.ok;
  dialog.close(true);
  dialog.open({ title: 'Next', bodyHTML: '' });
  time.flush();
  assert.notStrictEqual(page.active, opener, 'a dialog that took the place of the closed one keeps focus');
  dialog.close(false);
  time.flush();
  page.active = opener;
  dialog.open({ title: 'Last', bodyHTML: '' });
  opener.isConnected = false;
  dialog.close(false);
  page.active = null;
  const focused = opener.focused;
  time.flush();
  assert.strictEqual(opener.focused, focused, 'an opener no longer on the page is not focused');
});

/* ---- Step-up ----------------------------------------------------------------------- */

function stepUpPage({ me = { login: 'ada-l', authMethod: 'token' }, accept = true, typed = 'ada-l', token = ' tok ', grant = 'g-1' } = {}) {
  const calls = [];
  const toasts = [];
  const fields = { stepUpLogin: { value: typed }, stepUpCredential: { value: token } };
  const dialogs = [];
  const stepUp = createStepUp({
    modal: async request => { dialogs.push(request); return accept; },
    api: async (path, opts) => { calls.push([path, opts]); return path === '/api/security/step-up' ? { grant } : { done: true }; },
    toast: (message, kind) => toasts.push([message, kind]),
    identity: () => me,
    field: id => fields[id] || null
  });
  return { stepUp, calls, toasts, fields, dialogs };
}

check('a sensitive action is authorized once, for that action, by the login and the token typed again', async () => {
  const { stepUp, calls, fields, dialogs } = stepUpPage();
  const out = await stepUp.send('repo.delete', { repo: 'a/b' }, '/api/repo/a/b', { method: 'DELETE', headers: { 'x-a': '1' } }, 'Delete a/b');
  assert.deepStrictEqual(out, { done: true });
  assert.deepStrictEqual(calls[0], ['/api/security/step-up', { method: 'POST', body: { action: 'repo.delete', scope: { repo: 'a/b' }, confirm: 'ada-l', credential: 'tok' } }]);
  assert.deepStrictEqual(calls[1], ['/api/repo/a/b', { method: 'DELETE', headers: { 'x-a': '1', 'x-nv-step-up': 'g-1' } }]);
  assert.strictEqual(STEP_UP_HEADER, 'x-nv-step-up');
  assert.deepStrictEqual([fields.stepUpLogin.value, fields.stepUpCredential.value], ['', ''], 'what was typed does not stay on the page');
  assert.deepStrictEqual([dialogs[0].title, dialogs[0].okText, dialogs[0].danger], ['Verify sensitive action', 'Authorize once', true]);
  assert.match(dialogs[0].bodyHTML, /<b>Delete a\/b<\/b>/);
});

check('signed in through GitHub, no token is asked for or sent', async () => {
  const { stepUp, calls, dialogs } = stepUpPage({ me: { login: 'ada', authMethod: 'oauth' }, typed: 'ada' });
  await stepUp.request('key.rotate', null);
  assert.deepStrictEqual(calls[0][1].body, { action: 'key.rotate', scope: null, confirm: 'ada' });
  assert(!/stepUpCredential/.test(dialogs[0].bodyHTML) && /checked against the provider again/.test(dialogs[0].bodyHTML));
  assert.match(dialogs[0].bodyHTML, /<b>sensitive action<\/b>/, 'an action with no name is called what it is');
});

check('a login typed with autocorrect\'s dashes is named as a mismatch and nothing is sent', async () => {
  const { stepUp, calls, toasts, fields } = stepUpPage({ typed: 'ada–l' });
  assert.strictEqual(await stepUp.send('repo.delete', {}, '/api/x'), null);
  assert.deepStrictEqual(calls, []);
  assert.deepStrictEqual(toasts, [[mismatchMessage('ada-l'), 'err']]);
  assert.deepStrictEqual([fields.stepUpLogin.value, fields.stepUpCredential.value], ['', ''], 'a mismatch empties the fields too');
  const trimmed = stepUpPage({ typed: '  ada-l ' });
  assert(await trimmed.stepUp.request('a', {}), 'spaces around the login are not a mismatch');
});

check('declined, signed out, or answered without a grant, no request is sent with one', async () => {
  const declined = stepUpPage({ accept: false });
  assert.strictEqual(await declined.stepUp.send('a', {}, '/api/x'), null);
  assert.deepStrictEqual(declined.calls, []);
  for (const me of [null, {}, { login: '' }]) {
    await assert.rejects(stepUpPage({ me }).stepUp.request('a', {}), /Sign in before authorizing/);
  }
  for (const grant of [null, '', 42]) {
    const page = stepUpPage({ grant });
    assert.strictEqual(await page.stepUp.send('a', {}, '/api/x'), null);
    assert.strictEqual(page.calls.length, 1, `a grant of ${JSON.stringify(grant)} sends nothing on`);
  }
  const bodiless = createStepUp({ modal: async () => true, api: async () => null, toast: () => {}, identity: () => ({ login: 'ada' }), field: id => ({ stepUpLogin: { value: 'ada' } })[id] || null });
  assert.strictEqual(await bodiless.send('a', {}, '/api/x'), null, 'an answer with no body is no grant, not a TypeError');
  const fieldless = createStepUp({ modal: async () => true, api: async () => ({ grant: 'g' }), toast: () => {}, identity: () => ({ login: 'ada' }), field: () => null });
  assert.strictEqual(await fieldless.request('a', {}), '', 'fields gone from the page are an empty login, a mismatch');
});

check('what step-up asks is escaped, and its fields decline the keyboard\'s rewriting', () => {
  const body = stepUpBody('<img src=x>', 'a<b>', true);
  assert(!body.includes('<img') && body.includes('&lt;img src=x&gt;') && body.includes('a&lt;b&gt;'));
  for (const id of ['stepUpLogin', 'stepUpCredential']) {
    const tag = body.match(new RegExp(`<input id="${id}"[^>]*>`))[0];
    for (const attribute of ['autocomplete="off"', 'spellcheck="false"']) assert(tag.includes(attribute), `${id} lacks ${attribute}`);
  }
  const login = body.match(/<input id="stepUpLogin"[^>]*>/)[0];
  for (const attribute of ['autocorrect="off"', 'autocapitalize="off"']) assert(login.includes(attribute), `the login field lacks ${attribute}`);
  assert(/type="password"/.test(body.match(/<input id="stepUpCredential"[^>]*>/)[0]));
});

/* ---- Safe Passage ----------------------------------------------------------------- */

const OFFER = { available: true, path: 'docs/<a>.md', branch: 'nv/safe-1', baseBranch: 'main' };

function passagePage({ accept = true, repository = 'acme/demo', answers = {} } = {}) {
  const calls = [];
  const toasts = [];
  const shown = [];
  const dialogs = [];
  const world = { repository };
  const take = createSafePassage({
    modal: async request => { dialogs.push(request); if (typeof accept === 'function') return accept(world); return accept; },
    api: async (path, opts) => {
      calls.push([path, opts]);
      const answer = answers[path.split('/').pop()];
      if (answer instanceof Error) throw answer;
      return answer === undefined ? {} : answer;
    },
    toast: (message, kind) => toasts.push([message, kind]),
    presentError: error => shown.push(error),
    repository: () => world.repository
  });
  return { take, calls, toasts, shown, dialogs, world };
}
const refused = (status) => Object.assign(new Error('refused'), { status });

check('taken, the refused change goes to its own branch and a pull request, byte for byte', async () => {
  const { take, calls, toasts, dialogs } = passagePage({ answers: { pulls: { number: 12 }, file: { commit: 'c' } } });
  const out = await take({ safePassage: OFFER }, { content: 'exact\nbytes ', message: '  Fix docs ', sha: 'abc' });
  assert.deepStrictEqual(out, { written: { commit: 'c' }, pull: { number: 12 } });
  assert.deepStrictEqual(calls, [
    ['/api/repo/acme/demo/branches', { method: 'POST', body: { name: 'nv/safe-1', from: 'main' } }],
    ['/api/repo/acme/demo/file', { method: 'PUT', body: { path: 'docs/<a>.md', content: 'exact\nbytes ', message: 'Fix docs', branch: 'nv/safe-1', sha: 'abc' } }],
    ['/api/repo/acme/demo/pulls', { method: 'POST', body: { title: 'Fix docs', head: 'nv/safe-1', base: 'main', body: pullBody(offerOf({ safePassage: OFFER })) } }]
  ]);
  assert.deepStrictEqual(toasts, [['Opened pull request #12 ✦', 'ok']]);
  assert.deepStrictEqual([dialogs[0].title, dialogs[0].okText], ['This change needs approval', 'Send for review']);
  assert(dialogs[0].bodyHTML.includes('docs/&lt;a&gt;.md') && !dialogs[0].bodyHTML.includes('<a>'), 'what the server named is shown, not run');
});

check('a change with no message is named for its file, and a pull request with no number is still sent', async () => {
  const { take, calls, toasts } = passagePage();
  await take({ safePassage: OFFER }, { content: '' });
  assert.strictEqual(calls[1][1].body.message, 'Update docs/<a>.md');
  assert.deepStrictEqual(toasts, [['Sent for review ✦', 'ok']]);
});

check('a branch already there is a second attempt, and any other refusal stops the route', async () => {
  const again = passagePage({ answers: { branches: refused(422) } });
  assert.ok(typeof await again.take({ safePassage: OFFER }, { content: 'x' }) === 'object');
  assert.strictEqual(again.calls.length, 3);
  for (const status of [403, 409, 500, undefined]) {
    const stopped = passagePage({ answers: { branches: refused(status) } });
    assert.strictEqual(await stopped.take({ safePassage: OFFER }, { content: 'x' }), true, `a ${status} on the branch is taken and shown`);
    assert.strictEqual(stopped.calls.length, 1);
    assert.strictEqual(stopped.shown.length, 1);
  }
  const failed = passagePage({ answers: { file: refused(409) } });
  assert.strictEqual(await failed.take({ safePassage: OFFER }, { content: 'x' }), true);
  assert.deepStrictEqual([failed.calls.length, failed.shown.length, failed.toasts.length], [2, 1, 0]);
});

check('no offer, no content, no repository, or no to the dialog: nothing is sent', async () => {
  for (const error of [null, {}, { safePassage: null }, { safePassage: { ...OFFER, available: 'true' } }, { safePassage: { ...OFFER, available: false } }]) {
    const { take, calls, dialogs } = passagePage();
    assert.strictEqual(await take(error, { content: 'x' }), false);
    assert.deepStrictEqual([calls.length, dialogs.length], [0, 0]);
  }
  for (const change of [null, undefined, {}, { content: 7 }]) assert.strictEqual(await passagePage().take({ safePassage: OFFER }, change), false);
  const closed = passagePage({ repository: null });
  assert.strictEqual(await closed.take({ safePassage: OFFER }, { content: 'x' }), false);
  assert.strictEqual(closed.dialogs.length, 0, 'with no repository open nothing is offered');
  const declined = passagePage({ accept: false });
  assert.strictEqual(await declined.take({ safePassage: OFFER }, { content: 'x' }), false);
  assert.strictEqual(declined.calls.length, 0);
});

check('a repository opened while the offer was on screen is not sent the change', async () => {
  const moved = passagePage({ accept: world => { world.repository = 'acme/other'; return true; } });
  assert.strictEqual(await moved.take({ safePassage: OFFER }, { content: 'x' }), true, 'handled: the caller does not go on to queue it either');
  assert.deepStrictEqual(moved.calls, []);
  assert.deepStrictEqual(moved.toasts, [[MOVED_ON, 'err']]);
  const gone = passagePage({ accept: world => { world.repository = null; return true; } });
  assert.strictEqual(await gone.take({ safePassage: OFFER }, { content: 'x' }), true);
  assert.deepStrictEqual(gone.calls, []);
});

check('an offer\'s fields are read as text, whatever came', () => {
  assert.deepStrictEqual(offerOf({ safePassage: { available: true } }), { path: '', branch: '', baseBranch: '' });
  assert.deepStrictEqual(offerOf({ safePassage: { available: true, path: 7, branch: 'b', baseBranch: null } }), { path: '7', branch: 'b', baseBranch: '' });
  assert(offerBody({ path: 'p', branch: 'b', baseBranch: 'm' }).includes('<span class="mono">b → m</span>'));
});

/* Unfinished is failed: a check left waiting on an answer that never comes ends the process without passing. */
process.exitCode = 1;
(async () => {
  for (const [name, run] of checks) {
    try { await run(); } catch (error) { console.error(`FAIL ${name}`); throw error; }
  }
  console.log(`page dialog tests passed (${checks.length} checks)`);
  process.exitCode = 0;
})().catch(error => { console.error(error && error.stack || error); process.exitCode = 1; });
