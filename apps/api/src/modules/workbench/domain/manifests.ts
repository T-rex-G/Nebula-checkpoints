/*
 * The packages a repository's manifests declare, for the dependency audit:
 * npm's lockfile (or, failing it, package.json, whose ranges are only
 * approximate), Python requirements pinned with ==, Go modules, Cargo and
 * Bundler lockfiles. A version is kept only when it starts with a digit once
 * its range operators are stripped; a manifest that does not parse yields
 * whatever was read from it before it stopped.
 */
import { member } from '../../../platform/values/fields.ts';

export const MANIFESTS = Object.freeze(['package-lock.json', 'package.json', 'requirements.txt', 'go.mod', 'Cargo.lock', 'Gemfile.lock']);

export type Ecosystem = 'npm' | 'PyPI' | 'Go' | 'crates.io' | 'RubyGems';
export interface ManifestPackage {
  readonly name: string;
  readonly version: string;
  readonly ecosystem: Ecosystem;
}

export function cleanVer(value: unknown): string {
  return (String(value || '').replace(/^[\^~>=<v\s]+/, '').split(/[\s,]/)[0] ?? '').trim();
}

/* The entries of what a manifest names, as `Object.entries(value)` reads it. */
function entriesOf(value: unknown): [string, unknown][] {
  return Object.entries(Object(value));
}

export function parseManifest(name: string, text: string): ManifestPackage[] {
  const out: ManifestPackage[] = [];
  const add = (n: string, v: unknown, eco: Ecosystem): void => {
    const ver = cleanVer(v);
    if (n && /^\d/.test(ver)) out.push({ name: n, version: ver, ecosystem: eco });
  };
  try {
    if (name === 'package-lock.json') {
      const j: unknown = JSON.parse(text);
      if (member(j, 'packages')) {
        for (const [k, v] of entriesOf(member(j, 'packages'))) {
          if (!k.startsWith('node_modules/')) continue;
          add(k.slice('node_modules/'.length), member(v, 'version'), 'npm');
        }
      } else if (member(j, 'dependencies')) {
        for (const [k, v] of entriesOf(member(j, 'dependencies'))) add(k, member(v, 'version'), 'npm');
      }
    } else if (name === 'package.json') {
      const j: unknown = JSON.parse(text);
      for (const grp of [member(j, 'dependencies'), member(j, 'devDependencies')]) if (grp) for (const [k, v] of entriesOf(grp)) add(k, v, 'npm');
    } else if (name === 'requirements.txt') {
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*([A-Za-z0-9._-]+)\s*==\s*([0-9][^\s;#]*)/);
        if (m && m[1] !== undefined) add(m[1], m[2], 'PyPI');
      }
    } else if (name === 'go.mod') {
      for (const line of text.split('\n')) {
        if (/^\s*module\s/.test(line)) continue;
        const m = line.match(/^\s*([a-zA-Z0-9./_-]+)\s+v([0-9][^\s/]*)/);
        if (m && m[1] !== undefined) add(m[1], m[2], 'Go');
      }
    } else if (name === 'Cargo.lock') {
      for (const b of text.split('[[package]]')) {
        const n = (b.match(/name\s*=\s*"([^"]+)"/) || [])[1];
        const v = (b.match(/version\s*=\s*"([^"]+)"/) || [])[1];
        if (n && v) add(n, v, 'crates.io');
      }
    } else if (name === 'Gemfile.lock') {
      for (const line of text.split('\n')) {
        const m = line.match(/^\s{4}([A-Za-z0-9._-]+)\s+\(([0-9][^)]*)\)/);
        if (m && m[1] !== undefined) add(m[1], m[2], 'RubyGems');
      }
    }
  } catch {}
  return out;
}
