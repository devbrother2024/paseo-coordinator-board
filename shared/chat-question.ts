import { z } from "zod";
import { questionBlockSchema, splitQuestionBlock } from "./question-block";

// A session's own conversation draws its message with the code block as written, so a `board-question` block shows
// as raw JSON there. The board replaces a finished message that ends in a valid block with one that shows the text
// and the options, which fill the session's input like the board card does.
export const CHAT_QUESTION_KIND = "board-question-message";
export const chatQuestionSchema = z.object({ text: z.string(), block: questionBlockSchema });
export type ChatQuestion = z.infer<typeof chatQuestionSchema>;

// The timeline item for a session message, or nothing to leave the message as Paseo draws it. A message still being
// written is left alone: its block may not be closed yet, and the text should not jump while it streams.
export function chatQuestionItem(text: string, phase: "streaming" | "complete") {
  // Every message of every open session passes here on each render, so most leave before the fence scan.
  if (phase !== "complete" || !text.includes("board-question")) return undefined;
  const split = splitQuestionBlock(text.trim());
  if (!split.block) return undefined;
  const data: ChatQuestion = { text: split.text, block: split.block };
  return { items: [{ type: "plugin" as const, kind: CHAT_QUESTION_KIND, version: 1, data }] };
}
