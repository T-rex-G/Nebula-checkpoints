/*
 * The overview at work: shown for whoever is signed in, its readings asked
 * for, the reader taken to it, and its pulse drawn.
 *
 * The trust score and the live-signal count are read from what the session
 * already holds -- no measure asks for anything of its own, so opening the
 * overview cannot spend a reader's rate limit to draw a number at them.
 * Anything absent stays absent: the model reports it as unmeasured rather
 * than scoring it zero. One model, two readings: the summary row and the
 * cards below it used to be computed apart, which let the row say one thing
 * and the card under it another about the same session.
 */
import { model as pulseModel } from './workspace-pulse.ts';
import type { PulseView } from './workspace-pulse.ts';
import { pulseMeasures } from './overview-pulse.ts';
import type { PulseMeasure } from './overview-pulse.ts';

export interface OverviewState {
  readonly me: unknown;
  readonly repos: unknown;
  readonly scanner: unknown;
  readonly posture: unknown;
}

export interface CardHosts<Host> {
  readonly trust: Host | null;
  readonly signals: Host | null;
  readonly activity: Host | null;
}

export interface OverviewDeps<Host> {
  readonly state: OverviewState;
  readonly capabilities: {
    readonly features?: (() => unknown) | null;
    decision(name: string): { readonly status: unknown };
  };
  /* The browser's recovery references, counted (overview-core.ts). */
  readonly localSnapshots: () => Set<string>;
  readonly greet: () => void;
  readonly paintCoreState: () => void;
  readonly paintCoreLine: (pulse: PulseView) => void;
  /* The summary row's section and grid, and the row drawn into them (OverviewPulse.tsx). */
  readonly row: () => { readonly section: { hidden: boolean } | null; readonly grid: Host | null };
  readonly drawRow: (section: { hidden: boolean }, grid: Host, measures: readonly PulseMeasure[]) => void;
  readonly cards: () => CardHosts<Host>;
  readonly drawCards: (hosts: CardHosts<Host>, pulse: PulseView) => void;
  /* The readings the overview asks for (activity-feed-controller.ts, posture-controller.ts, pull-board-controller.ts). */
  readonly readings: {
    readonly scanner: () => unknown;
    readonly posture: () => unknown;
    readonly security: () => unknown;
    readonly feed: () => unknown;
    readonly renderSecurity: () => void;
  };
  readonly board: { watch(): void; visible(): boolean; load(): Promise<void>; render(): void };
  readonly showPage: (name: string) => unknown;
}

export interface Overview {
  /* Drawn for whoever is signed in and, unless `arrive` is false, the reader taken to it. */
  show(arrive?: boolean): void;
  /*
   * The pulse drawn from the list the session holds, or from one an
   * inventory hands it: its failure path reports an empty set without
   * discarding what the session still holds.
   */
  renderPulse(repos?: unknown): void;
}

export function createOverview<Host>(deps: OverviewDeps<Host>): Overview {
  const { state } = deps;

  function renderPulse(repos?: unknown): void {
    const list = Array.isArray(repos) ? repos : state.repos;
    const { capabilities } = deps;
    const pulse = pulseModel({
      repos: list,
      features: capabilities.features ? capabilities.features() : null,
      recoveryStatus: capabilities.decision('recovery').status,
      scanner: state.scanner,
      identity: state.me,
      posture: state.posture,
      localSnapshots: deps.localSnapshots()
    });
    const { section, grid } = deps.row();
    if (section && grid) deps.drawRow(section, grid, pulseMeasures(Array.isArray(list) ? list : [], pulse));
    deps.paintCoreLine(pulse);
    const hosts = deps.cards();
    if (hosts.trust || hosts.signals || hosts.activity) deps.drawCards(hosts, pulse);
    deps.readings.renderSecurity();
    deps.board.render();
  }

  function show(arrive = true): void {
    deps.greet();
    deps.paintCoreState();
    renderPulse();
    void deps.readings.scanner();
    void deps.readings.posture();
    void deps.readings.security();
    void deps.readings.feed();
    if (arrive) deps.showPage('overview');
    deps.board.watch();
    if (deps.board.visible()) void deps.board.load();
  }

  return { show, renderPulse };
}
