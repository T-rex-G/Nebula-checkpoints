import { boundedMap } from '../../../platform/concurrency/bounded-map.ts';
import type { GuardedFetchInput } from '../../../platform/network/guarded-fetch.ts';
import { listOf, ownEntry, read } from '../../../platform/values/fields.ts';
import * as ecosystems from '../domain/ecosystems.ts';
import type { DeclaredPackage } from '../domain/ecosystems.ts';
import { LIMITS, type AuditLimits } from '../domain/audit-files.ts';
import { parseJson } from '../domain/audit-text.ts';
import { advisoryKey, dedupePackages, normalizePypi, packageKey } from '../domain/dependencies.ts';
import { describeAdvisory, type AdvisedVersion, type Advisory, type AdvisoryAnswer } from '../domain/advisories.ts';
import type { RegistryAnswer } from '../domain/code-audit.ts';

/*
 * The public registries and the advisory database, asked through the guarded
 * transport: which declared names exist, and which installed versions have
 * published advisories.
 */

/* The guarded transport, as the advisory and registry profiles are asked through it; its answer is read field by field. */
export type AuditTransport = (input: GuardedFetchInput) => Promise<unknown>;
/* The ids OSV holds for each version asked, keyed by `advisoryKey`. The entries asked are handed back as given. */
export interface AdvisoryIds<E extends AdvisedVersion = AdvisedVersion> {
  readonly asked: E[];
  readonly ids: Map<string, string[]>;
  readonly unknown: Set<string>;
  readonly total: number;
}
export interface AdvisoryLookup {
  readonly answers: Map<string, AdvisoryAnswer>;
  readonly asked: number;
  readonly total: number;
  readonly ids?: Map<string, string[]>;
}
export interface RegistryLookup {
  readonly answers: Map<string, RegistryAnswer>;
  readonly asked: number;
  readonly total: number;
}

