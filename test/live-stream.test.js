'use strict';

/*
 * The property under test is not that a write happens. It is that a reader
 * which has stopped reading cannot make the server hold its events in memory
 * indefinitely, and that when one is disconnected for it the disconnection is
 * visible rather than a silently skipped write.
 */

const assert = require('assert');
const {
  MAX_LIVE_CLIENT_BUFFER_BYTES, WRITTEN, DROPPED, ENDED, writeLiveClient
} = require('../src/live-stream');

/*
 * A response stream does not throw when the reader stalls: it accepts the
 * write, returns false, and grows writableLength. This models that, which is
 * the behaviour the previous try/catch was written as though it could see.
 */
function fakeClient({ buffered = 0, ended = false, destroyed = false, throwOnWrite = false } = {}) {
  return {
    writableLength: buffered,
    writableEnded: ended,
    destroyed,
    writes: [],
    endCalls: 0,
    write(payload) {
      if (throwOnWrite) throw new Error('socket closed');
      this.writes.push(payload);
      this.writableLength += Buffer.byteLength(String(payload), 'utf8');
      return this.writableLength <= MAX_LIVE_CLIENT_BUFFER_BYTES;
    },
    end() { this.endCalls += 1; this.writableEnded = true; }
  };
}

/* A reader keeping up is written to, and nothing else happens to it. */
{
  const client = fakeClient();
  assert.strictEqual(writeLiveClient(client, 'event: intelligence\ndata: {}\n\n'), WRITTEN);
  assert.strictEqual(client.writes.length, 1);
  assert.strictEqual(client.endCalls, 0);
}

/*
 * A reader that has stopped reading is disconnected rather than buffered into.
 * write() returning false is not itself the signal -- that happens routinely
 * on a healthy connection -- the accumulated bytes are.
 */
{
  const stalled = fakeClient({ buffered: MAX_LIVE_CLIENT_BUFFER_BYTES + 1 });
  assert.strictEqual(writeLiveClient(stalled, 'data: x\n\n'), DROPPED);
  assert.strictEqual(stalled.writes.length, 0, 'nothing more may be taken into memory for a stalled reader');
  assert.strictEqual(stalled.endCalls, 1, 'the stream is ended so the browser reconnects and resumes from its cursor');
}

/* No additional payload fits when the reader is already at the bound. */
{
  const busy = fakeClient({ buffered: MAX_LIVE_CLIENT_BUFFER_BYTES });
  assert.strictEqual(writeLiveClient(busy, 'data: x\n\n'), DROPPED);
  assert.strictEqual(busy.endCalls, 1, 'the next payload would exceed the bound');
}

/* The caller is told, so a drop can be counted rather than inferred. */
{
  const dropped = [];
  const stalled = fakeClient({ buffered: MAX_LIVE_CLIENT_BUFFER_BYTES * 2 });
  writeLiveClient(stalled, 'data: x\n\n', { onDrop: client => dropped.push(client) });
  assert.strictEqual(dropped.length, 1, 'a drop must be observable to its caller');
  assert.strictEqual(dropped[0], stalled);
}

/* An already-finished stream is left alone rather than ended twice. */
{
  const gone = fakeClient({ ended: true });
  assert.strictEqual(writeLiveClient(gone, 'data: x\n\n'), ENDED);
  assert.strictEqual(gone.endCalls, 0);
  assert.strictEqual(gone.writes.length, 0);

  const destroyed = fakeClient({ destroyed: true });
  assert.strictEqual(writeLiveClient(destroyed, 'data: x\n\n'), ENDED);
  assert.strictEqual(destroyed.writes.length, 0);
}

/* A socket that really has gone reports itself finished rather than throwing. */
{
  const broken = fakeClient({ throwOnWrite: true });
  assert.strictEqual(writeLiveClient(broken, 'data: x\n\n'), ENDED);
}

/*
 * The bound is bytes, not messages. Many small events are the ordinary case
 * and must not be mistaken for a stall.
 */
{
  const client = fakeClient();
  let written = 0;
  for (let i = 0; i < 500; i += 1) {
    if (writeLiveClient(client, `data: ${i}\n\n`) === WRITTEN) written += 1;
  }
  assert.strictEqual(written, 500, 'a reader that keeps up is never dropped for volume alone');
  assert.strictEqual(client.endCalls, 0);
}

/*
 * A reader that never drains is dropped once the bytes accumulate, and only
 * then -- the point at which it stops is a function of the bound, not of how
 * many writes it took to get there.
 */
{
  const stalled = fakeClient();
  stalled.write = function (payload) {
    this.writes.push(payload);
    this.writableLength += Buffer.byteLength(String(payload), 'utf8');
    return false;
  };
  let status = WRITTEN;
  let attempts = 0;
  while (status === WRITTEN && attempts < 100_000) { status = writeLiveClient(stalled, 'data: '.padEnd(1024, 'x') + '\n\n'); attempts += 1; }
  assert.strictEqual(status, DROPPED, 'a reader that never drains is eventually disconnected');
  assert(stalled.writableLength <= MAX_LIVE_CLIENT_BUFFER_BYTES, 'without ever exceeding the bound');
  assert(stalled.writableLength < MAX_LIVE_CLIENT_BUFFER_BYTES * 2, 'and not long after');
}

/* An explicit bound overrides the default, so a caller can be stricter. */
{
  const client = fakeClient({ buffered: 2048 });
  assert.strictEqual(writeLiveClient(client, 'data: x\n\n', { maxBufferedBytes: 1024 }), DROPPED);
}

console.log('live stream backpressure tests passed');
