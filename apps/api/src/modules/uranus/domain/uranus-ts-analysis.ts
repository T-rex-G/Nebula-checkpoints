/* Bounded semantic evidence for JavaScript and TypeScript rendering and server-side calls. */
import ts from 'typescript';
import { MONGO_METHODS, mayContainMarkupSink, mayContainSemanticSink, mayUseChildProcess, mayUseMongoose, mayUseNodeFilesystem } from './uranus-ts-candidates.ts';
import { isOrdinaryHtmlReceiver, semanticSink } from './uranus-ts-framework.ts';
import { commandCall, type CommandBlocker, type Shell } from './uranus-ts-child-process.ts';
import { filesystemPaths, fixedPathChoice } from './uranus-ts-filesystem.ts';
import { mongooseFilter } from './uranus-ts-mongoose.ts';
import { buildSemanticProject } from './uranus-ts-project.ts';
import { semanticSqlSink } from './uranus-ts-sql.ts';
import { globalName, member, unwrap } from './uranus-ts-symbols.ts';
import { createSemanticReader, type SemanticValue } from './uranus-ts-values.ts';
import type { FlowFile, FlowRecord, ShellSites, TracedFlowRecord } from './uranus-flow.ts';
import type { Step } from './uranus-cfamily.ts';

export type SemanticReason = 'unknown-origin' | 'unknown-receiver' | 'html-context' | 'trust-boundary' | 'declared-input' | 'unverified-tag' | 'detached-document' | 'path-boundary' | CommandBlocker;
export interface SemanticStats {
  files: number;
  nodes: number;
  skippedFiles: number;
  unresolvedImports: number;
  unresolvedOperations: number;
  truncatedFiles: number;
  complete: boolean;
}
export interface SemanticLead { path: string; line: number; reason: SemanticReason }
export interface SemanticSite { path: string; line: number; suppressPattern: boolean }

interface LineEvidence {
  path: string;
  line: number;
  lineMask: string[];
  start: number;
  operations: number;
  safe: boolean;
  leads: SemanticLead[];
  flows: FlowRecord[];
}
const keyOf = (path: string, line: number) => path + '\0' + line;

function nameOfSite(node: ts.Node): ts.Node {
  const target = ts.isBinaryExpression(node) ? node.left : ts.isCallExpression(node) ? node.expression : null;
  return (target && member(target)?.key) || (ts.isJsxAttribute(node) ? node.name : node);
}

