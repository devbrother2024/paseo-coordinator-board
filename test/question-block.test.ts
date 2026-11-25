import { expect, test } from "bun:test";
import {
  applyBlockChoice, blockPicks, MAX_BLOCK_LENGTH, questionBlockSchema, splitQuestionBlock,
} from "../shared/question-block";

const fence = (body: unknown) => "```board-question\n" + (typeof body === "string" ? body : JSON.stringify(body, null, 2)) + "\n```";
const sample = {
  questions: [
    { id: "Q1", text: "Where should the cache live?", options: [
      { key: "A", text: "Memory", does: "Keeps it in the process", pros: "Fast", cons: "Lost on restart", recommended: true },
      { key: "B", text: "Disk" },
    ] },
    { id: "Q2", text: "Which checks should run?", multi: true, options: [
      { key: "A", text: "Unit", recommended: true }, { key: "B", text: "Lint", recommended: true }, { key: "C", text: "End to end" },
    ] },
  ],
  recommend: "A for Q1. Memory is enough at this size.",
  recommendedReply: "Go with A for Q1.\nRun unit and lint.",
};
const block = splitQuestionBlock(fence(sample)).block!;

test("a block at the end of a message is read and taken out of the text", () => {
  const read = splitQuestionBlock("I compared two places for the cache.\n\n" + fence(sample) + "\n  ");
  expect(read.text).toBe("I compared two places for the cache.");
  expect(read.block).toEqual({
    questions: [
      { id: "Q1", text: "Where should the cache live?", multi: false, options: [
        { key: "A", text: "Memory", recommended: true, does: "Keeps it in the process", pros: "Fast", cons: "Lost on restart" },
        { key: "B", text: "Disk", recommended: false },
      ] },
      { id: "Q2", text: "Which checks should run?", multi: true, options: [
        { key: "A", text: "Unit", recommended: true }, { key: "B", text: "Lint", recommended: true }, { key: "C", text: "End to end", recommended: false },
      ] },
    ],
    recommend: "A for Q1. Memory is enough at this size.",
    recommendedReply: "Go with A for Q1.\nRun unit and lint.",
  });
  expect(questionBlockSchema.safeParse(read.block).success).toBe(true);
  // Unknown fields and empty optional ones are dropped, and a question may come without options.
  const loose = splitQuestionBlock(fence({ note: "x", questions: [{ text: "Anything to add?", owner: "y", options: [] }], recommend: null })).block;
  expect(loose).toEqual({ questions: [{ text: "Anything to add?", multi: false, options: [] }] });
  // A message that is only a block keeps the block and leaves no text.
  expect(splitQuestionBlock(fence(sample)).text).toBe("");
});

test("a malformed, oversized or misplaced block is ignored", () => {
  const untouched = (message: string) => expect(splitQuestionBlock(message)).toEqual({ text: message });
  untouched("No block here.");
  untouched(fence("{ not json"));
  untouched(fence([1, 2]));
  untouched(fence({ questions: [] }));
  untouched(fence({ questions: [{ text: "" , options: [] }] }));
  untouched(fence({ questions: [{ text: "Q", options: [{ key: "A" }] }] }));
  untouched(fence({ questions: [{ text: "Q", options: [{ key: "A", text: "x", recommended: "yes" }] }] }));
  // The same key twice in a question, or the same question label twice, cannot be told apart in a reply.
  untouched(fence({ questions: [{ text: "Q", options: [{ key: "A", text: "x" }, { key: "A", text: "y" }] }] }));
  untouched(fence({ questions: [{ text: "Q", options: [] }, { text: "Q", options: [] }] }));
  // Limits: counts, field lengths and the whole block.
  untouched(fence({ questions: Array.from({ length: 9 }, (_, i) => ({ text: "Q" + i, options: [] })) }));
  untouched(fence({ questions: [{ text: "Q", options: Array.from({ length: 9 }, (_, i) => ({ key: "K" + i, text: "x" })) }] }));
  untouched(fence({ questions: [{ text: "x".repeat(501), options: [] }] }));
  untouched(fence({ questions: [{ text: "Q", options: [{ key: "k".repeat(17), text: "x" }] }] }));
  untouched(fence({ questions: [{ text: "Q", options: [] }], recommendedReply: "x".repeat(2001) }));
  untouched(fence({ questions: [{ text: "Q", options: [] }], pad: "x".repeat(MAX_BLOCK_LENGTH) }));
  // Only the last thing in the message counts, and only under the exact name.
  untouched(fence(sample) + "\n\nOne more thing after the block.");
  untouched("```json\n" + JSON.stringify(sample) + "\n```");
  untouched("Example:\n\n" + fence(sample) + "\n\n" + fence(sample).replace("board-question", "text"));
});

