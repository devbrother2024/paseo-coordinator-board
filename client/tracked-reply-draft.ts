import { isLongReply } from "./decision-reply-state";
import type { TrackedDecision } from "../shared/tracked-decisions";

export const optionId = (option: { key: string; text: string }) => JSON.stringify([option.key, option.text]);

// A reply answers these. Evidence, priority and history edits keep a draft sendable as written.
export function trackedReplyBasis(item: TrackedDecision, recipientId: string | null) {
  const subject = item.questions.length
    ? item.questions.map(question => [question.id ?? null, question.text, question.multi, question.options.map(optionId)])
    : [item.title, item.ask];
  return JSON.stringify([item.kind, item.mergeTarget ?? null, subject, item.where ?? null, item.sessionId, item.sessionHost ?? null, recipientId]);
}

// Merge cards use the PR action, and long explanations are not answers to send as they are.
export function recommendedTrackedReply(item: TrackedDecision) {
  if (item.kind === "merge" || item.questions.length || item.matchedSessionId) return "";
  const line = item.recommend[0]?.trim() ?? "";
  return isLongReply(line) ? "" : line;
}

export type FailureStreak = { key: string; count: number } | null;

// The same rejection twice in a row, for the same recipient, will not clear with another refresh.
export function nextFailureStreak(previous: FailureStreak, outcome: { status: string; reason?: string }, recipientId: string | null): FailureStreak {
  if (outcome.status !== "changed") return null;
  const key = JSON.stringify([outcome.reason ?? null, recipientId]);
  return { key, count: previous?.key === key ? previous.count + 1 : 1 };
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
