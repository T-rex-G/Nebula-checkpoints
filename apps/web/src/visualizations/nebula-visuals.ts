/*
 * The page's loader for the design's WebGL pieces (visuals-loader.ts says
 * what it asks before anything downloads). Each piece is imported through
 * the build, which names its chunk by its content, so a new deploy is never
 * hidden behind a year-long cache of the old one.
 */
import { probeSource } from '../platform/probe.ts';
import { readPieces } from './artwork.ts';
import { createVisuals } from './visuals-loader.ts';

const visuals = createVisuals({
  document,
  window,
  modules: {
    galaxy: () => import('./nebula-galaxy.ts'),
    singularity: () => import('./nebula-singularity.ts')
  }
});

/*
 * Asked once, on the landing only -- the shell behind sign-in has no ambient
 * motion to gate -- and after the page has loaded, so the frames measured are
 * the page at rest rather than the page being built.
 */
if (document.querySelector('.lp')) {
  if (document.readyState === 'complete') visuals.watchAmbient();
  else window.addEventListener('load', () => visuals.watchAmbient(), { once: true });
}

/* What the browser suite may read of the pieces on the page (artwork.ts). */
probeSource('artwork', () => ({ pieces: readPieces(document) }));

export default visuals;
export const { mount, repaint, supportsWebGL } = visuals;
