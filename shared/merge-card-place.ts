import type { PullDetail, PullRequestItem, PullRequestView } from "./prs";
import { pullKey, type TrackedDecision } from "./tracked-decisions";
import { heldMergeRecord, type MergeHold } from "./merge-hold";

export type MergeWaitReason = PullDetail | "unmapped" | "off";
// A ledger merge card whose PR GitHub has not confirmed ready. It waits in project progress as a PR row.
export type MergeWait = { pr: PullRequestItem } | { pr?: undefined; why: MergeWaitReason };
type MergeCard = Pick<TrackedDecision, "kind" | "mergeTarget" | "matchedPull" | "projectId">;

// null: the card belongs in My decisions. A ready PR, a PR no longer open whose merge or close the
// board has not confirmed yet (settleMergeCards moves confirmed ones out first), and boards without PR data keep their place.
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

type Holds = ReadonlyMap<string, MergeHold>;
const noHolds: Holds = new Map();

// Whether a ledger card is in My decisions now: its PR is not waiting on GitHub, and no work session runs on its branch.
export const decidesNow = (item: MergeCard, view: PullRequestView | undefined, holds: Holds = noHolds) =>
  !heldMergeRecord(item, holds) && waitingMergeCard(item, view) === null;

// Whether a merge-ready PR row is in My decisions now. A work session running on its branch keeps it in project progress.
export const pullDecidesNow = (pr: Pick<PullRequestItem, "repo" | "number" | "lane">, holds: Holds = noHolds) =>
  pr.lane === "review" && holds.get(pullKey(pr.repo, pr.number)) !== "running";

// One placement for the board screen and the decision count. held cards show as their PR row in the kanban;
// waiting cards show there too, or as a small row when the board could not read their PR.
export function placeMergeCards<T extends MergeCard & Pick<TrackedDecision, "key">>(items: readonly T[], view: PullRequestView | undefined, holds: Holds = noHolds) {
  const deciding: T[] = [];
  const waiting = new Map<string, MergeWait>();
  const held = new Set<string>();
  for (const item of items) {
    if (heldMergeRecord(item, holds)) { held.add(item.key); continue; }
    const wait = waitingMergeCard(item, view);
    if (wait) waiting.set(item.key, wait);
    else deciding.push(item);
  }
  return { deciding, waiting, held };
}

export type SettledState = { state: "MERGED" | "CLOSED"; at: string };
type SettleCard = MergeCard & Pick<TrackedDecision, "key">;

// A ledger merge card whose PR left the open list of a repository the board read in full.
// Whether it merged or closed still has to be confirmed before the card moves.
export function closedMergeTarget(item: MergeCard, view: PullRequestView | undefined) {
  const target = item.mergeTarget;
  if (!view || item.kind !== "merge" || !target || item.matchedPull) return null;
  if (view.items.some(p => p.repo === target.repo && p.number === target.number)) return null;
  const source = view.projects.find(p => p.repo === target.repo && p.status === "ok" &&
    (item.projectId === null || p.projectId === item.projectId));
  return source ? { repo: target.repo, number: target.number, projectId: source.projectId } : null;
}

// Cards whose PR is confirmed merged or closed leave My decisions. The ledger file stays as it is;
// the coordinator still clears it. Unconfirmed cards keep their place.
export function settleMergeCards<T extends SettleCard>(items: readonly T[], view: PullRequestView | undefined,
  states: ReadonlyMap<string, SettledState>) {
  const kept: T[] = [];
  const settled: { item: T; repo: string; number: number; state: SettledState["state"]; at: string }[] = [];
  for (const item of items) {
    const target = closedMergeTarget(item, view);
    const found = target && states.get(settledKey(target.repo, target.number));
    if (target && found) settled.push({ item, repo: target.repo, number: target.number, ...found });
    else kept.push(item);
  }
  return { items: kept, settled };
}

export const settledKey = (repo: string, number: number) => repo + "#" + number;

// Whether a ledger card takes a place of its own in the kanban. A merge card waiting with a PR row
// shows as that row in its project, so it does not count toward a section (such as Host-wide) by itself.
export const ownKanbanEntry = (wait: MergeWait | null | undefined) => !wait || !wait.pr;
