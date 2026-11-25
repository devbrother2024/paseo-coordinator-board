import type { TrackedDecision, TrackedReplyRoute } from "../shared/tracked-decisions";
import { dueTime, waitStart } from "../shared/decision-priority";
import { optionId, recommendedChoices, recommendedTrackedReply } from "./tracked-reply-draft";

type Translate = (korean: string, english: string) => string;
type Question = TrackedDecision["questions"][number];
// A question index, or the summary list after the last question.
export type Step = number | "summary";
export type QuestionDraft = { selected?: readonly string[]; typed?: string; skipped?: boolean; photos?: number };

// A card with several questions shows one at a time. A single question keeps the whole form on the card, and so does a
// card that cannot take a reply, since nothing would move it past the first question.
export const usesSteps = (questions: readonly Question[], answerable = true) => answerable && questions.length >= 2;

export function firstOpenStep(answered: readonly boolean[]): Step {
  const index = answered.findIndex(done => !done);
  return index < 0 ? "summary" : index;
}

// Where a card first shows: a card with several questions opens straight on its first unanswered question (the
// summary once all are answered), with no Answer button to press first. A single question keeps the whole form (null).
export function openingStep(questions: readonly Question[], answered: readonly boolean[], answerable = true): Step | null {
  if (!usesSteps(questions, answerable)) return null;
  return firstOpenStep(questions.map((_, index) => !!answered[index]));
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

// Which session the card's one chip opens. It is the session that takes the reply. When that session cannot, its chip
// is hidden and the chip opens the one that still can: the coordinator a redirected reply goes to (the owner link), or
// a live work session on another host or project. With neither, the card shows only the reason.
export function trackedChipSide(where: TrackedDecision["where"], route: TrackedReplyRoute | undefined, links: Sources): "owner" | "source" | null {
  const source = !!links.source && links.source !== "unavailable";
  const blocked = route?.blocked;
  if (where === "manager" || where === "human") {
    if (!blocked) return links.owner ? "owner" : source ? "source" : null;
    return source ? "source" : null;
  }
  if (!blocked || reachable.has(blocked)) return source ? "source" : links.owner ? "owner" : null;
  // The coordinator chip stands in only when it takes the redirected reply. A closed one is no way forward.
  return links.owner && route?.fallbackId ? "owner" : null;
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

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function waitText(minutes: number, t: Translate) {
  if (minutes < 1) return t("1분 미만 대기", "waiting <1m");
  if (minutes < 60) return t(`${minutes}분 대기`, `waiting ${minutes}m`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(`${hours}시간 대기`, `waiting ${hours}h`);
  return t(`${Math.floor(hours / 24)}일 대기`, `waiting ${Math.floor(hours / 24)}d`);
}

// The card header after the project: how long the card has waited, then its due date when it has one, as a date.
export function recordHeaderParts(item: Pick<TrackedDecision, "since" | "dueAt">, t: Translate, now = Date.now()) {
  const parts: string[] = [];
  const since = waitStart(item.since, now);
  if (since !== null && Number.isFinite(since)) parts.push(waitText(Math.floor((now - since) / 60_000), t));
  const due = dueTime(item.dueAt);
  if (due) {
    const day = new Date(due.at);
    const clock = due.timed ? " " + String(day.getHours()).padStart(2, "0") + ":" + String(day.getMinutes()).padStart(2, "0") : "";
    const ko = `${day.getMonth() + 1}월 ${day.getDate()}일${clock}`, en = `${months[day.getMonth()]} ${day.getDate()}${clock}`;
    const end = due.timed ? due.at : new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59, 999).getTime();
    parts.push(end <= now ? t(`기한 지남 · ${ko}`, `Overdue · ${en}`) : t(`기한 ${ko}`, `Due ${en}`));
  }
  return parts;
}

// A step that already starts with its own number ("1.", "1)", "1 ") shows it once in the numbered list. A number that
// is not the step's place is part of what the step says.
export function stepText(line: string, index: number) {
  const match = /^\s*(\d+)[.)]?\s+/.exec(line);
  return match && Number(match[1]) === index + 1 ? line.slice(match[0].length) : line;
}

// Each question's draft: the chosen options, a typed answer, a skip, and whether the field for one's own words is open.
// One question holds one kind of answer at a time.
export type AnswerDrafts = {
  selected: Readonly<Record<number, string[]>>; typed: Readonly<Record<number, string | undefined>>;
  skipped: Readonly<Record<number, boolean>>; writing: Readonly<Record<number, boolean>>;
};
export const emptyAnswers: AnswerDrafts = { selected: {}, typed: {}, skipped: {}, writing: {} };

export function chooseAnswer(draft: AnswerDrafts, index: number, id: string, multi: boolean): AnswerDrafts {
  const group = draft.selected[index] ?? [];
  const next = multi ? group.includes(id) ? group.filter(value => value !== id) : [...group, id] : [id];
  return { selected: { ...draft.selected, [index]: next }, typed: { ...draft.typed, [index]: undefined },
    skipped: { ...draft.skipped, [index]: false }, writing: { ...draft.writing, [index]: false } };
}

export function typeAnswer(draft: AnswerDrafts, index: number, text: string): AnswerDrafts {
  return { ...draft, typed: { ...draft.typed, [index]: text }, selected: { ...draft.selected, [index]: [] } };
}

// "Something else": opens an empty field in place of the options' answer, keeping anything already typed.
export function startWriting(draft: AnswerDrafts, index: number): AnswerDrafts {
  return { ...draft, writing: { ...draft.writing, [index]: true }, typed: { ...draft.typed, [index]: draft.typed[index] ?? "" },
    selected: { ...draft.selected, [index]: [] } };
}

// A skip clears the question's answer. Pressing again undoes it.
export function skipQuestion(draft: AnswerDrafts, index: number): AnswerDrafts {
  return { ...draft, skipped: { ...draft.skipped, [index]: !draft.skipped[index] }, selected: { ...draft.selected, [index]: [] },
    typed: { ...draft.typed, [index]: undefined } };
}

// Recommended picks replace the questions they fill, including a typed answer or a skip there, and nothing else.
export function applyPicks(draft: AnswerDrafts, picks: Readonly<Record<number, string[]>>): AnswerDrafts {
  const indexes = Object.keys(picks);
  return { ...draft, selected: { ...draft.selected, ...picks },
    typed: { ...draft.typed, ...Object.fromEntries(indexes.map(index => [index, undefined])) },
    skipped: { ...draft.skipped, ...Object.fromEntries(indexes.map(index => [index, false])) } };
}

// Where a one-at-a-time card goes after an answer: on to the next open question after a single choice or a skip,
// or nowhere (null) when the person moves on with Next. `answered` is what was on screen before this answer.
export function stepAfterAnswer(stepped: boolean, question: Question, answered: readonly boolean[], index: number,
  action: "choose" | "skip" | "unskip"): Step | null {
  if (!stepped || action === "unskip" || (action === "choose" && !advancesOnChoice(question))) return null;
  return nextOpenStep(answered.map((done, position) => position === index || done), index);
}

// Paste and drop reach photos only through the wrapper around a field, so a question's field stays wrapped. The
// attach button folds under More on a one-at-a-time card; with no field on screen, More holds the button alone.
export function photoPlacement(stepped: boolean, fieldShown: boolean, extrasOpen: boolean) {
  if (!stepped) return { wrapField: fieldShown, fieldControls: fieldShown, extrasComposer: false };
  return { wrapField: fieldShown, fieldControls: fieldShown && extrasOpen, extrasComposer: !fieldShown && extrasOpen };
}
