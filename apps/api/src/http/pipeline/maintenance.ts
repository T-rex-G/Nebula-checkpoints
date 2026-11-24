/*
 * Maintenance mode.
 *
 * render.yaml has carried NV_MAINTENANCE_MODE since the blueprint was written
 * and a contract test asserted it was set, but nothing read it: turning it on
 * did nothing whatsoever. An operator reaching for it during an incident would
 * have had a documented switch, a passing test, and a fully serving
 * application.
 *
 * What it must not do is take the health check down with it. The host restarts
 * an instance that fails health, so a maintenance switch that answers 503 to
 * everything removes the very thing the operator just reached for. Health stays
 * green and discloses the state; readiness reports not-ready, which is the
 * honest answer and the one load balancers act on.
 *
 * Read once at startup rather than per request: on the hosted platform an
 * environment change redeploys the service, so there is no state to poll for,
 * and a per-request read would invite the value to change midway through one.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Environment } from './environment.ts';

export function maintenanceMode(env: Environment): boolean {
  return /^(1|true|on|yes)$/i.test(String(env.NV_MAINTENANCE_MODE || '').trim());
}

/*
 * Placed after health and readiness and before everything else: those two have
 * to answer during maintenance, and nothing else may. Static assets are served
 * after it so the shell can still render and show the notice rather than a
 * bare browser error.
 */
export function apiMaintenance(enabled: boolean): RequestHandler {
  return function apiMaintenanceStep(req: Request, res: Response, next: NextFunction): void {
    if (!enabled) return next();
    res.setHeader('Retry-After', '120');
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({
      error: 'SERVICE_IN_MAINTENANCE',
      message: 'Nebulaverse-X is in maintenance and is not accepting requests right now.',
      nextAction: 'Retry once maintenance has finished. No data has been changed by this request.'
    });
  };
}
