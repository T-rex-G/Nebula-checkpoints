/*
 * Identity, not a version number: which build is answering, by digest -- the
 * source tree's fingerprint, the served browser bytes and how the server runs
 * (and, when compiled, the compiled tree).
 *
 * This route is deliberately readable before an invitation -- the hosted
 * alpha.17 validator and the operator checklist both probe it anonymously --
 * so whatever it says is said to everyone. releaseTreeSha256 is what those
 * callers actually read: ci/run-hosted-alpha17-validation.js takes the
 * fingerprint and nothing else, and the qualification manual records it at
 * the start and end of a run. It names the build exactly without publishing
 * the semantic version, which is the half an attacker can line up against a
 * list of known vulnerabilities.
 *
 * The version itself is not secret and is not being hidden from the people
 * running the alpha: it travels on /api/me, behind a session, and Settings
 * shows it to the tester who needs to quote it in a report.
 *
 * Every value is bound to bytes observed at startup (ADR-067, ADR-072): a
 * digest embedded at build time would be circular and could attest different
 * bytes.
 */
import type { Application, Request, Response } from 'express';

export interface VersionRouteDeps {
  readonly product: string;
  readonly releaseTreeSha256: string;
  readonly servedAssetsSha256: string;
  readonly serverRuntime: { readonly mode: string; readonly buildSha256?: string | null };
}

export function registerVersionRoute(app: Application, deps: VersionRouteDeps): void {
  app.get('/api/version', (req: Request, res: Response) => res.json({
    product: deps.product,
    releaseTreeSha256: deps.releaseTreeSha256,
    servedAssetsSha256: deps.servedAssetsSha256,
    serverRuntime: deps.serverRuntime.mode,
    ...(deps.serverRuntime.buildSha256 ? { serverBuildSha256: deps.serverRuntime.buildSha256 } : {})
  }));
}
