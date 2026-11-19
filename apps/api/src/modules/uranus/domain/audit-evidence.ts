import { fieldsOf, read } from '../../../platform/values/fields.ts';

/* Which detectors could still observe what they observed before: what a missing finding proves. */
export interface ResolutionEvidence {
  readonly files: boolean;
  readonly code: boolean;
  readonly dependencies: boolean;
  readonly licences: boolean;
}

export const count = (value: unknown): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0);

/*
 * A missing observation proves a fix only when the detector that made it could
 * still observe it. Each family of findings has its own detectors: the file
 * rules, the tracer on top of them for code, the registry and advisory lookups
 * for dependencies, the licence answers for licences. The merge gate and the
 * stored `analysis_complete` still ask for every family at once.
 */
export function resolutionEvidence(result: Readonly<Record<string, unknown>>, truncated = false): ResolutionEvidence {
  const coverage = fieldsOf(result.coverage);
  const files = coverage.complete === true && count(coverage.read) >= count(coverage.eligible) && !truncated;
  const traced = fieldsOf(read(result.engine, 'traced'));
  const code = files && !traced.limit && !['cut', 'failed', 'deep', 'truncated', 'patternOnly', 'rulesOnly'].some(key => count(traced[key]) > 0) && !count(coverage.rulesOnly);
  const lookedUp = ['packages', 'advisories'].every(name => {
    const checked = coverage[name];
    const total = name === 'packages' ? 'declared' : 'versions';
    return !checked || !(read(checked, 'inventoryComplete') === false || count(read(checked, 'unknown')) || count(read(checked, 'notChecked')) || count(read(checked, 'checked')) < count(read(checked, total)));
  });
  const dependencies = files && lookedUp;
  const licences = coverage.licences;
  const licenceStatus = read(result.licences, 'status');
  const licencesExpected = count(read(coverage.advisories, 'versions')) > 0;
  const licencesAnswered = !(licencesExpected && !licences && !licenceStatus) && !(licences && count(read(licences, 'fromLock')) + count(read(licences, 'answered')) < count(read(licences, 'versions')))
    && !(licenceStatus && (count(read(licenceStatus, 'unknown')) || count(read(licenceStatus, 'notAsked'))));
  return { files, code, dependencies, licences: dependencies && licencesAnswered };
}

/* Which detectors a stored finding depends on, read from its rule. */
export function evidenceFamily(rule: unknown): keyof ResolutionEvidence {
  const prefix = String(rule || '').split('-')[0];
  if (prefix === 'DEP') return 'dependencies';
  if (prefix === 'LIC') return 'licences';
  if (prefix === 'SEC' || prefix === 'ACC' || rule === 'AI-001' || rule === 'AI-002') return 'code';
  return 'files';
}
