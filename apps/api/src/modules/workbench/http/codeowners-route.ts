/*
 * Who owns what in a repository, by its CODEOWNERS file, for the findings
 * inbox to name beside each finding (packages/contracts/src/codeowners.ts
 * parses and matches). Read from the default branch at the three places
 * GitHub looks, first found wins; patterns and owners only, bounded in size
 * and lines.
 *
 * The guards are handed in under the names the route policy records.
 */
import type { Application, Request, RequestHandler, Response } from 'express';
import { member, type Fields } from '../../../platform/values/fields.ts';
import * as codeowners from '../../../../../../packages/contracts/src/codeowners.ts';
import type { Gh } from '../application/commit-writer.ts';
import { repositoryPath } from './provider-values.ts';

const CODEOWNERS_MAX_BYTES = 256 * 1024;

export interface CodeownersRouteDeps {
  readonly providerSessionAccess: RequestHandler;
  readonly alphaRepositoryAccess: RequestHandler;
  readonly capabilityAccess: (feature: string) => RequestHandler;
  readonly auth: RequestHandler;
  /* The provider account the session is acting as, as the guards attached it. */
  readonly account: (req: Request) => Fields;
  /* The server's public error answer. */
  readonly fail: (res: Response, error: unknown) => unknown;
  readonly gh: Gh;
}

/* `Buffer.from(value, 'base64')`, called as JavaScript calls it on a provider's field. */
function fromBase64(value: unknown): Buffer {
  const decoded: unknown = Reflect.apply(Buffer.from, Buffer, [value, 'base64']);
  if (!Buffer.isBuffer(decoded)) throw new TypeError('Buffer.from did not answer a Buffer');
  return decoded;
}

export function registerCodeownersRoute(app: Application, deps: CodeownersRouteDeps): void {
  const { providerSessionAccess, alphaRepositoryAccess, capabilityAccess, auth, account, fail, gh } = deps;

  app.get('/api/repo/:owner/:repo/codeowners', providerSessionAccess, alphaRepositoryAccess, capabilityAccess('file.read'), auth, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      for (const location of codeowners.LOCATIONS) {
        let meta: unknown;
        try {
          meta = await gh(account(req), `${repositoryPath(req)}/contents/${location.split('/').map(encodeURIComponent).join('/')}`);
        } catch (error) {
          if (error && Number(member(error, 'status')) === 404) continue;
          throw error;
        }
        if (!meta || member(meta, 'type') !== 'file') continue;
        if (Number(member(meta, 'size')) > CODEOWNERS_MAX_BYTES || !member(meta, 'content')) {
          res.json({ path: location, rules: [], tooLarge: Number(member(meta, 'size')) > CODEOWNERS_MAX_BYTES });
          return;
        }
        const text = fromBase64(member(meta, 'content')).toString('utf8');
        res.json({ path: location, rules: codeowners.serialize(codeowners.parse(text)), tooLarge: false });
        return;
      }
      res.json({ path: null, rules: [], tooLarge: false });
    } catch (e) { fail(res, e); }
  });
}
