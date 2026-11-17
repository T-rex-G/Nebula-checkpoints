/*
 * Stopping, once, on the first signal.
 *
 * In order: the job queues take no new work; the stop is logged; the live
 * streams are told why they end; the workers are asked to stop and hand back
 * what they have in flight. The server then stops accepting connections and,
 * once the open ones have closed, waits for each worker's work in turn, closes
 * the pool and exits cleanly. A worker that fails while finishing, or a pool
 * that fails to close, does not hold the exit.
 *
 * The order matters at the end: a webhook delivery in flight has already sent
 * its request, and if the pool closed first it could not record the attempt,
 * so its row would stay leased and the receiver would be sent the same event
 * again once the lease expired. A timer bounds the whole of it -- after ten
 * seconds the process exits with a failure regardless -- and does not itself
 * keep the process alive.
 */

export interface GracefulShutdownDeps {
  /* The job queues, closed to new work. */
  readonly closeJobs: () => void;
  /* The live streams, told why they end. */
  readonly closeStreams: (signal: string) => void;
  /* The workers, stopped; each hands back what to wait for, or nothing. */
  readonly drain: () => readonly (Promise<unknown> | null)[];
  readonly server: () => { close(callback: () => void): unknown };
  readonly closeDatabase: () => Promise<unknown>;
  readonly exit: (code: number) => void;
  readonly forceAfterMs?: number;
}

const FORCE_AFTER_MS = 10000;

export function createGracefulShutdown(deps: GracefulShutdownDeps) {
  let stopping = false;

  async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    deps.closeJobs();
    console.log(JSON.stringify({ t: new Date().toISOString(), event: 'shutdown', signal }));
    deps.closeStreams(signal);
    const drained = deps.drain();
    const force = setTimeout(() => deps.exit(1), deps.forceAfterMs ?? FORCE_AFTER_MS);
    if (typeof force.unref === 'function') force.unref();
    deps.server().close(async () => {
      for (const work of drained) {
        try { await work; } catch {}
      }
      try { await deps.closeDatabase(); } catch {}
      clearTimeout(force);
      deps.exit(0);
    });
  }

  return { shutdown, shuttingDown: () => stopping };
}

export type GracefulShutdown = ReturnType<typeof createGracefulShutdown>;