const ADVISORY_ID = /^[A-Za-z][A-Za-z0-9._-]{2,63}$/;
const OSV = 'https://api.osv.dev/v1';
const OSV_ECOSYSTEM = ecosystems.OSV_NAMES;
const OSV_HEADERS = Object.freeze({ 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Nebulaverse-X-Audit/1.0' });
const advisoryRank = (id: string): number => (id.startsWith('MAL-') ? 0 : id.startsWith('GHSA-') ? 1 : 2);

/*
 * The advisory ids OSV holds for each of these versions: one anonymous batch
 * query per few hundred packages through the guarded transport's advisory
 * profile. A batch that fails leaves its packages in `unknown`, and unknown is
 * never a finding -- nor, for the watch, news.
 */
export async function queryAdvisoryIds<E extends AdvisedVersion>(entries: readonly E[], transport: AuditTransport, limits: AuditLimits = LIMITS): Promise<AdvisoryIds<E>> {
  const unique: E[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = advisoryKey(entry);
    if (seen.has(key) || !ownEntry(OSV_ECOSYSTEM, entry.ecosystem)) continue;
    seen.add(key);
    unique.push(entry);
  }
  const asked = unique.slice(0, limits.maxAdvisoryQueries);
  const ids = new Map<string, string[]>();
  const unknown = new Set<string>();
  for (let start = 0; start < asked.length; start += limits.advisoryBatch) {
    const batch = asked.slice(start, start + limits.advisoryBatch);
    try {
      const response = await transport({
        url: `${OSV}/querybatch`, profile: 'advisory-query', method: 'POST', headers: { ...OSV_HEADERS },
        body: JSON.stringify({ queries: batch.map(entry => ({ package: { name: entry.name, ecosystem: ownEntry(OSV_ECOSYSTEM, entry.ecosystem) }, version: entry.version })) }),
        maxResponseBytes: 256 * 1024
      });
      const body = Number(read(response, 'statusCode')) === 200 ? parseJson(String(read(response, 'body') || '')) : null;
      const results = read(body, 'results');
      if (!body || !Array.isArray(results) || results.length !== batch.length) throw new Error('unanswered');
      batch.forEach((entry, index) => {
        const result: unknown = results[index];
        const key = advisoryKey(entry);
        const listed = read(result, 'vulns');
        if (!result || typeof result !== 'object' || Array.isArray(result)
          || (listed !== undefined && !Array.isArray(listed)) || read(result, 'next_page_token')) {
          /* This bounded lookup cannot claim a complete answer from an unfinished page. */
          unknown.add(key);
          return;
        }
        const vulns = listOf(listed);
        /* Only an id written as an advisory id names one: an entry with none, or with another kind of value, leaves the answer incomplete. */
        const named = vulns.map(vuln => read(vuln, 'id')).filter((id): id is string => typeof id === 'string' && ADVISORY_ID.test(id));
        /* An id this engine cannot name leaves the answer incomplete, but never hides the ones it can. */
        if (named.length < vulns.length) unknown.add(key);
        if (named.length || !vulns.length) ids.set(key, named);
      });
    } catch {
      batch.forEach(entry => unknown.add(advisoryKey(entry)));
    }
  }
  return { asked, ids, unknown, total: unique.length };
}

/* The records themselves, a bounded number, fetched concurrently. A record that does not come back leaves its id reported alone. */
export async function fetchAdvisoryRecords(order: readonly string[], transport: AuditTransport, limits: AuditLimits = LIMITS): Promise<Map<string, unknown>> {
  const records = new Map<string, unknown>();
  await boundedMap(order.slice(0, limits.maxAdvisoryDetails), limits.lookupConcurrency + 2, async id => {
    try {
      const response = await transport({ url: `${OSV}/vulns/${encodeURIComponent(id)}`, profile: 'advisory-query', method: 'GET', headers: { accept: 'application/json', 'user-agent': OSV_HEADERS['user-agent'] }, maxResponseBytes: 256 * 1024 });
      const record = Number(read(response, 'statusCode')) === 200 ? parseJson(String(read(response, 'body') || '')) : null;
      if (record && read(record, 'id') === id) records.set(id, record);
    } catch { /* The id alone is still reported. */ }
  });
  return records;
}

/*
 * Which of these versions have published advisories: the ids, then the
 * records for the advisories found, direct dependencies and malicious-package
 * records first. `ids` keeps every id OSV answered for each version, before
 * aliases are folded together -- what the watch compares against later.
 */
export async function lookupAdvisories(entries: readonly AdvisedVersion[], transport: AuditTransport, limits: AuditLimits = LIMITS): Promise<AdvisoryLookup & { readonly ids: Map<string, string[]> }> {
  const answers = new Map<string, AdvisoryAnswer>();
  const { asked, ids: idsByKey, unknown, total } = await queryAdvisoryIds(entries, transport, limits);
  for (const key of unknown) if (!idsByKey.has(key)) answers.set(key, 'unknown');

  /*
   * Records are fetched a round at a time across packages -- every
   * vulnerable package's first advisory, then every second one -- so a
   * budget spent on one package with forty advisories does not leave the
   * next one unrated.
   */
  const order: string[] = [];
  const queued = new Set<string>();
  const lists = asked.map(entry => [...(idsByKey.get(advisoryKey(entry)) || [])].sort((a, b) => advisoryRank(a) - advisoryRank(b)));
  for (let round = 0; lists.some(list => list.length > round); round += 1) {
    for (const list of lists) {
      const id = list[round];
      if (id && !queued.has(id)) { queued.add(id); order.push(id); }
    }
  }
  const records = await fetchAdvisoryRecords(order, transport, limits);

  for (const entry of asked) {
    const key = advisoryKey(entry);
    if (answers.has(key)) continue;
    const covered = new Set<string>();
    const advisories: Advisory[] = [];
    for (const id of [...(idsByKey.get(key) || [])].sort((a, b) => advisoryRank(a) - advisoryRank(b))) {
      if (covered.has(id)) continue;
      const record = records.get(id);
      const advisory = describeAdvisory(id, record, entry);
      listOf(read(record, 'aliases')).map(String).forEach(alias => covered.add(alias));
      covered.add(id);
      advisories.push(advisory);
    }
    const partial: { readonly partial?: true } = unknown.has(key) ? { partial: true } : {};
    answers.set(key, Object.freeze({ advisories: Object.freeze(advisories), ...partial }));
  }
  return { answers, asked: asked.length, total, ids: idsByKey };
}

/*
 * Does the public registry know this name? Asked with HEAD through the
 * guarded transport, so nothing but a status comes back. Only a 404 is
 * "missing": a timeout, a refusal or a 5xx is "unknown", and unknown is never
 * reported as a finding -- an unreachable registry is not an invented package.
 */
export function registryUrl(entry: { readonly ecosystem: string; readonly name: string }): string {
  if (entry.ecosystem === 'npm') return `https://registry.npmjs.org/${entry.name.startsWith('@') ? `@${encodeURIComponent(entry.name.slice(1))}` : encodeURIComponent(entry.name)}`;
  return `https://pypi.org/pypi/${encodeURIComponent(normalizePypi(entry.name))}/json`;
}

export async function lookupPackages(packages: readonly DeclaredPackage[], transport: AuditTransport, limits: AuditLimits = LIMITS): Promise<RegistryLookup> {
  const answers = new Map<string, RegistryAnswer>();
  const unique = dedupePackages(packages).slice(0, limits.maxPackages);
  await boundedMap(unique, limits.lookupConcurrency, async entry => {
    let answer: RegistryAnswer = 'unknown';
    try {
      const response = await transport({
        url: registryUrl(entry), profile: 'provider-read', method: 'HEAD',
        headers: { accept: 'application/json', 'user-agent': 'Nebulaverse-X-Audit/1.0' }, maxResponseBytes: 1024
      });
      const status = Number(read(response, 'statusCode'));
      if (status === 404) answer = 'missing';
      else if ((status >= 200 && status < 400)) answer = 'exists';
    } catch { answer = 'unknown'; }
    answers.set(packageKey(entry), answer);
  });
  return { answers, asked: unique.length, total: dedupePackages(packages).length };
}
