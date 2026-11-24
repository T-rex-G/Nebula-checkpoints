/*
 * Which segments of an address are not repeated in evidence: a JSON Web
 * Token, or a long run of token characters that is not a slug.
 *
 * URL.pathname keeps percent escapes, so a segment is read decoded as well,
 * up to four layers deep, while an ordinary path keeps its own spelling in
 * whatever is shown.
 */
export function privatePathSegment(value: unknown): boolean {
  let segment = String(value);
  for (let pass = 0; pass < 4; pass++) {
    if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(segment)) return true;
    /* A long run of token characters is hidden, unless it is a slug: three or more short lowercase words. */
    if (/^[A-Za-z0-9_-]{24,}$/.test(segment) && !/^[a-z]{1,15}(?:-[a-z]{1,15}){2,}$/.test(segment)) return true;
    let decoded: string;
    try { decoded = decodeURIComponent(segment); } catch { return false; }
    if (decoded === segment) break;
    segment = decoded;
  }
  return false;
}
