/*
 * The live streams open on this instance, by repository and identity.
 *
 * Every reader of a repository's verified events holds one entry here, and
 * four things act on them: a stream is admitted only under the limits for its
 * key and for the instance; a delivery is broadcast to its key's readers, and a
 * reader too far behind is dropped rather than buffered without bound; a
 * session that ends or is revoked closes its own streams, saying why; and a
 * shutdown tells every reader before it goes. They share one registry, so a
 * stream closed by any of them is gone for all of them.
 *
 * Each stream is tagged with the provider session that opened it, kept beside
 * the stream rather than on it.
 */
import { canAcceptLiveClient, writeLiveClient } from './live-stream.ts';

/* An open event stream: the response it is written to. */
export interface LiveClient {
  write(chunk: string): unknown;
  end(): unknown;
  readonly writableEnded?: boolean;
}

export interface LiveHubLimits {
  /* Streams open on the instance at most. */
  readonly maxTotal: number;
  /* Streams open for one repository and identity at most. */
  readonly maxPerKey: number;
}

export interface LiveHub {
  /* How many streams are open. */
  count(): number;
  /* Whether one more stream may open for `key`. */
  admits(key: string): boolean;
  /* Registers an open stream, with the provider session that opened it (if any). */
  add(key: string, client: LiveClient, sessionId: unknown): void;
  /* Forgets a stream its reader closed. */
  remove(key: string, client: LiveClient): void;
  /* Writes one event to every reader of `key`, dropping any reader too far behind. */
  broadcast(key: string, payload: string): void;
  /* Closes every stream the given sessions opened, saying why; answers how many it closed. */
  closeSessions(sessionIds: readonly unknown[] | null | undefined, reason?: string): number;
  /* Closes one stream whose alpha access has ended, saying so. */
  closeAlpha(key: string, client: LiveClient): void;
  /* Tells every reader the instance is going, closes them, and forgets them all. */
  shutdown(signal: string): void;
}

export function createLiveHub({ maxTotal, maxPerKey }: LiveHubLimits): LiveHub {
  const streams = new Map<string, Set<LiveClient>>();
  const sessionOf = new WeakMap<LiveClient, unknown>();

  const count = (): number => {
    let total = 0;
    for (const clients of streams.values()) total += clients.size;
    return total;
  };
  const forget = (key: string, clients: Set<LiveClient>): void => {
    if (!clients.size) streams.delete(key);
  };

  return Object.freeze({
    count,
    admits(key: string): boolean {
      const scoped = streams.get(key);
      return canAcceptLiveClient(count(), scoped ? scoped.size : 0, maxTotal, maxPerKey);
    },
    add(key: string, client: LiveClient, sessionId: unknown): void {
      sessionOf.set(client, sessionId);
      let clients = streams.get(key);
      if (!clients) {
        clients = new Set();
        streams.set(key, clients);
      }
      clients.add(client);
    },
    remove(key: string, client: LiveClient): void {
      const clients = streams.get(key);
      if (clients) { clients.delete(client); forget(key, clients); }
    },
    broadcast(key: string, payload: string): void {
      const clients = streams.get(key);
      if (!clients) return;
      /*
       * A copy, because a reader that has fallen behind is disconnected during
       * this loop and its own close handler removes it from the set being walked.
       */
      for (const client of [...clients]) {
        writeLiveClient(client, payload, {
          onDrop(dropped: LiveClient) {
            clients.delete(dropped);
            forget(key, clients);
          }
        });
      }
    },
    closeSessions(sessionIds: readonly unknown[] | null | undefined, reason = 'session-revoked'): number {
      const ids = new Set((sessionIds || []).filter(Boolean));
      if (!ids.size) return 0;
      let closed = 0;
      for (const [key, clients] of streams) {
        for (const client of [...clients]) {
          if (!ids.has(sessionOf.get(client))) continue;
          try { client.write(`event: session-revoked\ndata: ${JSON.stringify({ reason, at: new Date().toISOString() })}\n\n`); } catch { /* the reader is gone */ }
          try { client.end(); } catch { /* the reader is gone */ }
          clients.delete(client);
          closed += 1;
        }
        forget(key, clients);
      }
      return closed;
    },
    closeAlpha(key: string, client: LiveClient): void {
      const clients = streams.get(key);
      if (clients) { clients.delete(client); forget(key, clients); }
      if (client.writableEnded) return;
      try {
        client.write(`event: alpha-access-ended\ndata: ${JSON.stringify({
          reason: 'access-invalid',
          at: new Date().toISOString()
        })}\n\n`);
      } catch { /* the reader is gone */ }
      try { client.end(); } catch { /* the reader is gone */ }
    },
    shutdown(signal: string): void {
      for (const clients of streams.values()) {
        for (const client of clients) {
          try { client.write(`event: shutdown\ndata: ${JSON.stringify({ signal, at: new Date().toISOString() })}\n\n`); } catch { /* the reader is gone */ }
          try { client.end(); } catch { /* the reader is gone */ }
        }
      }
      streams.clear();
    }
  });
}
