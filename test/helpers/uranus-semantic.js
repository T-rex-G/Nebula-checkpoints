'use strict';

const assert = require('node:assert/strict');

const source = (path, ...lines) => ({ path, text: lines.join('\n') });
const findingsAt = (audit, path, line) => audit.findings.filter(f => f.rule === 'SEC-002' && f.path === path && f.line === line);

function checkedFlow(audit, sinkPath, sinkLine, originPath, originLine) {
  const findings = findingsAt(audit, sinkPath, sinkLine);
  assert.equal(findings.length, 1, `expected one DOM finding at ${sinkPath}:${sinkLine}`);
  const [finding] = findings;
  assert.equal(finding.evidence, 'traced');
  assert(finding.trace.some(step => step.role === 'entrypoint' && step.path === originPath && step.line === originLine),
    `expected the value from ${originPath}:${originLine} at ${sinkPath}:${sinkLine}`);
  const sink = finding.trace.at(-1);
  assert.equal(sink.role, 'sink');
  assert.equal(sink.path, sinkPath);
  assert.equal(sink.line, sinkLine);
  assert(!JSON.stringify(finding).includes('calendar-private-line'), 'an audit trace must not publish source text');
  return finding;
}

function checkSemanticAnalysis(analyse) {
  const registration = source('server/calendar.ts',
    'import site from "express";',
    'import { renderCalendar as receive } from "./views.js";',
    'const router = site.Router();',
    'router.get("/calendar", receive);');
  const view = source('server/views.ts',
    'export function renderCalendar(incoming, response) {',
    '  const label = incoming.get("x-calendar-label");',
    '  document.body.setHTMLUnsafe(label);',
    '}');
  const promoted = analyse({ files: [registration, view] });
  assert.equal(checkedFlow(promoted, view.path, 3, view.path, 2).verdict, 'needs-validation',
    'a symbol-bound route registration supplies a possible caller for the imported function');
  const localRegistry = source(registration.path, registration.text.replace('site.Router()', 'createLocalRegistry()'));
  assert(findingsAt(analyse({ files: [localRegistry, view] }), view.path, 3).every(f => f.evidence !== 'traced'),
    'an arbitrary callback registry supplies no request provenance');
  const browser = 'web/calendar.ts';
  const preview = 'web/preview.ts';
  const barrel = source('web/public.ts', 'export { show as paint, carry as displayName } from "./preview";');
  const helpers = source(preview,
    'export function carry(label: string) { return label; }',
    'export function show(label: string) {',
    '  const panel = document.createElement("aside");',
    '  panel.insertAdjacentHTML("beforeend", label);',
    '}');
  const callers = source(browser,
    'import { paint as draw, displayName as caption } from "./public";',
    'const panel = document.createElement("section");',
    'const supplied = window.location.hash; /* calendar-private-line */',
    'draw(supplied);',
    'const fixed = caption("Calendar");',
    'const dynamic = caption(supplied);',
    'panel.insertAdjacentHTML("beforeend", fixed);',
    'panel.insertAdjacentHTML("beforeend", dynamic);',
    'panel.textContent = supplied;');
  const cross = analyse({ files: [callers, barrel, helpers] });
  checkedFlow(cross, preview, 4, browser, 3);
  checkedFlow(cross, browser, 8, browser, 3);
  assert.equal(findingsAt(cross, browser, 7).length, 0, 'a helper called with a literal returns the literal at that call site');
  assert.equal(findingsAt(cross, browser, 9).length, 0, 'textContent places text, including values from a URL');

  const branches = source(browser,
    'function choices(enabled: boolean) {',
    '  const panel = document.createElement("aside");',
    '  let mixed = "fixed";',
    '  if (enabled) mixed = window.location.search;',
    '  panel.insertAdjacentHTML("beforeend", mixed);',
    '  let retained = "fixed";',
    '  if (enabled) { retained = window.location.hash; return; }',
    '  panel.insertAdjacentHTML("beforeend", retained);',
    '}');
  const branching = analyse({ files: [branches] });
  checkedFlow(branching, browser, 5, browser, 4);
  assert.equal(findingsAt(branching, browser, 8).length, 0, 'an early return removes its assignments from the continuing path');

  const bindings = source(browser,
    'const panel = document.createElement("main");',
    'function paint(window: {location: {hash: string}}) {',
    '  const local = window.location.hash;',
    '  panel.insertAdjacentHTML("beforeend", local);',
    '}',
    'const record = { innerHTML: "" };',
    'record.innerHTML = window.location.hash;',
    'const caption = readCaption();',
    'panel.insertAdjacentHTML("beforeend", caption);');
  const scoped = analyse({ files: [bindings] });
  assert(findingsAt(scoped, browser, 4).every(f => f.verdict === 'needs-validation'), 'a parameter called window does not establish a browser origin');
  assert.equal(findingsAt(scoped, browser, 7).length, 0, 'a plain record with a data property has no HTML sink');
  assert(findingsAt(scoped, browser, 9).every(f => f.verdict === 'needs-validation' && f.blocker), 'an unknown result must not establish a confirmed source-to-sink flow');

  const component = 'web/calendar-view.ts';
  const angular = source(component,
    'import { ActivatedRoute as CalendarRoute } from "@angular/router";',
    'import { DomSanitizer as MarkupService } from "@angular/platform-browser";',
    'export class CalendarView {',
    '  constructor(private route: CalendarRoute, private marks: MarkupService) {}',
    '  preview() {',
    '    const caption = this.route.snapshot.queryParamMap.get("calendar-private-line");',
    '    return this.marks.bypassSecurityTrustHtml(caption);',
    '  }',
    '  fixed() { return this.marks.bypassSecurityTrustHtml("<b>Calendar</b>"); }',
    '}');
  const sameSpelling = source('web/local-view.ts',
    'class Formatter { bypassSecurityTrustHtml(s: string) { return s.length; } }',
    'const formatter = new Formatter();',
    'formatter.bypassSecurityTrustHtml(window.location.hash);');
  const framework = analyse({ files: [angular, sameSpelling] });
  assert.equal(checkedFlow(framework, component, 7, component, 6).verdict, 'needs-validation',
    'a framework trust bypass still requires a downstream rendering context');
  assert.equal(findingsAt(framework, component, 9).length, 0, 'fixed markup in the trusted-HTML API has no external contribution');
  assert.equal(findingsAt(framework, sameSpelling.path, 3).length, 0, 'method spelling alone cannot identify a framework trust boundary');

  const declared = source(browser,
    'import { ActivatedRoute } from "@angular/router";',
    'export class Calendar {',
    '  constructor(private route: ActivatedRoute) {}',
    '  preview() { document.body.setHTMLUnsafe(this.route.snapshot.queryParamMap.get("name")); }',
    '}',
    'function decorate(panel: HTMLElement) { panel.setHTMLUnsafe(window.location.hash); }',
    'class Card { innerHTML = ""; }',
    'const card = new Card();',
    'card.innerHTML = window.location.hash;');
  const checkedBindings = analyse({ files: [declared] });
  assert.equal(checkedFlow(checkedBindings, browser, 4, browser, 4).verdict, 'needs-validation', 'an annotation alone cannot prove a runtime route');
  assert.equal(checkedFlow(checkedBindings, browser, 6, browser, 6).verdict, 'needs-validation', 'a declared browser receiver can be supplied by a caller');
  assert.equal(findingsAt(checkedBindings, browser, 9).length, 0, 'a fresh class instance with an ordinary field does not render HTML');

  const choices = source(browser,
    'const choose = (visible: boolean, title: string) => visible ? title : "Calendar";',
    'const caption = window.location.hash;',
    'document.body.setHTMLUnsafe(choose(false, caption));',
    'document.body.setHTMLUnsafe(choose(true, caption));',
    'function fromFinally() { try { return caption; } finally { return "Calendar"; } }',
    'document.body.setHTMLUnsafe(fromFinally());');
  const called = analyse({ files: [choices] });
  assert.equal(findingsAt(called, browser, 3).length, 0);
  assert.equal(checkedFlow(called, browser, 4, browser, 2).verdict, 'confirmed');
  assert.equal(findingsAt(called, browser, 6).length, 0, 'a returning finally block determines the result');

  const malformed = source('web/unfinished.ts', 'export const missing: = ;', 'document.body.innerHTML = missing;');
  const unsupported = source('web/calendar.vue', '<template><aside>Calendar</aside></template>');
  const mixed = analyse({ files: [callers, barrel, helpers, malformed, unsupported] });
  checkedFlow(mixed, browser, 8, browser, 3);
  assert.equal(mixed.engine.traced.semantic.complete, false, 'a malformed admitted source prevents a complete semantic scan');
  assert.equal(mixed.ledger.find(row => row.id === 'requests').status, 'partial');
  assert(findingsAt(mixed, malformed.path, 2).every(f => f.verdict === 'needs-validation'), 'a malformed declaration does not prove an external source');
  const limited = analyse({ files: [branches], trace: { skip: 'time' } });
  assert.equal(limited.engine.traced.limit, 'time');
  assert(limited.engine.traced.cut > 0);
  assert.equal(limited.ledger.find(row => row.id === 'requests').status, 'patterns');
  assert(!limited.findings.some(f => f.rule === 'SEC-002' && f.evidence === 'traced'), 'a skipped trace cannot supply a witness');

  const adapters = source(browser,
    'const ticket = readTitle();',
    'externalPanel.setHTMLUnsafe(adapter.format(ticket));',
    'document.body.setHTMLUnsafe(adapter.format(ticket));');
  const opaque = analyse({ files: [adapters] });
  assert.equal(findingsAt(opaque, browser, 2).length, 0, 'two unresolved calls do not establish that unchecked data reached a renderer');
  assert.equal(opaque.engine.traced.semantic.unresolvedOperations, 1);
  assert.equal(opaque.ledger.find(row => row.id === 'requests').status, 'partial');
  const actualRenderer = findingsAt(opaque, browser, 3);
  assert.equal(actualRenderer.length, 1);
  assert.equal(actualRenderer[0].verdict, 'needs-validation', 'a real renderer still needs review for the same opaque return');

  const tagged = source(browser,
    'const transform = catalog.loadTag();',
    'const heading = catalog.currentTitle;',
    'document.body.setHTMLUnsafe(transform`<b>${heading}</b>`);',
    'const supplied = window.location.search;',
    'const markup = transform`<b>${supplied}</b>`;',
    'document.body.setHTMLUnsafe(markup);');
  const tags = analyse({ files: [tagged] });
  assert.equal(tags.engine.traced.semantic.complete, false);
  assert.equal(findingsAt(tags, browser, 3).length, 0);
  const uncertainTag = checkedFlow(tags, browser, 6, browser, 4);
  assert.equal(uncertainTag.verdict, 'needs-validation');
  assert.match(uncertainTag.blocker, /template tag/);

  const dense = analyse({ files: [source(browser, ...Array.from({ length: 44 }, () =>
    'document.body.setHTMLUnsafe(window.location.hash);'))] });
  assert.equal(dense.engine.traced.semantic.truncatedFiles, 1);
  assert.equal(findingsAt(dense, browser, 1).length, 1, 'a truncated scan retains its first witness');
  assert.equal(dense.findings.filter(f => f.rule === 'SEC-002' && f.evidence === 'traced').length, 40);
  assert.equal(dense.ledger.find(row => row.id === 'requests').status, 'partial');
}

module.exports = { checkSemanticAnalysis };
