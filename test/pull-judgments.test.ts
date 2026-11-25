import { expect, test } from "bun:test";
import { applyPullJudgments, needsRunningConfirmation, ownerRunning, prunePullJudgments, pullColumn, pullJudgmentKey, pullStatusWords, unknownStatusWords, type PullJudgment } from "../shared/pull-judgments";
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
const on = { enabled: true, coordinator: true };

test("GitHub-ready PR without a coordinator verdict stays in project progress", () => {
  const [item] = applyPullJudgments([pr()], { ...on, judgments: {}, ledgerPulls: none });
  expect(item.lane).toBe("progress");
  expect(item.gate).toBe("awaiting");
  expect(pullStatusWords(item)[0]).toContain("코디네이터 판단 대기");
  expect(pullColumn(item)).toBe("running");
});

test("a ready verdict on the current head raises the merge card", () => {
  const [item] = applyPullJudgments([pr()], { ...on, judgments: judged("ready"), ledgerPulls: none });
  expect(item.lane).toBe("review");
  expect(item.gate).toBe("judged");
  expect(item.judgment?.verdict).toBe("ready");
  expect(pullColumn(item)).toBe("human");
});

test("needs-changes and blocked show the coordinator's reason", () => {
  const [changes] = applyPullJudgments([pr()], { ...on, judgments: judged("needs-changes"), ledgerPulls: none });
  expect(changes.lane).toBe("progress");
  expect(pullStatusWords(changes)).toEqual(["수정 필요: Review comments remain", "Needs changes: Review comments remain"]);
  expect(pullColumn(changes)).toBe("review");
  const [blocked] = applyPullJudgments([pr()], { ...on, judgments: judged("blocked", { reason: "Waiting\non  release" }), ledgerPulls: none });
  expect(pullStatusWords(blocked)[1]).toBe("Blocked: Waiting on release");
  const [working] = applyPullJudgments([pr()], { ...on, judgments: judged("in-progress"), ledgerPulls: none });
  expect(working.lane).toBe("progress");
  expect(pullStatusWords(working)[0]).toBe("작업 중");
  expect(pullColumn(working)).toBe("running");
});

test("a verdict on an older head expires when new commits arrive", () => {
  const [item] = applyPullJudgments([pr({ headSha: newer })], { ...on, judgments: judged("ready"), ledgerPulls: none });
  expect(item.lane).toBe("progress");
  expect(item.gate).toBe("stale");
  expect(item.judgment).toBeUndefined();
  expect(pullStatusWords(item)[0]).toBe("새 커밋, 다시 확인 필요");
  const [unknownHead] = applyPullJudgments([pr({ headSha: undefined })], { ...on, judgments: judged("ready"), ledgerPulls: none });
  expect(unknownHead.gate).toBe("stale");
});

test("a coordinator ledger merge card counts as the coordinator's judgment", () => {
  const ledger = new Set([pullJudgmentKey("org/example", 7)]);
  const [item] = applyPullJudgments([pr()], { ...on, judgments: {}, ledgerPulls: ledger });
  expect(item.lane).toBe("review");
  expect(item.gate).toBe("ledger");
  // The ledger card is bound to the head too: a verdict on an earlier head asks for another check,
  // and a current non-ready verdict wins.
  const [stale] = applyPullJudgments([pr({ headSha: newer })], { ...on, judgments: judged("ready"), ledgerPulls: ledger });
  expect(stale.lane).toBe("progress");
  expect(stale.gate).toBe("stale");
  for (const verdict of ["needs-changes", "in-progress", "blocked"] as const) {
    const [item] = applyPullJudgments([pr()], { ...on, judgments: judged(verdict), ledgerPulls: ledger });
    expect(item.lane).toBe("progress");
    expect(item.gate).toBe(verdict);
  }
  expect(applyPullJudgments([pr()], { ...on, judgments: judged("ready"), ledgerPulls: ledger })[0].gate).toBe("judged");
});

test("turning the setting off restores GitHub-only merge cards", () => {
  const [item] = applyPullJudgments([pr()], { ...on, enabled: false, judgments: judged("needs-changes"), ledgerPulls: none });
  expect(item.lane).toBe("review");
  expect(item.gate).toBe("github");
  expect(pullStatusWords(item)[0]).toBe("병합 검토 가능");
});

