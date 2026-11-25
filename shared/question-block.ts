import { z } from "zod";

// A question block is a fenced code block named `board-question` at the very end of a session's message. Its JSON lists
// the questions and options the session asks the person to choose from. The board draws them like a ledger card.
export const MAX_BLOCK_LENGTH = 12000;
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 8;
const limits = { id: 24, question: 500, key: 16, option: 300, detail: 400, recommend: 600, reply: 2000 };

const option = z.object({
  key: z.string().min(1).max(limits.key), text: z.string().min(1).max(limits.option), recommended: z.boolean(),
  does: z.string().min(1).max(limits.detail).optional(), pros: z.string().min(1).max(limits.detail).optional(),
  cons: z.string().min(1).max(limits.detail).optional(),
});
const question = z.object({
  id: z.string().min(1).max(limits.id).optional(), text: z.string().min(1).max(limits.question), multi: z.boolean(),
  options: z.array(option).max(MAX_OPTIONS),
});
export const questionBlockSchema = z.object({
  questions: z.array(question).min(1).max(MAX_QUESTIONS),
  recommend: z.string().min(1).max(limits.recommend).optional(),
  recommendedReply: z.string().min(1).max(limits.reply).optional(),
});
export type QuestionBlock = z.output<typeof questionBlockSchema>;
export type BlockQuestion = QuestionBlock["questions"][number];
export type BlockOption = BlockQuestion["options"][number];

// What the session wrote, before cleaning. Unknown fields are dropped; a wrong type rejects the block.
const text = z.string().nullish();
const written = z.object({
  questions: z.array(z.object({
    id: text, text: z.string(), multi: z.boolean().nullish(),
    options: z.array(z.object({ key: z.string(), text: z.string(), recommended: z.boolean().nullish(), does: text, pros: text, cons: text })).nullish(),
  })),
  recommend: text, recommendedReply: text,
});

const unsafe = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/g;
const oneLine = (value: string | null | undefined) => (value ?? "").replace(unsafe, " ").replace(/\s+/g, " ").trim();
// A reply to send keeps its line breaks.
const lines = (value: string | null | undefined) => (value ?? "").replace(/\r\n?/g, "\n")
  .replace(/[\u0000-\u0009\u000b-\u001f\u007f‪-‮⁦-⁩]/g, "").split("\n").map(line => line.trimEnd()).join("\n").trim();
const optional = <K extends string>(key: K, value: string) => (value ? { [key]: value } : {}) as { [P in K]?: string };

export const blockQuestionLabel = (item: Pick<BlockQuestion, "id" | "text">) => [item.id, item.text].filter(Boolean).join(" · ");
const optionText = (item: Pick<BlockOption, "key" | "text">) => item.key + " · " + item.text;

function readBlock(body: string): QuestionBlock | null {
  if (body.length > MAX_BLOCK_LENGTH) return null;
  let data: unknown;
  try { data = JSON.parse(body); } catch { return null; }
  const raw = written.safeParse(data);
  if (!raw.success) return null;
  const cleaned = {
    questions: raw.data.questions.map(item => ({
      ...optional("id", oneLine(item.id)), text: oneLine(item.text), multi: item.multi ?? false,
      options: (item.options ?? []).map(choice => ({
        key: oneLine(choice.key), text: oneLine(choice.text), recommended: choice.recommended ?? false,
        ...optional("does", oneLine(choice.does)), ...optional("pros", oneLine(choice.pros)), ...optional("cons", oneLine(choice.cons)),
      })),
    })),
    ...optional("recommend", oneLine(raw.data.recommend)), ...optional("recommendedReply", lines(raw.data.recommendedReply)),
  };
  const block = questionBlockSchema.safeParse(cleaned);
  if (!block.success) return null;
  // A reply names a question by its label and an option by its key, so neither may repeat.
  const labels = block.data.questions.map(blockQuestionLabel);
  if (new Set(labels).size !== labels.length) return null;
  for (const item of block.data.questions) {
    if (new Set(item.options.map(choice => choice.key)).size !== item.options.length) return null;
  }
  return block.data;
}

