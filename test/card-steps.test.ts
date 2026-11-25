import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  advancesOnChoice, answerSummary, clampStep, firstOpenStep, foldsAsk, isHumanCheck, nextOpenStep, openingStep, recommendAllPicks,
  applyPicks, chooseAnswer, emptyAnswers, photoPlacement, recordHeaderParts, skipQuestion, startWriting, stepAfterAnswer, stepText, typeAnswer,
  trackedChipSide, trackedReplyOffer, trackedSuggestion, usesSteps, visibleSteps,
} from "../client/card-steps";
import { optionId } from "../client/tracked-reply-draft";
import { trackedDecisionSchema, type TrackedDecision } from "../shared/tracked-decisions";

const ko = (korean: string) => korean;
const en = (_korean: string, english: string) => english;
function record(fields: Record<string, unknown> = {}): TrackedDecision {
  return trackedDecisionSchema.parse({ id: "card", key: "card", fingerprint: "0".repeat(64), source: "board", projectId: "a", title: "Card",
    matchedSessionId: null, matchedPull: null, ...fields });
}
const option = (key: string, text: string, recommended = false) => ({ key, text, recommended });
const question = (text: string, options: ReturnType<typeof option>[], multi = false) => ({ text, options, multi });
const ten = Array.from({ length: 10 }, (_, index) => question("Q" + (index + 1), [option("A", "first", true), option("B", "second")]));

test("only a card with two or more questions moves one question at a time", () => {
  expect(usesSteps([])).toBe(false);
  expect(usesSteps([ten[0]])).toBe(false);
  expect(usesSteps(ten.slice(0, 2))).toBe(true);
});

test("a card with several questions opens on its first unanswered question, with no Answer step before it", () => {
  const three = ten.slice(0, 3);
  expect(openingStep(three, [])).toBe(0);
  expect(openingStep(three, [false, false, false])).toBe(0);
  expect(openingStep(three, [true, false, false])).toBe(1);
  expect(openingStep(three, [true, true, false])).toBe(2);
  expect(openingStep(three, [true, true, true])).toBe("summary");
  // One question keeps the whole form on the card, and a card without questions has no steps.
  expect(openingStep([ten[0]], [false])).toBeNull();
  expect(openingStep([ten[0]], [true])).toBeNull();
  expect(openingStep([], [])).toBeNull();
});

test("a card that cannot take a reply shows all its questions at once, without steps", () => {
  expect(usesSteps(ten.slice(0, 3), false)).toBe(false);
  expect(usesSteps(ten.slice(0, 3), true)).toBe(true);
  expect(openingStep(ten.slice(0, 3), [], false)).toBeNull();
});

test("the next question skips answered ones and wraps before the summary", () => {
  expect(firstOpenStep([false, false, false])).toBe(0);
  expect(firstOpenStep([true, false, true])).toBe(1);
  expect(firstOpenStep([true, true])).toBe("summary");
  expect(nextOpenStep([true, false, false], 0)).toBe(1);
  expect(nextOpenStep([true, true, false, true], 1)).toBe(2);
  // Questions after the current one come first, then the ones left behind.
  expect(nextOpenStep([false, true, true, true], 2)).toBe(0);
  expect(nextOpenStep([true, true, true], 1)).toBe("summary");
});

test("a step past the last question shows the summary after the card loses questions", () => {
  expect(clampStep(2, 3)).toBe(2);
  expect(clampStep(3, 3)).toBe("summary");
  expect(clampStep("summary", 3)).toBe("summary");
  expect(clampStep(-1, 3)).toBe(0);
});

test("choosing moves on only for a single-choice question with options", () => {
  expect(advancesOnChoice(question("one", [option("A", "a")]))).toBe(true);
  expect(advancesOnChoice(question("many", [option("A", "a")], true))).toBe(false);
  expect(advancesOnChoice(question("free", []))).toBe(false);
});

