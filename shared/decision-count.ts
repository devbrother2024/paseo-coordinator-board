import type { Note, SessionRow } from "./contract";
import { trackedCoverage, pullKey, type TrackedDecisionView } from "./tracked-decisions";
import type { PullRequestView } from "./prs";
import { mergeHolds, mergeRecordLinks, snapshotHoldSessions } from "./merge-hold";
import { placeMergeCards, pullDecidesNow } from "./merge-card-place";

export function displayLane(session: SessionRow, note: Note | undefined): SessionRow["lane"] | "done" {
  if (session.nativePending) return "human";
  if (session.evidenceId && session.evidenceId === note?.evidenceId && note.origin === "person") {
    if (note.kind === "done") return "done";
    if (note.kind === "review") return "review";
    if (note.kind === "clear" && session.lane === "human") return "idle";
  }
  if (session.decisionAnswered) {
    return session.lane === "running" || session.lane === "unknown" ? session.lane : "review";
  }
  if (session.lane === "human" || note?.kind === "question") return "human";
  if (session.lane === "running") return "running";
  if (session.lane === "review" || note?.kind === "review" || (note?.kind === "done" && note.origin === "agent")) return "review";
  if (note?.kind === "done") return "done";
  return session.lane;
}

export function decisionCount(view: {sessions: SessionRow[]; notes: Record<string, Note>; pullRequests?: PullRequestView; trackedDecisions?: TrackedDecisionView}) {
  const sessions = view.sessions.filter(row => displayLane(row, view.notes[row.id]) === "human");
  const ledger = view.trackedDecisions?.items ?? [];
  const prs = view.pullRequests?.items ?? [];
  // A merge card whose work session still runs on the PR branch waits in project progress. Only sessions
  // in the snapshot count here; the board screen also reads other hosts.
  const holds = mergeHolds(prs, { sessions: snapshotHoldSessions(view.sessions), links: mergeRecordLinks(ledger) });
  // A merge card also waits there until GitHub confirms its PR is ready. The board screen uses the same placement.
  const records = placeMergeCards(ledger, view.pullRequests, holds).deciding;
  const covered = trackedCoverage(records);
  return records.length + sessions.filter(s => !covered.sessionIds.has(s.id)).length +
    prs.filter(pr => pullDecidesNow(pr, holds) && !covered.pullKeys.has(pullKey(pr.repo, pr.number))).length;
}
