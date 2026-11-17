/*
 * Settings: the page's look, the editor, offline use of the repository in
 * hand, the GitHub App, and where to find help.
 *
 * The panel opens at once; the GitHub App's status is drawn into it when it
 * arrives, and only into the panel that asked for it. Every control changes
 * the page as it is moved -- the slider as it slides, the rest when they
 * settle -- and the look is applied once more as the panel closes.
 */
import type { ModalRequest } from '../../components/modal.ts';
import type { EditorSettings } from '../../platform/page-state.ts';
import { escapeHtml } from '../../platform/html.ts';
import { DESIGNS, DESIGN_LABELS, EDITOR_FONTS, EDITOR_THEMES, FONT_SIZES } from '../shell/appearance.ts';
import type { GithubApp } from './github-app-controller.ts';

/* What the panel shows, read from the page as it opens. */
export interface SettingsView {
  readonly settings: Readonly<EditorSettings>;
  readonly dark: boolean;
  /* Whether the repository in hand is kept for offline use, or null with none in hand. */
  readonly offline: boolean | null;
  /* The alpha's own privacy actions, when its gate is on. */
  readonly alphaActions: string;
  /* The build the server runs, when it said. */
  readonly release: string;
}

const THEME_SWITCH = `<button class="theme-toggle" type="button" role="switch" aria-checked="%DARK%" aria-label="Toggle dark or light theme">
          <svg class="tt-ico tt-sun" width="14" height="14" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.2v2.4M12 19.4v2.4M21.8 12h-2.4M4.6 12H2.2M18.9 5.1l-1.7 1.7M6.8 17.2l-1.7 1.7M18.9 18.9l-1.7-1.7M6.8 6.8L5.1 5.1"/></svg>
          <svg class="tt-ico tt-moon" width="14" height="14" viewBox="0 0 24 24"><path d="M20 13.2A8 8 0 1 1 10.8 4a6.4 6.4 0 0 0 9.2 9.2z"/></svg>
          <span class="tt-knob"></span>
        </button>`;

const SUPPORT_ICON = '<svg class="ico" width="15" height="15" viewBox="0 0 24 24"><path d="M21.5 3.6L2.9 10.8c-1 .4-1 1.4.1 1.7l4.6 1.5 1.8 5.5c.3.9 1 .9 1.5.3l2.5-2.4 4.7 3.5c.8.5 1.5.2 1.7-.8l3-15.1c.3-1.2-.5-1.8-1.3-1.4z"/></svg>';

export function settingsBody(view: SettingsView): string {
  const s = view.settings;
  const choices = DESIGNS.map(name => `<button type="button" class="design-choice" role="radio" data-design-choice="${name}" aria-checked="${s.design === name}" tabindex="${s.design === name ? 0 : -1}">
            <span class="design-swatch design-swatch-${name}" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="design-name">${DESIGN_LABELS[name].name}</span>
            <span class="design-note">${DESIGN_LABELS[name].note}</span>
          </button>`).join('');
  const themes = EDITOR_THEMES.map(([value, label]) => `<option value="${value}" ${value === s.editorTheme ? 'selected' : ''}>${label}</option>`).join('');
  const fonts = EDITOR_FONTS.map(font => `<option ${font === s.editorFont ? 'selected' : ''}>${font}</option>`).join('');
  const offline = view.offline === null ? '' : `<label class="check"><input type="checkbox" id="setOfflineRepo" ${view.offline ? 'checked' : ''}> Enable offline access for this repository</label>
      <p class="hint" style="margin:0 0 10px">Opt-in only. Small text/JSON views are cached for 24 hours in an account/session-isolated cache; raw files, ZIPs, notifications and security data remain network-only.</p>`;
  return `
      <div class="set-group design-presets">
        <div class="set-label" id="setDesignLabel">Design</div>
        <div class="design-choices" role="radiogroup" aria-labelledby="setDesignLabel">
          ${choices}
        </div>
      </div>
      <div class="set-row"><span>Interface theme</span>
        ${THEME_SWITCH.replace('%DARK%', String(view.dark))}
      </div>
      <label class="field-label" for="setEdTheme">Editor theme</label>
      <select id="setEdTheme">${themes}</select>
      <label class="field-label" for="setEdFont">Editor font</label>
      <select id="setEdFont">${fonts}</select>
      <label class="field-label" for="setFs">Editor font size — <span id="setFsVal">${s.fontSize}px</span></label>
      <input type="range" min="${FONT_SIZES.min}" max="${FONT_SIZES.max}" value="${s.fontSize}" id="setFs" style="min-height:32px;padding:0">
      <label class="check"><input type="checkbox" id="setWrap" ${s.wrap ? 'checked' : ''}> Wrap long lines in editor</label>
      <label class="check"><input type="checkbox" id="setMotion" ${s.motion ? 'checked' : ''}> Animated nebula background</label>
      ${offline}
      <div class="set-group github-app-panel">
        <div class="set-label">GitHub App <span class="br-tag">optional</span></div>
        <p class="hint">Use short-lived installation credentials with repository-scoped access. Existing PAT and OAuth connections continue to work.</p>
        <div id="githubAppSettingsBody"><p class="hint" role="status">Loading connection details…</p></div>
      </div>
      ${view.alphaActions}
      <div class="set-group">
        <div class="set-label">About</div>
        <p class="hint" style="margin:4px 0 8px">Nebulaverse-X — GitHub from your pocket.</p>
        ${view.release ? `<p class="hint mono" id="setBuild" style="margin:0 0 8px">Build ${escapeHtml(view.release)}</p>` : ''}
        <div class="about-actions">
          <a class="btn btn-ghost small" href="https://t.me/MonteCristo_X" target="_blank" rel="noopener noreferrer">
            ${SUPPORT_ICON}
            Support &amp; feedback — Telegram
          </a>
          <button class="btn btn-ghost small" id="clearLocalBtn">Clear offline data</button>
        </div>
      </div>`;
}

