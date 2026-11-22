/* Bounded semantic evidence for JavaScript and TypeScript rendering and database calls. */
import ts from 'typescript';
import { mayContainMarkupSink, mayContainSemanticSink } from './uranus-ts-candidates.ts';
import { isOrdinaryHtmlReceiver, semanticSink } from './uranus-ts-framework.ts';
import { buildSemanticProject } from './uranus-ts-project.ts';
import { semanticSqlSink } from './uranus-ts-sql.ts';
import { globalName, member, unwrap } from './uranus-ts-symbols.ts';
import { createSemanticReader, type SemanticValue } from './uranus-ts-values.ts';
import type { FlowFile, FlowRecord, TracedFlowRecord } from './uranus-flow.ts';
import type { Step } from './uranus-cfamily.ts';

export type SemanticReason = 'unknown-origin' | 'unknown-receiver' | 'html-context' | 'trust-boundary' | 'declared-input';
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

function traced(value: SemanticValue, path: string, line: number, kind: 'sql' | 'dom', label: string,
  blocker: SemanticReason | null, pathOf: (node: ts.Node) => string): FlowRecord | null {
  if (value.kind !== 'input' || !value.origin) return null;
  const origin = value.origin;
  const trace: Step[] = [{ path: pathOf(origin), line: lineOf(origin), role: 'entrypoint', note: 'read from a modeled application input' }];
  for (const step of value.steps || []) {
    const path = pathOf(step), at = lineOf(step);
    if (trace.some(s => s.path === path && s.line === at)) continue;
    if (trace.length >= 5) break;
    trace.push({ path, line: at, role: 'propagation', note: 'the symbol or call carries the value' });
  }
  trace.push({ path, line, role: 'sink', note: label });
  const reason = blocker ?? (value.reason === 'declared-input' ? 'declared-input' : value.conditional ? 'conditional' : null);
  return { rule: kind === 'sql' ? 'SEC-001' : 'SEC-002', kind, severity: kind === 'sql' ? 'critical' : 'serious', path, line,
    source: 'a modeled application input', verdict: reason ? 'needs-validation' : 'confirmed',
    blocker: reason ? { reason } : null, trace, viaHelper: trace.some(step => step.path !== path) ? 'file' : null };
}

export function analyseSemanticFlows(files: readonly FlowFile[], legacy: TracedFlowRecord[], stop: () => boolean, perFileLimit: number) {
  const lines = new Map<string, LineEvidence>();
  const shadowed = new Set<string>(), ambient = new Set<string>();
  const sites: SemanticSite[] = [], leads: SemanticLead[] = [];
  const stats: SemanticStats = { files: 0, nodes: 0, skippedFiles: 0, unresolvedImports: 0, unresolvedOperations: 0, truncatedFiles: 0, complete: false };
  const analyzed: FlowRecord[] = [];
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
    const reader = createSemanticReader(checker, project.pathOf, stop, project.files);
    let visited = 0, interrupted = false;
    for (const file of project.files) {
      const path = project.pathOf(file);
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
        const sink = semanticSink(node, checker);
        if (sink || isOrdinaryHtmlReceiver(node, checker)) {
          const line = observeLine(file, nameOfSite(node), path, lines);
          if (sink && reader.reachable(node)) {
            for (const expression of [sink.value, ...(sink.additionalValues || [])]) {
              const value = reader.read(expression);
              if (value.kind === 'literal' || value.kind === 'scalar' || value.kind === 'trusted-html' ||
                  (value.kind === 'encoded-text' && sink.context === 'text')) continue;
              line.safe = false;
              const obstacle = sink.policy;
              // When both the receiver and a transform's implementation are unknown,
              // the compiler has no evidence that this expression passes unchecked data to a renderer.
              if (obstacle === 'unknown-receiver' && value.reason === 'unresolved-call') {
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
        if (sql && reader.reachable(node)) {
          const at = lineOf(nameOfSite(node));
          const flow = traced(reader.read(sql), path, at, 'sql', 'used as database statement text', null, project.pathOf);
          if (flow && admit('SEC-001', at)) analyzed.push(flow);
        }
        ts.forEachChild(node, visitNode);
      };
      visitNode(file);
      if (truncated) stats.truncatedFiles++;
      if (interrupted) break;
    }
    inspected = !project.incomplete && !interrupted && !reader.limited() && !stats.truncatedFiles;
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
    if (flow.rule !== 'SEC-002') return true;
    const line = covered.get(keyOf(flow.path, flow.line));
    if (!line) return true;
    if (line.safe) return false;
    const entry = flow.trace[0];
    if (!entry) return true;
    const sourceLine = keyOf(entry.path, entry.line);
    if (flow.source === 'the page’s URL' && shadowed.has(sourceLine) && !ambient.has(sourceLine)) return false;
    return line.operations !== 1 || !line.flows.some(replacement => replacement.verdict === 'needs-validation' &&
      replacement.trace[0]?.path === entry.path && replacement.trace[0]?.line === entry.line);
  });
  return { flows: [...kept, ...analyzed], sites, leads, stats };
}
