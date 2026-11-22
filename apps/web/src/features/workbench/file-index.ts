/*
 * Every file path of the open repository's branch, read once and held for
 * the command palette and the Safeguards screen.
 *
 * A list belongs to the repository and branch it was asked for: one that
 * answers after another was opened is dropped rather than held for the one
 * open now. Two readers asking at once share one request. A failure holds
 * nothing, so the next reader asks again; it is never held as an empty
 * repository, whose locks would each read as covering no file. Only the
 * paths written are kept.
 */
import { field } from '../../platform/values.ts';

export interface FileIndexDeps {
  readonly api: (path: string) => Promise<unknown>;
  /* The open repository: a record whose identity is the repository, its branch changed in place. */
  readonly work: () => unknown;
  /* The list held for the open repository, and its replacement. */
  readonly held: () => unknown;
  readonly hold: (files: readonly string[]) => void;
}

export interface FileIndex {
  /* The list held, or read and held; null when it could not be read for the repository open now. */
  load(): Promise<readonly string[] | null>;
}

export function createFileIndex(deps: FileIndexDeps): FileIndex {
  let pending: { readonly work: unknown; readonly branch: unknown; readonly answer: Promise<readonly string[] | null> } | null = null;

  async function read(work: unknown, branch: unknown): Promise<readonly string[] | null> {
    const current = (): boolean => deps.work() === work && field(work, 'branch') === branch;
    try {
      const answer = await deps.api(`/api/repo/${String(field(work, 'owner'))}/${String(field(work, 'repo'))}/files?ref=${encodeURIComponent(String(branch))}`);
      const files = field(answer, 'files');
      if (!current() || !Array.isArray(files)) return null;
      const list = Object.freeze(files.filter((entry): entry is string => typeof entry === 'string'));
      deps.hold(list);
      return list;
    } catch {
      return null;
    }
  }

  return {
    load() {
      const held = deps.held();
      if (Array.isArray(held)) return Promise.resolve(held as readonly string[]);
      const work = deps.work();
      if (!work) return Promise.resolve(null);
      const branch = field(work, 'branch');
      if (pending && pending.work === work && pending.branch === branch) return pending.answer;
      const answer = read(work, branch);
      const mine = { work, branch, answer };
      pending = mine;
      void answer.then(() => { if (pending === mine) pending = null; });
      return answer;
    }
  };
}
