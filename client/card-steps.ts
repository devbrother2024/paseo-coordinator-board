import type { TrackedDecision, TrackedReplyRoute } from "../shared/tracked-decisions";
import { optionId, recommendedChoices, recommendedTrackedReply } from "./tracked-reply-draft";

type Translate = (korean: string, english: string) => string;
type Question = TrackedDecision["questions"][number];
// A question index, or the summary list after the last question.
export type Step = number | "summary";
export type QuestionDraft = { selected?: readonly string[]; typed?: string; skipped?: boolean; photos?: number };

// A card with several questions shows one at a time. A single question keeps the whole form on the card.
export const usesSteps = (questions: readonly Question[]) => questions.length >= 2;

// A long card waits as a short preview until the person starts answering, so the next card stays in view.
export const foldsCard = (item: Pick<TrackedDecision, "questions">) => usesSteps(item.questions);

export function firstOpenStep(answered: readonly boolean[]): Step {
  const index = answered.findIndex(done => !done);
  return index < 0 ? "summary" : index;
}

// The next unanswered question after this one, then any left behind. With none left, the summary.
export function nextOpenStep(answered: readonly boolean[], current: number): Step {
  const after = answered.findIndex((done, index) => index > current && !done);
  if (after >= 0) return after;
  return firstOpenStep(answered);
}

// A step stays valid when the card loses questions under an open draft.
export function clampStep(step: Step, count: number): Step {
  if (step === "summary") return step;
  if (step >= count) return "summary";
  return Math.max(0, step);
}

// Choosing moves on only when one choice is the whole answer. A multi-choice question waits for Next.
export const advancesOnChoice = (question: Question) => !question.multi && question.options.length > 0;

// Recommend-all needs a recommendation the board can pick on every question. It fills only the questions the
// person has not answered, and disappears once nothing is left.
export function recommendAllPicks(questions: readonly Question[], answered: readonly boolean[]) {
  const usable = recommendedChoices({ questions }, () => false);
  if (Object.keys(usable).length !== questions.length || answered.every(Boolean)) return null;
  return recommendedChoices({ questions }, index => !!answered[index]);
}

const oneLine = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? flat.slice(0, limit - 1).trimEnd() + "…" : flat;
};

// "Q1 A · 20 photos": the question number, the chosen keys and their text, or what the person wrote.
export function answerSummary(index: number, question: Question, draft: QuestionDraft, t: Translate) {
  const label = "Q" + (index + 1);
  const photos = draft.photos ? t(`사진 ${draft.photos}장`, `${draft.photos} photo${draft.photos === 1 ? "" : "s"}`) : "";
  if (draft.skipped) return label + " · " + t("건너뜀", "Skipped");
  const chosen = question.options.filter(option => draft.selected?.includes(optionId(option)));
  const typed = draft.typed?.trim();
  const parts = chosen.length
    ? [label + " " + chosen.map(option => option.key).join(", "), oneLine(chosen.map(option => option.text).join(", "), 72)]
    : typed ? [label, oneLine(typed, 72)] : [label];
  if (photos) parts.push(photos);
  if (parts.length === 1) parts.push(t("아직 답하지 않음", "Not answered yet"));
  return parts.join(" · ");
}

// The request shows two lines. A longer one, or one with more lines, opens with More. A short one shows in full,
// since a narrow screen may need more than two lines for it and nothing else would reveal the rest.
export function foldsAsk(ask: readonly string[]) {
  if (ask.length > 1) return true;
  const first = ask[0]?.trim() ?? "";
  return first.includes("\n") || first.length > 90;
}

// A check the person does themselves, answered by telling the coordinator it is done.
export const isHumanCheck = (item: TrackedDecision) =>
  item.kind === "check" && item.where === "human" && !item.questions.length && !item.matchedSessionId;

// The one-tap suggestion under the reply field. A personal check without its own suggestion offers "I checked this".
export function trackedSuggestion(item: TrackedDecision, checked: string) {
  return recommendedTrackedReply(item) || (isHumanCheck(item) ? checked : "");
}

type Sources = { owner: boolean; source: "local" | "remote" | "unavailable" | undefined };
// A blocked work session that is still alive elsewhere can be opened to answer there.
const reachable = new Set(["other-host", "other-project"]);

// Which session the card's one chip opens. It is the session that takes the reply. When that session cannot,
// the chip opens the one that still can: the coordinator a fallback goes to, or a live session elsewhere.
export function trackedChipSide(where: TrackedDecision["where"], route: TrackedReplyRoute | undefined, links: Sources): "owner" | "source" | null {
  const source = links.source && links.source !== "unavailable";
  const pick = (first: "owner" | "source") => {
    const available = { owner: links.owner, source };
    const other = first === "owner" ? "source" : "owner";
    return available[first] ? first : available[other] ? other : null;
  };
  if (where === "manager" || where === "human") return pick("owner");
  const blocked = route?.blocked;
  if (!blocked || reachable.has(blocked)) return pick("source");
  return pick("owner");
}

// What a card offers for its reply. The board only sends: to the session that takes the reply, or, when that session
// cannot, to the fallback. With neither, the card explains why instead of showing a form it could not send, unless
// the person already wrote something there.
export function trackedReplyOffer(route: Pick<TrackedReplyRoute, "recipientId" | "fallbackId"> | undefined, redirected: boolean, hasDraft: boolean) {
  const send = !!route?.recipientId && !redirected;
  const fallback = !!route?.fallbackId && (!route.recipientId || redirected);
  return { send, fallback, form: send || fallback || !!route?.recipientId || hasDraft };
}

// A card's steps are how to do what it asks, so they show on its face. A long list shows its first three until opened.
export function visibleSteps(steps: readonly string[], expanded: boolean) {
  if (expanded || steps.length <= 5) return { shown: [...steps], more: 0 };
  return { shown: steps.slice(0, 3), more: steps.length };
}
