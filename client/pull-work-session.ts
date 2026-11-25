import type { PullRequestItem } from "../shared/prs";
import type { TrackedDecision } from "../shared/tracked-decisions";
import { trackedWorkSession, type RemoteWorkSession, type WorkSessionHost } from "./tracked-session-targets";

type PullRef = Pick<PullRequestItem, "repo" | "number" | "projectIds">;
type Directory = Parameters<typeof trackedWorkSession>[1];

// The work session a ledger card names for this PR. A PR row shows it like the card header does,
// including a session on another host. Sessions the row already links are not repeated.
export function ledgerPullSession(pr: PullRef, items: readonly TrackedDecision[], directory: Directory, linkedIds: ReadonlySet<string>):
  { kind: "local"; id: string } | RemoteWorkSession | undefined {
  for (const item of items) {
    const target = item.mergeTarget;
    if (!target || target.repo !== pr.repo || target.number !== pr.number) continue;
    if (item.projectId !== null && !pr.projectIds.includes(item.projectId)) continue;
    const found = trackedWorkSession(item, directory);
    if (!found || found.kind === "unavailable" || linkedIds.has(found.id)) continue;
    return found;
  }
  return undefined;
}

// What the PR row says about its work session besides the chips it shows.
export function pullSessionNote(linked: number, remote: { checking: boolean; found?: boolean } | undefined): "none" | "checking" | "unverified" {
  if (linked) return "none";
  if (remote?.checking) return "checking";
  return remote?.found ? "none" : "unverified";
}

// Whether the merge button may open the preview. A remote work session still being looked up could be
// running, so the button waits for the answer instead of skipping the running-session confirmation.
export function mergeGate(localRunning: boolean, remote: { pending: boolean; running: boolean } | undefined): "wait" | "confirm" | "open" {
  if (remote?.pending) return "wait";
  return localRunning || remote?.running ? "confirm" : "open";
}

// A remote lookup answer belongs to the lookup that produced it, and to the time it arrived.
// A board refresh starts a new lookup. Until it answers, a recent answer for the same session and hosts
// keeps the merge button usable; an old or missing one holds it. The press itself still waits for the newest answer.
export const remoteAnswerMaxAgeMs = 90_000;
export type RemoteAnswer<S, L> = { key: string; lookup: L; at: number; state: S | null };
export function remoteSessionView<S, L>(answer: RemoteAnswer<S, L> | undefined, key: string, lookup: L, now: number) {
  const same = !!answer && answer.key === key;
  const current = same && answer!.lookup === lookup;
  return {
    // undefined: nothing known yet for this session.
    shown: same ? answer!.state : undefined,
    pending: !same || (!current && now - answer!.at > remoteAnswerMaxAgeMs),
  };
}

// At Confirm merge the board waits for the newest remote answer. A session that turned running since the
// preview opened asks once more, unless the person already chose to go ahead while it was running.
export function confirmAfterLookup(fresh: { running: boolean } | null | undefined, acknowledgedRunning: boolean): "merge" | "ask" {
  return fresh?.running && !acknowledgedRunning ? "ask" : "merge";
}

// The owner the coordinator named for this PR, on the host where the board verified it.
// It joins the PR row like a ledger card's session, so the running check covers it too.
export function judgedOwnerSession(pr: Pick<PullRequestItem, "judgment">, hosts: readonly WorkSessionHost[], linkedIds: ReadonlySet<string>): RemoteWorkSession | undefined {
  const id = pr.judgment?.ownerSessionId, serverId = pr.judgment?.ownerSessionHost;
  if (!id || !serverId || linkedIds.has(id)) return undefined;
  const host = hosts.find(entry => entry.serverId === serverId);
  return host ? { kind: "remote", id, hosts: [host] } : undefined;
}
