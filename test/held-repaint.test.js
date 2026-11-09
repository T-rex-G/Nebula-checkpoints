'use strict';

/*
 * The overview's repaints wait for a press on their screen.
 *
 * A press is a click only when it begins and ends on one element. A card
 * rebuilt under the press replaces that element, and a card above it rebuilt
 * at another height moves it, so the press comes up on something else. While
 * a pointer, Space or Enter is down on a screen, every card on that screen
 * that repaints through apps/web/src/components/held-repaint.ts waits, and
 * draws its latest reading once the press is delivered. At an identity
 * boundary nothing held for the last reader is drawn.
 *
 * The module runs whole, in a stand-in browser: elements that know what they
 * contain and which screen they are on, a window that dispatches the events
 * the module listens for, and a clock the test moves.
 */

const assert = require('assert');
const { loadPageModule } = require('./helpers/page-module');

class Node {
  constructor(name, parent = null, { screen = false } = {}) {
    this.name = name;
    this.parent = parent;
    this.screen = screen;
  }

  contains(other) {
    for (let at = other; at; at = at.parent) if (at === this) return true;
    return false;
  }

  closest(selector) {
    assert.strictEqual(selector, 'main', 'a card\'s screen is the main landmark it sits in');
    for (let at = this; at; at = at.parent) if (at.screen) return at;
    return null;
  }
}

function browser() {
  const listeners = new Map();
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  const window = {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(listener);
    }
  };
  const globals = {
    window,
    Node,
    setTimeout(fn, ms = 0) { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }
  };
  const held = loadPageModule('apps/web/src/components/held-repaint.ts', globals);
  return {
    held,
    fire(type, event = {}) { for (const listener of listeners.get(type) || []) listener(event); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    }
  };
}

/* One screen with two cards and a control outside them, and a second screen with a card of its own. */
function page() {
  const overview = new Node('overview', null, { screen: true });
  const trust = new Node('trust body', new Node('trust card', overview));
  const posture = new Node('posture body', new Node('posture card', overview));
  const name = new Node('repository name', posture);
  const signOut = new Node('sign out', new Node('top bar', overview));
  const workbench = new Node('workbench', null, { screen: true });
  const editor = new Node('editor body', workbench);
  return { trust, posture, name, signOut, editor };
}

function drawn() {
  const log = [];
  return { log, draw: label => () => log.push(label) };
}

const cases = [];
const check = (name, run) => cases.push([name, run]);

check('a card is drawn at once when nothing is pressed', () => {
  const { held } = browser();
  const { trust } = page();
  const { log, draw } = drawn();
  held.repaintCard(trust, draw('trust'));
  assert.deepStrictEqual(log, ['trust']);
});

check('a press inside a card holds its repaint until the click, and draws the latest reading once', () => {
  const b = browser();
  const { posture, name } = page();
  const { log, draw } = drawn();
  b.fire('pointerdown', { target: name });
  b.held.repaintCard(posture, draw('first reading'));
  b.held.repaintCard(posture, draw('second reading'));
  assert.deepStrictEqual(log, []);
  b.fire('click', {});
  assert.deepStrictEqual(log, [], 'drawn after the click has been delivered, not inside it');
  b.advance(0);
  assert.deepStrictEqual(log, ['second reading']);
});

check('a press anywhere on a screen holds every card on that screen', () => {
  const b = browser();
  const { trust, posture, name, signOut } = page();
  const { log, draw } = drawn();
  b.fire('pointerdown', { target: name });
  b.held.repaintCard(trust, draw('trust, above the press'));
  assert.deepStrictEqual(log, [], 'the card above the pressed one waits too');
  b.fire('click', {});
  b.advance(0);
  assert.deepStrictEqual(log, ['trust, above the press']);

  b.fire('pointerdown', { target: signOut });
  b.held.repaintCard(posture, draw('posture, under a press on the bar'));
  assert.deepStrictEqual(log, ['trust, above the press']);
  b.fire('click', {});
  b.advance(0);
  assert.deepStrictEqual(log, ['trust, above the press', 'posture, under a press on the bar']);
});

