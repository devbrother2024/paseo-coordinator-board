import type { SessionRow } from "../shared/contract";

/**
 * The line a kept question card shows: how many times the session spoke after asking, and that the person has not answered.
 * Only a card the board found in the session's conversation is kept. Returns null for every other card.
 */
export function keptQuestionNotice(session: Pick<SessionRow, "keptQuestion" | "decision">) {
  const kept = session.keptQuestion;
  if (!kept || session.decision?.source !== "conversation") return null;
  const ko = `이 뒤로 세션이 ${kept.later}번 더 말함 · 아직 답 없음`;
  const en = `The session spoke ${kept.later} more ${kept.later === 1 ? "time" : "times"} since · No answer yet`;
  const line: [string, string] = kept.stale ? ["오래된 질문 · " + ko, "Old question · " + en] : [ko, en];
  return { key: kept.key, stale: !!kept.stale, line };
}
