// What a merge card's change request draft is bound to, and how its request key is kept across retries.
export type RetryKey = { signature: string; key: string };
// The state after a request went out: the next send, even with the same words, starts a new request.
export const finishedRetry: RetryKey = { signature: "", key: "" };

export function changeSignature(pr: { repo: string; number: number }, headSha: string, recipientId: string, text: string, photoIds: readonly number[]) {
  return JSON.stringify([pr.repo, pr.number, headSha, recipientId, text, photoIds]);
}

// Pressing send again with the same words, photos and target only checks the earlier attempt, so it keeps its key.
// Anything else is a new request.
export function changeRequestKey(previous: RetryKey, signature: string, mint: () => string): RetryKey {
  return previous.signature === signature ? previous : { signature, key: mint() };
}

// The commit and recipient a draft is written for. Empty when the card has no head or nobody to send to.
export const changeTargetKey = (headSha: string | undefined, recipientId: string | null | undefined) =>
  headSha && recipientId ? JSON.stringify([headSha, recipientId]) : "";

// A draft belongs to the commit and recipient on screen when it was written. Without a draft the card follows the PR.
// With one, a new head or recipient holds the send button until the person has looked at the change.
export function changeDraftTarget(confirmed: string, current: string, hasDraft: boolean) {
  return hasDraft ? { basis: confirmed, changed: confirmed !== current } : { basis: current, changed: false };
}

// The folded card of one sent request. Its request key keeps a second request about the same head, sent after the merge
// card was reopened, from being taken for the first.
export const changeReceiptKey = (pr: { repo: string; number: number }, headSha: string, requestKey: string) =>
  JSON.stringify(["change", pr.repo, pr.number, headSha, requestKey]);

type QueuedPull = { repo: string; number: number; changeQueueHead?: string; changeProjectId?: string };
// What the cancel, parallel and resume controls of a waiting request name: the project and head it was recorded under.
// Two managed projects can open the same repository, so the project the row is drawn for is only a stand-in.
export function changeQueueCard(pr: QueuedPull, drawnProjectId: string) {
  const projectId = pr.changeProjectId ?? drawnProjectId;
  if (!pr.changeQueueHead || !projectId) return null;
  return { kind: "pull" as const, projectId, repo: pr.repo, number: pr.number, headSha: pr.changeQueueHead };
}
