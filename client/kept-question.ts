import type { SessionRow } from "../shared/contract";

/**
 * What a card from the session's conversation shows about its question. Before the coordinator judges it, nothing: it is a
 * plain decision card, however old (the header shows how long it waited). Judged as needing the person, one line that says
 * what to do. Whether a question was handled is for the coordinator to judge, so the card never says it may have been
 * answered, and it is never faded. Returns null for every other card.
 */
export function keptQuestionNotice(session: Pick<SessionRow, "keptQuestion" | "decision">) {
  const kept = session.keptQuestion;
  if (!kept || session.decision?.source !== "conversation") return null;
  const todo = kept.verdictTodo;
  const line: [string, string] | null = kept.verdict === "needed"
    ? (todo ? ["처리 필요 · " + todo, "Needs your decision · " + todo] : ["처리 필요", "Needs your decision"])
    : null;
  return { key: kept.key, ended: !!kept.ended, line, older: kept.older ?? [], verdictEvidence: kept.verdictEvidence };
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
