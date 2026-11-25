import type { SessionRow } from "./contract";
import type { PullRequestItem } from "./prs";
import { pullKey, type TrackedDecision } from "./tracked-decisions";
import { matchesWorkspace, type WorkspacePull } from "./workspace-pull";

// running: a work session on the PR is still running, so the merge card waits in project progress.
// unverified: the board could not read every host, so the card stays in My decisions with a warning.
export type MergeHold = "running" | "unverified";
export type HoldSession = { id: string; projectId: string; running: boolean; workspacePull?: WorkspacePull };
type HoldRecord = Pick<TrackedDecision, "kind" | "mergeTarget" | "projectId" | "sessionId" | "matchedSessionId">;
type HoldPull = Pick<PullRequestItem, "repo" | "number" | "projectIds" | "lane" | "headRepo" | "headBranch" | "judgment">;
export type HoldInput = {
  // Sessions in the board snapshot: this host's and those assigned to another host.
  sessions: readonly HoldSession[];
  // Running sessions read from other hosts. complete is false while a host is loading or failed.
  peers?: { rows: readonly HoldSession[]; complete: boolean };
  // Coordinator ledger cards. A merge card names the work session behind its PR.
  records?: readonly HoldRecord[];
};

export const mergeHoldWords = {
  running: ["작업 세션 진행 중 · 끝나면 병합 카드로 올라옵니다", "Work session running · Moves to a merge card when it finishes"],
  unverified: ["작업 세션 상태를 확인하지 못했습니다.", "Could not check whether a work session is still running."],
} as const satisfies Record<MergeHold, readonly [string, string]>;

export const snapshotHoldSessions = (rows: readonly Pick<SessionRow, "id" | "projectId" | "lane" | "workspacePull">[]): HoldSession[] =>
  rows.map(row => ({ id: row.id, projectId: row.projectId, running: row.lane === "running", ...(row.workspacePull ? { workspacePull: row.workspacePull } : {}) }));

const targets = (record: HoldRecord, pr: HoldPull) => record.kind === "merge" && record.mergeTarget?.repo === pr.repo &&
  record.mergeTarget.number === pr.number && (record.projectId === null || pr.projectIds.includes(record.projectId));

// Which PRs that would be merge cards wait instead. The setting that limits merge cards to coordinator-checked
// PRs does not matter here: a PR still being changed is not ready to merge either way.
export function mergeHolds(prs: readonly HoldPull[], input: HoldInput): Map<string, MergeHold> {
  const holds = new Map<string, MergeHold>();
  const all = [...input.sessions, ...input.peers?.rows ?? []];
  for (const pr of prs) {
    if (pr.lane !== "review") continue;
    const named = new Set<string>();
    if (pr.judgment?.ownerSessionId) named.add(pr.judgment.ownerSessionId);
    for (const record of input.records ?? []) {
      const id = targets(record, pr) && (record.matchedSessionId || record.sessionId);
      if (id) named.add(id);
    }
    const linked = (s: HoldSession) => named.has(s.id) ||
      (pr.projectIds.includes(s.projectId) && matchesWorkspace(pr, s.workspacePull));
    if (all.some(s => s.running && linked(s))) holds.set(pullKey(pr.repo, pr.number), "running");
    else if (input.peers && !input.peers.complete) holds.set(pullKey(pr.repo, pr.number), "unverified");
  }
  return holds;
}

// A ledger merge card waits with its PR while the PR's work session runs.
export const heldMergeRecord = (record: Pick<TrackedDecision, "kind" | "mergeTarget">, holds: ReadonlyMap<string, MergeHold>) =>
  record.kind === "merge" && !!record.mergeTarget && holds.get(pullKey(record.mergeTarget.repo, record.mergeTarget.number)) === "running";
