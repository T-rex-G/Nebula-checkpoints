export const MONGO_METHODS = new Set(['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'updateOne', 'updateMany', 'deleteOne', 'deleteMany', 'countDocuments', 'where', 'find_one', 'update_one', 'update_many', 'delete_one', 'delete_many', 'count_documents', 'find_one_and_update']);

const mongooseModule = /['"]mongoose['"]/;
export function mayUseMongoose(text: string): boolean {
  return mongooseModule.test(text) || text.includes('\\');
}

const MARKUP_PROPERTIES = /innerHTML|outerHTML|srcdoc|insertAdjacentHTML|setHTMLUnsafe|createContextualFragment|parseFromString|dangerouslySetInnerHTML|bypassSecurityTrustHtml/;

export function mayContainMarkupSink(text: string): boolean {
  // Keep the conservative legacy-spelling mask for overlapping line findings.
  return MARKUP_PROPERTIES.test(text) || text.includes('write') || text.includes('\\');
}

/* Module specifiers are local data. Include escaped spellings in the conservative
 * pass because the parser decodes the string literal before resolving a call. */
const onePath = new Set(['access', 'lstat', 'mkdir', 'open', 'opendir', 'readFile', 'readdir', 'readlink', 'realpath',
  'rm', 'rmdir', 'stat', 'truncate', 'unlink', 'writeFile', 'appendFile']);
const twoPaths = new Set(['copyFile', 'cp', 'link', 'rename']);

export function filesystemPathCount(name: string): number {
  if (twoPaths.has(name)) return 2;
  return onePath.has(name) ? 1 : 0;
}

const filesystemOperation = new RegExp('\\b(?:' + [...onePath, ...twoPaths].join('|') + ')(?:Sync)?\\b');
const filesystemModule = /["'`](?:node:)?fs(?:\/promises)?["'`]/;
export function mayUseNodeFilesystem(text: string): boolean {
  return filesystemModule.test(text) || text.includes('\\');
}

export function hasNamedSemanticSink(text: string): boolean {
  return MARKUP_PROPERTIES.test(text) || mongooseModule.test(text) || (filesystemModule.test(text) && filesystemOperation.test(text)) || /\b(?:write|writeln|query|execute)\b/.test(text);
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