/* A control of the panel, as an input or change event hands it over. */
export interface SettingControl {
  readonly id: string;
  readonly value: string;
  checked: boolean;
}

/* The setting a control changes, and its new value; null for a control that is not a setting. */
export function settingChange(control: SettingControl): Partial<EditorSettings> | null {
  switch (control.id) {
    case 'setFs': return { fontSize: Number(control.value) };
    case 'setWrap': return { wrap: control.checked };
    case 'setMotion': return { motion: control.checked };
    case 'setEdTheme': return { editorTheme: control.value };
    case 'setEdFont': return { editorFont: control.value };
    default: return null;
  }
}

export interface SettingsPanelDeps {
  readonly modal: (request: ModalRequest) => Promise<unknown>;
  /* Asked as the panel opens: whether the dialog showing is still this one. */
  readonly modalOwner: () => () => boolean;
  readonly view: () => SettingsView;
  readonly mutateSettings: (change: (settings: EditorSettings) => void) => void;
  readonly apply: () => void;
  readonly element: (selector: string) => { textContent: string | null; addEventListener(type: string, listener: () => void): void } | null;
  readonly setOffline: (enabled: boolean) => Promise<void>;
  readonly purgeLocalData: (full: boolean) => Promise<void>;
  readonly toast: (message: string, kind?: string) => void;
  readonly githubApp: GithubApp;
}

export interface SettingsPanel {
  open(): Promise<void>;
  /* An input event inside the page: the slider changes the size as it moves. */
  onInput(target: SettingControl | null): void;
  /* A change event inside the page: the other controls once they settle. */
  onChange(target: SettingControl | null): Promise<void>;
}

export function createSettingsPanel(deps: SettingsPanelDeps): SettingsPanel {
  function change(control: SettingControl, shown?: () => void): void {
    const next = settingChange(control);
    if (!next) return;
    deps.mutateSettings(settings => { Object.assign(settings, next); });
    if (shown) shown();
    deps.apply();
  }

  async function open(): Promise<void> {
    const closed = deps.modal({ title: 'Settings', okText: 'Done', bodyHTML: settingsBody(deps.view()) });
    const stillOpen = deps.modalOwner();
    const clear = deps.element('#clearLocalBtn');
    if (clear) {
      clear.addEventListener('click', () => {
        deps.purgeLocalData(true).then(() => deps.toast('Offline caches and queued commits cleared ✦', 'ok')).catch(() => {});
      });
    }
    /* The panel and its controls open at once: the App's status neither delays the entrance nor replaces a later dialog. */
    deps.githubApp.show(stillOpen).catch(() => {});
    await closed;
    deps.apply();
  }

  function onInput(target: SettingControl | null): void {
    if (!target || target.id !== 'setFs') return;
    change(target, () => {
      const shown = deps.element('#setFsVal');
      if (shown) shown.textContent = `${target.value}px`;
    });
  }

  async function onChange(target: SettingControl | null): Promise<void> {
    if (!target) return;
    if (target.id !== 'setOfflineRepo') {
      if (target.id !== 'setFs') change(target);
      return;
    }
    try {
      await deps.setOffline(target.checked);
      deps.toast(target.checked ? 'Offline access enabled for this repository ✦' : 'Offline repository cache removed ✦', 'ok');
    } catch (error) {
      target.checked = !target.checked;
      deps.toast(error instanceof Error ? error.message : String(error), 'err');
    }
  }

  return { open, onInput, onChange };
}
