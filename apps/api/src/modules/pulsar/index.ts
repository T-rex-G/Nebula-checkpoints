/*
 * Pulsar: what is happening in the repositories, as it happens. A GitHub
 * webhook delivery checked against its signature and read into one event
 * shape, with the risk it carries; the live streams each event is written to,
 * which drop a reader too far behind rather than buffering for it; the
 * activity feed merged from what each repository answered; and the routes
 * that connect, read and stream a repository's events. The rest of the
 * server reaches this module through this file only.
 */
import * as feedRules from './domain/activity-feed.ts';
export { normalizeGithubWebhook, riskForEvent } from './domain/webhook-events.ts';
export type { Risk, RiskContext, RiskEvent, RiskReason, WebhookEvent } from './domain/webhook-events.ts';
export { verifyGithubSignature } from './domain/webhook-signature.ts';
export { DROPPED, ENDED, MAX_LIVE_CLIENT_BUFFER_BYTES, WRITTEN, canAcceptLiveClient, writeLiveClient } from './application/live-stream.ts';
export type { LiveWrite, LiveWriteOptions } from './application/live-stream.ts';
export { createLiveHub } from './application/live-hub.ts';
export type { LiveClient, LiveHub, LiveHubLimits } from './application/live-hub.ts';
export { decodeEventCursor, encodeEventCursor } from './domain/event-cursor.ts';
export type { EventCursor } from './domain/event-cursor.ts';
export { registerActivityRoutes } from './http/activity-routes.ts';
export type { ActivityRouteDeps } from './http/activity-routes.ts';
export { registerLiveEventRoutes } from './http/live-event-routes.ts';
export type { AlphaWebhookRecords, LiveEventRouteDeps } from './http/live-event-routes.ts';
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
