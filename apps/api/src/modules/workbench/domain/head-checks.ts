/*
 * The head a write lands on. A write names the branch head its view was
 * loaded at, and lands only there: a branch that moved underneath it is
 * refused rather than overwritten. An aggregate change -- a batch, a folder
 * move -- must name that head; a single file may leave it out.
 *
 * A destination that already holds something is refused rather than
 * replaced. A rename or a folder move names a new path; a tree entry for a
 * path that exists is an overwrite, and git accepts it without a word -- so
 * renaming a.txt onto b.txt used to replace b.txt in the same commit that
 * removed a.txt, and the only trace was a diff nobody had asked to see. A
 * parent that is a file is refused for the same reason: the provider rejects
 * the tree, and the reader should hear which path was in the way rather than
 * a 422 from the Git Data API.
 */
export type HeadCheckError = Error & { status: number; code: string };

function refusal(message: string, status: number, code: string): HeadCheckError {
  return Object.assign(new Error(message), { status, code });
}

export function branchChangedError(): HeadCheckError {
  return refusal('The branch changed since this view was loaded. Refresh the repository and retry so newer work is not overwritten.', 409, 'BRANCH_CHANGED');
}

export function assertExpectedHead(expectedHeadSha: unknown, actualHeadSha: unknown): void {
  if (!expectedHeadSha) return;
  if (!/^[0-9a-f]{40}$/i.test(String(expectedHeadSha))) {
    throw refusal('expectedHeadSha must be a 40-character commit SHA', 400, 'INVALID_EXPECTED_HEAD');
  }
  if (String(expectedHeadSha).toLowerCase() !== String(actualHeadSha || '').toLowerCase()) throw branchChangedError();
}

export function requireAggregateExpectedHead(expectedHeadSha: unknown): string {
  if (!/^[0-9a-f]{40}$/i.test(String(expectedHeadSha || ''))) {
    throw refusal('Aggregate mutations require expectedHeadSha from a fresh repository view', 409, 'AGGREGATE_EXPECTED_HEAD_REQUIRED');
  }
  return String(expectedHeadSha).toLowerCase();
}

export function destinationExistsError(target: string, parent?: string): HeadCheckError {
  return refusal(parent
    ? `${parent} is a file, so ${target} cannot be created under it.`
    : `${target} already exists. Choose another name, or delete it first.`, 409, 'DESTINATION_EXISTS');
}