// The last code block that stands on its own (outside any other fence), when it is closed, named `board-question` and
// followed by nothing. A block quoted earlier in the message, or one inside another fence, is not the question.
function lastBlock(rows: readonly string[]) {
  let open: { mark: string; size: number; info: string; start: number; own: boolean } | null = null;
  let last: { info: string; start: number; end: number; own: boolean } | null = null;
  rows.forEach((row, index) => {
    const fence = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(row);
    if (!fence) return;
    const [, indent, marks, rest] = fence;
    if (open) {
      // Only a bare fence of the same kind, at least as long, closes the open one.
      if (marks[0] === open.mark && marks.length >= open.size && !rest.trim()) { last = { ...open, end: index }; open = null; }
    } else if (marks[0] !== "`" || !rest.includes("`")) {
      open = { mark: marks[0], size: marks.length, info: rest.trim(), start: index, own: !indent && marks[0] === "`" };
    }
  });
  const found = last as { info: string; start: number; end: number; own: boolean } | null;
  if (open || !found || !found.own || found.info !== "board-question") return null;
  return rows.slice(found.end + 1).every(row => !row.trim()) ? found : null;
}

// The message without its question block, and the block when it is valid. Anything else leaves the message as it is.
export function splitQuestionBlock(message: string): { text: string; block?: QuestionBlock } {
  const rows = message.split(/\r?\n/);
  const found = lastBlock(rows);
  const block = found && readBlock(rows.slice(found.start + 1, found.end).join("\n"));
  if (!found || !block) return { text: message };
  return { text: rows.slice(0, found.start).join("\n").trimEnd(), block };
}

const prefix = (item: BlockQuestion) => blockQuestionLabel(item) + ": ";

// The options a question's line names, read in option order, and whatever the person wrote after them.
function chosen(line: string, item: BlockQuestion) {
  let rest = line.slice(prefix(item).length);
  const keys: string[] = [];
  for (const choice of item.options) {
    const label = optionText(choice);
    if (rest === label) { keys.push(choice.key); rest = ""; }
    else if (rest.startsWith(label + ", ")) { keys.push(choice.key); rest = rest.slice(label.length + 2); }
  }
  return { keys, rest };
}

const lineOf = (rows: readonly string[], item: BlockQuestion) => rows.findIndex(row => row.startsWith(prefix(item)));

// Which options are chosen, read from the text in the card's input. The text is the only record of the choice.
export function blockPicks(text: string, block: QuestionBlock): Record<number, string[]> {
  const rows = text.split("\n");
  const picks: Record<number, string[]> = {};
  block.questions.forEach((item, index) => {
    const at = lineOf(rows, item);
    const keys = at < 0 ? [] : chosen(rows[at], item).keys;
    if (keys.length) picks[index] = keys;
  });
  return picks;
}

function writeLine(text: string, block: QuestionBlock, index: number, keys: readonly string[]) {
  const item = block.questions[index];
  const picked = item.options.filter(choice => keys.includes(choice.key));
  const rows = text ? text.split("\n") : [];
  const at = lineOf(rows, item);
  // What the person added to the line (a condition, an answer of their own) stays after the options.
  const written = at < 0 ? "" : chosen(rows[at], item).rest;
  const parts = [...picked.map(optionText), ...(written ? [written] : [])];
  const line = parts.length ? prefix(item) + parts.join(", ") : null;
  if (at >= 0) {
    if (line) rows[at] = line; else rows.splice(at, 1);
  } else if (line) {
    // Answers stay in question order above anything else the person wrote.
    const placed = block.questions.map(other => lineOf(rows, other));
    const before = Math.max(-1, ...placed.slice(0, index));
    const after = placed.slice(index + 1).filter(position => position >= 0);
    rows.splice(before >= 0 ? before + 1 : after.length ? Math.min(...after) : 0, 0, line);
  }
  return rows.join("\n").replace(/^\n+/, "");
}

// Pressing an option fills the card's input. A single-choice question swaps its option, a multiple-choice one toggles it,
// and pressing the only chosen option again removes the line.
export function applyBlockChoice(text: string, block: QuestionBlock, index: number, key: string) {
  const item = block.questions[index];
  if (!item?.options.some(choice => choice.key === key)) return text;
  const current = blockPicks(text, block)[index] ?? [];
  const next = current.includes(key) ? current.filter(other => other !== key) : item.multi ? [...current, key] : [key];
  return writeLine(text, block, index, next);
}
