/*
 * The workbench's dependency audit: the packages a repository's manifests
 * declare (the lockfile's when it has one), at most four hundred of them,
 * checked against the public OSV database, with each advisory's summary and
 * severity, and GitHub's own Dependabot alerts when the token may read them.
 * It says when OSV could not answer, so a clean result is never one nobody
 * checked, and when versions came from package.json ranges rather than a
 * lockfile.
 *
 * The guards are handed in under the names the route policy records.
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import { cleanText } from '../../../platform/values/text.ts';
import { member, type Fields } from '../../../platform/values/fields.ts';
import type { Gh } from '../application/commit-writer.ts';
import type { GuardedFetch } from '../application/lfs.ts';
import { MANIFESTS, parseManifest, type ManifestPackage } from '../domain/manifests.ts';
import { listed, repositoryPath, sliced } from './provider-values.ts';

export interface DependencyAuditRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => Fields;
  /* The server's public error answer. */
  readonly fail: (res: Response, error: unknown) => unknown;
  readonly gh: Gh;
  /* The guarded transport, for the OSV database. */
  readonly fetch: GuardedFetch;
}

/* `Buffer.from(value, 'base64')`, called as JavaScript calls it on a provider's field. */
function fromBase64(value: unknown): Buffer {
  const decoded: unknown = Reflect.apply(Buffer.from, Buffer, [value, 'base64']);
  if (!Buffer.isBuffer(decoded)) throw new TypeError('Buffer.from did not answer a Buffer');
  return decoded;
}

interface Vulnerable extends ManifestPackage {
  readonly ids: unknown[];
}

export function registerDependencyAuditRoute(app: Application, deps: DependencyAuditRouteDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, account, fail, gh } = deps;
  const R = repositoryPath;

  app.get('/api/repo/:owner/:repo/audit-deps', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('dependency-audit'), auth, async (req: Request, res: Response) => {
    try {
      const branch = req.query.ref || '';
      const found: ManifestPackage[] = [], sources: { file: string; packages: number; approximate: boolean }[] = [];
      for (const name of MANIFESTS) {
        try {
          const f = await gh(account(req), `${R(req)}/contents/${encodeURIComponent(name)}${branch ? `?ref=${encodeURIComponent(String(branch))}` : ''}`);
          const text = fromBase64(member(f, 'content') || '').toString('utf8');
          const pkgs = parseManifest(name, text);
          if (pkgs.length) { sources.push({ file: name, packages: pkgs.length, approximate: name === 'package.json' }); found.push(...pkgs); }
          if (name === 'package-lock.json' && pkgs.length) break;
        } catch {}
      }
      const seen = new Set<string>();
      const pkgs = found.filter(p => {
        const k = `${p.ecosystem}:${p.name}@${p.version}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 400);
      const vulnerable: Vulnerable[] = [];
      const osv = { available: pkgs.length === 0, queried: pkgs.length, error: '' };
      if (pkgs.length) {
        try {
          const r = await deps.fetch('https://api.osv.dev/v1/querybatch', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ queries: pkgs.map(p => ({ version: p.version, package: { name: p.name, ecosystem: p.ecosystem } })) })
          }, 25000);
          if (!r.ok) {
            osv.error = `OSV service returned HTTP ${r.status}`;
          } else {
            const data: unknown = await r.json();
            const results = member(data, 'results');
            if (!Array.isArray(results)) osv.error = 'OSV returned an unexpected response';
            else {
              osv.available = true;
              results.forEach((row: unknown, i: number) => {
                const vulns = row && member(row, 'vulns');
                const pkg = pkgs[i];
                if (vulns && member(vulns, 'length') && pkg) {
                  vulnerable.push({ ...pkg, ids: listed(vulns, 'row.vulns.map').map(v => member(v, 'id')).slice(0, 8) });
                }
              });
            }
          }
        } catch (error) {
          osv.error = cleanText(error && member(error, 'message') || 'OSV request failed', 240);
        }
      }
      const ids = [...new Set(vulnerable.flatMap(v => v.ids))].slice(0, 20);
      const details: Record<string, unknown> = {};
      await Promise.allSettled(ids.map(async id => {
        const r2 = await deps.fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(String(id))}`, {}, 12000);
        if (r2.ok) {
          const v: unknown = await r2.json();
          details[String(id)] = {
            summary: member(v, 'summary') || String(member(v, 'details') || '').slice(0, 160),
            severity: listed(member(v, 'severity') || [], '(v.severity || []).map').map(x => member(x, 'score')).join(' ')
              || ((member(v, 'database_specific') && member(member(v, 'database_specific'), 'severity')) || ''),
            aliases: sliced(member(v, 'aliases') || [], 0, '(v.aliases || []).slice', 3)
          };
        }
      }));
      let dependabot: Record<string, unknown> = { available: false, alerts: [] };
      if ((account(req).provider || 'github') === 'github') {
        try {
          const al = await gh(account(req), `${R(req)}/dependabot/alerts?state=open&per_page=50`);
          dependabot = {
            available: true,
            alerts: listed(al || [], '(al || []).map').map(a => {
              const advisory = member(a, 'security_advisory');
              const dependency = member(a, 'dependency');
              return {
                severity: advisory && member(advisory, 'severity'),
                package: dependency && member(dependency, 'package') && member(member(dependency, 'package'), 'name'),
                summary: advisory && member(advisory, 'summary')
              };
            })
          };
        } catch { dependabot = { available: false, alerts: [], note: 'Token lacks security_events scope, or alerts are off for this repo' }; }
      }
      res.json({
        kind: 'nebulaverse-audit', generatedAt: new Date().toISOString(),
        owner: req.params.owner, repo: req.params.repo,
        scanned: pkgs.length, sources, vulnerable, details, dependabot, osv,
        complete: pkgs.length === 0 || osv.available,
        approximate: sources.some(s => s.approximate) && !sources.some(s => s.file === 'package-lock.json')
      });
    } catch (e) { fail(res, e); }
  });
}