test("recommend-all appears only when every question has a usable recommendation", () => {
  const all = recommendAllPicks(ten, ten.map(() => false));
  expect(Object.keys(all ?? {})).toHaveLength(10);
  expect(all?.[3]).toEqual([optionId(option("A", "first"))]);
  // One question without a recommendation hides the button.
  const missing = [...ten.slice(0, 9), question("Q10", [option("A", "first"), option("B", "second")])];
  expect(recommendAllPicks(missing, missing.map(() => false))).toBeNull();
  // A single-choice question with two recommendations cannot be filled.
  expect(recommendAllPicks([ten[0], question("two", [option("A", "a", true), option("B", "b", true)])], [false, false])).toBeNull();
  // A free-text question has nothing to pick.
  expect(recommendAllPicks([ten[0], question("free", [])], [false, false])).toBeNull();
  // Multi-choice questions take every recommended option.
  const multi = question("many", [option("A", "a", true), option("B", "b"), option("C", "c", true)], true);
  expect(recommendAllPicks([ten[0], multi], [false, false])?.[1]).toEqual([optionId(option("A", "a")), optionId(option("C", "c"))]);
});

test("recommend-all keeps the person's own answers and hides once everything is answered", () => {
  const picks = recommendAllPicks(ten.slice(0, 3), [false, true, false]);
  expect(Object.keys(picks ?? {})).toEqual(["0", "2"]);
  expect(recommendAllPicks(ten.slice(0, 3), [true, true, true])).toBeNull();
});

test("an answered question folds into one summary line", () => {
  const q = question("How many photos?", [option("A", "20장, 100 MiB", true), option("B", "50장")]);
  expect(answerSummary(0, q, { selected: [optionId(q.options[0])] }, ko)).toBe("Q1 A · 20장, 100 MiB");
  const multi = question("Which?", [option("A", "a"), option("B", "b"), option("C", "c")], true);
  expect(answerSummary(1, multi, { selected: [optionId(multi.options[2]), optionId(multi.options[0])] }, en)).toBe("Q2 A, C · a, c");
  expect(answerSummary(2, q, { typed: "  my own\nanswer  " }, en)).toBe("Q3 · my own answer");
  expect(answerSummary(3, q, { skipped: true }, ko)).toBe("Q4 · 건너뜀");
  expect(answerSummary(3, q, { skipped: true }, en)).toBe("Q4 · Skipped");
  expect(answerSummary(4, q, {}, en)).toBe("Q5 · Not answered yet");
  expect(answerSummary(0, q, { selected: [optionId(q.options[1])], photos: 2 }, ko)).toBe("Q1 B · 50장 · 사진 2장");
  expect(answerSummary(0, q, { photos: 1 }, en)).toBe("Q1 · 1 photo");
  const long = "x".repeat(200);
  expect(answerSummary(0, q, { typed: long }, en).length).toBeLessThanOrEqual(90);
});

test("a long or multi-line request folds after two lines", () => {
  expect(foldsAsk(["short request"])).toBe(false);
  expect(foldsAsk(["first", "second"])).toBe(true);
  expect(foldsAsk(["line one\nline two"])).toBe(true);
  expect(foldsAsk(["y".repeat(91)])).toBe(true);
  expect(foldsAsk(["y".repeat(90)])).toBe(false);
  expect(foldsAsk([])).toBe(false);
});

test("a personal check card suggests 'I checked this' when the ledger has no reply of its own", () => {
  const check = record({ kind: "check", where: "human" });
  expect(isHumanCheck(check)).toBe(true);
  expect(trackedSuggestion(check, "확인했어요")).toBe("확인했어요");
  expect(trackedSuggestion(record({ kind: "check", where: "human", recommendedReply: "봤어요" }), "확인했어요")).toBe("봤어요");
  // A personal check whose recommendation is an instruction suggests the ledger's example reply instead.
  const disconnect = record({ kind: "check", where: "human", recommend: ["원격 데스크톱 연결 끊기"], howToAnswer: "원격 데스크톱 끊었어" });
  expect(trackedSuggestion(disconnect, "확인했어요")).toBe("원격 데스크톱 끊었어");
  // Other cards keep the ledger's own suggestion, or none.
  expect(isHumanCheck(record({ kind: "check", where: "manager" }))).toBe(false);
  expect(trackedSuggestion(record({ kind: "answer", where: "manager" }), "확인했어요")).toBe("");
  expect(trackedSuggestion(record({ kind: "answer", where: "manager", recommend: ["진행"] }), "확인했어요")).toBe("진행");
  expect(isHumanCheck(record({ kind: "check", where: "human", questions: [ten[0]] }))).toBe(false);
});

