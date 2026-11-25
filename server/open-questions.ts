import type { SessionRow } from "../shared/contract";
import { blockPicks, type BlockQuestion, type QuestionBlock } from "../shared/question-block";
import { questionChoices, type Choice, type LabelDefinition } from "../shared/question-choices";
import { raisedQuestionSchema, type ClosedReason, type Preferences, type RaisedQuestion } from "./preferences";
import { turnQuestion } from "./turn-question";

/**
 * A question the board raised stays until something shows it was handled. Staying by mistake is allowed, leaving by
 * mistake is not. What counts as handled:
 * - board: a reply sent from the board's card arrived in the session (its message id is a board receipt),
 * - session: a later message of the session says so on its own line (`결정 반영: …`, `Decision applied: …`, or that the
 *   question moved to a ledger card),
 * - ledger: a ledger card carried the same question for the same session and is gone now,
 * - person: the person pressed **Close as handled** on the card,
 * - choice: the person wrote to the session an answer that names the card's option or recommended reply.
 * Anything else the person writes marks the question as maybe answered. Messages from other sessions, later messages
 * without a question, time, and a session that stops or ends do not close it.
 */

// An assistant message. `key` names it for the question it may ask. `settles` counts its settling lines.
export type AssistantEvent = {
  role: "assistant"; seq: number; key: string; text: string; truncated?: boolean; at?: string;
  definitions?: LabelDefinition[]; block?: QuestionBlock; settles?: number;
};
// Input the session received without a sender: what a person wrote or a reply the board sent for the person.
export type InputEvent = { role: "user"; seq: number; ids: string[]; text: string; at?: string };
export type QuestionEvent = AssistantEvent | InputEvent;

export type QuestionContext = {
  closed?: Preferences["closedQuestions"];
  boardMessageIds?: ReadonlySet<string>;
  clarificationIds?: ReadonlySet<string>;
  records?: readonly RaisedQuestion[];
  // Questions ledger cards carry for this session. Undefined when the ledger was not read.
  ledgerQuestions?: ReadonlySet<string>;
  now?: number;
};

export type FoundQuestion = {
  key: string; epoch: string; seq: number; question: string; markdown: string; context: string; askedAt?: string;
  later: number; countedSeq?: number; maybeAnswered?: true; moved?: true;
  turn?: AssistantEvent; earlier?: AssistantEvent[]; record?: RaisedQuestion;
};
export type QuestionScan = { epoch?: string; open: FoundQuestion[]; closed: { key: string; reason: ClosedReason; epoch: string; seq: number }[] };

const HOUR = 60 * 60 * 1000;
// Display only: a question reads as old after this many later messages or this long. It never leaves for that.
export const OLD_QUESTION = { later: 15, ageMs: 12 * HOUR };
export const MAX_OPEN_PER_SESSION = 64;
export const MAX_CLOSED = 4000;

const applied = /^(?:결정\s*반영|decision\s+applied)\s*[:：]\s*\S/iu;
const moved = /^(?:질문(?:은|을)?\s+(?:원장\s+)?카드\s*\S{1,80}?\s*(?:으로|로)\s+옮(?:김|겼습니다|겼어요)|(?:the\s+)?question\s+(?:was\s+)?moved\s+to\s+(?:the\s+)?(?:ledger\s+)?card\s+\S.{0,80}?)$/iu;

/** How many lines of a message say a question was handled. Code blocks, quotes and inline code do not count. */
export function settlingLines(text: string) {
  let fenced = false;
  let count = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/^(?:`{3,}|~{3,})/.test(line)) { fenced = !fenced; continue; }
    if (fenced || line.startsWith(">")) continue;
    const plain = line.replace(/^[-*+]\s+/, "").replace(/\*\*/g, "").trim();
    const end = (part: string) => part.replace(/[.。]$/, "").trim();
    const last = plain.split(/(?<=[.!?。！？])\s+/).at(-1) ?? "";
    if (applied.test(plain) || moved.test(end(plain)) || moved.test(end(last))) count++;
  }
  return count;
}

const norm = (value: string) => value.normalize("NFC").replace(/\s+/g, " ").trim().replace(/[.!。！]+$/u, "").trim().toLowerCase();
// "(b)", "b)", "B안", "2번" name the label b, B, 2.
const bare = (value: string) => norm(value).replace(/^[(\[（]\s*/u, "").replace(/\s*[)\]）.]$/u, "").replace(/(?<=\S)(?:안|번)$/u, "").trim();
const parts = (text: string) => text.split(/\n|[,;，]/u).map(norm).filter(Boolean);

function answersOption(rest: string, item: BlockQuestion) {
  return item.options.some(option => {
    const key = norm(option.key), label = norm(option.text);
    return rest === key || bare(rest) === key || rest === label || [" · ", ". ", ": ", ") "].some(join => rest === key + join + label);
  });
}

function answersBlockPart(part: string, item: BlockQuestion, index: number, count: number) {
  const ids = [...new Set([item.id, "q" + (index + 1)].filter((id): id is string => !!id).map(norm))];
  const id = ids.find(name => part === name || new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|[·:：.)\\-])`, "u").test(part));
  if (!id) return count === 1 && answersOption(part, item);
  const rest = part.slice(id.length).replace(/^\s*[·:：.)\-]?\s*/u, "");
  // The line the board's options fill: "Q1 · question?: A · text".
  const filled = rest.match(/[:：]\s*(.+)$/u)?.[1];
  return answersOption(rest, item) || (!!filled && answersOption(filled, item));
}