function lineOf(node: ts.Node): number {
  const file = node.getSourceFile();
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

/* Check every candidate spelling on a line before replacing a legacy observation:
 * two independent writes at the same rule/line share a public finding ID. */
function observeLine(file: ts.SourceFile, token: ts.Node, path: string, lines: Map<string, LineEvidence>): LineEvidence {
  const pos = token.getStart(file);
  const number = file.getLineAndCharacterOfPosition(pos).line;
  const line = number + 1, key = keyOf(path, line);
  let evidence = lines.get(key);
  if (!evidence) {
    const starts = file.getLineStarts();
    const start = starts[number] ?? 0, end = starts[number + 1] ?? file.end;
    evidence = { path, line, start, lineMask: file.text.slice(start, end).split(''), operations: 0, safe: true, leads: [], flows: [] };
    lines.set(key, evidence);
  }
  evidence.operations++;
  for (let i = Math.max(0, pos - evidence.start); i < Math.min(token.end - evidence.start, evidence.lineMask.length); i++) evidence.lineMask[i] = ' ';
  return evidence;
}

/* Distinguish a lexical binding named window/location from an actual browser URL.
 * A line containing both origins is ambiguous at the legacy trace's resolution. */
function browserRoot(node: ts.Node): ts.Identifier | null {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return null;
  const ref = member(node);
  if (!ref) return null;
  const receiver = unwrap(ref.base);
  if (ts.isIdentifier(receiver)) {
    if (receiver.text === 'location' && ['search', 'hash', 'href', 'pathname'].includes(ref.name)) return receiver;
    if (receiver.text === 'document' && ['URL', 'documentURI', 'referrer', 'baseURI'].includes(ref.name)) return receiver;
    if (receiver.text === 'window' && ref.name === 'name') return receiver;
  }
  const base = member(receiver);
  if (!base || base.name !== 'location' || !['search', 'hash', 'href', 'pathname'].includes(ref.name)) return null;
  const root = unwrap(base.base);
  return ts.isIdentifier(root) && ['window', 'document', 'globalThis', 'self'].includes(root.text) ? root : null;
}

function traced(value: SemanticValue, path: string, line: number, kind: 'sql' | 'dom' | 'path' | 'nosql' | 'command', label: string,
  blocker: SemanticReason | null, pathOf: (node: ts.Node) => string): FlowRecord | null {
  if (value.kind !== 'input' || !value.origin) return null;
  const origin = value.origin;
  const trace: Step[] = [{ path: pathOf(origin), line: lineOf(origin), role: 'entrypoint', note: 'read from a modeled application input' }];
  for (const step of value.steps || []) {
    const path = pathOf(step), at = lineOf(step);
    if (trace.some(s => s.path === path && s.line === at)) continue;
    if (trace.length >= 5) break;
    const note = ts.isTaggedTemplateExpression(step) && value.reason === 'unverified-tag'
      ? 'a template tag received this value as a substitution' : 'the symbol or call carries the value';
    trace.push({ path, line: at, role: 'propagation', note });
  }
  trace.push({ path, line, role: 'sink', note: label });
  const valueReason = value.reason === 'declared-input' || value.reason === 'unverified-tag' ? value.reason : null;
  const reason = (kind === 'nosql' ? 'nosql' : blocker) ?? valueReason ?? (value.conditional ? 'conditional' : null);
  return { rule: { sql: 'SEC-001', dom: 'SEC-002', path: 'SEC-022', nosql: 'SEC-029', command: 'SEC-011' }[kind], kind, severity: kind === 'sql' || kind === 'command' ? 'critical' : 'serious', path, line,
    source: 'a modeled application input', verdict: reason ? 'needs-validation' : 'confirmed',
    blocker: reason ? { reason } : null, trace, viaHelper: trace.some(step => step.path !== path) ? 'file' : null };
}

export function analyseSemanticFlows(files: readonly FlowFile[], legacy: TracedFlowRecord[], stop: () => boolean, perFileLimit: number, shellSites: ShellSites) {
  const lines = new Map<string, LineEvidence>();
  const shadowed = new Set<string>(), ambient = new Set<string>();
  const sites: SemanticSite[] = [], leads: SemanticLead[] = [];
  const stats: SemanticStats = { files: 0, nodes: 0, skippedFiles: 0, unresolvedImports: 0, unresolvedOperations: 0, truncatedFiles: 0, complete: false };
  const analyzed: FlowRecord[] = [];
  const shellModes = new Map<TracedFlowRecord, Shell>();
  const safeFilters = new Map<string, boolean>();
  const reported = new Map<string, Set<string>>();
  for (const flow of legacy) {
    let entries = reported.get(flow.path);
    if (!entries) { entries = new Set(); reported.set(flow.path, entries); }
    entries.add(flow.rule + '/' + flow.line);
  }
  let inspected = false;
  try {
    const project = buildSemanticProject(files, stop, files.length <= 32 ? undefined : file => mayContainSemanticSink(file.text));
    stats.files = project.files.length;
    stats.nodes = project.nodes;
    stats.skippedFiles = project.skippedFiles;
    stats.unresolvedImports = project.unresolvedImports;
    const checker = project.checker;
    if (!checker) return { flows: legacy, sites, leads, stats };
    let reader: ReturnType<typeof createSemanticReader> | undefined;
    const values = () => reader ??= createSemanticReader(checker, project.pathOf, stop, project.files);
    let visited = 0, interrupted = false;
    const mongoose = project.files.some(file => mayUseMongoose(file.text));
    for (const file of project.files) {
      const path = project.pathOf(file);
      const childProcess = mayUseChildProcess(file.text);
      const filesystem = mayUseNodeFilesystem(file.text);
      const reports = reported.get(path) ?? new Set<string>();
      let truncated = false;
      function admit(rule: string, line: number): boolean {
        const id = rule + '/' + line;
        if (reports.has(id)) return true;
        if (reports.size >= perFileLimit) { truncated = true; return false; }
        reports.add(id);
        return true;
      }
      // The compiler host has already bounded tree depth. Source order also
      // makes a truncated report retain the earliest witnessed sites.
      const visitNode = (node: ts.Node): void => {
        if (interrupted) return;
        if ((visited++ & 127) === 0 && stop()) { interrupted = true; return; }
        const root = browserRoot(node);
        if (root) {
          const sourceLine = keyOf(path, lineOf(root));
          (globalName(root, root.text, checker) ? ambient : shadowed).add(sourceLine);
        }
        const sink = ts.isBinaryExpression(node) || ts.isCallExpression(node) || ts.isJsxAttribute(node) ? semanticSink(node, checker) : null;
        if (sink || (ts.isBinaryExpression(node) && isOrdinaryHtmlReceiver(node, checker))) {
          const line = observeLine(file, sink?.site ?? nameOfSite(node), path, lines);
          if (sink && values().reachable(node)) {
            for (const expression of [sink.value, ...(sink.additionalValues || [])]) {
              const value = values().read(expression);
              if (value.kind === 'literal' || value.kind === 'scalar' || value.kind === 'trusted-html' ||
                  (value.kind === 'encoded-text' && sink.context === 'text')) continue;
              line.safe = false;
              const obstacle = sink.policy;
              // An opaque tag without a witnessed substitution supplies no origin.
              // An opaque call on an unresolved rendering boundary also lacks a witness.
              if (value.reason === 'unresolved-tag' || (obstacle === 'unknown-receiver' &&
                  (value.reason === 'unresolved-call' || value.reason === 'unresolved-member'))) {
                stats.unresolvedOperations++;
                continue;
              }
              if (!admit('SEC-002', line.line)) continue;
              const flow = traced(value, path, line.line, 'dom', sink.label, obstacle, project.pathOf);
              if (flow) line.flows.push(flow);
              else {
                const reason: SemanticReason = value.kind === 'encoded-text' ? 'html-context' : obstacle ?? 'unknown-origin';
                line.leads.push({ path, line: line.line, reason });
              }
            }
          }
        }
        const sql = ts.isCallExpression(node) && semanticSqlSink(node, checker);
        if (sql && values().reachable(node)) {
          const at = lineOf(nameOfSite(node));
          const value = values().read(sql);
          const flow = traced(value, path, at, 'sql', 'used as database statement text', null, project.pathOf);
          if (flow) {
            if (admit('SEC-001', at)) analyzed.push(flow);
          } else if (value.kind !== 'literal' && value.kind !== 'scalar') {
            // An HTML encoding guarantee or an opaque call cannot settle statement text.
            stats.unresolvedOperations++;
          }
        }
        if (mongoose && ts.isCallExpression(node)) {
          const method = member(node.expression, checker);
          if (method && (MONGO_METHODS.has(method.name) || method.name === 'update')) {
            // The lexical tracer keys each call by the line of its opening parenthesis.
            const at = file.getLineAndCharacterOfPosition(node.arguments.pos - 1).line + 1;
            const result = mongooseFilter(node, method.name, method.base, checker, values);
            const key = keyOf(path, at);
            if (reports.has('SEC-029/' + at)) safeFilters.set(key, result === 'safe' && safeFilters.get(key) !== false);
            if (result && result !== 'safe' && admit('SEC-029', at)) {
              const flow = traced(result, path, at, 'nosql', 'used as a field in a database query object', null, project.pathOf);
              if (flow) analyzed.push(flow);
            }
          }
        }
        if (childProcess && ts.isCallExpression(node)) {
          const call = commandCall(node, checker, values);
          // Reconcile the executable and argv evidence at this exact call, even on a shared line.
          const offset = node.arguments.pos - 1;
          if (call && call.shell !== 'enabled') {
            for (const flow of shellSites.get(path)?.get(offset) ?? []) shellModes.set(flow, call.shell);
          }
          const argument = call?.argument;
          if (argument) {
            const at = file.getLineAndCharacterOfPosition(node.arguments.pos - 1).line + 1;
            const flow = traced(argument.value, path, at, 'command', 'supplied in the child process argument position', argument.blocker, project.pathOf);
            if (flow && admit('SEC-011', at)) analyzed.push(flow);
          }
        }
        if (filesystem && ts.isCallExpression(node)) {
          let unresolved = false;
          for (const argument of filesystemPaths(node, checker)) {
            const reader = values();
            if (!reader.reachable(node)) break;
            const value = reader.read(argument);
            if (value.kind === 'literal' || value.kind === 'scalar' || fixedPathChoice(argument, reader.guards(node), checker)) continue;
            const at = lineOf(nameOfSite(node));
            const flow = traced(value, path, at, 'path', 'selects a Node filesystem pathname', 'path-boundary', project.pathOf);
            if (!flow) unresolved = true;
            else if (admit('SEC-022', at)) analyzed.push(flow);
          }
          if (unresolved) stats.unresolvedOperations++;
        }
        ts.forEachChild(node, visitNode);
      };
      visitNode(file);
      if (truncated) stats.truncatedFiles++;
      if (interrupted) break;
    }
    inspected = !project.incomplete && !interrupted && !reader?.limited() && !stats.truncatedFiles;
    stats.complete = inspected && !stats.unresolvedOperations;
  } catch (error) {
    // A compiler or traversal failure never discards findings from the other analysis.
    if (!(error instanceof Error)) throw error;
    stats.complete = false;
  }
  const covered = new Map<string, LineEvidence>();
  for (const [key, line] of lines) {
    const accounted = inspected && !mayContainMarkupSink(line.lineMask.join(''));
    if (accounted) covered.set(key, line);
    sites.push({ path: line.path, line: line.line, suppressPattern: accounted && line.safe });
    leads.push(...line.leads);
    analyzed.push(...line.flows);
  }
  const kept = legacy.filter(flow => {
    if (inspected && shellModes.get(flow) === 'disabled') return false;
    if (flow.rule === 'SEC-029') return !inspected || !safeFilters.get(keyOf(flow.path, flow.line));
    if (flow.rule !== 'SEC-002') return true;
    const line = covered.get(keyOf(flow.path, flow.line));
    if (!line) return true;
    if (line.safe) return false;
    const entry = flow.trace[0];
    if (!entry) return true;
    const sourceLine = keyOf(entry.path, entry.line);
    if (flow.source === 'the page’s URL' && shadowed.has(sourceLine) && !ambient.has(sourceLine)) return false;
    if (line.operations !== 1) return true;
    return !line.flows.some(replacement => {
      if (replacement.trace[0]?.path !== entry.path || replacement.trace[0]?.line !== entry.line) return false;
      if (replacement.verdict === 'needs-validation') return true;
      return replacement.verdict === flow.verdict && replacement.trace.some(step =>
        step.role === 'propagation' && step.path !== flow.path && !flow.trace.some(old => old.path === step.path && old.line === step.line));
    });
  });
  const reconciled = kept.map(flow => flow.verdict === 'confirmed' && shellModes.has(flow)
    ? { ...flow, verdict: 'needs-validation' as const, blocker: { reason: 'shell-option' as const } } : flow);
  return { flows: [...reconciled, ...analyzed], sites, leads, stats };
}
