import { expect, test } from "bun:test";
import { changeDraftTarget, changeQueueCard, changeReceiptKey, changeRequestKey, changeSignature, changeTargetKey, finishedRetry } from "../client/change-request-draft";

const head = "a".repeat(40), newer = "b".repeat(40);
const pr = { repo: "org/example", number: 7 };

test("an unchanged retry keeps its key, and an edited draft or another target gets a new one", () => {
  let minted = 0;
  const mint = () => "change-key-" + ++minted;
  const signature = changeSignature(pr, head, "worker-1", "Keep the old flag", [1]);
  const first = changeRequestKey(finishedRetry, signature, mint);
  expect(first).toEqual({ signature, key: "change-key-1" });
  // Pressing again with the same words, photos and target checks the earlier attempt under the same key.
  expect(changeRequestKey(first, changeSignature(pr, head, "worker-1", "Keep the old flag", [1]), mint)).toBe(first);
  expect(minted).toBe(1);
  // Other words, other photos, another commit or another recipient are each a new request.
  for (const other of [
    changeSignature(pr, head, "worker-1", "Keep the old flag, please", [1]),
    changeSignature(pr, head, "worker-1", "Keep the old flag", [1, 2]),
    changeSignature(pr, newer, "worker-1", "Keep the old flag", [1]),
    changeSignature(pr, head, "coord", "Keep the old flag", [1]),
    changeSignature({ repo: "org/example", number: 8 }, head, "worker-1", "Keep the old flag", [1]),
  ]) expect(changeRequestKey(first, other, mint).key).not.toBe(first.key);
  // After a request went out, the same words sent again (the card was reopened) start over.
  expect(changeRequestKey(finishedRetry, signature, mint).key).not.toBe(first.key);
});

test("a draft written for one commit and recipient waits for a look when either changes", () => {
  const written = changeTargetKey(head, "worker-1");
  // Nothing written yet: the card simply follows the PR.
  expect(changeDraftTarget(written, changeTargetKey(newer, "worker-1"), false)).toEqual({ basis: changeTargetKey(newer, "worker-1"), changed: false });
  // With a draft, a new head or a new recipient holds the send button until the person confirms.
  expect(changeDraftTarget(written, written, true)).toEqual({ basis: written, changed: false });
  expect(changeDraftTarget(written, changeTargetKey(newer, "worker-1"), true)).toEqual({ basis: written, changed: true });
  expect(changeDraftTarget(written, changeTargetKey(head, "coord"), true)).toEqual({ basis: written, changed: true });
  // A card that lost its head or recipient has no target to send to.
  expect(changeTargetKey(undefined, "worker-1")).toBe("");
  expect(changeTargetKey(head, null)).toBe("");
  expect(changeDraftTarget(written, "", true).changed).toBe(true);
});

test("each change request leaves its own folded card, also when sent again about the same head", () => {
  const first = changeReceiptKey(pr, head, "change-key-1");
  // Sent, the merge card reopened, then sent again about the same head: a second request, so a second card.
  expect(changeReceiptKey(pr, head, "change-key-2")).not.toBe(first);
  expect(changeReceiptKey(pr, head, "change-key-1")).toBe(first);
  expect(changeReceiptKey(pr, newer, "change-key-1")).not.toBe(first);
  expect(changeReceiptKey({ repo: "org/example", number: 8 }, head, "change-key-1")).not.toBe(first);
});

test("the controls of a waiting request name the project and head it was recorded under", () => {
  // Two managed projects can open the same repository. The row may be drawn for either, but the request belongs to one.
  const waiting = { repo: "org/example", number: 7, headSha: newer, changeQueueHead: head, changeProjectId: "alpha" };
  expect(changeQueueCard(waiting, "beta")).toEqual({ kind: "pull", projectId: "alpha", repo: "org/example", number: 7, headSha: head });
  // Without a recorded project (an older board) the drawn project stands in.
  expect(changeQueueCard({ ...waiting, changeProjectId: undefined }, "beta")?.projectId).toBe("beta");
  // No waiting request, or nothing to name the project by: no controls.
  expect(changeQueueCard({ repo: "org/example", number: 7, headSha: head }, "beta")).toBeNull();
  expect(changeQueueCard({ ...waiting, changeProjectId: undefined }, "")).toBeNull();
});
