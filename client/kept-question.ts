import type { SessionRow } from "../shared/contract";

/**
 * What a card from the session's conversation shows about its question: how many times the session spoke after asking,
 * whether the person may have answered in the session, whether the session ended, and the older questions still open.
 * Returns null for every other card.
 */
export function keptQuestionNotice(session: Pick<SessionRow, "keptQuestion" | "decision">) {
  const kept = session.keptQuestion;
  if (!kept || session.decision?.source !== "conversation") return null;
  const ko: string[] = [], en: string[] = [];
  if (kept.stale) { ko.push("오래된 질문"); en.push("Old question"); }
  if (kept.ended) { ko.push("세션 끝남 · 미처리"); en.push("Session ended · Not handled"); }
  if (kept.maybeAnswered) { ko.push("세션에 답했을 수 있음 · 확인"); en.push("You may have answered in the session · Check"); }
  else if (kept.later > 0) {
    ko.push(`이 뒤로 세션이 ${kept.later}번 더 말함 · 아직 답 없음`);
    en.push(`The session spoke ${kept.later} more ${kept.later === 1 ? "time" : "times"} since · No answer yet`);
  }
  const line: [string, string] | null = ko.length ? [ko.join(" · "), en.join(" · ")] : null;
  return { key: kept.key, stale: !!kept.stale, ended: !!kept.ended, line, older: kept.older ?? [] };
}