/** Whether what the person wrote is an answer the card offered: an option's label or text, or the recommended reply. */
export function answersChoices(text: string, question: { block?: QuestionBlock; choices?: readonly Choice[] }) {
  const written = text.trim();
  if (!written) return false;
  const block = question.block;
  if (block) {
    if (block.recommendedReply && norm(written) === norm(block.recommendedReply)) return true;
    if (Object.keys(blockPicks(written, block)).length) return true;
    const pieces = parts(written);
    return pieces.length > 0 && pieces.every(part => block.questions.some((item, index) => answersBlockPart(part, item, index, block.questions.length)));
  }
  const choices = question.choices ?? [];
  const pieces = parts(written);
  return choices.length > 0 && pieces.length === 1 &&
    choices.some(choice => bare(choice.label) === bare(pieces[0]) || norm(choice.markdown) === pieces[0]);
}

function choicesOf(item: FoundQuestion) {
  if (item.turn?.block || item.record?.block) return { block: item.turn?.block ?? item.record!.block };
  if (!item.turn) return { choices: item.record?.choices ?? [] };
  return { choices: questionChoices({ question: item.markdown, context: item.context, message: item.turn, earlier: [...(item.earlier ?? [])].reverse() }).choices };
}

function fromRecord(record: RaisedQuestion): FoundQuestion {
  return { key: record.key, epoch: record.epoch, seq: record.seq, question: record.question, markdown: record.markdown ?? record.question,
    context: record.context ?? "", askedAt: record.askedAt, later: record.later, countedSeq: record.countedSeq ?? record.seq,
    ...(record.maybeAnswered ? { maybeAnswered: true as const } : {}), ...(record.moved ? { moved: true as const } : {}), record };
}

