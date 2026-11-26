import { expect, test } from "bun:test";
import { BOARD_REPLY_KIND, boardReply, boardReplyItem, boardReplyMessageSchema, CHAT_QUESTION_KIND, answerPicks, foldedAnswer, chatQuestionItem, chatQuestionSchema, messageKey, questionAnswer } from "../shared/chat-question";

const block = "```board-question\n" + JSON.stringify({ questions: [
  { id: "Q1", text: "Where should the cache live?", options: [{ key: "A", text: "Memory", recommended: true }, { key: "B", text: "Disk" }] },
], recommendedReply: "Go with A." }, null, 2) + "\n```";

test("a finished message ending in a question block is drawn as text and options instead of raw JSON", () => {
  const result = chatQuestionItem("I compared two places.\n\nPlease choose one.\n\n" + block + "\n", "complete");
  expect(result?.items).toHaveLength(1);
  const item = result!.items[0];
  expect(item).toMatchObject({ type: "plugin", kind: CHAT_QUESTION_KIND, version: 1 });
  expect(item.data.text).toBe("I compared two places.\n\nPlease choose one.");
  expect(item.data.text).not.toContain("board-question");
  expect(item.data.block.questions[0].options.map(option => option.text)).toEqual(["Memory", "Disk"]);
  expect(item.data.block.recommendedReply).toBe("Go with A.");
  // What the renderer validates is what the transformer wrote.
  expect(chatQuestionSchema.safeParse(item.data).success).toBe(true);
});

test("a message without a valid block, or one still streaming, is left as Paseo draws it", () => {
  expect(chatQuestionItem("No block here.", "complete")).toBeUndefined();
  expect(chatQuestionItem("Text\n\n```board-question\n{ nope\n```", "complete")).toBeUndefined();
  expect(chatQuestionItem("Text\n\n```json\n{}\n```", "complete")).toBeUndefined();
  expect(chatQuestionItem("Text\n\n" + block, "streaming")).toBeUndefined();
  // An example inside another fence is part of that fence, not a question.
  expect(chatQuestionItem("How to ask:\n\n````markdown\n" + block + "\n````", "complete")).toBeUndefined();
});

const asked = "I compared two places.\n\n" + block;
const reply = "[Coordinator Board · app · Cache]\n" + JSON.stringify({ cardId: "c", action: "reply", questions: [] }) + "\n\nQ1 · Where should the cache live?: A · Memory";
const said = (type: string, text: string) => ({ item: { type, text } });

test("a question message is answered by the first message from the person after it", () => {
  const key = chatQuestionItem(asked, "complete")!.items[0].data.key;
  expect(key).toBe(messageKey(asked.trim()));
  // Nothing from the person yet: still open, also with the session's later work in between.
  expect(questionAnswer([said("user_message", "Start"), said("assistant_message", asked)], key)).toEqual({ state: "open" });
  expect(questionAnswer([said("assistant_message", asked), { item: { type: "tool_call" } }], key)).toEqual({ state: "open" });
  // A board reply: the person's words without the board's heading and context.
  expect(questionAnswer([said("assistant_message", asked), said("reasoning", "x"), said("user_message", reply)], key))
    .toEqual({ state: "answered", reply: "Q1 · Where should the cache live?: A · Memory", viaBoard: true });
  // A message typed in the session answers it only when it names an option.
  expect(questionAnswer([said("assistant_message", asked), said("user_message", "Q1은 B로 해 주세요")], key))
    .toEqual({ state: "answered", reply: "Q1은 B로 해 주세요", viaBoard: false });
  expect(questionAnswer([said("assistant_message", asked), said("user_message", "B로 해")], key))
    .toEqual({ state: "answered", reply: "B로 해", viaBoard: false });
  // 2026-11-26: a later request about something else is not an answer; the question stays open.
  const other = "And the second table on the board breaks. Let's check that too.";
  expect(questionAnswer([said("assistant_message", asked), said("user_message", other)], key)).toEqual({ state: "open" });
  expect(questionAnswer([said("assistant_message", asked), said("user_message", "Go with disk")], key)).toEqual({ state: "open" });
  // A board reply in words only (a question about the card) does not answer it either.
  const asking = reply.replace("Q1 · Where should the cache live?: A · Memory", "Why not disk?");
  expect(questionAnswer([said("assistant_message", asked), said("user_message", asking)], key)).toEqual({ state: "open" });
  // A follow-up first, the answer later: the answer is the later one.
  expect(questionAnswer([said("assistant_message", asked), said("user_message", other), said("user_message", "Q1: A")], key))
    .toEqual({ state: "answered", reply: "Q1: A", viaBoard: false });
  // The same question asked again later is the one that counts.
  expect(questionAnswer([said("assistant_message", asked), said("user_message", "Hm"), said("assistant_message", asked)], key)).toEqual({ state: "open" });
  // Out of the record read, it is not called answered.
  expect(questionAnswer([said("user_message", "Q1은 A")], key)).toEqual({ state: "unknown" });
});

