/*
 * Safeguards drawn: what stands between a mistake and the repository, in one
 * place, read top to bottom as a reviewer would -- the posture in three
 * figures; this app's own switches beside the rules the provider enforces
 * for every client; the paths this app refuses to change, with one-tap
 * presets that say how many files each would cover; and the recovery tools.
 * The provider's rules are read, never written: the link goes to the
 * provider's own settings page, where changing them belongs.
 *
 * A rule reading the page cannot read -- no list of controls -- is said as
 * one, rather than stopping the screen at "Reading...". A pattern and a link
 * are written into attributes escaped as attributes, so a lock named with a
 * quote is a lock and nothing more.
 */
import { escapeAttribute, escapeHtml } from '../../platform/html.ts';
import { field, hasFields, items } from '../../platform/values.ts';
import { protectedPatternMatch } from './protected-paths.ts';

export interface Preset { readonly label: string; readonly patterns: readonly string[] }

export const SAFEGUARD_PRESETS: readonly Preset[] = Object.freeze([
  { label: 'CI workflows', patterns: ['.github/workflows/**'] },
  { label: 'Environment files', patterns: ['**/.env*'] },
  { label: 'Keys and certificates', patterns: ['**/*.pem', '**/*.key'] },
  { label: 'Lockfiles', patterns: ['**/package-lock.json', '**/yarn.lock', '**/pnpm-lock.yaml', '**/poetry.lock', '**/Cargo.lock', '**/go.sum'] },
  { label: 'Migrations', patterns: ['**/migrations/**'] },
  { label: 'Infrastructure', patterns: ['**/*.tf', '**/Dockerfile', '**/docker-compose*.yml'] },
  { label: 'Code owners', patterns: ['**/CODEOWNERS'] }
].map(preset => Object.freeze({ label: preset.label, patterns: Object.freeze(preset.patterns) })));

export const SG_ICON = Object.freeze({
  on: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  off: '<path d="M7 7l10 10M17 7L7 17"/>',
  unknown: '<path d="M9.2 9.3a2.9 2.9 0 1 1 3.9 2.7c-.7.3-1.1.9-1.1 1.6v.6M12 17.2v.1"/>',
  snapshot: '<path d="M4 8.5h3l1.6-2.5h6.8L17 8.5h3v10.5H4z"/><circle cx="12" cy="13.3" r="3.3"/>',
  recover: '<path d="M4 12a8 8 0 1 0 2.3-5.6M4 4v5h5"/><path d="M12 8v4.5l3 1.8"/>',
  scan: '<path d="M12 3.3l7.2 3v5.3c0 4.3-3 7.9-7.2 9.4-4.2-1.5-7.2-5.1-7.2-9.4V6.3z"/><path d="M9.3 12l2 2 3.5-3.8"/>',
  activity: '<path d="M3.5 12h4l2.5-6 4 12 2.5-6h4"/>',
  evidence: '<path d="M7 3.5h6.5L18 8v12.5H7z"/><path d="M13.5 3.5V8H18M9.5 13l1.8 1.8 3.4-3.6"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.4"/><path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7"/>',
  branch: '<circle cx="6.5" cy="5.5" r="2.2"/><circle cx="6.5" cy="18.5" r="2.2"/><circle cx="17.5" cy="8.5" r="2.2"/><path d="M6.5 7.7v8.6M17.5 10.7c0 3.3-3 4.3-8.8 5.4"/>',
  out: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'
});
export type IconName = keyof typeof SG_ICON;

