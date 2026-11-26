import type { ReplyEntry } from "../shared/reply-history";
import { questionWords } from "./open-questions";
import type { Preferences } from "./preferences";

export const MAX_SKIPPED_REPLIES = 200;

/**
 * Queued replies whose question closed some other way (a decision-applied line, a relayed answer, a ledger card, the
 * coordinator's judgment, the person closing it, another board reply). They are not sent: the decision was already made.
 * A reply queued with its question's key matches that key. One queued before the key was recorded matches a closed
 * question of the same session with the same words, closed after the reply was queued, unless the session has an open
 * question with those words again.
 */
export function handledQueuedReplies(scope: Pick<Preferences, "queuedDecisions" | "closedQuestions" | "raisedQuestions">) {
  const found: { id: string; reason: string }[] = [];
  for (const [id, queued] of Object.entries(scope.queuedDecisions ?? {})) {
    const sessionId = queued.input.sessionId;
    if (queued.question) {
      const closed = scope.closedQuestions?.[queued.question];
      if (closed && closed.sessionId === sessionId) found.push({ id, reason: closed.reason });
      continue;
    }
    const words = questionWords(queued.title);
    if (!words) continue;
    const reopened = (scope.raisedQuestions?.[sessionId]?.questions ?? []).some(question => questionWords(question.question) === words);
    if (reopened) continue;
    // Only a question closed after the reply was queued: a reply left later answers the question asked again.
    const queuedAt = Date.parse(queued.at);
    const closed = Object.values(scope.closedQuestions ?? {}).find(entry => entry.sessionId === sessionId && entry.question &&
      questionWords(entry.question) === words && Date.parse(entry.at) >= queuedAt);
    if (closed) found.push({ id, reason: closed.reason });
  }
  return found;
}

/** Moves the handled queued replies out of the queue into the skipped record. Returns the moved ones with their photo counts. */
export function foldHandledQueuedReplies(scope: Preferences, now = Date.now()) {
  const moved: { id: string; photos: number }[] = [];
  for (const { id, reason } of handledQueuedReplies(scope)) {
    const queued = scope.queuedDecisions[id];
    scope.skippedReplies[id] = { title: queued.title.slice(0, 2000), projectId: queued.input.projectId, sessionId: queued.input.sessionId,
      recipientId: queued.input.recipientId, answer: queued.input.text.slice(0, 24000), queuedAt: queued.at, at: new Date(now).toISOString(),
      reason, ...(queued.photos.length ? { imageCount: queued.photos.length } : {}) };
    delete scope.queuedDecisions[id];
    moved.push({ id, photos: queued.photos.length });
  }
  const entries = Object.entries(scope.skippedReplies);
  if (entries.length > MAX_SKIPPED_REPLIES) {
    entries.sort(([, a], [, b]) => a.at.localeCompare(b.at));
    for (const [id] of entries.slice(0, entries.length - MAX_SKIPPED_REPLIES)) delete scope.skippedReplies[id];
  }
  return moved;
}

/** Skipped replies for recent decisions in the selected projects: already handled, not sent. */
export function skippedReplyHistory(scope: Pick<Preferences, "skippedReplies">, selected: ReadonlySet<string>): ReplyEntry[] {
  return Object.entries(scope.skippedReplies ?? {}).filter(([, entry]) => selected.has(entry.projectId)).map(([id, entry]) => ({
    key: "skipped:" + id, title: entry.title, projectId: entry.projectId, at: entry.at, status: "closed" as const, skipped: true as const,
    // The queued photos were removed with the reply: the record says so instead of offering them.
    answer: entry.answer, recipientId: entry.recipientId, ...(entry.imageCount ? { imageCount: entry.imageCount, localPhotos: false, photosDropped: true as const } : {}),
    origin: { sessionId: entry.sessionId, cardId: entry.sessionId, revision: id, questions: [] },
  }));
}
