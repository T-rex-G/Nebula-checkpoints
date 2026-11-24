'use strict';
/*
 * A page's markup as elements a module can work on, in Node.
 *
 * What a module writes as innerHTML is parsed as the browser parses it
 * (parse5), and the elements answer the calls page modules make:
 * querySelector and querySelectorAll with simple selectors (#id, escaped as
 * CSS.escape writes it, .class, a tag, [attribute] or [attribute="value"]),
 * alone or apart by spaces for descendants, dataset, the form controls'
 * disabled, checked and value, textContent, listeners, click, focus,
 * contains and replaceChildren. As in Chromium, a control disabled or
 * removed while it has focus lets go of it, and click() on a disabled
 * control does nothing. A module that needs more is driven in a browser.
 */
const { parseFragment } = require('parse5');

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const attributeText = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const plainText = value => String(value).replace(/[&<>\u00a0]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\u00a0': '&nbsp;' })[ch]);
const dataName = key => 'data-' + key.replace(/[A-Z]/g, ch => '-' + ch.toLowerCase());

class Text {
  constructor(text) { this.text = text; this.parent = null; }
  get textContent() { return this.text; }
  [Symbol.for('nodejs.util.inspect.custom')]() { return JSON.stringify(this.text); }
}

class Element {
  constructor(doc, tag, attributes = []) {
    this.doc = doc;
    this.localName = tag.toLowerCase();
    this.tagName = tag.toUpperCase();
    this.attributes = new Map(attributes.map(({ name, value }) => [name, value]));
    this.childNodes = [];
    this.parent = null;
    this.listeners = [];
    this.state = {};
    const element = this;
    this.dataset = new Proxy({}, {
      get: (target, key) => (typeof key === 'string' ? element.attributes.get(dataName(key)) : undefined),
      set: (target, key, value) => { element.attributes.set(dataName(String(key)), String(value)); return true; },
      has: (target, key) => typeof key === 'string' && element.attributes.has(dataName(key))
    });
  }

  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  get id() { return this.getAttribute('id') || ''; }
  get className() { return this.getAttribute('class') || ''; }
  get href() { return this.getAttribute('href') || ''; }

  get disabled() { return this.attributes.has('disabled'); }
  set disabled(on) {
    if (on) {
      this.attributes.set('disabled', '');
      if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body;
    } else this.attributes.delete('disabled');
  }
  get checked() { return 'checked' in this.state ? this.state.checked : this.attributes.has('checked'); }
  set checked(on) { this.state.checked = Boolean(on); }
  get value() { return 'value' in this.state ? this.state.value : (this.getAttribute('value') || ''); }
  set value(text) { this.state.value = String(text); }

  get children() { return this.childNodes.filter(node => node instanceof Element); }
  get isConnected() {
    let node = this;
    while (node.parent) node = node.parent;
    return node === this.doc.body;
  }

  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(text) { this.replace([new Text(text == null ? '' : String(text))]); }

  get innerHTML() { return this.childNodes.map(serialize).join(''); }
  set innerHTML(html) { this.replace(parseFragment(String(html)).childNodes.map(node => this.doc.adopt(node)).filter(Boolean)); }

  replace(nodes) {
    if (this.doc.activeElement !== this && this.contains(this.doc.activeElement)) this.doc.activeElement = this.doc.body;
    for (const node of this.childNodes) node.parent = null;
    this.childNodes = nodes;
    for (const node of nodes) node.parent = this;
  }
  replaceChildren() { this.replace([]); }
  appendChild(node) { if (node.parent) node.parent.childNodes = node.parent.childNodes.filter(other => other !== node); node.parent = this; this.childNodes.push(node); return node; }

  contains(node) {
    for (let at = node; at; at = at.parent) if (at === this) return true;
    return false;
  }

  matches(selector) {
    const id = /^#((?:[\w-]|\\[0-9a-fA-F]{1,6} ?|\\[^0-9a-fA-F])+)$/.exec(selector);
    if (id) return this.id === id[1].replace(/\\([0-9a-fA-F]{1,6}) ?|\\(.)/g, (all, hex, ch) => (hex ? String.fromCodePoint(parseInt(hex, 16)) : ch));
    const cls = /^\.([\w-]+)$/.exec(selector);
    if (cls) return this.className.split(/\s+/).includes(cls[1]);
    const attribute = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
    if (attribute) return this.attributes.has(attribute[1]) && (attribute[2] === undefined || this.attributes.get(attribute[1]) === attribute[2]);
    if (/^[a-z][\w-]*$/.test(selector)) return this.localName === selector;
    throw new Error(`markup-dom reads one simple selector, not ${JSON.stringify(selector)}`);
  }
  /* One simple selector, or several apart by spaces, each matched by an ancestor of the next, as a browser reads them. */
  querySelectorAll(selector) {
    const parts = selector.trim().split(/\s+/);
    const last = parts.pop();
    const within = element => {
      let at = element.parent;
      for (let i = parts.length - 1; i >= 0; i -= 1) {
        while (at && !(at instanceof Element && at.matches(parts[i]))) at = at.parent;
        if (!at) return false;
        at = at.parent;
      }
      return true;
    };
    const found = [];
    const walk = element => { for (const child of element.children) { if (child.matches(last) && within(child)) found.push(child); walk(child); } };
    walk(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  addEventListener(type, listener) { this.listeners.push([type, listener]); }
  removeEventListener(type, listener) { this.listeners = this.listeners.filter(([t, l]) => t !== type || l !== listener); }
  listening(type) { return this.listeners.some(([t]) => t === type); }
  /* Every listener for an event, in order; resolves once those that are asynchronous have settled. */
  dispatch(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
    return Promise.all(this.listeners.filter(([t]) => t === type).map(([, listener]) => listener(event)));
  }
  click() { return this.disabled ? Promise.resolve([]) : this.dispatch('click'); }
  /* Shown as its tag, id and data, so an assertion naming an element never walks the whole document. */
  [Symbol.for('nodejs.util.inspect.custom')]() {
    const named = ['id', 'class', 'aria-label', ...[...this.attributes.keys()].filter(name => name.startsWith('data-'))].filter(name => this.attributes.has(name));
    return `<${this.localName}${named.map(name => ` ${name}="${this.attributes.get(name)}"`).join('')}>`;
  }
  focus() { if (!this.disabled && this.isConnected) this.doc.activeElement = this; }
}

function serialize(node) {
  if (node instanceof Text) return plainText(node.text);
  const attributes = [...node.attributes].map(([name, value]) => (value === '' ? ` ${name}` : ` ${name}="${attributeText(value)}"`)).join('');
  return VOID.has(node.localName) ? `<${node.localName}${attributes}>` : `<${node.localName}${attributes}>${node.innerHTML}</${node.localName}>`;
}

/* A document with a body, connected, that elements are made and adopted into. */
function createDocument() {
  const doc = {
    activeElement: null,
    createElement: tag => new Element(doc, tag),
    adopt(node) {
      if (node.nodeName === '#text') return new Text(node.value);
      if (!node.tagName) return null;
      const element = new Element(doc, node.tagName, node.attrs);
      for (const child of node.childNodes) { const adopted = doc.adopt(child); if (adopted) { adopted.parent = element; element.childNodes.push(adopted); } }
      return element;
    }
  };
  doc.body = new Element(doc, 'body');
  doc.activeElement = doc.body;
  return doc;
}

module.exports = { createDocument, Element };