/** The questions still open in a session, from its recent conversation (if read) and the questions the board raised before. */
export function scanQuestions(evidence: { epoch?: string; events?: readonly QuestionEvent[] } | null | undefined, coordinatorDigest = false,
  context: QuestionContext = {}): QuestionScan {
  const epoch = evidence?.epoch ?? "";
  const events = evidence?.events ?? [];
  const closedKeys = context.closed ?? {};
  const records = new Map((context.records ?? []).map(record => [record.key, record]));
  const inWindow = new Set(events.flatMap(event => event.role === "assistant" ? [event.key] : []));
  type Item = FoundQuestion & { closed: boolean };
  const list: Item[] = [];
  const closed: QuestionScan["closed"] = [];
  const close = (item: Item, reason: ClosedReason) => {
    if (item.closed) return;
    item.closed = true;
    closed.push({ key: item.key, reason, epoch: item.epoch, seq: item.seq });
  };
  // Questions asked before the messages read: those still open, and in this timeline also those already closed, so a
  // settling line in the window finds the question it refers to.
  const before = [
    ...[...records.values()].filter(record => !inWindow.has(record.key) && !Object.hasOwn(closedKeys, record.key))
      .map(record => ({ ...fromRecord(record), closed: false })),
    ...Object.entries(closedKeys).filter(([key, entry]) => entry.epoch === epoch && epoch && entry.seq !== undefined && !inWindow.has(key) &&
      events.length > 0 && entry.seq < events[0].seq)
      .map(([key, entry]): Item => ({ key, epoch, seq: entry.seq!, question: "", markdown: "", context: "", later: 0, closed: true })),
  ];
  // Same timeline in order of position, other timelines first in the order they were raised.
  before.sort((a, b) => (a.epoch === epoch ? 1 : 0) - (b.epoch === epoch ? 1 : 0) ||
    (a.epoch === epoch ? a.seq - b.seq : (a.record?.raisedAt ?? "").localeCompare(b.record?.raisedAt ?? "")));
  list.push(...before);
  const assistants: AssistantEvent[] = [];
  for (const event of events) {
    if (event.role === "assistant") {
      // A settling line refers to the latest questions asked before it, whether or not they were already closed.
      for (let left = event.settles ?? 0, index = list.length - 1; left > 0 && index >= 0; left--, index--) close(list[index], "session");
      for (const item of list) {
        if (item.closed || item.epoch !== epoch || item.countedSeq === undefined || event.seq <= item.countedSeq) continue;
        item.later++;
        item.countedSeq = event.seq;
      }
      const record = records.get(event.key);
      const asked = turnQuestion(event, coordinatorDigest);
      if (asked || record) {
        const base = record ? fromRecord(record) : undefined;
        list.push({ key: event.key, epoch, seq: event.seq, question: asked?.question ?? record!.question, markdown: asked?.markdown ?? base!.markdown,
          context: asked?.context ?? base!.context, askedAt: event.at ?? record?.askedAt, later: 0, countedSeq: event.seq,
          ...(record?.maybeAnswered ? { maybeAnswered: true as const } : {}), ...(record?.moved ? { moved: true as const } : {}),
          turn: event, earlier: [...assistants], ...(record ? { record } : {}), closed: Object.hasOwn(closedKeys, event.key) });
      }
      assistants.push(event);
      continue;
    }
    if (event.ids.some(id => context.clarificationIds?.has(id))) continue;
    const open = list.filter(item => !item.closed);
    if (!open.length) continue;
    if (event.ids.some(id => context.boardMessageIds?.has(id))) {
      close(open.at(-1)!, "board");
      continue;
    }
    const match = [...open].reverse().find(item => answersChoices(event.text, choicesOf(item)));
    if (match) close(match, "choice");
    else for (const item of open) item.maybeAnswered = true;
  }
  if (context.ledgerQuestions) {
    for (const item of list) {
      if (item.closed) continue;
      if (context.ledgerQuestions.has(item.question)) item.moved = true;
      else if (item.moved) close(item, "ledger");
    }
  }
  return { epoch, open: list.filter(item => !item.closed).map(({ closed: _closed, ...item }) => item), closed };
}

/** What the card shows about the open question and the older ones still open in the same session. */
export function questionNotice(scan: QuestionScan, ended: boolean, now = Date.now()): NonNullable<SessionRow["keptQuestion"]> | undefined {
  const main = scan.open.at(-1);
  if (!main) return undefined;
  const age = main.askedAt ? now - Date.parse(main.askedAt) : NaN;
  const old = main.later > OLD_QUESTION.later || age > OLD_QUESTION.ageMs;
  const older = scan.open.slice(0, -1).slice(-10).reverse().map(item => ({ key: item.key, question: item.question.slice(0, 340), ...(item.askedAt ? { askedAt: item.askedAt } : {}) }));
  return { key: main.key, later: main.later, ...(old ? { stale: true as const } : {}), ...(main.maybeAnswered ? { maybeAnswered: true as const } : {}),
    ...(ended ? { ended: true as const } : {}), ...(older.length ? { older } : {}) };
}

/** The context a session's scan needs from the host settings. */
export function questionContext(scope: Pick<Preferences, "closedQuestions" | "raisedQuestions" | "decisionReceipts" | "clarifications">, sessionId: string,
  ledgerQuestions?: ReadonlySet<string>, now?: number): QuestionContext {
  const boardMessageIds = new Set<string>();
  for (const [id, receipt] of Object.entries(scope.decisionReceipts ?? {})) {
    if (receipt.sessionId !== sessionId) continue;
    boardMessageIds.add(id);
    if (receipt.messageId) boardMessageIds.add(receipt.messageId);
  }
  const closed = Object.fromEntries(Object.entries(scope.closedQuestions ?? {}).filter(([, entry]) => entry.sessionId === sessionId));
  return { closed, boardMessageIds, clarificationIds: new Set(Object.keys(scope.clarifications ?? {})),
    records: scope.raisedQuestions?.[sessionId]?.questions ?? [], ...(ledgerQuestions ? { ledgerQuestions } : {}), ...(now === undefined ? {} : { now }) };
}

