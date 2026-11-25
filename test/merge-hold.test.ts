import { expect, test } from "bun:test";
import { heldMergeRecord, mergeHolds, mergeHoldWords, snapshotHoldSessions } from "../shared/merge-hold";
import { decisionCount } from "../shared/decision-count";
import type { PullRequestItem } from "../shared/prs";
import { pullColumn } from "../shared/pull-judgments";
import type { SessionRow } from "../shared/contract";
import type { TrackedDecision } from "../shared/tracked-decisions";

const pr = (extra: Partial<PullRequestItem> = {}): PullRequestItem => ({
  repo: "org/example", number: 7, title: "Sample", url: "https://github.com/org/example/pull/7", headSha: "a".repeat(40),
  headRepo: "org/example", headBranch: "feat/sample", projectIds: ["project"], lane: "review", reason: "ready", gate: "judged",
  updatedAt: "2026-11-24T00:00:00Z", ...extra,
});
const onBranch = { kind: "branch" as const, repo: "org/example", branch: "feat/sample" };
const session = (running: boolean, extra: Record<string, unknown> = {}) => ({ id: "work", projectId: "project", running, workspacePull: onBranch, ...extra });
const key = "org/example#7";

test("a running work session on the PR branch keeps the merge card in project progress", () => {
  expect(mergeHolds([pr()], { sessions: [session(true)] }).get(key)).toBe("running");
});

test("an idle work session lets the merge card into My decisions", () => {
  expect(mergeHolds([pr()], { sessions: [session(false)] }).has(key)).toBe(false);
});

test("a session in another project or on another branch does not hold the PR", () => {
  expect(mergeHolds([pr()], { sessions: [session(true, { projectId: "other" })] }).has(key)).toBe(false);
  expect(mergeHolds([pr()], { sessions: [session(true, { workspacePull: { ...onBranch, branch: "feat/other" } })] }).has(key)).toBe(false);
});

test("the owner the coordinator named holds the PR while it runs, even without a matching workspace", () => {
  const owned = pr({ judgment: { verdict: "ready", reason: "Done", at: "2026-11-24T01:00:00.000Z", ownerSessionId: "owner" } });
  expect(mergeHolds([owned], { sessions: [session(true, { id: "owner", workspacePull: undefined })] }).get(key)).toBe("running");
  expect(mergeHolds([owned], { sessions: [session(false, { id: "owner", workspacePull: undefined })] }).has(key)).toBe(false);
});

const record = (extra: Partial<TrackedDecision> = {}) => ({
  kind: "merge" as const, mergeTarget: { repo: "org/example", number: 7 }, projectId: "project", sessionId: "ledger-work", ...extra,
}) as Pick<TrackedDecision, "kind" | "mergeTarget" | "projectId" | "sessionId" | "matchedSessionId">;

test("the work session a ledger merge card names holds the PR and the card", () => {
  const holds = mergeHolds([pr({ gate: "ledger" })], { sessions: [session(true, { id: "ledger-work", workspacePull: undefined })], records: [record()] });
  expect(holds.get(key)).toBe("running");
  expect(heldMergeRecord(record(), holds)).toBe(true);
  expect(heldMergeRecord(record({ kind: "check" }), holds)).toBe(false);
  expect(heldMergeRecord(record({ mergeTarget: { repo: "org/example", number: 8 } }), holds)).toBe(false);
});

test("a ledger card for another project does not lend its session to the PR", () => {
  const holds = mergeHolds([pr()], { sessions: [session(true, { id: "ledger-work", workspacePull: undefined })], records: [record({ projectId: "other" })] });
  expect(holds.has(key)).toBe(false);
});

test("a running session on another host holds the PR", () => {
  const peers = { rows: [session(true, { id: "remote" })], complete: true };
  expect(mergeHolds([pr()], { sessions: [], peers }).get(key)).toBe("running");
});

test("when another host could not be read, the card stays in My decisions with a warning", () => {
  expect(mergeHolds([pr()], { sessions: [], peers: { rows: [], complete: false } }).get(key)).toBe("unverified");
  // A session known to run still wins over the unknown host.
  expect(mergeHolds([pr()], { sessions: [session(true)], peers: { rows: [], complete: false } }).get(key)).toBe("running");
  expect(mergeHolds([pr()], { sessions: [], peers: { rows: [], complete: true } }).has(key)).toBe(false);
});

test("only PRs that would be merge cards are held", () => {
  expect(mergeHolds([pr({ lane: "progress", gate: "awaiting" })], { sessions: [session(true)] }).size).toBe(0);
  expect(mergeHolds([pr({ lane: "progress", reason: "checks-failed", gate: undefined })], { sessions: [session(true)] }).size).toBe(0);
});

test("the same rule applies when merge cards follow GitHub status only", () => {
  expect(mergeHolds([pr({ gate: "github" })], { sessions: [session(true)] }).get(key)).toBe("running");
});

test("the kanban and warning words come in both languages", () => {
  expect(mergeHoldWords.running).toEqual(["작업 세션 진행 중 · 끝나면 병합 카드로 올라옵니다", "Work session running · Moves to a merge card when it finishes"]);
  expect(mergeHoldWords.unverified[0]).toBe("작업 세션 상태를 확인하지 못했습니다.");
  expect(mergeHoldWords.unverified[1].length).toBeGreaterThan(0);
});

const row = (lane: SessionRow["lane"], extra: Partial<SessionRow> = {}) => ({
  id: "work", projectId: "project", title: "Work", lane, status: lane === "running" ? "running" : "idle", workspacePull: onBranch, ...extra,
}) as SessionRow;

test("snapshot rows map to running states", () => {
  expect(snapshotHoldSessions([row("running"), row("idle", { id: "rest" })]).map(s => s.running)).toEqual([true, false]);
});

test("the decision count leaves out PRs and ledger merge cards held by a running session", () => {
  const ledger = { key: "ledger", kind: "merge", mergeTarget: { repo: "org/example", number: 7 }, matchedPull: { repo: "org/example", number: 7 },
    projectId: "project", sessionId: "work" } as unknown as TrackedDecision;
  const pullRequests = { projects: [], items: [pr()] };
  expect(decisionCount({ sessions: [row("running")], notes: {}, pullRequests })).toBe(0);
  expect(decisionCount({ sessions: [row("idle")], notes: {}, pullRequests })).toBe(1);
  const trackedDecisions = { status: "ok", items: [ledger] } as never;
  expect(decisionCount({ sessions: [row("running")], notes: {}, pullRequests: { projects: [], items: [pr({ gate: "ledger" })] }, trackedDecisions })).toBe(0);
  expect(decisionCount({ sessions: [row("idle")], notes: {}, pullRequests: { projects: [], items: [pr({ gate: "ledger" })] }, trackedDecisions })).toBe(1);
});

test("a held PR row lands in the kanban's running column", () => {
  for (const gate of ["judged", "ledger", "github"] as const) expect(pullColumn({ ...pr({ gate }), lane: "progress" })).toBe("running");
});
