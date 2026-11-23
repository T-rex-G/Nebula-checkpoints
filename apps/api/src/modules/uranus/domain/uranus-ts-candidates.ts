const MARKUP_PROPERTIES = /innerHTML|outerHTML|srcdoc|insertAdjacentHTML|setHTMLUnsafe|createContextualFragment|parseFromString|dangerouslySetInnerHTML|bypassSecurityTrustHtml/;

export function mayContainMarkupSink(text: string): boolean {
  // Keep the conservative legacy-spelling mask for overlapping line findings.
  return MARKUP_PROPERTIES.test(text) || text.includes('write') || text.includes('\\');
}

export function hasNamedSemanticSink(text: string): boolean {
  return MARKUP_PROPERTIES.test(text) || /\b(?:write|writeln|query|execute)\b/.test(text);
}

/* A computed access requires an expression before its opening bracket and a
 * key inside it. Its closing bracket may be followed by arbitrary TypeScript
 * assertions, comments, aliases or parentheses before the actual operation.
 * Exclude only unambiguous operand-start contexts. A line break stays possible
 * because it may terminate a comment containing the apparent preceding token. */
function possibleElementAccess(text: string): boolean {
  for (let at = text.indexOf('['); at >= 0; at = text.indexOf('[', at + 1)) {
    let left = at - 1, right = at + 1;
    while (left >= 0 && (text[left] === ' ' || text[left] === '\t')) left--;
    if (left < 0 || '=(:,;{['.includes(text.charAt(left))) continue;
    while (text[right] === ' ' || text[right] === '\t') right++;
    const first = text.charCodeAt(right);
    // The immutable-key evaluator accepts strings. A numeric literal cannot
    // identify a modeled method or property, even after a type assertion.
    if (right < text.length && text[right] !== ']' && !(first >= 48 && first <= 57)) return true;
  }
  return false;
}

export function mayContainSemanticSink(text: string): boolean {
  return hasNamedSemanticSink(text) || text.includes('\\') || /\bbind\b/.test(text) || possibleElementAccess(text);
}
