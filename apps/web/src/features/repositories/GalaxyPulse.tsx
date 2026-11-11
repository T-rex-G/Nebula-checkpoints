/*
 * The pulse over the repository list, drawn. What it says is
 * galaxy-pulse.ts's.
 */
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import type { LanguageAxis } from '../overview/workspace-pulse.ts';
import { RadarChart } from '../overview/PulseCharts.tsx';
import { galaxyPulse } from './galaxy-pulse.ts';
import type { GalaxyPulseView } from './galaxy-pulse.ts';

/*
 * The radar gives the estate its shape; the ranked list beside it gives each
 * language its number and its share, read off one baseline. It has its own
 * cell, spanning the row: a radar squeezed into a third of the grid beside
 * two numbers is a chart nobody can read the labels of.
 */
function Languages({ spread, languages }: { spread: readonly LanguageAxis[]; languages: number }): ReactElement {
  const total = spread.reduce((sum, axis) => sum + axis.count, 0) || 1;
  const peak = Math.max(...spread.map(axis => axis.count), 1);
  const folded = spread.find(axis => axis.folded);
  return (
    <div className="gx-pulse-cell gx-pulse-radar">
      <dt>Languages</dt>
      <dd>
        <div className="gx-lang">
          {/* Drawn again, and its arrival played again, when the estate it draws changes. */}
          <RadarChart
            key={spread.map(axis => `${axis.label}:${axis.count}`).join('|')}
            axes={spread}
            label={`Repositories by language: ${spread.map(axis => `${axis.label} ${axis.count}`).join(', ')}.`}
          />
          <ol className="gx-lang-list" aria-label="Repositories by language">
            {spread.map(axis => {
              const name = axis.folded ? `Other (${axis.folded})` : axis.label;
              return (
                <li key={axis.label}>
                  <span className="gx-lang-name" title={name}>{name}</span>
                  <span className="gx-lang-bar" aria-hidden="true">
                    {/* Its share of the largest, as the stylesheet's --w (.gx-lang-bar i): React names no custom property. */}
                    <i ref={node => { if (node) node.style.setProperty('--w', String(Math.round((axis.count / peak) * 1000) / 1000)); }} />
                  </span>
                  <span className="gx-lang-n">{String(axis.count)}</span>
                  <span className="gx-lang-pc">{`${Math.round((axis.count / total) * 100)}%`}</span>
                </li>
              );
            })}
          </ol>
        </div>
        <span className="gx-pulse-note">
          {folded && folded.folded ? `${languages} in use, the smallest ${folded.folded} grouped` : `${languages} across the set`}
        </span>
      </dd>
    </div>
  );
}

function GalaxyPulse({ view }: { view: GalaxyPulseView }): ReactElement {
  return (
    <>
      {view.measures.map(measure => (
        <div key={measure.label} className="gx-pulse-cell">
          <dt>{measure.label}</dt>
          <dd>
            <span className="gx-pulse-value">{String(measure.value)}</span>
            <span className="gx-pulse-note">{measure.note}</span>
          </dd>
        </div>
      ))}
      {view.spread ? <Languages spread={view.spread} languages={view.languages} /> : null}
    </>
  );
}

const roots = new WeakMap<HTMLElement, Root>();

/* Draws the pulse into its grid, and says whether there is anything in it to show. */
export function render(grid: HTMLElement, repos: unknown): boolean {
  const view = galaxyPulse(repos);
  let root = roots.get(grid);
  if (!root) {
    grid.textContent = '';
    root = createRoot(grid);
    roots.set(grid, root);
  }
  const target = root;
  flushSync(() => target.render(<GalaxyPulse view={view} />));
  return view.measures.length > 0 || view.spread !== null;
}
