import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { blockPicks, questionBlockSchema, splitQuestionBlock, type QuestionBlock } from "./question-block";

// A session's own conversation draws its message with the code block as written, so a `board-question` block shows
// as raw JSON there. The board replaces a finished message that ends in a valid block with one that shows the text
// and the options, which fill the session's input like the board card does.
export const CHAT_QUESTION_KIND = "board-question-message";
export const chatQuestionSchema = z.object({ key: z.string(), text: z.string(), block: questionBlockSchema });
export type ChatQuestion = z.infer<typeof chatQuestionSchema>;

// The timeline item for a session message, or nothing to leave the message as Paseo draws it. A message still being
// written is left alone: its block may not be closed yet, and the text should not jump while it streams.
export function chatQuestionItem(text: string, phase: "streaming" | "complete") {
  // Every message of every open session passes here on each render, so most leave before the fence scan.
  if (phase !== "complete" || !text.includes("board-question")) return undefined;
  const split = splitQuestionBlock(text.trim());
  if (!split.block) return undefined;
  const data: ChatQuestion = { key: messageKey(text.trim()), text: split.text, block: split.block };
  return { items: [{ type: "plugin" as const, kind: CHAT_QUESTION_KIND, version: 1, data }] };
}

// Names a message by its text, so the board host can find the same message in the session's record. Two FNV-1a
// rounds with different seeds; this is a lookup name, not a security check.
export function messageKey(text: string) {
  let a = 0x811c9dc5, b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0") + text.length.toString(16);
}

// A reply the board sent for a card: its heading line, the board's context as JSON, a blank line, then the person's
// words. Anything else is not one.
export function boardReply(text: string): { heading: string; answer: string } | null {
  const found = /^\[Coordinator Board · ([^\]\n]*)\]\n(\{[^\n]*\})\n\n([\s\S]*)$/.exec(text);
  if (!found) return null;
  try {
    const context = JSON.parse(found[2]);
    if (!context || typeof context !== "object" || typeof context.action !== "string") return null;
  } catch { return null; }
  return { heading: found[1], answer: found[3] };
}

export const chatQuestionStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("open") }),
  z.object({ state: z.literal("answered"), reply: z.string().max(4000), viaBoard: z.boolean() }),
  z.object({ state: z.literal("unknown") }),
]);
export type ChatQuestionState = z.infer<typeof chatQuestionStateSchema>;

type Entry = { item: { type: string; text?: string } };

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The options a reply names, by question. Only these count as an answer, so a later message about something else (a
// new request, a pasted clipboard) does not answer the question:
// - the line the board card or the conversation writes (`Q1 · question: A · option`);
// - a question id followed by an option key (`Q1은 A`, `Q1: A로`, `Q1 A`), for each question with an id;
// - for a block with one question, a reply that is an option key alone or starts with one followed by punctuation
//   or a Korean particle (`A`, `A.`, `A로 해`, `B안으로`). A key followed by a word is not one: "A quick question"
//   starts with the article.
export function answerPicks(reply: string, block: QuestionBlock): Record<number, string[]> {
  const picks = blockPicks(reply, block);
  block.questions.forEach((question, index) => {
    if (picks[index] || !question.options.length) return;
    const keys = question.options.map(option => escape(option.key)).join("|");
    const named = question.id
      ? new RegExp("(?:^|[^A-Za-z0-9])" + escape(question.id) + "\\s*(?:은|는|:|·|=|-)?\\s*(" + keys + ")(?![A-Za-z0-9])").exec(reply)
      : null;
    const lead = block.questions.length === 1
      ? new RegExp("^\\s*(" + keys + ")(?=\\s*$|[.,!)]|\\s*(?:로|으로|안))").exec(reply)
      : null;
    const key = (named ?? lead)?.[1];
    if (key) picks[index] = [key];
  });
  return picks;
}

// Whether the person answered a question message, read from the session's recent record. The message is found by
// its key, and its block is read from it. The first later message from the person that names an option is the
// answer; a message that names none (a new request, a follow-up question) leaves the question open. A message not in
// the record read is unknown, and the question stays open to choose from: it is never shown as answered without the
// answer in hand. Messages from other sessions are not the person's and are not in `user_message`.
export function questionAnswer(entries: readonly Entry[], key: string): ChatQuestionState {
  let at = -1;
  entries.forEach((entry, index) => {
    if (entry.item.type === "assistant_message" && typeof entry.item.text === "string" && messageKey(entry.item.text.trim()) === key) at = index;
  });
  if (at < 0) return { state: "unknown" };
  const block = splitQuestionBlock(entries[at].item.text!.trim()).block;
  if (!block) return { state: "unknown" };
  for (const entry of entries.slice(at + 1)) {
    if (entry.item.type !== "user_message" || typeof entry.item.text !== "string") continue;
    const text = entry.item.text.trim();
    const reply = boardReply(text);
    const words = (reply ? reply.answer : text).trim();
    if (Object.keys(answerPicks(words, block)).length) return { state: "answered", reply: words.slice(0, 4000), viaBoard: !!reply };
  }
  return { state: "open" };
}

export const chatQuestionState = defineRpc({
  name: "board.chat-question-state",
  input: z.strictObject({ sessionId: z.string().min(1).max(256), key: z.string().min(1).max(64) }),
  output: chatQuestionStateSchema,
});

// The board's own replies in a session's conversation show the person's words, not the board's context JSON.
export const BOARD_REPLY_KIND = "board-reply-message";
export const boardReplyMessageSchema = z.object({ heading: z.string(), answer: z.string(), text: z.string() });
export type BoardReplyMessage = z.infer<typeof boardReplyMessageSchema>;

export function boardReplyItem(text: string) {
  const reply = boardReply(text);
  if (!reply) return undefined;
  const data: BoardReplyMessage = { heading: reply.heading, answer: reply.answer, text };
  return { items: [{ type: "plugin" as const, kind: BOARD_REPLY_KIND, version: 1, data }] };
}

// What a folded, answered question shows: where the answer came from and the options it chose. The answer's own words
// are not repeated: they are the person's message right below. Without a chosen option it does not fold.
export function foldedAnswer(state: ChatQuestionState, block: QuestionBlock) {
  if (state.state !== "answered") return null;
  const picks = answerPicks(state.reply, block);
  return Object.keys(picks).length ? { viaBoard: state.viaBoard, picks } : null;
}