test("the card shows one chip: the session that takes the reply, or the one that can still be opened", () => {
  const both = { owner: true, source: "local" as const };
  const route = (recipientId: string | null, blocked?: string, fallbackId: string | null = null) =>
    ({ targetId: recipientId, recipientId, fallbackId, ...(blocked ? { blocked } : {}) }) as Parameters<typeof trackedChipSide>[1];
  // A coordinator card opens the coordinator. The work session moves to the evidence.
  expect(trackedChipSide("manager", route("owner"), both)).toBe("owner");
  // A coordinator that cannot take the reply loses its chip. The work session can still be opened.
  expect(trackedChipSide("human", route(null, "closed"), both)).toBe("source");
  expect(trackedChipSide("manager", route(null, "error"), { owner: true, source: undefined })).toBeNull();
  expect(trackedChipSide("manager", route(null, "error"), { owner: true, source: "unavailable" })).toBeNull();
  expect(trackedChipSide("human", route(null, "owner-unverified"), { owner: false, source: "local" })).toBe("source");
  // A work session card opens the work session.
  expect(trackedChipSide("session", route("worker"), both)).toBe("source");
  // A session that cannot take replies leaves the coordinator, where the fallback goes.
  expect(trackedChipSide("session", route(null, "closed", "owner"), both)).toBe("owner");
  expect(trackedChipSide("session", route(null, "missing", "owner"), { owner: true, source: undefined })).toBe("owner");
  // A live session on another host or project can still be opened to answer there.
  expect(trackedChipSide("session", route(null, "other-host", "owner"), { owner: true, source: "remote" })).toBe("source");
  expect(trackedChipSide("session", route(null, "other-project", "owner"), both)).toBe("source");
  expect(trackedChipSide("session", route(null, "other-host", "owner"), { owner: true, source: "unavailable" })).toBe("owner");
  // An ended work session keeps no chip of its own. With no coordinator to open, only the reason shows.
  expect(trackedChipSide("session", route(null, "closed"), { owner: false, source: "local" })).toBeNull();
  expect(trackedChipSide("session", route(null, "error", "owner"), { owner: true, source: "local" })).toBe("owner");
  // The ledger owner is closed too, so nothing takes a redirected reply: no coordinator chip either.
  expect(trackedChipSide("session", route(null, "closed", null), { owner: true, source: "local" })).toBeNull();
  expect(trackedChipSide("session", route(null, "no-session", null), { owner: true, source: undefined })).toBeNull();
  expect(trackedChipSide("session", undefined, { owner: false, source: undefined })).toBeNull();
});

test("a blocked card offers the fallback in place of Send, and no form when nothing can take the reply", () => {
  const route = (recipientId: string | null, fallbackId: string | null) => ({ recipientId, fallbackId });
  expect(trackedReplyOffer(route("worker", "owner"), false, false)).toEqual({ send: true, fallback: false, form: true });
  expect(trackedReplyOffer(route(null, "owner"), false, false)).toEqual({ send: false, fallback: true, form: true });
  // A redirected reply awaiting its check retries only through the fallback.
  expect(trackedReplyOffer(route("worker", "owner"), true, false)).toEqual({ send: false, fallback: true, form: true });
  expect(trackedReplyOffer(route(null, null), false, false)).toEqual({ send: false, fallback: false, form: false });
  expect(trackedReplyOffer(undefined, false, false).form).toBe(false);
  // Something already written stays on screen even when no session can take it now.
  expect(trackedReplyOffer(route(null, null), false, true)).toEqual({ send: false, fallback: false, form: true });
});

test("cards never offer a way to close a record without sending", () => {
  const root = join(import.meta.dir, "..");
  const sources = (folder: string): string[] => readdirSync(join(root, folder), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? entry.name === "vendor" ? [] : sources(join(folder, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(folder, entry.name)] : []);
  const removed = [/보드에만 저장/, /Save on board only/, /기록 닫기/, /Close record/, /"확인했어요"\s*,\s*"I checked this"\)\s*;?\s*$/m, /type="checkbox"/,
    /acknowledge\("(?:save|review)"\)/];
  for (const file of sources("client")) {
    const text = readFileSync(join(root, file), "utf8");
    for (const pattern of removed) expect({ file, found: pattern.test(text) }).toEqual({ file, found: false });
  }
  // Every resolve call from a card names the session that takes the reply.
  const card = readFileSync(join(root, "client", "tracked-decisions.tsx"), "utf8");
  const calls = card.split("await resolve(").slice(1).map(call => call.slice(0, call.indexOf("});")));
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call).toContain("recipientId: to");
});

