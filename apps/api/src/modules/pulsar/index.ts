/*
 * Pulsar: what is happening in the repositories, as it happens. A GitHub
 * webhook delivery checked against its signature and read into one event
 * shape, with the risk it carries; the live stream each event is written to,
 * which drops a reader too far behind rather than buffering for it; and the
 * activity feed merged from what each repository answered. The rest of the
 * server reaches this module through this file only.
 */
import * as feedRules from './domain/activity-feed.ts';
export { normalizeGithubWebhook, riskForEvent } from './domain/webhook-events.ts';
export type { Risk, RiskContext, RiskEvent, RiskReason, WebhookEvent } from './domain/webhook-events.ts';
export { verifyGithubSignature } from './domain/webhook-signature.ts';
export { DROPPED, ENDED, MAX_LIVE_CLIENT_BUFFER_BYTES, WRITTEN, canAcceptLiveClient, writeLiveClient } from './application/live-stream.ts';
export type { LiveWrite, LiveWriteOptions } from './application/live-stream.ts';
/* The activity feed, as one namespace: its `KINDS` and `instant` are words other modules use for other things. */
export const activityFeed = Object.freeze({
  KINDS: feedRules.KINDS,
  MAX_REPOSITORIES: feedRules.MAX_REPOSITORIES,
  MAX_EVENTS: feedRules.MAX_EVENTS,
  instant: feedRules.instant,
  selectRepositories: feedRules.selectRepositories,
  feed: feedRules.feed
});
export type { EventKind, Feed, FeedEvent, SelectedRepository } from './domain/activity-feed.ts';
