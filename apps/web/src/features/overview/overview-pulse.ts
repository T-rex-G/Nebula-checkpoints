/*
 * The summary row across the top of the overview. Every figure here is read
 * off the same pulse model the cards below use, so the row can never disagree
 * with the card that explains it -- and a measure without a source shows an em
 * dash and the words "Not measured" rather than a plausible-looking zero.
 */
import type { PulseView } from './workspace-pulse.ts';

export const PULSE_ICONS = Object.freeze({
  repositories: 'M4 6.5A2.5 2.5 0 0 1 6.5 4H19v13H6.5A2.5 2.5 0 0 0 4 19.5z',
  private: 'M6 10.5h12v9H6zM9 10.5V7.5a3 3 0 0 1 6 0v3',
  trust: 'M12 3.2l7 3v5.3c0 4.2-2.9 7.6-7 9.3-4.1-1.7-7-5.1-7-9.3V6.2z',
  signals: 'M2 12h3.4l2.3-7 3.4 14 2.6-9.4 1.8 5 1.6-2.6H22',
  attention: 'M12 4.4l8.4 15H3.6zM12 10.4v4M12 17.1h.01'
});
export type PulseIcon = keyof typeof PULSE_ICONS;

/* One cell of the row: a figure, or null where nothing was measured. */
export interface PulseMeasure {
  readonly icon: PulseIcon;
  readonly label: string;
  readonly value: number | null;
  readonly note: string;
}

const isPrivate = (repo: unknown): boolean => !!(repo && typeof repo === 'object' && (repo as { private?: unknown }).private);

export function pulseMeasures(list: readonly unknown[], pulse: PulseView | null | undefined): PulseMeasure[] {
  const trust = pulse && pulse.trust;
  const signals = pulse && pulse.signals;
  /*
   * "Needs attention" counts the components the model itself scored as warning
   * or critical. Components it could not measure are not counted -- an unknown
   * is not a problem, and reporting it as one would invent a fault.
   */
  const flagged = trust && Array.isArray(trust.components)
    ? trust.components.filter(component => component.status === 'warning' || component.status === 'critical').length
    : null;
  const scored = trust && trust.score !== null && trust.score !== undefined;
  return [
    { icon: 'repositories', label: 'Galaxies', value: list.length, note: 'repositories connected' },
    { icon: 'private', label: 'Private', value: list.filter(isPrivate).length, note: 'of the connected set' },
    {
      icon: 'trust', label: 'Trust score',
      value: scored ? trust.score : null,
      note: scored ? `Grade ${trust.grade} \u00b7 ${trust.measuredCount} of ${trust.componentCount} measured` : 'Not measured'
    },
    {
      icon: 'signals', label: 'Provider-verified',
      value: signals && signals.measured ? signals.providerVerified : null,
      note: signals && signals.measured ? `of ${signals.total} \u00b7 registry evidence` : 'Not measured'
    },
    {
      icon: 'attention', label: 'Needs attention',
      value: flagged,
      note: flagged === null ? 'Not measured' : (flagged === 1 ? 'component flagged' : 'components flagged')
    }
  ];
}
