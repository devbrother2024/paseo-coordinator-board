import { expect, test } from "bun:test";
import { waitingMergeCard } from "../shared/merge-card-place";
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

test("a merge card for a PR that is no longer open keeps its follow-up questions in My decisions", () => {
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