test("PRs GitHub does not consider ready keep their GitHub status", () => {
  const [item] = applyPullJudgments([pr({ reason: "checks-pending", lane: "progress" })], { ...on, judgments: judged("ready"), ledgerPulls: none });
  expect(item.lane).toBe("progress");
  expect(item.gate).toBeUndefined();
  expect(pullStatusWords(item)[0]).toBe("검사 중");
  // A forged lane from an earlier pass is never trusted.
  const [draft] = applyPullJudgments([pr({ reason: "draft", lane: "review", gate: "judged" })], { ...on, enabled: false, judgments: {}, ledgerPulls: none });
  expect(draft.lane).toBe("progress");
  expect(draft.gate).toBeUndefined();
});

test("a running work session or owner asks for one more confirmation", () => {
  expect(needsRunningConfirmation([{ running: false }, { running: true }])).toBe(true);
  expect(needsRunningConfirmation([{ running: false }])).toBe(false);
  expect(needsRunningConfirmation([])).toBe(false);
  const [item] = applyPullJudgments([pr()], { ...on, judgments: judged("ready", { ownerSessionId: "worker" }), ledgerPulls: none });
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

test("without a coordinator GitHub decides, but a current non-ready verdict still holds the PR", () => {
  const off = { enabled: true, coordinator: false };
  expect(applyPullJudgments([pr()], { ...off, judgments: {}, ledgerPulls: none })[0]).toMatchObject({ lane: "review", gate: "github" });
  expect(applyPullJudgments([pr({ headSha: newer })], { ...off, judgments: judged("needs-changes"), ledgerPulls: none })[0].gate).toBe("github");
  for (const verdict of ["needs-changes", "in-progress", "blocked"] as const) {
    expect(applyPullJudgments([pr()], { ...off, judgments: judged(verdict), ledgerPulls: none })[0]).toMatchObject({ lane: "progress", gate: verdict });
  }
  expect(applyPullJudgments([pr()], { ...off, judgments: judged("ready"), ledgerPulls: none })[0]).toMatchObject({ lane: "review", gate: "judged" });
  // Turning the setting off is the only way to ignore a current verdict.
  expect(applyPullJudgments([pr()], { enabled: false, coordinator: false, judgments: judged("blocked"), ledgerPulls: none })[0].gate).toBe("github");
});

test("each GitHub state has its own words, and status unknown is kept for lookups that failed", () => {
  expect(pullStatusWords(pr({ reason: "computing", lane: "progress" }))).toEqual(["GitHub이 병합 가능 여부를 계산 중", "GitHub is still checking whether it can merge"]);
  expect(pullStatusWords(pr({ reason: "review-required", lane: "progress" }))).toEqual(["리뷰 필요", "Review required"]);
  expect(pullStatusWords(pr({ reason: "checks-pending", lane: "progress" }))[0]).toBe("검사 중");
  expect(pullStatusWords(pr({ reason: "blocked", lane: "progress" }))[0]).toBe("병합 조건 대기");
  expect(pullStatusWords(pr({ reason: "unknown", lane: "progress" }))[0]).toBe("상태 미확인");
  expect(pullStatusWords(pr({ reason: "unknown", lane: "progress", detail: "gh-auth" }))).toEqual(["상태 미확인: 호스트의 gh 로그인 필요", "Status unknown: gh on the host needs to sign in"]);
  expect(unknownStatusWords("unmapped")).toEqual(["상태 미확인: 저장소 연결 없음", "Status unknown: No repository linked"]);
  expect(pullColumn(pr({ reason: "computing", lane: "progress" }))).toBe("running");
  expect(pullColumn(pr({ reason: "review-required", lane: "progress" }))).toBe("review");
});

test("a verified remote owner's host is carried to the PR row", () => {
  const [item] = applyPullJudgments([pr()], { ...on, judgments: judged("ready", { ownerSessionId: "far", ownerSessionHost: "peer-a" }), ledgerPulls: none });
  expect(item.judgment).toMatchObject({ ownerSessionId: "far", ownerSessionHost: "peer-a" });
});
