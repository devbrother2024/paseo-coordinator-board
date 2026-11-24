import { isLongReply } from "./decision-reply-state";
import type { TrackedDecision, TrackedReplyReason, TrackedReplyRoute } from "../shared/tracked-decisions";

export const optionId = (option: { key: string; text: string }) => JSON.stringify([option.key, option.text]);

// Evidence, risks, urgency, the example and recommended answers, PR links, history and labels may change under a draft.
// The ledger owner has its own confirmation, and the rest is bookkeeping.
const unaffected = new Set(["why", "risk", "urgency", "howToAnswer", "recommendedReply", "qa", "replyHistory", "since", "projectTitle", "owner",
  "dueAt", "blocksWork", "pullTarget", "pullRepository", "sourceCoordinatorId", "key", "fingerprint", "queuedReply", "matchedPull"]);

// Any other edit changes what the reply answers, so the person looks again before sending it.
export function trackedReplyBasis(item: TrackedDecision, recipientId: string | null) {
  return JSON.stringify([Object.entries(item).filter(([field]) => !unaffected.has(field)), recipientId]);
}

// The session or coordinator that would take the reply now. A ledger owner is confirmed on its own.
// While a redirected reply waits for its check, the retry goes to the fallback.
export function trackedBasisRecipient(item: Pick<TrackedDecision, "sourceCoordinatorId">, route: TrackedReplyRoute | undefined, redirected = false) {
  return item.sourceCoordinatorId !== undefined ? null : (redirected ? null : route?.recipientId) ?? route?.fallbackId ?? null;
}

// A redirected reply that went out unconfirmed can only be checked again with the fallback, never sent to the card's
// own session. Its retry stays on offer after that session can take replies again.
export function redirectAwaitsCheck(outcome: { status: string; mode?: string; recipientId?: string } | null, fallbackId: string | null) {
  return outcome?.status === "unconfirmed" && outcome.mode === "fallback" && !!fallbackId && outcome.recipientId === fallbackId;
}

// Retrying an unconfirmed reply checks that reply under the revision it was sent for, so it is never sent twice.
export function trackedRetryFingerprint(previous: { status: string; requested?: string; answer?: string; recipientId?: string } | null,
  fingerprint: string, answer: string, recipientId: string | null) {
  const same = (previous?.answer ?? "") === answer.trim() && (previous?.recipientId ?? null) === recipientId;
  return previous?.status === "unconfirmed" && previous.requested && same ? previous.requested : fingerprint;
}

const finished = new Set(["sent", "closed", "already-closed"]);
// The revision a finished reply closed: the earlier one the board confirmed, or the one it was asked to answer.
// A newer revision on screen stays open, as the board still lists it.
export function closedRevision(outcome: { status: string; requested?: string; revision?: string } | null) {
  return outcome && finished.has(outcome.status) ? outcome.revision ?? outcome.requested ?? null : null;
}

// Merge cards use the PR action, and long explanations are not answers to send as they are. The ledger's own short
// reply comes first, then the first recommendation line.
export function recommendedTrackedReply(item: TrackedDecision) {
  if (item.kind === "merge" || item.questions.length || item.matchedSessionId) return "";
  return [item.recommendedReply, item.recommend[0]].map(line => line?.trim() ?? "").find(line => line && !isLongReply(line)) ?? "";
}

// Everything a card sends stays on screen. A reply written before the card gained questions keeps its editor,
// and a photo of a question that no longer exists has to be removed before sending.
export function trackedDraftLayout<Photo extends { questionIndex?: number }>(
  item: Pick<TrackedDecision, "questions" | "matchedSessionId">, freeReply: string, photos: readonly Photo[],
) {
  const questions = item.questions.length;
  return {
    freeEditor: !questions && !item.matchedSessionId,
    carried: questions > 0 && (!!freeReply.trim() || photos.some(photo => photo.questionIndex === undefined)),
    orphaned: photos.filter(photo => photo.questionIndex !== undefined && photo.questionIndex >= questions),
  };
}

export type FailureStreak = { key: string; count: number } | null;

// The same rejection twice in a row, for the same recipient, will not clear with another refresh.
export function nextFailureStreak(previous: FailureStreak, outcome: { status: string; reason?: string }, recipientId: string | null): FailureStreak {
  if (outcome.status !== "changed") return null;
  const key = JSON.stringify([outcome.reason ?? null, recipientId]);
  return { key, count: previous?.key === key ? previous.count + 1 : 1 };
}

// These reasons keep the form and the typed reply. The rest need a fresh card first.
const recoverable = new Set<string>(["revised", "earlier-unconfirmed", "owner-changed", "recipient-changed", "recipient-closed", "recipient-error",
  "recipient-missing", "recipient-unchecked"] satisfies TrackedReplyReason[]);

// What a rejected reply leaves the person able to do. A changed card holds the send button until its newer revision is
// on screen. Any other rejection repeated for the same recipient points to the session instead of another refresh.
export function trackedRecovery(outcome: { status: string; reason?: string; requested?: string; fingerprint: string } | null,
  fingerprint: string, streak: FailureStreak) {
  const changed = outcome?.status === "changed";
  const needsRefresh = outcome?.status === "out-of-scope" || outcome?.status === "unavailable" || (changed && !recoverable.has(outcome.reason ?? ""));
  const awaitingRevision = outcome?.reason === "revised" && (outcome.requested ?? outcome.fingerprint) === fingerprint;
  const blocking = changed && (outcome.reason !== "revised" || awaitingRevision);
  return { needsRefresh, awaitingRevision, stuck: blocking && (streak?.count ?? 0) >= 2 };
}

// Fill only questions the person has not answered or skipped, using the ledger's own recommended options.
export function recommendedChoices(item: TrackedDecision, answered: (index: number) => boolean) {
  const picks: Record<number, string[]> = {};
  item.questions.forEach((question, index) => {
    const recommended = question.options.filter(option => option.recommended);
    if (answered(index) || !recommended.length || (!question.multi && recommended.length > 1)) return;
    picks[index] = recommended.map(optionId);
  });
  return picks;
}
