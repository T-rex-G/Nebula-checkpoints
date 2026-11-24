/*
 * The alpha's privacy retention, run once the store is first ready and daily
 * after that: the privacy store removes what the retention policy says has
 * outlived its purpose (alphaRetentionPolicy in ../domain/alpha-privacy.ts).
 *
 * What it logs is counts, and a failure only by its code, never its message:
 * the run reads tester records, and a message is where a value from one of
 * them could be carried into the log.
 */

export interface AlphaPrivacyRetentionDeps {
  readonly config: { readonly enabled: boolean };
  readonly store: { runRetention(): Promise<object> } | null;
}

export interface AlphaPrivacyRetention {
  /* Starts the daily run, once; nothing when the alpha is not enabled. */
  start(): void;
}

const RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,79}$/;

export function createAlphaPrivacyRetention(deps: AlphaPrivacyRetentionDeps): AlphaPrivacyRetention {
  const { config, store } = deps;
  let started = false;

  async function run(): Promise<void> {
    if (!config.enabled || !store) return;
    try {
      const result = await store.runRetention();
      const counts = Object.fromEntries(Object.entries(result)
        .filter(([, value]) => Number.isSafeInteger(value)));
      console.log(JSON.stringify({
        t: new Date().toISOString(),
        alphaRetention: counts
      }));
    } catch (error) {
      const code = error && (error as { readonly code?: unknown }).code;
      console.error(JSON.stringify({
        t: new Date().toISOString(),
        warn: 'alpha privacy retention failed',
        code: ERROR_CODE.test(String(code || '')) ? code : 'ALPHA_RETENTION_FAILED'
      }));
    }
  }

  return {
    start() {
      if (!config.enabled || !store) return;
      if (started) return;
      started = true;
      void run();
      const timer = setInterval(() => { void run(); }, RETENTION_INTERVAL_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
  };
}
