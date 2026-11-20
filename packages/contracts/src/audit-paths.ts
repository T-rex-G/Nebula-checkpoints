export const AUDIT_PATHS_CONTRACT_VERSION = 1;

/* Directory conventions describe where a finding lives, not whether the code runs. */
export function isTestPath(filePath: string): boolean {
  return /(^|\/)(tests?|__tests__|spec|specs|e2e|cypress|playwright)\//i.test(filePath) ||
    /\.(test|spec)\.[a-z]+$/i.test(filePath) || /(^|\/)test_[^/]+\.py$|_test\.(py|go)$/.test(filePath);
}

export function supportingPathRole(path: unknown): 'test' | 'example' | 'asset' | null {
  if (typeof path !== 'string') return null;
  if (isTestPath(path)) return 'test';
  if (/(^|\/)(__fixtures__|fixtures?|testdata|test-data|examples?|samples?|tutorials?)\//i.test(path)) return 'example';
  if (/(^|\/)(static|assets)\//i.test(path)) return 'asset';
  return null;
}
