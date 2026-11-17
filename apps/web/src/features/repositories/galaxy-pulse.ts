/*
 * The pulse over the repository list: what this session actually loaded.
 *
 * Each measure names its own source, and a measure without one is not drawn:
 * the design shows a trust score, and nothing on this list computes one, so
 * that tile is absent rather than invented. Drawn by GalaxyPulse.tsx.
 */
import { field, items } from '../../platform/values.ts';
import { RADAR_MIN_AXES, languageSpread } from '../overview/workspace-pulse.ts';
import type { LanguageAxis } from '../overview/workspace-pulse.ts';

export interface Measure {
  readonly label: string;
  readonly value: number;
  readonly note: string;
}

export interface GalaxyPulseView {
  readonly measures: readonly Measure[];
  /* Languages as a radar, from three of them; below that their count stays a measure. */
  readonly spread: readonly LanguageAxis[] | null;
  readonly languages: number;
}

export function galaxyPulse(repos: unknown): GalaxyPulseView {
  const list = items(repos);
  const languages = new Set(list.map(repo => field(repo, 'language')).filter(Boolean)).size;
  /*
   * The language tile earned a chart and lost its number. "Languages 7" is
   * true and it is not an answer: it cannot say which seven, nor that one of
   * them is nearly the whole estate while the rest are a file each. Below
   * three languages there is no polygon to draw -- one or two spokes is a
   * line pretending to be a shape -- so the count stays in that case rather
   * than a degenerate chart being drawn to keep the layout tidy.
   */
  const spread = languageSpread(list);
  const radar = spread.length >= RADAR_MIN_AXES;
  /*
   * Private and public together account for the set, so the row never stops
   * on an empty slot and a reader can check one figure against the other two.
   * Public is counted only where the provider said so: a repository whose
   * visibility did not come back is neither, rather than assumed open.
   */
  const measures: Measure[] = [
    { label: 'Galaxies', value: list.length, note: 'repositories connected' },
    { label: 'Private', value: list.filter(repo => field(repo, 'private')).length, note: 'of the connected set' },
    { label: 'Public', value: list.filter(repo => field(repo, 'private') === false).length, note: 'readable by anyone' },
    ...(radar ? [] : [{ label: 'Languages', value: languages, note: languages === 1 ? 'in use' : 'across the set' }])
  ].filter(measure => Number.isFinite(measure.value));
  return { measures, spread: radar ? spread : null, languages };
}
