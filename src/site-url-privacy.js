'use strict';

/* URL.pathname retains percent escapes. Inspect decoded segments too, while
   keeping the original spelling of ordinary paths in public evidence. */
function privatePathSegment(value) {
  let segment = String(value);
  for (let pass = 0; pass < 4; pass++) {
    if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(segment)) return true;
    /* A long run of token characters is hidden, unless it is a slug: three or more short lowercase words. */
    if (/^[A-Za-z0-9_-]{24,}$/.test(segment) && !/^[a-z]{1,15}(?:-[a-z]{1,15}){2,}$/.test(segment)) return true;
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { return false; }
    if (decoded === segment) break;
    segment = decoded;
  }
  return false;
}

module.exports = { privatePathSegment };
