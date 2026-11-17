/*
 * The address GitHub delivers a repository's webhooks to.
 *
 * It is the deployment's configured public URL (PUBLIC_BASE_URL, else the one
 * Render gives the service), else the address the request arrived at. In
 * production it must be configured and must be HTTPS: an inferred host is
 * whatever the request said it was, and a delivery to plain HTTP would carry
 * its signature in the clear. It never carries credentials.
 */

type Environment = Readonly<Record<string, string | undefined>>;

interface CallbackRequest {
  readonly protocol: string;
  get(name: string): string | undefined;
}

export function publicCallbackBase(req: CallbackRequest, env: Environment): string {
  const configured = String(env.PUBLIC_BASE_URL || env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '');
  const inferred = `${req.protocol}://${req.get('host')}`;
  if (env.NODE_ENV === 'production' && !configured) {
    throw Object.assign(new Error('Set PUBLIC_BASE_URL for verified live events on non-Render production hosts'), { status: 400 });
  }
  const value = configured || inferred;
  const u = new URL(value);
  if (env.NODE_ENV === 'production' && u.protocol !== 'https:') throw Object.assign(new Error('Live events require an HTTPS public URL'), { status: 400 });
  if (u.username || u.password || !['http:', 'https:'].includes(u.protocol)) throw Object.assign(new Error('Invalid public callback URL'), { status: 400 });
  return value;
}
