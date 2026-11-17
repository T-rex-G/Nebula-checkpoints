/*
 * The sign-in screen: what it says, and what the controlled alpha adds to it.
 * (A sign-in that did not complete is said by the alpha's door, which takes
 * its marker out of the address before the page runs, or by the workspace it
 * hands the reader to: alpha-ui.ts.)
 *
 * The guidance asks for a short-lived fine-grained token and says where the
 * session's credentials live; the deployment's limits are said in megabytes,
 * or said to be unknown -- never guessed. Unknown means no number, not a
 * small one: a ceiling of zero is still a ceiling.
 *
 * Two panels belong to the controlled alpha and say so: one tells an invited
 * tester never to connect a production repository, the other offers to end
 * an alpha session. With the gate off there is no cohort and no alpha route
 * that answers, so they are removed -- not merely not added, since a panel
 * built on an earlier load outlives the screen it was built for.
 */
/* The deployment's limits, as /api/config says them: each a number of megabytes, or unknown. */
export interface RuntimeLimits {
  readonly uploadMaxMb?: unknown;
  readonly gitDataMaxMb?: unknown;
  readonly nativePushMaxMb?: unknown;
  readonly contentsMaxMb?: unknown;
}
const LIMIT_KEYS = ['uploadMaxMb', 'gitDataMaxMb', 'nativePushMaxMb', 'contentsMaxMb'] as const;
const known = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/* Whether every limit an upload is checked against is known. */
export function runtimeLimitsKnown(runtime: RuntimeLimits): boolean {
  return LIMIT_KEYS.every(key => known(runtime[key]));
}

/* The guidance under the token field: markup of the page's own words, and nothing of the server's. */
export function loginGuidanceHtml(githubAppEnabled: boolean): string {
  const github = 'Create a short-lived <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">fine-grained token</a> limited to selected repositories. Start with Contents read access; add Contents write or other permissions only for the actions you need.';
  const app = githubAppEnabled ? ' After sign-in, open Settings → GitHub App to connect an installation limited to selected repositories.' : '';
  return `${github}${app} Sessions use an HttpOnly session cookie stored by your browser. GitHub credentials are encrypted in that cookie or in server-side session storage.`;
}

/* The deployment's limits in words. */
export function limitsText(runtime: RuntimeLimits): string {
  if (!runtimeLimitsKnown(runtime)) {
    return 'Deployment upload limits are unavailable. Retry before uploading; provider limits also apply. Public alpha: no production service guarantee.';
  }
  const value = (key: keyof RuntimeLimits): string => (known(runtime[key]) ? `${String(runtime[key])} MB` : 'unavailable');
  return `Deployment limits — Direct upload: ${value('uploadMaxMb')}; Git data: ${value('gitDataMaxMb')}; native push: ${value('nativePushMaxMb')}. Provider limits also apply. Public alpha: no production service guarantee.`;
}

export const ALPHA_PROVIDER_GUIDANCE = 'Sign in with a short-lived fine-grained token limited to selected sandbox repositories. A configured GitHub App can then be connected from Settings; never use a production repository.';

interface Node {
  id: string;
  className: string;
  textContent: string | null;
  readonly dataset: { alphaPrivacyAction?: string };
  type?: string;
  append(...children: Node[]): void;
  remove(): void;
  querySelector(selector: string): Node | null;
}
export interface LoginChromeDeps {
  readonly gateEnabled: () => boolean;
  readonly card: () => { insertBefore(node: Node, before: unknown): unknown; appendChild(node: Node): unknown } | null;
  readonly find: (selector: string) => Node | null;
  readonly create: (tag: string) => Node;
}
export interface LoginChrome {
  /* The alpha's word on provider permissions, under the sign-in; null with the gate off or no card to put it in. */
  ensureGuidance(): Node | null;
  /* The control that ends an alpha session; null with the gate off or no card. */
  ensureSessionControls(): Node | null;
}

export function createLoginChrome(deps: LoginChromeDeps): LoginChrome {
  function remove(): void {
    for (const id of ['#alphaProviderGuidance', '#loginAlphaSessionControls']) {
      const node = deps.find(id);
      if (node) node.remove();
    }
  }
  const heading = (text: string): Node => { const h = deps.create('h2'); h.textContent = text; return h; };
  const hint = (text?: string): Node => { const p = deps.create('p'); p.className = 'hint'; if (text !== undefined) p.textContent = text; return p; };

  function ensureGuidance(): Node | null {
    if (!deps.gateEnabled()) { remove(); return null; }
    const card = deps.card();
    if (!card) return null;
    let panel = deps.find('#alphaProviderGuidance');
    if (!panel) {
      panel = deps.create('section');
      panel.id = 'alphaProviderGuidance';
      panel.className = 'set-group alpha-provider-guidance';
      panel.append(heading('Provider permission review'), hint());
      card.insertBefore(panel, deps.find('#loginError'));
    }
    const copy = panel.querySelector('p');
    if (copy) copy.textContent = ALPHA_PROVIDER_GUIDANCE;
    return panel;
  }

  function ensureSessionControls(): Node | null {
    if (!deps.gateEnabled()) { remove(); return null; }
    const card = deps.card();
    if (!card) return null;
    const existing = deps.find('#loginAlphaSessionControls');
    if (existing) return existing;
    const controls = deps.create('section');
    controls.id = 'loginAlphaSessionControls';
    controls.className = 'set-group alpha-privacy-panel';
    const end = deps.create('button');
    end.type = 'button';
    end.className = 'btn btn-ghost btn-block';
    end.dataset.alphaPrivacyAction = 'end';
    end.textContent = 'End alpha session';
    controls.append(heading('Alpha session'), hint('Provider access is separate from the controlled alpha session.'), end);
    card.appendChild(controls);
    return controls;
  }

  return { ensureGuidance, ensureSessionControls };
}
