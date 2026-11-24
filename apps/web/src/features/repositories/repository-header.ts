/*
 * The workbench header's name. The owner is its own span so a phone can show
 * the repository alone; the text, and the title a pointer reads, are the full
 * name either way, and both are set as text, never as markup.
 */
interface Named {
  title: string;
  replaceChildren(...nodes: unknown[]): void;
}
export interface HeaderDocument {
  createElement(tag: 'span'): { className: string; textContent: string | null };
  createTextNode(text: string): unknown;
}

export function nameRepository(host: Named | null, doc: HeaderDocument, owner: string, repo: string): void {
  if (!host) return;
  const ownerPart = doc.createElement('span');
  ownerPart.className = 'repo-owner';
  ownerPart.textContent = `${owner}/`;
  host.replaceChildren(ownerPart, doc.createTextNode(repo));
  host.title = `${owner}/${repo}`;
}
