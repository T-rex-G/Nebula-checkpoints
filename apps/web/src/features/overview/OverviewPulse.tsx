/*
 * The overview's summary row, drawn: the same elements and classes it had
 * before it was a component. What it says is overview-pulse.ts's.
 */
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { repaintCard } from '../../components/held-repaint.ts';
import { PULSE_ICONS } from './overview-pulse.ts';
import type { PulseMeasure } from './overview-pulse.ts';

function Cell({ measure }: { measure: PulseMeasure }): ReactElement {
  return (
    <div className={measure.value === null ? 'gx-pulse-cell is-unmeasured' : 'gx-pulse-cell'}>
      <dt>
        <svg className="gx-pulse-ico" viewBox="0 0 24 24" aria-hidden="true"><path d={PULSE_ICONS[measure.icon]} /></svg>
        <span>{measure.label}</span>
      </dt>
      <dd>
        {/* Nothing measured is a dash, never a nought: a measured nought is a reading. */}
        <span className="gx-pulse-value">{measure.value === null ? '\u2014' : String(measure.value)}</span>
        <span className="gx-pulse-note">{measure.note}</span>
      </dd>
    </div>
  );
}

const roots = new WeakMap<HTMLElement, Root>();

/*
 * The row drawn into its grid and shown, once no press is down on the
 * overview, like the cards below it (components/held-repaint.ts): a row that
 * changes height under a press moves what was pressed.
 */
export function render(section: { hidden: boolean }, grid: HTMLElement, measures: readonly PulseMeasure[]): void {
  repaintCard(grid, () => {
    let root = roots.get(grid);
    if (!root) {
      grid.textContent = '';
      root = createRoot(grid);
      roots.set(grid, root);
    }
    const target = root;
    flushSync(() => target.render(<>{measures.map(measure => <Cell key={measure.label} measure={measure} />)}</>));
    section.hidden = false;
  });
}
