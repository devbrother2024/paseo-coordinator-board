import type { PullDetail, PullRequestItem, PullRequestView } from "./prs";
import type { TrackedDecision } from "./tracked-decisions";

export type MergeWaitReason = PullDetail | "unmapped" | "off";
// A ledger merge card whose PR GitHub has not confirmed ready. It waits in project progress as a PR row.
export type MergeWait = { pr: PullRequestItem } | { pr?: undefined; why: MergeWaitReason };
type MergeCard = Pick<TrackedDecision, "kind" | "mergeTarget" | "matchedPull" | "projectId">;

// null: the card belongs in My decisions. A ready PR, a PR no longer open (merged or closed, so
// its follow-up questions still need an answer), and boards without PR data keep their place.
export function waitingMergeCard(item: MergeCard, view: PullRequestView | undefined): MergeWait | null {
  const target = item.mergeTarget;
  if (!view || item.kind !== "merge" || !target || item.matchedPull) return null;
  const pr = view.items.find(p => p.repo === target.repo && p.number === target.number &&
    (item.projectId === null || p.projectIds.includes(item.projectId)));
  if (pr) return pr.reason === "ready" ? null : { pr };
  const sources = view.projects.filter(p => p.repo === target.repo && (item.projectId === null || p.projectId === item.projectId));
  if (sources.some(p => p.status === "ok" || p.status === "truncated")) return null;
  const failed = sources.find(p => p.status === "unavailable");
  if (failed) return { why: failed.failure ?? "lookup-failed" };
  const own = item.projectId === null ? undefined : view.projects.find(p => p.projectId === item.projectId);
  return { why: own?.status === "off" ? "off" : "unmapped" };
}

export const decidesNow = (item: MergeCard, view: PullRequestView | undefined) => waitingMergeCard(item, view) === null;
