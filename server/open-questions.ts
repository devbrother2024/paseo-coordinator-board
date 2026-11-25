import type { SessionRow } from "../shared/contract";
import { blockQuestionLabel, type BlockQuestion, type QuestionBlock } from "../shared/question-block";
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
  // Board reply message ids, with the question each answered when its receipt names it.
  boardMessageIds?: ReadonlyMap<string, string | undefined>;
  clarificationIds?: ReadonlySet<string>;
  records?: readonly RaisedQuestion[];
  // Questions ledger cards carry for this session, with the key of the card. Undefined when the ledger was not read.
  ledgerQuestions?: ReadonlyMap<string, string>;
  // Keys of ledger cards with a resolution on record. Undefined when the resolutions could not be read.
  ledgerResolved?: ReadonlySet<string>;
  now?: number;
};

export type FoundQuestion = {
  key: string; epoch: string; seq: number; question: string; markdown: string; context: string; askedAt?: string;
  later: number; countedSeq?: number; maybeAnswered?: true; moved?: true; movedTo?: string;
  turn?: AssistantEvent; earlier?: AssistantEvent[]; record?: RaisedQuestion;
};
export type QuestionScan = { epoch?: string; open: FoundQuestion[]; closed: { key: string; reason: ClosedReason; epoch: string; seq: number }[] };

const HOUR = 60 * 60 * 1000;
// Display only: a question reads as old after this many later messages or this long. It never leaves for that.
export const OLD_QUESTION = { later: 15, ageMs: 12 * HOUR };
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

// The question a line answers in full in the form the board's options fill, or null. Free text after the options
// ("Q1 · question: A · text, but check first") is not a full answer.
function filledLine(line: string, block: QuestionBlock) {
  for (const [index, item] of block.questions.entries()) {
    const prefix = blockQuestionLabel(item) + ": ";
    if (!line.startsWith(prefix)) continue;
    const picked = line.slice(prefix.length).split(", ");
    return picked.every(text => item.options.some(option => option.key + " · " + option.text === text)) ? index : null;
  }
  return null;
}

/** Whether what the person wrote is an answer the card offered: an option's label or text, or the recommended reply. */
export function answersChoices(text: string, question: { block?: QuestionBlock; choices?: readonly Choice[] }) {
  const written = text.trim();
  if (!written) return false;
  const block = question.block;
  if (block) {
    if (block.recommendedReply && norm(written) === norm(block.recommendedReply)) return true;
    // Every question of the block has to be answered, and every line has to be an answer: a line the board's options fill
    // ("Q1 · question: A · text, B · text") or short answers ("Q1 A, Q2 B"). Anything else written leaves the card open.
    const answered = new Set<number>();
    for (const line of written.split("\n").map(row => row.trim()).filter(Boolean)) {
      const filled = filledLine(line, block);
      if (filled !== null) { answered.add(filled); continue; }
      for (const part of parts(line)) {
        const index = block.questions.findIndex((item, at) => answersBlockPart(part, item, at, block.questions.length));
        if (index < 0) return false;
        answered.add(index);
      }
    }
    return block.questions.every((_, index) => answered.has(index));
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
    ...(record.maybeAnswered ? { maybeAnswered: true as const } : {}), ...(record.moved ? { moved: true as const } : {}),
    ...(record.movedTo ? { movedTo: record.movedTo } : {}), record };
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
          ...(record?.movedTo ? { movedTo: record.movedTo } : {}), turn: event, earlier: [...assistants], ...(record ? { record } : {}), closed: Object.hasOwn(closedKeys, event.key) });
      }
      assistants.push(event);
      continue;
    }
    if (event.ids.some(id => context.clarificationIds?.has(id))) continue;
    // A board reply closes the question it answered: the one its receipt names, or for a reply sent without that, the
    // latest question asked before it, even one already closed. Reading the same timeline again closes nothing else.
    const reply = event.ids.find(id => context.boardMessageIds?.has(id));
    if (reply !== undefined) {
      const answered = context.boardMessageIds!.get(reply);
      const target = answered ? list.find(item => item.key === answered) : list.at(-1);
      if (target) close(target, "board");
      continue;
    }
    const open = list.filter(item => !item.closed);
    if (!open.length) continue;
    // An answer that fits more than one question asked before it cannot tell which one it answers, so it closes none.
    // Questions closed since count too: a closure recorded later must not make the same answer clear when the timeline
    // is read again.
    const matches = list.filter(item => answersChoices(event.text, choicesOf(item)));
    if (matches.length === 1 && !matches[0].closed) close(matches[0], "choice");
    else for (const item of open) item.maybeAnswered = true;
  }
  // A question that moved to a ledger card closes only when that card has a resolution on record. A card that left the
  // ledger without one gives the question back to the conversation card.
  if (context.ledgerQuestions) {
    for (const item of list) {
      if (item.closed) continue;
      const card = context.ledgerQuestions.get(item.question);
      if (card) { item.moved = true; item.movedTo = card; continue; }
      if (!item.moved) continue;
      if (item.movedTo && context.ledgerResolved?.has(item.movedTo)) close(item, "ledger");
      else if (context.ledgerResolved) { delete item.moved; delete item.movedTo; }
    }
  }
  return { epoch, open: list.filter(item => !item.closed).map(({ closed: _closed, ...item }) => item), closed };
}

