/*
 * The Neural map's history under the stage: a slider over every event, the
 * caption of the one it points at, and a strip of six around it.
 */
import { timeAgo } from './graph-summary.ts';

export interface TimelineEvent {
  readonly label: unknown;
  readonly type: string;
  readonly time: unknown;
  readonly nodeId: string;
}

/* Where the slider points: within the events, or nowhere when there are none. */
export function timelineIndex(index: number, events: number, toLatest: boolean): number {
  const at = toLatest ? events - 1 : index;
  return Math.max(events ? 0 : -1, Math.min(events - 1, at));
}

/* The caption under the slider. */
export function timelineCaption(event: TimelineEvent | undefined, now: number): string {
  return event ? `${String(event.label)} · ${timeAgo(event.time, now)}` : 'No activity events available';
}

export interface StripCard {
  readonly index: number;
  readonly label: string;
  readonly detail: string;
  readonly active: boolean;
}

/*
 * Six events around the one the slider points at -- three before it where
 * there are three -- so the strip moves with the slider and never runs off
 * the end of the history.
 */
export function eventStrip(events: readonly TimelineEvent[], index: number, now: number): readonly StripCard[] {
  const start = Math.max(0, Math.min(Math.max(0, events.length - 6), index - 3));
  return events.slice(start, start + 6).map((event, i) => ({
    index: start + i,
    label: String(event.label),
    detail: `${event.type} · ${timeAgo(event.time, now)}`,
    active: start + i === index
  }));
}
