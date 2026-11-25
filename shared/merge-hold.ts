import type { SessionRow } from "./contract";
import type { PullRequestItem } from "./prs";
import { pullKey, type TrackedDecision } from "./tracked-decisions";
import { matchesWorkspace, type WorkspacePull } from "./workspace-pull";

// What a running work session linked to a merge-ready PR means for its merge card.
// running: the session works on the PR's head branch now, so the card waits in project progress.
// elsewhere: the session works on another branch (often the next unit stacked on this PR). The card stays with one line.
// branch-unknown: the session runs but the board cannot tell its branch. The card stays with a warning and asks once more.
// unverified: the linked session is on a host the board could not read. The card stays with a warning and asks once more.
export type MergeHold = "running" | "elsewhere" | "branch-unknown" | "unverified";
export type HoldSession = { id: string; projectId: string; running: boolean; workspacePull?: WorkspacePull };
// A session named for a PR (by a ledger merge card). hosts lists the other hosts it may be on.
export type HoldLink = { repo: string; number: number; projectId: string | null; id: string; hosts?: readonly string[] };
type HoldPull = Pick<PullRequestItem, "repo" | "number" | "projectIds" | "lane" | "headRepo" | "headBranch" | "judgment">;
export type HoldInput = {
  // Sessions in the board snapshot: this host's and those assigned to another host.
  sessions: readonly HoldSession[];
  // Running sessions read from other hosts, and the hosts the board read in full. A linked session on any
  // other host (offline, hidden, still loading or failed) cannot be checked.
  peers?: { rows: readonly HoldSession[]; read: ReadonlySet<string> };
  links?: readonly HoldLink[];
};

export const mergeHoldWords = {
  running: ["작업 세션 진행 중 · 끝나면 병합 카드로 올라옵니다", "Work session running · Moves to a merge card when it finishes"],
  elsewhere: ["작업 세션이 다른 일을 진행 중입니다.", "The work session is busy with other work."],
  "branch-unknown": ["작업 세션이 진행 중이지만 작업 브랜치를 확인하지 못했습니다.", "A work session is running, but the board could not tell its branch."],
  unverified: ["작업 세션 상태를 확인하지 못했습니다.", "Could not check whether the work session is still running."],
} as const satisfies Record<MergeHold, readonly [string, string]>;

// Whether the person should confirm once more before the merge preview opens.
export const asksBeforeMerge = (hold: MergeHold | undefined) => hold === "branch-unknown" || hold === "unverified";

export const snapshotHoldSessions = (rows: readonly Pick<SessionRow, "id" | "projectId" | "lane" | "workspacePull">[]): HoldSession[] =>
  rows.map(row => ({ id: row.id, projectId: row.projectId, running: row.lane === "running", ...(row.workspacePull ? { workspacePull: row.workspacePull } : {}) }));

type LinkRecord = Pick<TrackedDecision, "kind" | "mergeTarget" | "projectId" | "sessionId" | "matchedSessionId">;
// The session each ledger merge card names for its PR. resolveHosts says which other hosts it may be on.
export function mergeRecordLinks<T extends LinkRecord>(records: readonly T[], resolveHosts?: (record: T) => readonly string[] | undefined): HoldLink[] {
  return records.flatMap(record => {
    const id = record.matchedSessionId || record.sessionId;
    if (record.kind !== "merge" || !record.mergeTarget || !id) return [];
    const hosts = resolveHosts?.(record);
    return [{ ...record.mergeTarget, projectId: record.projectId, id, ...(hosts?.length ? { hosts } : {}) }];
  });
}

// The other hosts a ledger card's session may be on. A card naming a host the board cannot reach now
// (offline or hidden) still points there, so the PR warns instead of passing as checked.
export function linkedHosts(target: { kind: string; hosts?: readonly { serverId: string }[] } | undefined,
  hint: string | null | undefined, here: { hostId?: string; hostLabel: string }): string[] | undefined {
  if (target?.kind === "remote") return target.hosts?.map(host => host.serverId);
  return target?.kind === "unavailable" && hint && hint !== here.hostId && hint.toLowerCase() !== here.hostLabel.toLowerCase() ? [hint] : undefined;
}

