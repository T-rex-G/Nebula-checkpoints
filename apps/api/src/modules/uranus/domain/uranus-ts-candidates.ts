/* A spelling filter may select extra files. Each sink below has a fixed property
 * name or JSX attribute. Any escape can conceal part of that spelling. */
export function mayContainMarkupSink(text: string): boolean {
  return /innerHTML|outerHTML|srcdoc|insertAdjacentHTML|setHTMLUnsafe|createContextualFragment|parseFromString|write|dangerouslySetInnerHTML|bypassSecurityTrustHtml|\\/.test(text);
}

export function mayContainSemanticSink(text: string): boolean {
  // Computed calls/writes and Function.bind may name a method through several
  // constant fragments. Include them in project selection. Only actual legacy
  // spellings participate in per-line overlap reconciliation.
  return mayContainMarkupSink(text) || /\b(?:query|bind)\b|\]\s*[()/?+|=]/.test(text);
}