check('a card on another screen is drawn at once during a press', () => {
  const b = browser();
  const { name, editor } = page();
  const { log, draw } = drawn();
  b.fire('pointerdown', { target: name });
  b.held.repaintCard(editor, draw('editor'));
  assert.deepStrictEqual(log, ['editor']);
});

check('a repaint the click asks for is drawn at once, and the held one is dropped', () => {
  const b = browser();
  const { posture, name } = page();
  const { log, draw } = drawn();
  b.fire('pointerdown', { target: name });
  b.held.repaintCard(posture, draw('held reading'));
  b.fire('click', {});
  b.held.repaintCard(posture, draw('what the click drew'));
  b.advance(0);
  assert.deepStrictEqual(log, ['what the click drew']);
});

check('a release with no click draws after the grace a touch needs', () => {
  const b = browser();
  const { posture, name } = page();
  const { log, draw } = drawn();
  b.fire('pointerdown', { target: name });
  b.held.repaintCard(posture, draw('reading'));
  b.fire('pointerup', {});
  b.advance(399);
  assert.deepStrictEqual(log, []);
  b.advance(1);
  assert.deepStrictEqual(log, ['reading']);
});

check('a cancelled pointer draws at once', () => {
  const b = browser();
  const { posture, name } = page();
  const { log, draw } = drawn();
  b.fire('pointerdown', { target: name });
  b.held.repaintCard(posture, draw('reading'));
  b.fire('pointercancel', {});
  b.advance(0);
  assert.deepStrictEqual(log, ['reading']);
});

check('no press holds a card longer than five seconds', () => {
  const b = browser();
  const { posture, name } = page();
  const { log, draw } = drawn();
  b.fire('pointerdown', { target: name });
  b.held.repaintCard(posture, draw('reading'));
  b.advance(4999);
  assert.deepStrictEqual(log, []);
  b.advance(1);
  assert.deepStrictEqual(log, ['reading']);
});

check('Space and Enter press as a pointer does; other keys do not', () => {
  const b = browser();
  const { trust, name } = page();
  const { log, draw } = drawn();
  b.fire('keydown', { key: 'Tab', target: name });
  b.held.repaintCard(trust, draw('after Tab'));
  assert.deepStrictEqual(log, ['after Tab']);
  b.fire('keydown', { key: ' ', target: name });
  b.held.repaintCard(trust, draw('after Space'));
  assert.deepStrictEqual(log, ['after Tab']);
  b.fire('keyup', { key: ' ' });
  b.advance(400);
  assert.deepStrictEqual(log, ['after Tab', 'after Space']);
  b.fire('keydown', { key: 'Enter', target: name });
  b.held.repaintCard(trust, draw('after Enter'));
  b.fire('click', {});
  b.advance(0);
  assert.deepStrictEqual(log, ['after Tab', 'after Space', 'after Enter']);
});

check('an identity boundary drops every held repaint, and the press still ends as it would', () => {
  const b = browser();
  const { trust, posture, name } = page();
  const { log, draw } = drawn();
  b.fire('pointerdown', { target: name });
  b.held.repaintCard(trust, draw('last reader: trust'));
  b.held.repaintCard(posture, draw('last reader: posture'));
  b.held.discardHeldRepaints();
  b.held.repaintCard(posture, draw('next reading'));
  assert.deepStrictEqual(log, [], 'the press is still down, so the next reading waits for it');
  b.fire('click', {});
  b.advance(0);
  assert.deepStrictEqual(log, ['next reading']);
});

let failed = 0;
for (const [name, run] of cases) {
  try {
    run();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`not ok - ${name}\n${error.stack}`);
  }
}
if (failed) {
  console.error(`${failed} of ${cases.length} held-repaint checks failed`);
  process.exit(1);
}
console.log(`held repaint: ${cases.length} checks passed`);
