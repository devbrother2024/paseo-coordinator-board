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

// A reply format that lists choices ("A / B") or leaves blanks ("<time>") guides the person; it is not a sentence to send.
const replyFormat = (line: string) => /<[^>]+>/.test(line) || /\s\/\s/.test(line);

// Merge cards use the PR action, and long explanations are not answers to send as they are. The ledger's own short
// reply comes first, then its example reply (the sentence to send after following the recommendation), then the first
// recommendation line, which can be an instruction rather than a reply.
export function recommendedTrackedReply(item: TrackedDecision) {
  if (item.kind === "merge" || item.questions.length || item.matchedSessionId) return "";
  const example = item.howToAnswer?.trim() ?? "";
  return [item.recommendedReply, replyFormat(example) ? "" : example, item.recommend[0]].map(line => line?.trim() ?? "")
    .find(line => line && !isLongReply(line)) ?? "";
}

// Where a card's one input is. Without questions it is the card's own. With one question it is that question's input.
// With several, the card's input stays under them for a question, a change request or a note. A card tied to a session
// question (and no questions of its own) uses the session card's input, and while the merge card takes a change request
// the ledger side adds none, unless something was already written there.
// Everything a card sends stays on screen: a reply written before a one-question card gained its question keeps its
// editor, and a photo of a question that no longer exists has to be removed before sending.
export function trackedDraftLayout<Photo extends { questionIndex?: number }>(
  item: Pick<TrackedDecision, "questions" | "matchedSessionId">, freeReply: string, photos: readonly Photo[], pullTakesInput = false,
) {
  const questions = item.questions.length;
  const written = !!freeReply.trim() || photos.some(photo => photo.questionIndex === undefined);
  // The merge card's input takes over only while this side has nothing written. A draft or photo from before the merge
  // input appeared keeps its editor, so it can still be read, sent or cleared.
  const freeEditor = (!pullTakesInput || written) && (questions ? questions >= 2 : !item.matchedSessionId);
  return {
    freeEditor,
    carried: questions > 0 && !freeEditor && written,
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
