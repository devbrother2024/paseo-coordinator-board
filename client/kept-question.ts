import type { SessionRow } from "../shared/contract";

/**
 * What a card from the session's conversation shows about its question, all of it plain: the question is old, the
 * session ended, the coordinator judged that it still needs the person, or how many times the session spoke since.
 * Whether a question was handled is for the coordinator to judge, so the card never says it may have been answered.
 * Returns null for every other card.
 */
export function keptQuestionNotice(session: Pick<SessionRow, "keptQuestion" | "decision">) {
  const kept = session.keptQuestion;
  if (!kept || session.decision?.source !== "conversation") return null;
  const ko: string[] = [], en: string[] = [];
  if (kept.stale) { ko.push("오래된 질문"); en.push("Old question"); }
  if (kept.ended) { ko.push("세션 끝남 · 미처리"); en.push("Session ended · Not handled"); }
  if (kept.verdict === "needed") { ko.push("코디네이터 판단: 처리 필요"); en.push("Coordinator: needs your decision"); }
  else if (kept.later > 0 && !kept.ended && !kept.stale) {
    ko.push(`이 뒤로 세션이 ${kept.later}번 더 말함`);
    en.push(`The session spoke ${kept.later} more ${kept.later === 1 ? "time" : "times"} since`);
  }
  const line: [string, string] | null = ko.length ? [ko.join(" · "), en.join(" · ")] : null;
  return { key: kept.key, stale: !!kept.stale, ended: !!kept.ended, line, older: kept.older ?? [], verdictEvidence: kept.verdictEvidence };
}

type OlderQuestion = NonNullable<NonNullable<SessionRow["keptQuestion"]>["older"]>[number];
export const OLDER_SHOWN = 10;

/** The other open questions the card shows: the first 10, and all of them once opened. `more` labels the toggle. */
export function olderQuestions(older: readonly OlderQuestion[], open: boolean) {
  const hidden = older.length - OLDER_SHOWN;
  if (hidden <= 0) return { shown: [...older], more: null };
  return open ? { shown: [...older], more: ["접기", "Less"] as [string, string] }
    : { shown: older.slice(0, OLDER_SHOWN), more: [`외 ${hidden}개 더 보기`, `${hidden} more`] as [string, string] };
}
