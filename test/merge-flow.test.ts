import { expect, test } from "bun:test";
import { afterConfirm, afterReopen, announceBoardMerge, onBoardMerge, reopenAttempts, reopenedWords } from "../client/merge-flow";

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
