import { expect, test } from "bun:test";
import { closedMergeTarget, ownKanbanEntry, settleMergeCards, settledKey, waitingMergeCard } from "../shared/merge-card-place";
import { decisionCount } from "../shared/decision-count";
import { trackedDecisionSchema } from "../shared/tracked-decisions";
import type { PullRequestItem, PullRequestView } from "../shared/prs";

const card = (overrides: Record<string, unknown> = {}) => trackedDecisionSchema.parse({
  source: "ledger", id: "merge", key: "ledger-merge", projectId: "studio", title: "Merge sample", kind: "merge",
  fingerprint: "a".repeat(64), matchedSessionId: null, matchedPull: null,
  mergeTarget: { repo: "example/app", number: 12 }, ...overrides,
});
const pull = (extra: Partial<PullRequestItem> = {}): PullRequestItem => ({
  repo: "example/app", number: 12, title: "Sample", url: "https://github.com/example/app/pull/12", projectIds: ["studio"],
  lane: "progress", reason: "checks-pending", updatedAt: "2026-11-25T00:00:00Z", ...extra,
});
const view = (items: PullRequestItem[], status: PullRequestView["projects"][number]["status"] = "ok", extra = {}): PullRequestView => ({
  items, projects: [{ projectId: "studio", repo: status === "unmapped" || status === "off" ? null : "example/app", mode: status === "off" ? "off" : "auto", status, ...extra }],
});

test("a merge card whose PR is not confirmed ready waits in project progress with its PR row", () => {
  const pr = pull({ reason: "computing" });
  expect(waitingMergeCard(card(), view([pr]))).toEqual({ pr });
  expect(waitingMergeCard(card(), view([pull({ reason: "unknown", detail: "gh-auth" })]))).toMatchObject({ pr: { detail: "gh-auth" } });
});

test("a merge card stays in My decisions once GitHub confirms the PR ready", () => {
  expect(waitingMergeCard(card({ matchedPull: { repo: "example/app", number: 12 } }), view([pull({ reason: "ready", lane: "review" })]))).toBeNull();
  expect(waitingMergeCard(card(), view([pull({ reason: "ready", lane: "review" })]))).toBeNull();
});

test("a merge card for a PR no longer open stays in My decisions until its merge or close is confirmed", () => {
  expect(waitingMergeCard(card(), view([]))).toBeNull();
  // Other kinds and boards without PR data are unaffected.
  expect(waitingMergeCard(card({ kind: "answer" }), view([pull()]))).toBeNull();
  expect(waitingMergeCard(card(), undefined)).toBeNull();
});

test("without a readable repository the card waits and says why", () => {
  expect(waitingMergeCard(card(), view([], "unavailable", { failure: "timeout" }))).toEqual({ why: "timeout" });
  expect(waitingMergeCard(card(), view([], "unavailable"))).toEqual({ why: "lookup-failed" });
  expect(waitingMergeCard(card(), view([], "unmapped"))).toEqual({ why: "unmapped" });
  expect(waitingMergeCard(card(), view([], "off"))).toEqual({ why: "off" });
});

test("the decision count leaves waiting merge cards out", () => {
  const items = [card(), card({ id: "other", key: "ledger-other", kind: "answer", mergeTarget: null })];
  const trackedDecisions = { items, status: "ok" as const };
  expect(decisionCount({ sessions: [], notes: {}, trackedDecisions, pullRequests: view([pull()]) })).toBe(1);
  const ready = view([pull({ reason: "ready", lane: "review" })]);
  const matched = { items: [card({ matchedPull: { repo: "example/app", number: 12 } }), items[1]], status: "ok" as const };
  expect(decisionCount({ sessions: [], notes: {}, trackedDecisions: matched, pullRequests: ready })).toBe(2);
});

test("a merge card whose PR merged or closed leaves My decisions; an unconfirmed one stays", () => {
  const merged = card();
  const closed = card({ id: "closed", key: "ledger-closed", mergeTarget: { repo: "example/app", number: 13 } });
  const unsure = card({ id: "unsure", key: "ledger-unsure", mergeTarget: { repo: "example/app", number: 14 } });
  const other = card({ id: "answer", key: "ledger-answer", kind: "answer", mergeTarget: null });
  const states = new Map([[settledKey("example/app", 12), { state: "MERGED" as const, at: "2026-11-25T01:00:00.000Z" }],
    [settledKey("example/app", 13), { state: "CLOSED" as const, at: "2026-11-25T02:00:00.000Z" }]]);
  const { items, settled } = settleMergeCards([merged, closed, unsure, other], view([]), states);
  expect(items.map(item => item.key)).toEqual(["ledger-unsure", "ledger-answer"]);
  expect(settled.map(({ item, state }) => [item.key, state])).toEqual([["ledger-merge", "MERGED"], ["ledger-closed", "CLOSED"]]);
  // The badge counts only what is left.
  expect(decisionCount({ sessions: [], notes: {}, trackedDecisions: { items, status: "ok" }, pullRequests: view([]) })).toBe(2);
  expect(decisionCount({ sessions: [], notes: {}, trackedDecisions: { items: [merged, closed, unsure, other], status: "ok" }, pullRequests: view([]) })).toBe(4);
});

test("only a PR missing from a fully read open list is a merge or close candidate", () => {
  expect(closedMergeTarget(card(), view([]))).toEqual({ repo: "example/app", number: 12, projectId: "studio" });
  expect(closedMergeTarget(card(), view([pull()]))).toBeNull();
  for (const status of ["unavailable", "truncated", "unmapped", "off"] as const) expect(closedMergeTarget(card(), view([], status))).toBeNull();
  expect(closedMergeTarget(card({ matchedPull: { repo: "example/app", number: 12 } }), view([]))).toBeNull();
});

test("a host-wide section counts only cards it shows: a merge card waiting as a PR row is not one of them", () => {
  const hostWide = [card({ projectId: null }), card({ id: "b", key: "ledger-b", projectId: null, mergeTarget: { repo: "example/app", number: 13 } })];
  const asRow = view([pull({ projectIds: ["studio"] })]);
  expect(hostWide.filter(item => ownKanbanEntry(waitingMergeCard(item, asRow))).map(item => item.key)).toEqual(["ledger-b"]);
  expect(ownKanbanEntry({ why: "unmapped" })).toBe(true);
  expect(ownKanbanEntry(null)).toBe(true);
});

test("review waits run on the settled list: a session named only by a merged card counts as uncovered", async () => {
  const { coveredSessionIds } = await import("../server/review-wait");
  const merged = card({ sessionId: "worker" });
  const states = new Map([[settledKey("example/app", 12), { state: "MERGED" as const, at: "2026-11-25T01:00:00.000Z" }]]);
  const { items } = settleMergeCards([merged], view([]), states);
  expect(coveredSessionIds([merged]).has("worker")).toBe(true);
  expect(coveredSessionIds(items).has("worker")).toBe(false);
});
