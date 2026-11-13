/*
 * "Show the numbers": the table under a chart, for every reader.
 *
 * A chart is read by eye and by pointer; the same figures in a table are read
 * by anyone, a screen reader and a keyboard included. Folded in a <details>,
 * the element that already means this: keyboard-operable and announced with
 * no code here, and find-in-page opens it on its own.
 */
import type { ReactElement } from 'react';

/*
 * Which tables a reader has opened, by caption, across every card: a card
 * that has to draw its table anew -- after a reading that failed, say -- draws
 * it as the reader left it. Kept for the page's life only; it holds the
 * captions the cards wrote and nothing read from anywhere.
 */
const openNumbers = new Set<string>();

export type Cell = string | number;

export function NumbersTable({ caption, headings, rows, note }: {
  caption: string;
  headings: readonly string[];
  rows: readonly (readonly Cell[])[];
  note?: string;
}): ReactElement {
  const remember = (open: boolean): void => { if (open) openNumbers.add(caption); else openNumbers.delete(caption); };
  /*
   * A reading drawn between the press and its toggle event draws into this
   * same element, which keeps what the reader chose; the choice is written
   * down when the toggle lands, for a card that later has to draw it anew.
   */
  return (
    <details className="wp-numbers" open={openNumbers.has(caption)} onToggle={event => remember(event.currentTarget.open)}>
      <summary>Show the numbers</summary>
      <table>
        <caption>{caption}</caption>
        <thead>
          <tr>{headings.map(heading => <th key={heading} scope="col">{heading}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={`${rowIndex}:${String(row[0])}`}>
              {row.map((value, index) => index === 0
                ? <th key={index} scope="row">{String(value)}</th>
                : <td key={index}>{String(value)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {note ? <p className="wp-numbers-note">{note}</p> : null}
    </details>
  );
}
