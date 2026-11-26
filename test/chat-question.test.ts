import { expect, test } from "bun:test";
import { CHAT_QUESTION_KIND, chatQuestionItem, chatQuestionSchema } from "../shared/chat-question";

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
