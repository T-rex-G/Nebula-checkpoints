import { boundedMap } from '../../../platform/concurrency/bounded-map.ts';
import type { GuardedFetchInput } from '../../../platform/network/guarded-fetch.ts';
import { read } from '../../../platform/values/fields.ts';
import { versionKey, type LicenceAnswer, type LicenceEntry } from '../domain/licences.ts';

/*
 * The licence of each dependency version its lockfile did not state, asked of
 * deps.dev by ecosystem, name and version -- anonymously, through the guarded
 * transport's licence profile, which reaches that one host and nothing else.
 * Nothing about the repository leaves but the names and versions it depends on.
 */

/* The guarded transport, as the licence profile is asked through it; its answer is read field by field. */
export type LicenceTransport = (input: GuardedFetchInput) => Promise<unknown>;

const DEPS_DEV = 'https://api.deps.dev/v3/systems';
const DEPS_DEV_SYSTEM: ReadonlyMap<string, string> = new Map([['npm', 'npm'], ['pypi', 'pypi'], ['go', 'go'], ['maven', 'maven'], ['cargo', 'cargo'], ['nuget', 'nuget'], ['rubygems', 'rubygems']]);
export const LIMITS = Object.freeze({ maxLookups: 600, concurrency: 8, maxResponseBytes: 128 * 1024 });

export function depsDevUrl(entry: { readonly ecosystem: string; readonly name: string; readonly version: string }): string | null {
  const system = DEPS_DEV_SYSTEM.get(entry.ecosystem);
  if (!system) return null;
  const name = entry.ecosystem === 'pypi' ? String(entry.name).toLowerCase().replace(/[-_.]+/g, '-') : entry.name;
  const version = entry.ecosystem === 'go' && !/^v/.test(entry.version) ? `v${entry.version}` : entry.version;
  return `${DEPS_DEV}/${system}/packages/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
}

export interface LicenceLookup {
  readonly answers: Map<string, LicenceAnswer>;
  readonly asked: number;
  readonly answered: number;
  readonly fromLock: number;
  readonly total: number;
}

/*
 * The licence of each version that its lockfile did not state, asked of
 * deps.dev one version at a time, the project's own dependencies first,
 * within a bound. An answer lists the licences a version was released
 * under; more than one all apply. A question that is not answered leaves
 * that version unknown, never permissive.
 */
export async function lookupLicences(inventory: Iterable<LicenceEntry>, transport: LicenceTransport | null | undefined, limits: typeof LIMITS = LIMITS): Promise<LicenceLookup> {
  const answers = new Map<string, LicenceAnswer>();
  const wanted: LicenceEntry[] = [];
  const seen = new Set<string>();
  let fromLock = 0;
  for (const entry of inventory) {
    const key = versionKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    if (entry.license) { answers.set(key, { value: entry.license, source: 'lock' }); fromLock += 1; continue; }
    if (DEPS_DEV_SYSTEM.has(entry.ecosystem)) wanted.push(entry);
  }
  const asked = wanted.slice(0, limits.maxLookups);
  let answered = 0;
  if (transport) {
    await boundedMap(asked, limits.concurrency, async entry => {
      const key = versionKey(entry);
      try {
        const response = await transport({ url: depsDevUrl(entry), profile: 'licence-query', method: 'GET', headers: { accept: 'application/json', 'user-agent': 'Nebulaverse-X-Audit/1.0' }, maxResponseBytes: limits.maxResponseBytes });
        const status = Number(read(response, 'statusCode'));
        if (status === 404) { answers.set(key, { value: null, source: 'deps.dev', missing: true }); answered += 1; return; }
        if (status !== 200) throw new Error('unanswered');
        const body: unknown = JSON.parse(String(read(response, 'body') || ''));
        const listed = read(body, 'licenses');
        const licences = Array.isArray(listed) ? listed.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, 6) : [];
        answers.set(key, { value: licences.length > 1 ? licences.map(item => `(${item})`).join(' AND ') : licences[0] || null, source: 'deps.dev' });
        answered += 1;
      } catch {
        answers.set(key, 'unknown');
      }
    });
  }
  for (const entry of wanted.slice(limits.maxLookups)) answers.set(versionKey(entry), 'not-asked');
  if (!transport) for (const entry of asked) answers.set(versionKey(entry), 'not-asked');
  return { answers, asked: transport ? asked.length : 0, answered, fromLock, total: seen.size };
}
