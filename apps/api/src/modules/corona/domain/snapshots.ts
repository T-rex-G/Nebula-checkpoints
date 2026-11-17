/*
 * What a restore would do, from two snapshots of one repository: the
 * baseline it would return to and what is there now. Branches and tags, and
 * the files a manifest lists, are each sorted into those that match, those
 * that moved, those that must be recreated, and those newer than the
 * baseline, which a restore keeps.
 */
import { member, read } from '../../../platform/values/fields.ts';
import { cleanText } from '../../../platform/values/text.ts';

export interface Comparison {
  readonly unchanged: { readonly name: string; readonly sha: unknown }[];
  readonly move: { readonly name: string; readonly expected: unknown; readonly current: unknown }[];
  readonly recreate: { readonly name: string; readonly expected: unknown; readonly current: '' }[];
  readonly preserve: { readonly name: string; readonly current: unknown }[];
}

function compareNamedObjects(baselineItems: unknown, currentItems: unknown, key = 'name', value = 'sha'): Comparison {
  const named = (items: unknown): Map<string, unknown> => new Map((Array.isArray(items) ? items : [])
    .filter(item => item && read(item, key)).map(item => [String(read(item, key)), item]));
  const baseline = named(baselineItems);
  const current = named(currentItems);
  const unchanged: Comparison['unchanged'] = [], move: Comparison['move'] = [], recreate: Comparison['recreate'] = [], preserve: Comparison['preserve'] = [];
  for (const [name, expected] of baseline) {
    const actual = current.get(name);
    if (!actual) recreate.push({ name, expected: read(expected, value) || '', current: '' });
    else if (String(read(actual, value) || '') === String(read(expected, value) || '')) unchanged.push({ name, sha: read(expected, value) || '' });
    else move.push({ name, expected: read(expected, value) || '', current: read(actual, value) || '' });
  }
  for (const [name, actual] of current) if (!baseline.has(name)) preserve.push({ name, current: read(actual, value) || '' });
  return { unchanged, move, recreate, preserve };
}

export function compareSnapshots(baselineSnapshot: unknown = {}, currentSnapshot: unknown = {}) {
  const baselineOf = (key: string): unknown => member(baselineSnapshot, key);
  const currentOf = (key: string): unknown => member(currentSnapshot, key);
  const ownerA = cleanText(baselineOf('owner') || '', 100).toLowerCase();
  const ownerB = cleanText(currentOf('owner') || '', 100).toLowerCase();
  const repoA = cleanText(baselineOf('repo') || '', 100).toLowerCase();
  const repoB = cleanText(currentOf('repo') || '', 100).toLowerCase();
  const providerA = cleanText(baselineOf('provider') || '', 40).toLowerCase();
  const providerB = cleanText(currentOf('provider') || '', 40).toLowerCase();
  const providerCompatible = !providerA || !providerB || providerA === providerB;
  const compatible = !!ownerA && !!repoA && ownerA === ownerB && repoA === repoB && providerCompatible;
  const refs = compareNamedObjects(baselineOf('refs'), currentOf('refs'));
  const tags = compareNamedObjects(baselineOf('tags'), currentOf('tags'));
  const manifestFiles = (manifest: unknown): readonly unknown[] => {
    const files = manifest && read(manifest, 'files');
    return manifest && Array.isArray(files) ? files : [];
  };
  const baseManifest = manifestFiles(baselineOf('manifest'));
  const currentManifest = manifestFiles(currentOf('manifest'));
  const fileDiff = compareNamedObjects(baseManifest, currentManifest, 'path', 'sha');
  const files = {
    unchanged: fileDiff.unchanged.map(item => ({ path: item.name, sha: item.sha })),
    modified: fileDiff.move.map(item => ({ path: item.name, expected: item.expected, current: item.current })),
    restore: fileDiff.recreate.map(item => ({ path: item.name, expected: item.expected })),
    preserve: fileDiff.preserve.map(item => ({ path: item.name, current: item.current }))
  };
  const counts = {
    refsToMove: refs.move.length,
    refsToRecreate: refs.recreate.length,
    refsUnchanged: refs.unchanged.length,
    newerRefsPreserved: refs.preserve.length,
    tagsChanged: tags.move.length + tags.recreate.length,
    filesModified: files.modified.length,
    filesToRestore: files.restore.length,
    newerFilesPreserved: files.preserve.length
  };
  const truncated = (manifest: unknown): boolean => !!(manifest && read(manifest, 'truncated'));
  return {
    compatible,
    repository: compatible ? `${String(baselineOf('owner'))}/${String(baselineOf('repo'))}` : '',
    refs,
    tags,
    files,
    counts,
    manifestCompared: !!(baseManifest.length || currentManifest.length),
    truncated: truncated(baselineOf('manifest')) || truncated(currentOf('manifest'))
  };
}

export type SnapshotComparison = ReturnType<typeof compareSnapshots>;
