/*
 * Where GitHub delivers a webhook. The body is read raw, before the server's
 * JSON parser, because the signature in X-Hub-Signature-256 is over the exact
 * bytes GitHub sent; Pulsar verifies it and stores the event.
 */
import express from 'express';
import type { Application, RequestHandler } from 'express';

export interface WebhookIntakeRouteDeps {
  /* Pulsar's webhook receiver. */
  readonly receiveGithubWebhook: RequestHandler;
}

export function registerWebhookIntakeRoute(app: Application, deps: WebhookIntakeRouteDeps): void {
  const { receiveGithubWebhook } = deps;
  app.post('/hooks/github/:hookId', express.raw({ type: 'application/json', limit: '2mb' }), receiveGithubWebhook);
}
