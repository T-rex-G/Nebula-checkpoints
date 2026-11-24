/*
 * The cursor a page of verified intelligence events hands back: where the
 * next page starts, as the time and id of the last event read, opaque to the
 * page. A cursor from before ids were part of it -- a bare time -- is still
 * read, as starting after that time.
 */
import { read } from '../../../platform/values/fields.ts';

export interface EventCursor {
  readonly createdAt: string;
  readonly eventId: string;
}

/* The cursor after an event, or '' when the event has no usable time or id. */
export function encodeEventCursor(createdAt: unknown, eventId: unknown): string {
  const timestamp: Date = Reflect.construct(Date, [createdAt || 0]);
  if (!Number.isFinite(timestamp.getTime()) || !eventId) return '';
  return Buffer.from(JSON.stringify({ t: timestamp.toISOString(), id: String(eventId) }), 'utf8').toString('base64url');
}

/* Where a page starts, or null for the newest events. */
export function decodeEventCursor(value: unknown): EventCursor | null {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    const timestamp: Date = Reflect.construct(Date, [parsed && read(parsed, 't')]);
    const eventId = String((parsed && read(parsed, 'id')) || '');
    if (Number.isFinite(timestamp.getTime()) && eventId) return { createdAt: timestamp.toISOString(), eventId };
  } catch { /* not a cursor: perhaps a bare time */ }
  const legacy = new Date(raw);
  return Number.isFinite(legacy.getTime()) ? { createdAt: legacy.toISOString(), eventId: '' } : null;
}
