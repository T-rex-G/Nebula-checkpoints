/*
 * A style may set a custom property: the stylesheet reads several that a
 * component sets (--risk, --audit-fill, --audit-read, --lit). React sets a
 * property whose name starts with two dashes as written; this says so to
 * the type checker, so no style needs a cast.
 */
import 'react';

declare module 'react' {
  interface CSSProperties {
    [property: `--${string}`]: string | undefined;
  }
}
