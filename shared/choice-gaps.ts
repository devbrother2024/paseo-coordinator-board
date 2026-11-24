import type { Decision } from "./decision-actions";
import type { TrackedDecision } from "./tracked-decisions";
import { cardChoiceGaps, type ChoiceGaps } from "./question-choices";

type LedgerFields = Pick<TrackedDecision, "title" | "ask" | "recommend" | "howToAnswer" | "why" | "steps" | "questions">;

/** Options a ledger card names in its title, request, recommendation or reply example without listing them. */
export function ledgerChoiceGaps(item: LedgerFields): ChoiceGaps {
  return cardChoiceGaps([item.title, ...item.ask, ...item.recommend, item.howToAnswer],
    item.questions.flatMap(question => question.options.map(({ key }) => key)),
    [...item.why, ...item.steps, ...item.questions.map(question => question.text)]);
}

/** Options a coordinator judgment names without carrying them as selectable options. */
export function coordinatorChoiceGaps(content: Pick<Decision, "question" | "recommendation" | "needsInput" | "options"> & { recommendationReason?: string }): ChoiceGaps {
  return cardChoiceGaps([content.question, content.recommendation, content.needsInput, content.recommendationReason],
    (content.options ?? []).map(({ label }) => label));
}
