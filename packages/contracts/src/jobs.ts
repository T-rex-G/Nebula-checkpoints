/*
 * Work that outlives a request, and how the page follows it.
 *
 * Two kinds. A polled job (an audit, a deployed-site check, a rendered audit)
 * lives in one server process's memory: the first request starts it and is
 * answered 202 with a run id and a stage, and the page asks again with that
 * id until the result is there. A restart loses the job, and the page is
 * told the run is gone instead of being left polling.
 *
 * An exposure scan is kept in the database instead and moves through states
 * that survive a restart, ending in one of four terminal states.
 *
 * Each code a job can fail with is written out here, not composed, so the
 * page and the error-code catalogue can name it.
 */

export const JOBS_CONTRACT_VERSION = 1;

export const JOB_KINDS = Object.freeze(['audit', 'site', 'rendered'] as const);
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_FAILURES = Object.freeze(['RUN_GONE', 'IN_PROGRESS', 'BUSY', 'TIMEOUT'] as const);
export type JobFailure = (typeof JOB_FAILURES)[number];

export const JOB_STAGES: Readonly<Record<JobKind, readonly string[]>> = Object.freeze({
  audit: Object.freeze(['queued', 'resolving', 'reading', 'rules', 'advisories', 'intel', 'analysing', 'patterns']),
  site: Object.freeze(['page', 'transport', 'paths', 'pages', 'scripts', 'libraries', 'email']),
  rendered: Object.freeze(['launching', 'desktop', 'mobile', 'accessibility', 'capturing'])
});

/* The stage a fresh job reports before its work has said anything. */
export const JOB_FIRST_STAGE: Readonly<Record<JobKind, string>> = Object.freeze({
  audit: 'resolving', site: 'page', rendered: 'launching'
});

export const JOB_ERROR_CODES: Readonly<Record<JobKind, Readonly<Record<JobFailure, string>>>> = Object.freeze({
  audit: Object.freeze({ RUN_GONE: 'AUDIT_RUN_GONE', IN_PROGRESS: 'AUDIT_IN_PROGRESS', BUSY: 'AUDIT_BUSY', TIMEOUT: 'AUDIT_TIMEOUT' }),
  site: Object.freeze({ RUN_GONE: 'SITE_CHECK_RUN_GONE', IN_PROGRESS: 'SITE_CHECK_IN_PROGRESS', BUSY: 'SITE_CHECK_BUSY', TIMEOUT: 'SITE_CHECK_TIMEOUT' }),
  rendered: Object.freeze({ RUN_GONE: 'RENDERED_AUDIT_RUN_GONE', IN_PROGRESS: 'RENDERED_AUDIT_IN_PROGRESS', BUSY: 'RENDERED_AUDIT_BUSY', TIMEOUT: 'RENDERED_AUDIT_TIMEOUT' })
});

/* The 202 answer while a polled job runs. */
export interface RunningJob {
  readonly state: 'running';
  readonly run: string;
  readonly stage: string;
  readonly done: number;
  readonly total: number;
  readonly position: number | null;
  readonly limit: number | null;
  readonly elapsedMs: number;
}

/* An exposure scan's life, as the database keeps it. */
export const SCAN_STATES = Object.freeze(['queued', 'running', 'complete', 'partial', 'failed', 'canceled'] as const);
export type ScanState = (typeof SCAN_STATES)[number];
export const TERMINAL_SCAN_STATES = Object.freeze(['complete', 'partial', 'failed', 'canceled'] as const);
export type TerminalScanState = (typeof TERMINAL_SCAN_STATES)[number];