test("only the board's own reply shape is read as a board reply", () => {
  expect(boardReply(reply)).toEqual({ heading: "app · Cache", answer: "Q1 · Where should the cache live?: A · Memory" });
  expect(boardReply("Just words")).toBeNull();
  expect(boardReply("[Coordinator Board · x]\n{not json}\n\nhi")).toBeNull();
  expect(boardReply("[Coordinator Board · x]\n{\"cardId\":\"c\"}\n\nhi")).toBeNull();
  expect(messageKey("a")).not.toBe(messageKey("b"));
});

test("a board reply in the conversation shows the person's words and keeps the full message behind a toggle", () => {
  const item = boardReplyItem(reply)!.items[0];
  expect(item).toMatchObject({ type: "plugin", kind: BOARD_REPLY_KIND, version: 1,
    data: { heading: "app · Cache", answer: "Q1 · Where should the cache live?: A · Memory", text: reply } });
  expect(boardReplyMessageSchema.safeParse(item.data).success).toBe(true);
  // A message the person typed is left as Paseo draws it.
  expect(boardReplyItem("Go with disk")).toBeUndefined();
});

test("a folded question shows the chosen options, never the answer's own words, and folds only on a choice", () => {
  const question = chatQuestionItem(asked, "complete")!.items[0].data.block;
  expect(foldedAnswer({ state: "answered", reply: "Q1 · Where should the cache live?: A · Memory", viaBoard: true }, question))
    .toEqual({ viaBoard: true, picks: { 0: ["A"] } });
  expect(foldedAnswer({ state: "answered", reply: "Q1은 B로", viaBoard: false }, question)).toEqual({ viaBoard: false, picks: { 0: ["B"] } });
  // A pasted clipboard or a follow-up question chooses nothing: the question does not fold.
  const pasted = JSON.stringify({ type: "excalidraw/clipboard", elements: [{ text: "x".repeat(500) }] }) + "\nWhich computer was it?";
  expect(foldedAnswer({ state: "answered", reply: pasted, viaBoard: false }, question)).toBeNull();
  expect(foldedAnswer({ state: "open" }, question)).toBeNull();
  expect(foldedAnswer({ state: "unknown" }, question)).toBeNull();
});

test("which option a reply names", () => {
  const two = { questions: [
    { id: "Q1", text: "Cache?", multi: false, options: [{ key: "A", text: "Memory", recommended: false }, { key: "B", text: "Disk", recommended: false }] },
    { id: "Q2", text: "Checks?", multi: false, options: [{ key: "A", text: "Unit", recommended: false }, { key: "B", text: "Lint", recommended: false }] },
  ] };
  expect(answerPicks("Q1은 A, Q2는 B로 해 주세요", two)).toEqual({ 0: ["A"], 1: ["B"] });
  expect(answerPicks("Q2: A", two)).toEqual({ 1: ["A"] });
  // With two questions a bare key does not say which question it answers.
  expect(answerPicks("A로 해", two)).toEqual({});
  // A key glued to other letters or digits is not a choice, nor is Q10 an answer to Q1.
  expect(answerPicks("Q1 AB", two)).toEqual({});
  expect(answerPicks("Q10 A", two)).toEqual({});
  const one = { questions: [two.questions[0]] };
  expect(answerPicks("A", one)).toEqual({ 0: ["A"] });
  expect(answerPicks("B안으로 가자", one)).toEqual({ 0: ["B"] });
  expect(answerPicks("A2UI 세션 얘기인데", one)).toEqual({});
  expect(answerPicks("이 표가 깨져", one)).toEqual({});
});
