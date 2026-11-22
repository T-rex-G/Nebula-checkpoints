/* A spelling filter may select extra files. Each sink below has a fixed property
 * name or JSX attribute. Any escape can conceal part of that spelling. */
export function mayContainMarkupSink(text: string): boolean {
  return /innerHTML|outerHTML|srcdoc|insertAdjacentHTML|setHTMLUnsafe|createContextualFragment|write|dangerouslySetInnerHTML|bypassSecurityTrustHtml|\\/.test(text);
}

export function mayContainSemanticSink(text: string): boolean {
  return mayContainMarkupSink(text) || /\bquery\b/.test(text);
}