test("a card's steps show on its face: all of five or fewer, the first three of more", () => {
  const steps = (count: number) => Array.from({ length: count }, (_, index) => "step " + (index + 1));
  expect(visibleSteps([], false)).toEqual({ shown: [], more: 0 });
  expect(visibleSteps(steps(5), false)).toEqual({ shown: steps(5), more: 0 });
  expect(visibleSteps(steps(6), false)).toEqual({ shown: steps(3), more: 6 });
  expect(visibleSteps(steps(6), true)).toEqual({ shown: steps(6), more: 0 });
});

test("steps sit under the recommendation and leave the folded evidence", () => {
  const card = readFileSync(join(import.meta.dir, "..", "client", "tracked-decisions.tsx"), "utf8");
  const evidence = card.slice(card.indexOf("{expanded && <View"));
  expect(evidence).not.toContain("item.steps");
  const face = card.slice(0, card.indexOf("{expanded && <View"));
  expect(card).toContain("visibleSteps(item.steps");
  // Rendered right after the one-line recommendation, before the reply form.
  expect(face.indexOf("steps.shown.map")).toBeGreaterThan(face.indexOf('t("추천", "Recommendation")'));
  expect(face.indexOf("steps.shown.map")).toBeLessThan(face.indexOf("{queue && <View"));
});

test("the header shows how long the card waited and its due date only when it has one", () => {
  const now = new Date(2026, 10, 25, 12, 0).getTime();
  const at = (days: number, hours = 0) => new Date(2026, 10, 25 + days, 12 + hours).toISOString();
  expect(recordHeaderParts({ since: at(0, -3), dueAt: null }, ko, now)).toEqual(["3시간 대기"]);
  expect(recordHeaderParts({ since: at(0, -3), dueAt: null }, en, now)).toEqual(["waiting 3h"]);
  // No due date: no "No deadline" text.
  expect(recordHeaderParts({ since: undefined, dueAt: undefined }, ko, now)).toEqual([]);
  expect(recordHeaderParts({ since: undefined, dueAt: "2026-11-27" }, ko, now)).toEqual(["기한 11월 27일"]);
  expect(recordHeaderParts({ since: undefined, dueAt: "2026-11-27" }, en, now)).toEqual(["Due Nov 27"]);
  // A date-only due day is not overdue until the day ends.
  expect(recordHeaderParts({ since: undefined, dueAt: "2026-11-25" }, ko, now)).toEqual(["기한 11월 25일"]);
  expect(recordHeaderParts({ since: undefined, dueAt: "2026-11-24" }, en, now)).toEqual(["Overdue · Nov 24"]);
  const timed = new Date(2026, 10, 25, 15, 30).toISOString();
  expect(recordHeaderParts({ since: undefined, dueAt: timed }, ko, now)).toEqual(["기한 11월 25일 15:30"]);
  expect(recordHeaderParts({ since: at(-2), dueAt: "not a date" }, ko, now)).toEqual(["2일 대기"]);
});

test("a step that numbers itself shows its number once", () => {
  expect(stepText("1. Sign in", 0)).toBe("Sign in");
  expect(stepText("2) 도메인 열기", 1)).toBe("도메인 열기");
  expect(stepText("3 터미널에서 실행", 2)).toBe("터미널에서 실행");
  expect(stepText("  4.  Check expiry", 3)).toBe("Check expiry");
  // A number that is not this step's place is part of the text.
  expect(stepText("3. Go back to step 3", 0)).toBe("3. Go back to step 3");
  expect(stepText("2026년 설정 확인", 0)).toBe("2026년 설정 확인");
  expect(stepText("10개 파일 확인", 9)).toBe("10개 파일 확인");
  expect(stepText("1.5배로 늘리기", 0)).toBe("1.5배로 늘리기");
  expect(stepText("`npm test` 실행", 0)).toBe("`npm test` 실행");
});