// Where a running session works compared with the PR's head branch.
function branchOf(pr: HoldPull, workspace: WorkspacePull | undefined): "same" | "other" | "unknown" {
  if (!workspace) return "unknown";
  if (matchesWorkspace(pr, workspace)) return "same";
  // A branch workspace cannot be compared when GitHub did not report the PR's head branch.
  return workspace.kind === "branch" && (!pr.headRepo || !pr.headBranch) ? "unknown" : "other";
}

const rank: Record<MergeHold, number> = { running: 3, "branch-unknown": 2, unverified: 2, elsewhere: 1 };

// A PR's merge card state, and the linked sessions known to be running on another branch. Only those sessions
// are exempt from the running confirmation; any other session still answers for itself.
export type HoldDetail = { hold: MergeHold; elsewhere: ReadonlySet<string> };

// What each PR that would be a merge card shows. The setting that limits merge cards to coordinator-checked PRs
// does not matter here: a PR whose branch is still being changed is not ready to merge either way.
export function mergeHolds(prs: readonly HoldPull[], input: HoldInput): Map<string, MergeHold> {
  return new Map([...mergeHoldDetails(prs, input)].map(([key, detail]) => [key, detail.hold]));
}

export function mergeHoldDetails(prs: readonly HoldPull[], input: HoldInput): Map<string, HoldDetail> {
  const holds = new Map<string, HoldDetail>();
  const peerRows = input.peers?.rows ?? [];
  const find = (id: string) => input.sessions.find(s => s.id === id) ?? peerRows.find(s => s.id === id);
  for (const pr of prs) {
    if (pr.lane !== "review") continue;
    let hold: MergeHold | undefined;
    const elsewhere = new Set<string>();
    const raise = (next: MergeHold) => { if (!hold || rank[next] > rank[hold]) hold = next; };
    // Sessions whose workspace is this PR's branch.
    for (const s of [...input.sessions, ...peerRows]) {
      if (s.running && pr.projectIds.includes(s.projectId) && matchesWorkspace(pr, s.workspacePull)) raise("running");
    }
    // Sessions named for this PR, wherever they work now.
    const named: { id: string; hosts?: readonly string[] }[] = [];
    const owner = pr.judgment;
    if (owner?.ownerSessionId) named.push({ id: owner.ownerSessionId, ...(owner.ownerSessionHost ? { hosts: [owner.ownerSessionHost] } : {}) });
    for (const link of input.links ?? []) {
      if (link.repo === pr.repo && link.number === pr.number && (link.projectId === null || pr.projectIds.includes(link.projectId))) named.push(link);
    }
    for (const { id, hosts } of named) {
      const found = find(id);
      if (found?.running) {
        const branch = branchOf(pr, found.workspacePull);
        if (branch === "other") elsewhere.add(id);
        raise(branch === "same" ? "running" : branch === "other" ? "elsewhere" : "branch-unknown");
      } else if (!found && input.peers && hosts?.some(host => !input.peers!.read.has(host))) raise("unverified");
    }
    if (hold) holds.set(pullKey(pr.repo, pr.number), { hold, elsewhere });
  }
  return holds;
}

// A ledger merge card waits with its PR while the PR's work session runs on its branch.
export const heldMergeRecord = (record: Pick<TrackedDecision, "kind" | "mergeTarget">, holds: ReadonlyMap<string, MergeHold>) =>
  record.kind === "merge" && !!record.mergeTarget && holds.get(pullKey(record.mergeTarget.repo, record.mergeTarget.number)) === "running";

// Whether the board saw this exact session working on another branch, so the card's remote lookup of it asks nothing.
export const seenElsewhere = (details: ReadonlyMap<string, HoldDetail>, pr: Pick<HoldPull, "repo" | "number">, sessionId: string | undefined) =>
  !!sessionId && !!details.get(pullKey(pr.repo, pr.number))?.elsewhere.has(sessionId);

// A held PR shows as a plain row in the kanban's running column instead of a merge card.
export const kanbanPull = <T extends Pick<HoldPull, "repo" | "number" | "lane">>(pr: T, holds: ReadonlyMap<string, MergeHold>): T =>
  holds.get(pullKey(pr.repo, pr.number)) === "running" ? { ...pr, lane: "progress" } : pr;
