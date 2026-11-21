#!/usr/bin/env node
'use strict';

// Offline accuracy qualification. Only the explicitly selected trusted Uranus engine is loaded.
const path = require('node:path');
const ts = require('typescript');
const { tally } = require('./uranus-owasp-benchmark');
const { CORPORA, applicationCases, policyCases, sha256, git } = require('./uranus-framework-inputs');

const PROTOCOL_SHA256 = 'f5daa477ed790fe02517654ede21e5e81f248c7222bd457fe7082c2f823304ed';
const ratio = (n, denominator) => denominator ? n / denominator : null;

function measure(rows, confirmed) {
  const matches = row => confirmed ? row.findings.filter(f => f.verdict === 'confirmed') : row.findings;
  const outcomes = rows.map(row => ({ name: row.id, category: row.language, rule: row.rule,
    cwe: row.cwe, real: row.positive, flagged: matches(row).length > 0 }));
  const { tp, fp, fn, tn } = tally(outcomes).total;
  let labelledLines = 0, matchedLines = 0;
  for (const row of rows) {
    labelledLines += row.locations.length;
    const reported = new Set(matches(row).map(f => f.line));
    matchedLines += row.locations.filter(line => reported.has(line)).length;
  }
  return { tp, fp, fn, tn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn),
    falsePositiveRate: ratio(fp, fp + tn), falseNegativeRate: ratio(fn, tp + fn),
    matchedPositiveLines: matchedLines, labelledPositiveLines: labelledLines,
    positivesWithoutLineLabels: rows.filter(row => row.positive && !row.locations.length).length };
}

function scores(rows) {
  return { all: measure(rows, false), confirmed: measure(rows, true) };
}

function scoreCases(cases, analyse) {
  const rows = [];
  let engine, ruleset;
  for (const { text, ...label } of cases) {
    const { path: filePath, rule, start, end } = label;
    const kind = label.language === 'typescript' ? ts.ScriptKind.TS : ts.ScriptKind.JS;
    const parsed = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, false, kind);
    const parseDiagnostics = parsed.parseDiagnostics.map(d => ({ code: d.code,
      line: parsed.getLineAndCharacterOfPosition(d.start ?? 0).line + 1 }));
    const audit = analyse({ files: [{ path: filePath, text }] });
    if (rows.length && (audit.engine.version !== engine || audit.engine.ruleset !== ruleset)) {
      throw new Error('The analysis identity changed within a run');
    }
    engine = audit.engine.version;
    ruleset = audit.engine.ruleset;
    const sameRule = audit.findings.filter(finding => finding.path === filePath && finding.rule === rule);
    const findings = sameRule.filter(f => f.line >= start && f.line <= end)
      .map(f => ({ line: f.line, verdict: f.verdict, evidence: f.evidence }));
    rows.push({ ...label, inputSha256: sha256(text), findings, sameRuleOutsideInterval: sameRule.length - findings.length,
      parseDiagnostics, engineTraced: audit.engine.traced, capped: audit.capped, capReason: audit.capReason });
  }
  const groups = new Map();
  for (const row of rows) {
    const key = row.language + '/CWE-' + row.cwe;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return { engine, ruleset, cases: rows, overall: scores(rows),
    byLanguageAndCwe: Object.fromEntries([...groups].map(([key, group]) => [key, scores(group)])) };
}

function main() {
  const [corpus, checkout, flag, selectedEngine, ...extra] = process.argv.slice(2);
  if (!Object.hasOwn(CORPORA, corpus) || !checkout || extra.length ||
      (flag !== undefined && (flag !== '--trusted-engine' || !selectedEngine))) {
    throw new Error('Usage: node scripts/uranus-framework-benchmark.js <juice-shop|dom-policy> <upstream-checkout> [--trusted-engine <engine-checkout>]');
  }
  const engineRoot = selectedEngine ? path.resolve(selectedEngine) : path.resolve(__dirname, '..');
  const { analyse } = require(path.join(engineRoot, 'apps/api/src/modules/uranus/index.ts'));
  const inputs = corpus === 'juice-shop' ? applicationCases(checkout) : policyCases(checkout);
  const cpuStart = process.cpuUsage(), start = process.hrtime.bigint();
  const result = scoreCases(inputs.cases, analyse);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const cpu = process.cpuUsage(cpuStart);
  const engineChanges = git(engineRoot, 'status', '--short', '--', 'apps/api/src/modules/uranus', 'packages/contracts').trim();
  console.log(JSON.stringify({
    protocol: 1, protocolSha256: PROTOCOL_SHA256, corpus, ...CORPORA[corpus], engineCommit: git(engineRoot, 'rev-parse', 'HEAD').trim(),
    engineChanges, node: process.version, runtime: { platform: process.platform, arch: process.arch, elapsedMs,
      cpuMs: (cpu.user + cpu.system) / 1000, processPeakRssKiB: process.resourceUsage().maxRSS },
    scope: 'One file per audit. No package or provider lookups. Timings include syntax diagnostics and scoring after input extraction.',
    excluded: inputs.excluded, ...result
  }, null, 2));
}

if (require.main === module) main();
module.exports = { scoreCases, PROTOCOL_SHA256 };
