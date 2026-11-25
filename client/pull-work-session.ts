import type { PullRequestItem } from "../shared/prs";
import type { TrackedDecision } from "../shared/tracked-decisions";
import { trackedWorkSession, type RemoteWorkSession } from "./tracked-session-targets";

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
