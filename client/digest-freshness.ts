import { waitStart } from "../shared/decision-priority";
import type { Card } from "./model";

const threeHours = 3 * 60 * 60 * 1000;

export function shouldRefreshDigest(lastDigestAt: string | undefined, pending: readonly Card[], coordinator: string | null, now: number) {
  const last = waitStart(lastDigestAt, now);
  if (!coordinator || last === null || now - last < threeHours) return false;
  return pending.some(({ session, note }) => {
    if (session.id === coordinator || session.nativePending || session.decisionAnswered) return false;
    const source = session.decision?.source;
    const at = source === "conversation" ? session.decisionRequestedAt
      : (source === "agent-note" || (!source && note?.kind === "question" && note.origin === "agent")) ? note?.requestedAt
        : undefined;
    const asked = waitStart(at, now);
    return asked !== null && asked > last;
  });
}

export type DigestSubmission = { coordinator: string; lastDigestAt: string | undefined };

export function digestRequestWaiting(submission: DigestSubmission | null, coordinator: string | null, lastDigestAt: string | undefined) {
  return !!submission && submission.coordinator === coordinator &&
    (!lastDigestAt || (!!submission.lastDigestAt && lastDigestAt <= submission.lastDigestAt));
}
