import type { MergePreview, MergeResult } from "../shared/prs";

// What the PR card does after the person pressed Confirm merge.
// reopen: the head is the one reviewed but details moved, or GitHub is still recomputing, so read a new preview right there.
// recheck: stop, and offer to check the latest state inside the same card.
export function afterConfirm(result: Pick<MergeResult, "status" | "reason">): "done" | "reopen" | "recheck" {
  if (result.status === "merged" || result.status === "already-merged") return "done";
  if (result.status === "changed" && result.reason === "outdated") return "reopen";
  // Right after another merge GitHub recomputes this PR. Wait a moment and read the preview again.
  if (result.status === "blocked" && result.reason === "computing") return "reopen";
  return "recheck";
}

export const reopenAttempts = 3;
export const reopenDelayMs = 3_000;
// After another merge GitHub can need a moment to recompute this PR. Wait a little, a few times.
export function afterReopen(preview: Pick<MergePreview, "status" | "reason" | "token" | "methods">, attempt: number): "show" | "wait" | "recheck" {
  if (preview.status === "ready" && preview.token && preview.methods.length) return "show";
  if (preview.status === "blocked" && preview.reason === "computing" && attempt + 1 < reopenAttempts) return "wait";
  return "recheck";
}

// The line shown above a preview the board read again on its own.
export function reopenedWords(previousBase: string | undefined, nextBase: string): readonly [string, string] {
  return previousBase && previousBase !== nextBase
    ? ["다른 병합으로 기준이 바뀌어 다시 확인했습니다.", "Another merge moved the base, so the board checked again."]
    : ["병합 정보가 바뀌어 다시 확인했습니다.", "Merge details changed, so the board checked again."];
}

// A merge on the board tells other open previews for the same repository to read again.
type Listener = (repo: string, number: number) => void;
const listeners = new Set<Listener>();
export function onBoardMerge(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function announceBoardMerge(repo: string, number: number) {
  for (const listener of [...listeners]) listener(repo, number);
}

export type ReopenOutcome =
  | { kind: "show"; preview: MergePreview; words: readonly [string, string] }
  | { kind: "stop"; preview: MergePreview }
  | { kind: "gone" };
type ReopenDeps = { read: () => Promise<MergePreview>; delay: (ms: number) => Promise<void>; alive: () => boolean };

// Read the merge preview again after a confirmation stopped on moved details. GitHub may still be
// recomputing, so wait a little a few times. It never merges; the person presses Confirm merge again.
// gone: the card went away while waiting. A failed read rejects, and the card shows the lookup error.
export async function reopenPreview(deps: ReopenDeps, previousBase: string | undefined): Promise<ReopenOutcome> {
  for (let attempt = 0; ; attempt++) {
    const preview = await deps.read();
    if (!deps.alive()) return { kind: "gone" };
    const step = afterReopen(preview, attempt);
    if (step === "show") return { kind: "show", preview, words: reopenedWords(previousBase, preview.baseSha) };
    if (step === "recheck") return { kind: "stop", preview };
    await deps.delay(reopenDelayMs);
    if (!deps.alive()) return { kind: "gone" };
  }
}

// Another PR merged on the board. An open preview of a different PR in the same repository reads again,
// unless the card is already busy.
export function reopensAfterMerge(merged: { repo: string; number: number }, card: { repo: string; number: number },
  previewOpen: boolean, busy: boolean) {
  return merged.repo === card.repo && merged.number !== card.number && previewOpen && !busy;
}
