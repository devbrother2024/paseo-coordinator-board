import { expect, test } from "bun:test";
import { afterConfirm, afterReopen, announceBoardMerge, onBoardMerge, reopenAttempts, reopenDelayMs, reopenedWords, reopenPreview, reopensAfterMerge } from "../client/merge-flow";
import type { MergePreview } from "../shared/prs";

const preview = (extra = {}) => ({ status: "ready" as const, reason: "ready" as const, token: "00000000-0000-4000-8000-000000000000", methods: ["squash" as const], ...extra });

test("an outdated confirmation reopens the preview; a moved head or other stop offers a recheck", () => {
  expect(afterConfirm({ status: "changed", reason: "outdated" })).toBe("reopen");
  expect(afterConfirm({ status: "changed", reason: "changed" })).toBe("recheck");
  expect(afterConfirm({ status: "changed", reason: "expired" })).toBe("recheck");
  expect(afterConfirm({ status: "blocked", reason: "computing" })).toBe("reopen");
  expect(afterConfirm({ status: "blocked", reason: "conflict" })).toBe("recheck");
  expect(afterConfirm({ status: "unconfirmed", reason: "unconfirmed" })).toBe("recheck");
  expect(afterConfirm({ status: "merged", reason: "merged" })).toBe("done");
});

test("a reopened preview shows only when it is ready, and waits a few times while GitHub recomputes", () => {
  expect(afterReopen(preview(), 0)).toBe("show");
  const computing = preview({ status: "blocked", reason: "computing", token: null, methods: [] });
  expect(afterReopen(computing, 0)).toBe("wait");
  expect(afterReopen(computing, reopenAttempts - 1)).toBe("recheck");
  expect(afterReopen(preview({ status: "blocked", reason: "changed", token: null }), 0)).toBe("recheck");
  expect(afterReopen(preview({ methods: [] }), 0)).toBe("recheck");
});

test("the reopened line says when another merge moved the base", () => {
  expect(reopenedWords("a".repeat(40), "b".repeat(40))[0]).toBe("다른 병합으로 기준이 바뀌어 다시 확인했습니다.");
  expect(reopenedWords("a".repeat(40), "a".repeat(40))[1]).toBe("Merge details changed, so the board checked again.");
});

test("a board merge reaches every open listener until it unsubscribes", () => {
  const heard: string[] = [];
  const stop = onBoardMerge((repo, number) => heard.push(repo + "#" + number));
  announceBoardMerge("example/app", 3);
  stop();
  announceBoardMerge("example/app", 4);
  expect(heard).toEqual(["example/app#3"]);
});

const full = (extra: Partial<MergePreview> = {}): MergePreview => ({ status: "ready", reason: "ready", title: "Sample", headSha: "a".repeat(40),
  headRef: "topic", baseRef: "main", baseSha: "c".repeat(40), checks: 1, methods: ["squash"], defaultMethod: "squash",
  token: "00000000-0000-4000-8000-000000000000", ...extra });
const computing = full({ status: "blocked", reason: "computing", token: null, methods: [] });
function deps(previews: MergePreview[], alive = () => true) {
  const log = { reads: 0, delays: [] as number[] };
  return { log, deps: { read: async () => { log.reads++; return previews.shift()!; }, delay: async (ms: number) => { log.delays.push(ms); }, alive } };
}

test("the consecutive-merge reread waits while GitHub recomputes, then shows the new preview without merging", async () => {
  const { log, deps: d } = deps([computing, computing, full()]);
  const outcome = await reopenPreview(d, "b".repeat(40));
  expect(outcome).toMatchObject({ kind: "show", preview: { baseSha: "c".repeat(40) } });
  if (outcome.kind === "show") expect(outcome.words[0]).toBe("다른 병합으로 기준이 바뀌어 다시 확인했습니다.");
  expect(log).toEqual({ reads: 3, delays: [reopenDelayMs, reopenDelayMs] });
});

test("the reread stops after its attempts, on any other stop, and when the card goes away", async () => {
  const exhausted = deps(Array.from({ length: reopenAttempts + 2 }, () => computing));
  expect(await reopenPreview(exhausted.deps, undefined)).toMatchObject({ kind: "stop", preview: { reason: "computing" } });
  expect(exhausted.log.reads).toBe(reopenAttempts);
  const changed = deps([full({ status: "blocked", reason: "changed", token: null })]);
  expect(await reopenPreview(changed.deps, undefined)).toMatchObject({ kind: "stop", preview: { reason: "changed" } });
  let open = true;
  const leaving = deps([computing, full()], () => open);
  leaving.deps.delay = async () => { open = false; };
  expect(await reopenPreview(leaving.deps, undefined)).toEqual({ kind: "gone" });
  expect(leaving.log.reads).toBe(1);
  const failing = { read: async () => { throw Error("offline"); }, delay: async () => {}, alive: () => true };
  await expect(reopenPreview(failing, undefined)).rejects.toThrow("offline");
});

test("only an open, idle preview of another PR in the same repository rereads after a board merge", () => {
  const card = { repo: "example/app", number: 2 };
  expect(reopensAfterMerge({ repo: "example/app", number: 1 }, card, true, false)).toBe(true);
  expect(reopensAfterMerge({ repo: "example/app", number: 2 }, card, true, false)).toBe(false);
  expect(reopensAfterMerge({ repo: "example/other", number: 1 }, card, true, false)).toBe(false);
  expect(reopensAfterMerge({ repo: "example/app", number: 1 }, card, false, false)).toBe(false);
  expect(reopensAfterMerge({ repo: "example/app", number: 1 }, card, true, true)).toBe(false);
});