/**
 * Why the coordinator should judge whether an open question was handled, or nothing when the board can tell or the
 * coordinator already judged it: another question of the session came after it, the session spoke after it, or the
 * person wrote something else to the session after it.
 */
export type JudgeReason = NonNullable<RaisedQuestion["judge"]>;
export function judgeReason(scan: QuestionScan, item: FoundQuestion, index: number, verdict?: RaisedQuestion["verdict"], ended = false): JudgeReason | undefined {
  if (verdict) return undefined;
  if (ended) return "session-ended";
  if (index < scan.open.length - 1) return "others-open";
  if (item.maybeAnswered) return "person-wrote";
  return item.later > 0 ? "spoke-after" : undefined;
}

/**
 * What the card shows about the open question. Other open questions of the session ride along, judged or not: a question
 * leaves only when something shows it was handled.
 */
export function questionNotice(scan: QuestionScan, ended: boolean, now = Date.now()): NonNullable<SessionRow["keptQuestion"]> | undefined {
  const main = scan.open.at(-1);
  if (!main) return undefined;
  const age = main.askedAt ? now - Date.parse(main.askedAt) : NaN;
  const old = main.later > OLD_QUESTION.later || age > OLD_QUESTION.ageMs;
  const verdict = main.record?.verdict;
  // All of them: the card folds what does not fit, nothing is cut here.
  const older = scan.open.slice(0, -1).reverse()
    .map(item => ({ key: item.key, question: item.question.slice(0, 340), ...(item.askedAt ? { askedAt: item.askedAt } : {}) }));
  return { key: main.key, later: main.later, ...(old ? { stale: true as const } : {}), ...(main.maybeAnswered ? { maybeAnswered: true as const } : {}),
    ...(ended ? { ended: true as const } : {}), ...(older.length ? { older } : {}),
    ...(verdict ? { verdict: "needed" as const, ...(verdict.evidence ? { verdictEvidence: verdict.evidence } : {}) } : {}) };
}

/** The context a session's scan needs from the host settings. */
export type LedgerView = { questions: ReadonlyMap<string, ReadonlyMap<string, string>>; resolved?: ReadonlySet<string> };
export function questionContext(scope: Pick<Preferences, "closedQuestions" | "raisedQuestions" | "decisionReceipts" | "clarifications"> & { coordinator?: string | null },
  sessionId: string, ledger?: LedgerView, now?: number): QuestionContext {
  const boardMessageIds = new Map<string, string | undefined>();
  for (const [id, receipt] of Object.entries(scope.decisionReceipts ?? {})) {
    if (receipt.sessionId !== sessionId) continue;
    boardMessageIds.set(id, receipt.question);
    if (receipt.messageId) boardMessageIds.set(receipt.messageId, receipt.question);
  }
  const closed = Object.fromEntries(Object.entries(scope.closedQuestions ?? {}).filter(([, entry]) => entry.sessionId === sessionId));
  return { closed, boardMessageIds, clarificationIds: new Set(Object.keys(scope.clarifications ?? {})),
    records: scope.raisedQuestions?.[sessionId]?.questions ?? [],
    ...(ledger ? { ledgerQuestions: ledger.questions.get(sessionId) ?? new Map(), ...(ledger.resolved ? { ledgerResolved: ledger.resolved } : {}) } : {}),
    ...(now === undefined ? {} : { now }) };
}

/** One revision of a ledger card: its key and fingerprint, as its resolution records them. */
export const ledgerCardId = (key: string, fingerprint: string) => JSON.stringify([key, fingerprint]);

/** Questions ledger cards carry, by session: question to the card revision (`ledgerCardId`). */
export function ledgerQuestionsBySession(items: readonly { key: string; fingerprint: string; sessionMatch?: { sessionId: string; question: string } | null }[]) {
  const map = new Map<string, Map<string, string>>();
  for (const item of items) {
    if (!item.sessionMatch) continue;
    const questions = map.get(item.sessionMatch.sessionId) ?? new Map<string, string>();
    questions.set(item.sessionMatch.question, ledgerCardId(item.key, item.fingerprint));
    map.set(item.sessionMatch.sessionId, questions);
  }
  return map;
}

type SessionLabel = Pick<SessionRow, "id" | "projectId" | "serverId" | "title" | "projectTitle" | "workspaceTitle"> & { status?: string };