test("only a block that stands on its own at the very end counts, whatever the message quotes before it", () => {
  // An earlier block quoted in the body is an example. The one at the end is the question.
  const earlier = fence({ questions: [{ text: "An old question?", options: [] }] });
  const quoted = splitQuestionBlock("Last time I asked:\n\n" + earlier + "\n\nNow the real one.\n\n" + fence(sample));
  expect(quoted.block?.questions[0].text).toBe("Where should the cache live?");
  expect(quoted.text).toBe("Last time I asked:\n\n" + earlier + "\n\nNow the real one.");
  // Other code blocks before it do not get in the way either.
  expect(splitQuestionBlock("Run this:\n\n```sh\nnpm test\n```\n\n~~~\nplain\n~~~\n\n" + fence(sample)).block).toBeDefined();
  // A block inside another fence is part of that fence: closed, left open, or opened with a longer or other marker.
  const untouched = (message: string) => expect(splitQuestionBlock(message)).toEqual({ text: message });
  untouched("How to ask:\n\n````markdown\n" + fence(sample) + "\n````");
  untouched("How to ask:\n\n````markdown\n" + fence(sample));
  untouched("How to ask:\n\n~~~\n" + fence(sample));
  untouched("How to ask:\n\n```\nexample\n" + fence(sample));
  // A block left open, or indented as part of a list or quote, is not one.
  untouched("Text\n\n```board-question\n" + JSON.stringify(sample));
  untouched("Text\n\n> " + fence(sample).split("\n").join("\n> "));
  // Windows line endings read the same.
  expect(splitQuestionBlock(("Text\n\n" + fence(sample)).replace(/\n/g, "\r\n")).block?.questions).toHaveLength(2);
});

test("control characters are removed before the block is shown", () => {
  const read = splitQuestionBlock(fence({
    questions: [{ id: "Q‮1", text: "Which\u0000 one\n  is it?", options: [{ key: "A⁦", text: "First\u0007", does: "line\none" }] }],
    recommend: "Take‪ A",
    recommendedReply: "A\u0000 please.\r\nThanks⁩.",
  })).block!;
  expect(read.questions[0]).toEqual({ id: "Q 1", text: "Which one is it?", multi: false,
    options: [{ key: "A", text: "First", recommended: false, does: "line one" }] });
  expect(read.recommend).toBe("Take A");
  expect(read.recommendedReply).toBe("A please.\nThanks.");
});

test("choosing an option writes that question's line, and the text says what is chosen", () => {
  let text = applyBlockChoice("", block, 0, "A");
  expect(text).toBe("Q1 · Where should the cache live?: A · Memory");
  expect(blockPicks(text, block)).toEqual({ 0: ["A"] });
  // A single-choice question swaps its option. A multiple-choice question adds and removes them in option order.
  text = applyBlockChoice(text, block, 0, "B");
  expect(text).toBe("Q1 · Where should the cache live?: B · Disk");
  text = applyBlockChoice(text, block, 1, "C");
  text = applyBlockChoice(text, block, 1, "A");
  expect(text).toBe("Q1 · Where should the cache live?: B · Disk\nQ2 · Which checks should run?: A · Unit, C · End to end");
  expect(blockPicks(text, block)).toEqual({ 0: ["B"], 1: ["A", "C"] });
  // What the person wrote stays, and an earlier question's line goes above a later one's.
  const written = applyBlockChoice("Q2 · Which checks should run?: C · End to end\n\nAlso, why not Redis?", block, 0, "A");
  expect(written).toBe("Q1 · Where should the cache live?: A · Memory\nQ2 · Which checks should run?: C · End to end\n\nAlso, why not Redis?");
  expect(applyBlockChoice("Why not Redis?", block, 1, "B")).toBe("Q2 · Which checks should run?: B · Lint\nWhy not Redis?");
  // Pressing the chosen option again removes its line. A line the person rewrote is no longer a choice.
  expect(applyBlockChoice("Q1 · Where should the cache live?: A · Memory\nWhy?", block, 0, "A")).toBe("Why?");
  expect(blockPicks("Q1 · Where should the cache live?: neither, use Redis", block)).toEqual({});
  expect(blockPicks("Q2 · Which checks should run?: A · Unit, and one of my own", block)).toEqual({ 1: ["A"] });
  expect(applyBlockChoice(text, block, 0, "missing")).toBe(text);
  // What the person added to a line stays when another option is chosen or the choice is taken back.
  const qualified = "Q2 · Which checks should run?: A · Unit, but do not run against production";
  expect(applyBlockChoice(qualified, block, 1, "C")).toBe("Q2 · Which checks should run?: A · Unit, C · End to end, but do not run against production");
  expect(applyBlockChoice(qualified, block, 1, "A")).toBe("Q2 · Which checks should run?: but do not run against production");
  expect(applyBlockChoice("Q1 · Where should the cache live?: neither, use Redis", block, 0, "B")).toBe("Q1 · Where should the cache live?: B · Disk, neither, use Redis");
  expect(blockPicks("Q1 · Where should the cache live?: B · Disk, neither, use Redis", block)).toEqual({ 0: ["B"] });
});