/** Questions ledger cards carry, by session. */
export function ledgerQuestionsBySession(items: readonly { sessionMatch?: { sessionId: string; question: string } | null }[]) {
  const map = new Map<string, Set<string>>();
  for (const item of items) {
    if (!item.sessionMatch) continue;
    const set = map.get(item.sessionMatch.sessionId) ?? new Set<string>();
    set.add(item.sessionMatch.question);
    map.set(item.sessionMatch.sessionId, set);
  }
  return map;
}

type SessionLabel = Pick<SessionRow, "id" | "projectId" | "serverId" | "title" | "projectTitle" | "workspaceTitle">;

/**
 * Saves what a scan found: open questions stay recorded (new ones are added), closed ones leave with the reason that
 * closed them. Returns whether anything changed. Only a scan's own evidence removes a record.
 */
export function saveScan(scope: Preferences, row: SessionLabel, scan: QuestionScan, display: (item: FoundQuestion) => Partial<RaisedQuestion>, now = Date.now()) {
  const before = JSON.stringify([scope.raisedQuestions[row.id] ?? null, scan.closed.map(item => scope.closedQuestions[item.key] ?? null)]);
  const at = new Date(now).toISOString();
  for (const item of scan.closed) {
    if (!Object.hasOwn(scope.closedQuestions, item.key)) scope.closedQuestions[item.key] = { sessionId: row.id, at, reason: item.reason, epoch: item.epoch, seq: item.seq };
  }
  const saved = scope.raisedQuestions[row.id];
  const questions = scan.open.map((item): RaisedQuestion => {
    const kept = item.record;
    const core: RaisedQuestion = {
      ...(kept ?? {}),
      key: item.key, epoch: item.epoch, seq: item.seq, question: item.question.slice(0, 2000),
      ...(item.askedAt ? { askedAt: item.askedAt } : {}), raisedAt: kept?.raisedAt ?? at,
      later: item.later, ...(item.countedSeq !== undefined ? { countedSeq: item.countedSeq } : {}),
      ...(item.maybeAnswered ? { maybeAnswered: true as const } : {}), ...(item.moved ? { moved: true as const } : {}),
    };
    // Display fields that do not fit the record are left out. The question itself is always kept.
    const full = raisedQuestionSchema.safeParse({ ...core, ...display(item) });
    return full.success ? full.data : core;
  }).slice(-MAX_OPEN_PER_SESSION);
  if (questions.length) {
    scope.raisedQuestions[row.id] = { projectId: saved?.projectId ?? row.projectId, ...(row.serverId ?? saved?.serverId ? { serverId: row.serverId ?? saved?.serverId } : {}),
      title: (row.title || saved?.title || "").slice(0, 400), projectTitle: (row.projectTitle || saved?.projectTitle || "").slice(0, 400),
      workspaceTitle: (row.workspaceTitle || saved?.workspaceTitle || "").slice(0, 400), questions };
  } else delete scope.raisedQuestions[row.id];
  const entries = Object.entries(scope.closedQuestions);
  if (entries.length > MAX_CLOSED) {
    entries.sort(([, a], [, b]) => a.at.localeCompare(b.at));
    for (const [key] of entries.slice(0, entries.length - MAX_CLOSED)) delete scope.closedQuestions[key];
  }
  return JSON.stringify([scope.raisedQuestions[row.id] ?? null, scan.closed.map(item => scope.closedQuestions[item.key] ?? null)]) !== before;
}

/** The display fields a record keeps, so the card reads the same after the message leaves the excerpt. */
export function recordDisplay(details: { question: string; markdown: string; context: string; choices: readonly Choice[]; block?: QuestionBlock }): Partial<RaisedQuestion> {
  return {
    ...(details.markdown && details.markdown !== details.question ? { markdown: details.markdown.slice(0, 2000) } : {}),
    ...(details.context ? { context: details.context.slice(0, 2000) } : {}),
    ...(details.choices.length ? { choices: [...details.choices] } : {}),
    ...(details.block ? { block: details.block } : {}),
  };
}

/** The person pressed Close as handled. Recorded on this host only; nothing is sent to the session. */
export function closeQuestionByPerson(scope: Preferences, sessionId: string, key: string, now = Date.now()) {
  const saved = scope.raisedQuestions[sessionId];
  const record = saved?.questions.find(question => question.key === key);
  scope.closedQuestions[key] = { sessionId, at: new Date(now).toISOString(), reason: "person", ...(record ? { epoch: record.epoch, seq: record.seq } : {}) };
  if (saved) {
    saved.questions = saved.questions.filter(question => question.key !== key);
    if (!saved.questions.length) delete scope.raisedQuestions[sessionId];
  }
}
