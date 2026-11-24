import { expect, test } from "bun:test";
import { applyPullJudgments, needsRunningConfirmation, ownerRunning, prunePullJudgments, pullColumn, pullJudgmentKey, pullStatusWords, type PullJudgment } from "../shared/pull-judgments";
import type { PullRequestItem } from "../shared/prs";

const head = "a".repeat(40);
const newer = "b".repeat(40);
const pr = (extra: Partial<PullRequestItem> = {}): PullRequestItem => ({
  repo: "org/example", number: 7, title: "Sample", url: "https://github.com/org/example/pull/7",
  headSha: head, projectIds: ["project"], lane: "review", reason: "ready", updatedAt: "2026-11-24T00:00:00Z", ...extra,
});
const judged = (verdict: PullJudgment["verdict"], extra: Partial<PullJudgment> = {}): Record<string, PullJudgment> => ({
  [pullJudgmentKey("org/example", 7)]: {
    repo: "org/example", number: 7, headSha: head, verdict, reason: "Review comments remain", at: "2026-11-24T01:00:00.000Z",
    coordinator: "coordinator", ...extra,
  },
});
const none = new Set<string>();

test("GitHub-ready PR without a coordinator verdict stays in project progress", () => {
  const [item] = applyPullJudgments([pr()], { enabled: true, judgments: {}, ledgerPulls: none });
  expect(item.lane).toBe("progress");
  expect(item.gate).toBe("awaiting");
  expect(pullStatusWords(item)[0]).toContain("코디네이터 판단 대기");
  expect(pullColumn(item)).toBe("running");
});

test("a ready verdict on the current head raises the merge card", () => {
  const [item] = applyPullJudgments([pr()], { enabled: true, judgments: judged("ready"), ledgerPulls: none });
  expect(item.lane).toBe("review");
  expect(item.gate).toBe("judged");
  expect(item.judgment?.verdict).toBe("ready");
  expect(pullColumn(item)).toBe("human");
});

test("needs-changes and blocked show the coordinator's reason", () => {
  const [changes] = applyPullJudgments([pr()], { enabled: true, judgments: judged("needs-changes"), ledgerPulls: none });
  expect(changes.lane).toBe("progress");
  expect(pullStatusWords(changes)).toEqual(["수정 필요: Review comments remain", "Needs changes: Review comments remain"]);
  expect(pullColumn(changes)).toBe("review");
  const [blocked] = applyPullJudgments([pr()], { enabled: true, judgments: judged("blocked", { reason: "Waiting\non  release" }), ledgerPulls: none });
  expect(pullStatusWords(blocked)[1]).toBe("Blocked: Waiting on release");
  const [working] = applyPullJudgments([pr()], { enabled: true, judgments: judged("in-progress"), ledgerPulls: none });
  expect(working.lane).toBe("progress");
  expect(pullStatusWords(working)[0]).toBe("작업 중");
  expect(pullColumn(working)).toBe("running");
});

test("a verdict on an older head expires when new commits arrive", () => {
  const [item] = applyPullJudgments([pr({ headSha: newer })], { enabled: true, judgments: judged("ready"), ledgerPulls: none });
  expect(item.lane).toBe("progress");
  expect(item.gate).toBe("stale");
  expect(item.judgment).toBeUndefined();
  expect(pullStatusWords(item)[0]).toBe("새 커밋, 다시 확인 필요");
  const [unknownHead] = applyPullJudgments([pr({ headSha: undefined })], { enabled: true, judgments: judged("ready"), ledgerPulls: none });
  expect(unknownHead.gate).toBe("stale");
});

test("a coordinator ledger merge card counts as the coordinator's judgment", () => {
  const ledger = new Set([pullJudgmentKey("org/example", 7)]);
  const [item] = applyPullJudgments([pr()], { enabled: true, judgments: {}, ledgerPulls: ledger });
  expect(item.lane).toBe("review");
  expect(item.gate).toBe("ledger");
  // A stale verdict does not hide a ledger card, a current non-ready verdict does.
  expect(applyPullJudgments([pr({ headSha: newer })], { enabled: true, judgments: judged("ready"), ledgerPulls: ledger })[0].gate).toBe("ledger");
  expect(applyPullJudgments([pr()], { enabled: true, judgments: judged("needs-changes"), ledgerPulls: ledger })[0].lane).toBe("progress");
});

test("turning the setting off restores GitHub-only merge cards", () => {
  const [item] = applyPullJudgments([pr()], { enabled: false, judgments: judged("needs-changes"), ledgerPulls: none });
  expect(item.lane).toBe("review");
  expect(item.gate).toBe("github");
  expect(pullStatusWords(item)[0]).toBe("병합 검토 가능");
});

test("PRs GitHub does not consider ready keep their GitHub status", () => {
  const [item] = applyPullJudgments([pr({ reason: "checks-pending", lane: "progress" })], { enabled: true, judgments: judged("ready"), ledgerPulls: none });
  expect(item.lane).toBe("progress");
  expect(item.gate).toBeUndefined();
  expect(pullStatusWords(item)[0]).toBe("검사 중");
  // A forged lane from an earlier pass is never trusted.
  const [draft] = applyPullJudgments([pr({ reason: "draft", lane: "review", gate: "judged" })], { enabled: false, judgments: {}, ledgerPulls: none });
  expect(draft.lane).toBe("progress");
  expect(draft.gate).toBeUndefined();
});

test("a running work session or owner asks for one more confirmation", () => {
  expect(needsRunningConfirmation([{ running: false }, { running: true }])).toBe(true);
  expect(needsRunningConfirmation([{ running: false }])).toBe(false);
  expect(needsRunningConfirmation([])).toBe(false);
  const [item] = applyPullJudgments([pr()], { enabled: true, judgments: judged("ready", { ownerSessionId: "worker" }), ledgerPulls: none });
  expect(ownerRunning(item, [{ id: "worker", lane: "running" }])).toBe(true);
  expect(ownerRunning(item, [{ id: "worker", lane: "idle" }])).toBe(false);
  expect(ownerRunning(pr(), [{ id: "worker", lane: "running" }])).toBe(false);
});

test("the judgment store keeps the newest entries", () => {
  const many: Record<string, PullJudgment> = {};
  for (let i = 1; i <= 5; i++) many["org/example#" + i] = { ...judged("ready")["org/example#7"], number: i, at: `2026-11-24T0${i}:00:00.000Z` };
  expect(Object.keys(prunePullJudgments(many, 3)).sort()).toEqual(["org/example#3", "org/example#4", "org/example#5"]);
  expect(prunePullJudgments(many, 10)).toBe(many);
});