/**
 * Saves what a scan found, question by question: open questions are added or updated, closed ones leave the record with
 * the reason that closed them. Questions this scan did not see (added by another snapshot meanwhile) stay as they are.
 * Open questions are never cut by count. Returns whether anything changed.
 */
export function saveScan(scope: Preferences, row: SessionLabel, scan: QuestionScan, display: (item: FoundQuestion) => Partial<RaisedQuestion>, now = Date.now()) {
  const snapshot = () => JSON.stringify([scope.raisedQuestions[row.id] ?? null, scan.closed.map(item => scope.closedQuestions[item.key] ?? null)]);
  const before = snapshot();
  const at = new Date(now).toISOString();
  for (const item of scan.closed) {
    if (!Object.hasOwn(scope.closedQuestions, item.key)) scope.closedQuestions[item.key] = { sessionId: row.id, at, reason: item.reason, epoch: item.epoch, seq: item.seq };
  }
  const saved = scope.raisedQuestions[row.id];
  const questions = new Map((saved?.questions ?? []).map(question => [question.key, question]));
  for (const [index, item] of scan.open.entries()) {
    if (Object.hasOwn(scope.closedQuestions, item.key)) continue;
    const kept = questions.get(item.key) ?? item.record;
    const judge = judgeReason(scan, item, index, kept?.verdict, row.status === "closed");
    const core: RaisedQuestion = {
      key: item.key, epoch: item.epoch, seq: item.seq, question: item.question.slice(0, 2000),
      ...(item.askedAt && item.askedAt.length <= 64 ? { askedAt: item.askedAt } : {}), raisedAt: kept?.raisedAt ?? at,
      later: item.later, ...(item.countedSeq !== undefined ? { countedSeq: item.countedSeq } : {}),
      ...(item.maybeAnswered ? { maybeAnswered: true as const } : {}), ...(item.moved ? { moved: true as const } : {}),
      ...(item.movedTo ? { movedTo: item.movedTo } : {}), ...(judge ? { judge } : {}),
      // The coordinator's verdict and the notice it got stay with the question.
      ...(kept?.verdict ? { verdict: kept.verdict } : {}), ...(kept?.notified ? { notified: kept.notified } : {}),
      ...(kept?.notifiedAt ? { notifiedAt: kept.notifiedAt } : {}), ...(kept?.notices ? { notices: kept.notices } : {}),
    };
    // Display fields that do not fit the record are left out. The question itself is always kept.
    // The scan's flags replace the saved ones; the saved display fields stay unless the scan has new ones.
    const { moved: _moved, movedTo: _movedTo, maybeAnswered: _maybe, judge: _judge, ...shown } = kept ?? {};
    const full = raisedQuestionSchema.safeParse({ ...shown, ...core, ...display(item) });
    const plain = raisedQuestionSchema.safeParse(core);
    questions.set(item.key, full.success ? full.data : plain.success ? plain.data : { ...core, epoch: core.epoch.slice(0, 4096) });
  }
  for (const item of scan.closed) questions.delete(item.key);
  for (const key of [...questions.keys()]) if (Object.hasOwn(scope.closedQuestions, key)) questions.delete(key);
  if (questions.size) {
    scope.raisedQuestions[row.id] = { projectId: row.projectId || saved?.projectId || "", ...(row.serverId ?? saved?.serverId ? { serverId: row.serverId ?? saved?.serverId } : {}),
      ...(saved?.noticedAt ? { noticedAt: saved.noticedAt } : {}),
      title: (row.title || saved?.title || "").slice(0, 400), projectTitle: (row.projectTitle || saved?.projectTitle || "").slice(0, 400),
      workspaceTitle: (row.workspaceTitle || saved?.workspaceTitle || "").slice(0, 400), questions: [...questions.values()] };
  } else delete scope.raisedQuestions[row.id];
  const entries = Object.entries(scope.closedQuestions);
  if (entries.length > MAX_CLOSED) {
    entries.sort(([, a], [, b]) => a.at.localeCompare(b.at));
    for (const [key] of entries.slice(0, entries.length - MAX_CLOSED)) delete scope.closedQuestions[key];
  }
  return snapshot() !== before;
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

/**
 * The person pressed Close as handled, or wrote a done note on the card (`noteRevision`). Recorded on this host only;
 * nothing is sent to the session.
 */
export function closeQuestionByPerson(scope: Preferences, sessionId: string, key: string, now = Date.now(), noteRevision?: number) {
  const saved = scope.raisedQuestions[sessionId];
  const record = saved?.questions.find(question => question.key === key);
  scope.closedQuestions[key] = { sessionId, at: new Date(now).toISOString(), reason: "person", ...(record ? { epoch: record.epoch, seq: record.seq } : {}),
    ...(noteRevision === undefined ? {} : { noteRevision }) };
  if (saved) {
    saved.questions = saved.questions.filter(question => question.key !== key);
    if (!saved.questions.length) delete scope.raisedQuestions[sessionId];
  }
}
