/*
 * A person's safety controls: read-only mode, the sync freeze, and the paths
 * they have protected in each repository.
 *
 * What is stored is read through defaultSafety, so a missing or malformed
 * record is the controls all off rather than an error. A change is applied by
 * applySafetyPatch to the controls as they are now, never to a copy a request
 * took earlier: only the switches the change names are set, and a path is
 * protected or released one at a time. A path is kept clean (forward slashes,
 * no leading slash, no doubled slash, nothing that climbs out with ".."), a
 * repository holds at most 100 of them, and at most 30 repositories hold any.
 */

export interface SafetyControls {
  readOnly: boolean;
  freezeSync: boolean;
  protected: Record<string, string[]>;
}

export interface SafetyPatch {
  readonly readOnly?: unknown;
  readonly freezeSync?: unknown;
  readonly protect?: { readonly repo?: unknown; readonly path?: unknown; readonly on?: unknown } | null;
}

const invalid = (message: string, status: number) => Object.assign(new Error(message), { status, code: 'SAFETY_INPUT_INVALID', providerChanged: false });

export function defaultSafety(value: unknown): SafetyControls {
  const sf = (value && typeof value === 'object' ? value : {}) as { readonly readOnly?: unknown; readonly freezeSync?: unknown; readonly protected?: unknown };
  return {
    readOnly: !!sf.readOnly,
    freezeSync: !!sf.freezeSync,
    protected: (sf.protected && typeof sf.protected === 'object' ? sf.protected : {}) as Record<string, string[]>
  };
}

export function applySafetyPatch(state: unknown, patch: SafetyPatch | null | undefined): SafetyControls {
  const cur = defaultSafety(state);
  cur.protected = { ...cur.protected };
  const b = patch || {};
  if (typeof b.readOnly === 'boolean') cur.readOnly = b.readOnly;
  if (typeof b.freezeSync === 'boolean') cur.freezeSync = b.freezeSync;
  if (b.protect && b.protect.repo && b.protect.path) {
    const key = String(b.protect.repo).trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(key)) throw invalid('Invalid repository key', 400);
    const list = new Set(cur.protected[key] || []);
    const protectedPath = String(b.protect.path).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/').trim();
    if (!protectedPath || protectedPath.length > 512 || protectedPath.includes('..')) throw invalid('Invalid protected path or pattern', 400);
    if (b.protect.on === false) list.delete(protectedPath); else list.add(protectedPath);
    if (list.size > 100) throw invalid('Up to 100 protected paths or patterns per repository', 413);
    if (list.size) cur.protected[key] = [...list].sort(); else delete cur.protected[key];
    if (Object.keys(cur.protected).length > 30) throw invalid('Up to 30 repositories with protected paths', 413);
  }
  return cur;
}
