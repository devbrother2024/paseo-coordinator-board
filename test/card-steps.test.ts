import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  advancesOnChoice, answerSummary, clampStep, firstOpenStep, foldsAsk, foldsCard, isHumanCheck, nextOpenStep, recommendAllPicks,
  trackedChipSide, trackedReplyOffer, trackedSuggestion, usesSteps,
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
  expect(foldsCard(record({ questions: ten }))).toBe(true);
  expect(foldsCard(record({ questions: [ten[0]] }))).toBe(false);
  expect(foldsCard(record())).toBe(false);
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
  expect(trackedChipSide("human", route(null, "closed"), both)).toBe("owner");
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
  expect(trackedChipSide("session", route(null, "closed"), { owner: false, source: "local" })).toBe("source");
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