export const icon = (name: IconName, cls = 'sg-ico'): string =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${SG_ICON[name]}</svg>`;

/* How many of the files a set of patterns covers, as the server reads a lock; null without a list. */
export function matchCount(patterns: readonly string[], files: unknown): number | null {
  if (!Array.isArray(files)) return null;
  return files.filter(file => patterns.some(pattern => protectedPatternMatch(pattern, file))).length;
}

/* When the last snapshot this browser kept for a repository was taken, or null; a time that is not one is none. */
export function snapshotTakenAt(stored: string | null): string | null {
  try {
    const at = field(JSON.parse(stored || 'null'), 'capturedAt');
    return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? at : null;
  } catch { return null; }
}

/* ---- the provider's rules ---- */

export type RuleState = 'on' | 'off' | 'unknown';
export interface RuleControl { readonly id: string; readonly label: string; readonly state: RuleState; readonly detail: string }
export interface Rules {
  readonly protected: boolean;
  readonly partial: boolean;
  readonly sources: readonly string[];
  readonly controls: readonly RuleControl[];
  readonly settingsUrl: string;
}
export type RulesReading = Rules | { readonly error: string };

export const RULES_UNREADABLE = 'The provider\u2019s answer could not be read.';
export const RULES_SILENT = 'The provider did not answer.';

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/* The provider's answer for one branch, as the screen reads it: its controls each on, off or unknown. */
export function readRules(answer: unknown): RulesReading {
  const controls = field(answer, 'controls');
  if (!Array.isArray(controls)) return Object.freeze({ error: RULES_UNREADABLE });
  const url = text(field(answer, 'settingsUrl'));
  return Object.freeze({
    protected: Boolean(field(answer, 'protected')),
    partial: field(answer, 'access') === 'partial',
    sources: Object.freeze(items(field(answer, 'sources')).filter((source): source is string => typeof source === 'string')),
    controls: Object.freeze(controls.filter(hasFields).map(control => {
      const state = field(control, 'state');
      return Object.freeze({
        id: text(field(control, 'id')),
        label: text(field(control, 'label')),
        state: (state === 'on' || state === 'off' ? state : 'unknown') as RuleState,
        detail: text(field(control, 'detail'))
      });
    })),
    settingsUrl: /^https:\/\//.test(url) ? url : ''
  });
}

const readable = (rules: RulesReading | null): rules is Rules => Boolean(rules) && !('error' in (rules as object));

/* The rules the provider enforces, as "N of M"; a dash before they are read. */
export const rulesFigure = (rules: RulesReading | null): string =>
  readable(rules) ? `${rules.controls.filter(control => control.state === 'on').length} of ${rules.controls.length}` : '\u2014';

export interface Posture { readonly tone: 'good' | 'part' | 'open'; readonly word: string }

/* The posture in one word: the branch's rules, then whether anything is locked and a snapshot kept. */
export function posture(rules: RulesReading | null, lockedCount: number, snapshotAt: string | null): Posture {
  if (!readable(rules)) return { tone: 'part', word: 'Branch rules unread' };
  const on = (id: string): boolean => rules.controls.find(control => control.id === id)?.state === 'on';
  if (!rules.protected) return { tone: 'open', word: 'Unprotected branch' };
  if (on('review') && on('force-push') && on('deletion')) {
    return lockedCount && snapshotAt ? { tone: 'good', word: 'Guarded' } : { tone: 'part', word: 'Mostly guarded' };
  }
  return { tone: 'part', word: 'Partly guarded' };
}

export function rulesHTML(rules: RulesReading | null): string {
  if (!rules) return '<p class="sg-muted sg-loading">Reading the provider\u2019s rules\u2026</p>';
  if (!readable(rules)) return `<p class="sg-muted">${escapeHtml(rules.error)}</p>`;
  const rows = rules.controls.map(control => `<li class="sg-rule" data-state="${control.state}">
      <span class="sg-rule-glyph">${icon(control.state)}</span>
      <span class="sg-rule-text"><span class="sg-rule-name">${escapeHtml(control.label)}</span>${control.detail && !/administration access/.test(control.detail) ? `<span class="sg-rule-detail">${escapeHtml(control.detail)}</span>` : ''}</span>
    </li>`).join('');
  const partial = rules.partial ? '<p class="sg-note">Some rules need administration access to read; those show a question mark, never a tick.</p>' : '';
  const link = rules.settingsUrl
    ? `<a class="sg-link" href="${escapeAttribute(rules.settingsUrl)}" target="_blank" rel="noopener noreferrer">Branch settings ${icon('out', 'sg-ico sg-ico-sm')}</a>` : '';
  return `<ul class="sg-rules">${rows}</ul>${partial}<div class="sg-card-foot"><span class="sg-muted">${rules.sources.length ? escapeHtml(rules.sources.join(' \u00b7 ')) : rules.protected ? 'Protected' : 'No rule covers this branch'}</span>${link}</div>`;
}

/* ---- the screen ---- */

/* Each tile names the capability that gates it, so a tile whose capability is not Supported is never drawn. */
export const TILES = Object.freeze([
  { id: 'sgSnap', feature: 'recovery', icon: 'snapshot', title: 'Emergency snapshot' },
  { id: 'sgRecover', feature: 'recovery', icon: 'recover', title: 'Disaster recovery', sub: 'Preview, then restore refs' },
  { id: 'sgScan', feature: 'dependency-audit', icon: 'scan', title: 'Security scan', sub: 'Dependencies and upload gate' },
  { id: 'sgActivity', feature: 'governance', icon: 'activity', title: 'Export activity', sub: 'Commits, PRs, issues, releases' },
  { id: 'sgEvidence', feature: 'governance', icon: 'evidence', title: 'Export evidence', sub: 'Signed, verifiable package' }
] as const);

export interface ScreenModel {
  /* The repository's key and branch, as named in the posture. */
  readonly key: string;
  readonly branch: string;
  readonly readOnly: boolean;
  readonly freeze: boolean;
  /* Whether the switches are this reader's to change; in the hosted alpha they are the deployment's. */
  readonly global: boolean;
  readonly locks: readonly string[];
  readonly snapshotAt: string | null;
  readonly ago: (iso: string) => string;
}

export function screenHTML(model: ScreenModel): string {
  const { global, locks, snapshotAt } = model;
  const providerName = 'GitHub';
  const switchRow = (id: string, on: boolean, title: string, sub: string): string => `<label class="sg-switch-row${global ? '' : ' is-managed'}">
      <span class="sg-switch-text"><span class="sg-switch-title">${title}</span><span class="sg-switch-sub">${sub}</span></span>
      <input type="checkbox" role="switch" class="sg-switch" id="${id}" ${on ? 'checked' : ''} ${global ? '' : 'disabled'}>
    </label>`;
  const tiles = TILES.map(tile => {
    const sub = tile.id === 'sgSnap' ? (snapshotAt ? `Last ${model.ago(snapshotAt)}` : 'None taken yet') : ('sub' in tile ? tile.sub : '');
    return `<button type="button" class="sg-tile" id="${tile.id}" data-feature="${tile.feature}">
      ${icon(tile.icon, 'sg-ico sg-tile-ico')}<span class="sg-tile-title">${tile.title}</span><span class="sg-tile-sub">${escapeHtml(sub)}</span></button>`;
  }).join('');
  return `<div class="sg sg-page">
      <section class="sg-posture" data-tone="part" aria-live="polite">
        <span class="sg-posture-mark">${icon('scan', 'sg-ico')}</span>
        <div class="sg-posture-read"><p class="sg-posture-word" id="sgPostureWord">Reading\u2026</p>
          <p class="sg-posture-sub"><span class="mono">${escapeHtml(model.key)}</span> \u00b7 <span class="mono">${escapeHtml(model.branch)}</span></p></div>
        <dl class="sg-stats">
          <div><dt>Branch rules</dt><dd id="sgStatRules">\u2026</dd></div>
          <div><dt>Locked paths</dt><dd>${locks.length}</dd></div>
          <div><dt>Snapshot</dt><dd>${snapshotAt ? escapeHtml(model.ago(snapshotAt)) : 'Never'}</dd></div>
        </dl>
      </section>
      <div class="sg-grid">
        <section class="sg-card" aria-labelledby="sgLocalHead">
          <h3 class="sg-card-head" id="sgLocalHead">${icon('lock')}In Nebulaverse-X</h3>
          ${switchRow('sgReadOnly', model.readOnly, 'Read-only mode', 'Refuse every commit, upload, delete, merge and reset.')}
          ${switchRow('sgFreeze', model.freeze, 'Freeze scheduled sync', 'Pause queued and automatic syncs; manual sync still works.')}
          ${global ? '' : '<p class="sg-note">Set by the deployment in the hosted alpha; protected paths below are yours to change.</p>'}
        </section>
        <section class="sg-card" aria-labelledby="sgProviderHead" id="sgProvider">
          <div class="sg-card-row"><h3 class="sg-card-head" id="sgProviderHead">${icon('branch')}On ${escapeHtml(providerName)} \u00b7 <span class="mono">${escapeHtml(model.branch)}</span></h3>
            <button type="button" class="btn btn-ghost small" id="sgRulesRefresh">Read again</button></div>
          <div id="sgRules">${rulesHTML(null)}</div>
        </section>
      </div>
      <section class="sg-card sg-paths" aria-labelledby="sgPathsHead">
        <div class="sg-card-row"><h3 class="sg-card-head" id="sgPathsHead">${icon('lock')}Locked paths <span class="sg-count">${locks.length}</span></h3><span class="sg-muted" id="sgFilesNote"></span></div>
        <p class="sg-muted sg-lede">Nebulaverse-X refuses to change these, on the server, until they are unlocked.</p>
        <div class="sg-presets" role="group" aria-label="Lock a common set">${SAFEGUARD_PRESETS.map((preset, index) => {
          const done = preset.patterns.every(pattern => locks.includes(pattern));
          return `<button type="button" class="sg-preset" data-preset="${index}" ${done ? 'disabled aria-pressed="true"' : 'aria-pressed="false"'} title="${escapeAttribute(preset.patterns.join('  '))}">
            ${icon(done ? 'on' : 'lock', 'sg-ico sg-ico-sm')}<span>${escapeHtml(preset.label)}</span><span class="sg-preset-n" data-preset-n="${index}"></span></button>`;
        }).join('')}</div>
        <div class="sg-add"><input id="sgProtectPattern" type="text" placeholder="A file, folder or pattern, e.g. config/**" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Path or pattern to lock"><button type="button" class="btn btn-ghost small" id="sgAddProtect">Lock</button></div>
        ${locks.length
          ? `<ul class="sg-locked">${locks.map((pattern, index) => `<li class="sg-lock-row"><span class="mono sg-lock-pattern">${escapeHtml(pattern)}</span><span class="sg-lock-n" data-lock-n="${index}"></span><button type="button" class="btn btn-ghost small sg-unlock" data-unlock="${index}" aria-label="Unlock ${escapeAttribute(pattern)}">Unlock</button></li>`).join('')}</ul>`
          : '<p class="sg-empty">Nothing locked yet. Start with a preset, or lock a file from its menu in the tree.</p>'}
      </section>
      <section class="sg-actions" aria-labelledby="sgToolsHead">
        <h3 class="sg-card-head sg-tools-head" id="sgToolsHead">${icon('recover')}Recovery and evidence</h3>
        <div class="sg-tiles">${tiles}</div>
      </section>
    </div>`;
}