test("answer drafts: choosing, typing, writing, skipping and recommended picks keep one answer per question", () => {
  const a = optionId(option("A", "a")), b = optionId(option("B", "b")), c = optionId(option("C", "c"));
  let draft = emptyAnswers;
  // A single choice replaces the earlier one and clears a typed answer, a skip and the open writing field.
  draft = typeAnswer(draft, 0, "own words");
  draft = skipQuestion(draft, 1);
  draft = startWriting(draft, 2);
  draft = chooseAnswer(draft, 0, a, false);
  draft = chooseAnswer(draft, 0, b, false);
  expect(draft.selected[0]).toEqual([b]);
  expect(draft.typed[0]).toBeUndefined();
  // Multi-choice toggles.
  draft = chooseAnswer(draft, 3, a, true);
  draft = chooseAnswer(draft, 3, c, true);
  draft = chooseAnswer(draft, 3, a, true);
  expect(draft.selected[3]).toEqual([c]);
  // Choosing on a skipped question undoes the skip; choosing closes the writing field.
  expect(chooseAnswer(draft, 1, a, false).skipped[1]).toBe(false);
  expect(draft.writing[2]).toBe(true);
  expect(chooseAnswer(draft, 2, a, false).writing[2]).toBe(false);
  // Typing clears the choice.
  expect(typeAnswer(draft, 0, "x").selected[0]).toEqual([]);
  // Writing opens an empty field without dropping what was typed.
  expect(startWriting(typeAnswer(draft, 4, "kept"), 4).typed[4]).toBe("kept");
  expect(startWriting(draft, 5)).toMatchObject({ typed: { 5: "" }, selected: { 5: [] }, writing: { 5: true } });
  // A skip clears the answer; a second press undoes it.
  const skipped = skipQuestion(draft, 0);
  expect(skipped).toMatchObject({ skipped: { 0: true }, selected: { 0: [] } });
  expect(skipped.typed[0]).toBeUndefined();
  expect(skipQuestion(skipped, 0).skipped[0]).toBe(false);
  // Recommended picks overwrite only the questions they fill, and undo their typed answers and skips.
  const picked = applyPicks(typeAnswer(skipQuestion(draft, 6), 7, "mine"), { 6: [a] });
  expect(picked.selected[6]).toEqual([a]);
  expect(picked.skipped[6]).toBe(false);
  expect(picked.typed[7]).toBe("mine");
  expect(picked.selected[0]).toEqual([b]);
});

test("the step after an answer: a single choice or a skip moves on, other answers wait for Next", () => {
  const single = question("one", [option("A", "a")]);
  const multi = question("many", [option("A", "a")], true);
  // The question just answered counts as answered, even before the new draft is on screen.
  expect(stepAfterAnswer(true, single, [false, false, false], 0, "choose")).toBe(1);
  expect(stepAfterAnswer(true, single, [false, true, true], 0, "choose")).toBe("summary");
  expect(stepAfterAnswer(true, multi, [false, false], 0, "choose")).toBeNull();
  expect(stepAfterAnswer(true, single, [false, false], 0, "skip")).toBe(1);
  expect(stepAfterAnswer(true, single, [true, false], 0, "unskip")).toBeNull();
  // A card that shows all questions at once never moves.
  expect(stepAfterAnswer(false, single, [false, false], 0, "choose")).toBeNull();
});

test("a stepped question field stays inside the photo wrapper so paste and drop attach photos", () => {
  // With a field on screen, it is wrapped and the attach button follows More.
  expect(photoPlacement(true, true, false)).toEqual({ wrapField: true, fieldControls: false, extrasComposer: false });
  expect(photoPlacement(true, true, true)).toEqual({ wrapField: true, fieldControls: true, extrasComposer: false });
  // With no field, More holds the attach button on its own.
  expect(photoPlacement(true, false, true)).toEqual({ wrapField: false, fieldControls: false, extrasComposer: true });
  expect(photoPlacement(true, false, false)).toEqual({ wrapField: false, fieldControls: false, extrasComposer: false });
  // The one-question form keeps its field and attach button together.
  expect(photoPlacement(false, true, false)).toEqual({ wrapField: true, fieldControls: true, extrasComposer: false });
});
