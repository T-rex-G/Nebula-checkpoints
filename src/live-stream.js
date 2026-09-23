'use strict';

/*
 * Every live-event write went out as `try { client.write(...) } catch {}`.
 *
 * That catch does nothing for the failure it looks like it is guarding. A
 * response stream does not throw when the reader stops reading -- write()
 * returns false and Node buffers the payload in memory until it can be sent.
 * A paused tab, a phone that lost signal, a proxy that stalls: the socket stays
 * open, the writes keep being accepted, and nothing in the process ever finds
 * out. With a hundred streams admitted by default and intelligence events fanning
 * out to each of them, that is unbounded growth on a instance that has 512MB.
 *
 * The download path already knew this -- it awaits 'drain' before its next
 * chunk -- but an event fan-out cannot wait: it is called from a request that
 * has its own work to finish, and one stalled reader would hold up everyone
 * else's events.
 *
 * So a reader that has fallen too far behind is disconnected instead. That is
 * safe here precisely because it is not a loss: intelligence events are
 * persisted, and the browser reconnects and resumes from its cursor, which is
 * the same path it takes after any dropped connection. Ending the stream tells
 * it to do that. Silently skipping the write would not -- the client would sit
 * on an open socket believing it was current, which is the one outcome worth
 * avoiding.
 */

/*
 * Roughly a few hundred small events, or one pathological one. Small enough
 * that a hundred stalled readers cannot add up to real memory, large enough
 * that an ordinary slow connection catching its breath is not disconnected for
 * it.
 */
const MAX_LIVE_CLIENT_BUFFER_BYTES = 256 * 1024;

const WRITTEN = 'written';
const DROPPED = 'dropped';
const ENDED = 'ended';

function bufferedBytes(client) {
  const length = Number(client && client.writableLength);
  return Number.isFinite(length) && length > 0 ? length : 0;
}

/*
 * Returns what happened rather than a boolean, so a caller can count drops
 * without inferring them from a false that also means "buffered, will flush".
 */
function writeLiveClient(client, payload, options = {}) {
  if (!client || typeof client.write !== 'function') return ENDED;
  if (client.writableEnded || client.destroyed) return ENDED;

  const limit = Number(options.maxBufferedBytes) > 0
    ? Number(options.maxBufferedBytes)
    : MAX_LIVE_CLIENT_BUFFER_BYTES;

  /*
   * Checked before the write, not after. After is too late: the payload that
   * crosses the line has already been taken into memory, and a single large
   * event would be accepted no matter how far behind the reader already was.
   */
  const payloadBytes = Buffer.isBuffer(payload) ? payload.length : Buffer.byteLength(String(payload), 'utf8');
  if (bufferedBytes(client) + payloadBytes > limit) {
    if (typeof options.onDrop === 'function') options.onDrop(client);
    try {
      if (typeof client.destroy === 'function') client.destroy();
      else client.end();
    } catch { /* the socket is already gone */ }
    return DROPPED;
  }

  try {
    client.write(payload);
  } catch {
    /* A stream that really has gone away throws on write; it is finished. */
    return ENDED;
  }
  return WRITTEN;
}

module.exports = Object.freeze({
  MAX_LIVE_CLIENT_BUFFER_BYTES,
  WRITTEN,
  DROPPED,
  ENDED,
  writeLiveClient
});
