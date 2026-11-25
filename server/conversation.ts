import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { SessionRow } from "../shared/contract";
import type { Preferences } from "./preferences";
import { labelDefinitions, questionChoices, type LabelDefinition } from "../shared/question-choices";
import { splitQuestionBlock, type QuestionBlock } from "../shared/question-block";
import { withAssignmentHost } from "./host-assignment";
import { waitsForIdle } from "../shared/busy-delivery";
import { questionIn, turnQuestion } from "./turn-question";
import { questionContext, questionNotice, scanQuestions, settlingLines, type AssistantEvent, type FoundQuestion, type QuestionContext,
  type LedgerView, type QuestionEvent, type QuestionScan } from "./open-questions";

type Sdk = PluginHandlerContext["paseo"];
type Page = Awaited<ReturnType<ReturnType<Sdk["agents"]["ref"]>["timeline"]["refetch"]>>;
// `definitions` keeps option definitions such as "(a) …" from the part of a long turn that `text` cuts off.
// `block` is the question block the message ended with. `text` no longer holds it.
export type Turn = { role: "user" | "assistant"; text: string; truncated?: boolean; at?: string; definitions?: LabelDefinition[]; block?: QuestionBlock };
type ClarificationObservation = { bodyHash: string; response?: string };
export type Evidence = {
  id: string; turns: Turn[]; deliverWhenIdle?:true;
  replies?: Map<string, string>;
  lastInputIds?: string[];
  boardMessageHashes?: Map<string,string>;
  clarificationMessages?: Map<string, ClarificationObservation>;
  laterInput?: boolean;
  deliveries?: { id: string; sender: string; bodyHash: string }[];
  // Sender of the most recent agent message when it is the latest input.
  lastInputSender?: string;
  // The timeline the excerpt read, and its messages and inputs in order, for the questions the session asked.
  epoch?: string;
  events?: QuestionEvent[];
};
const HOUR = 60 * 60 * 1000;
// How far back the board reads to find a question it has not seen yet.
const OLDER_PAGES = 2;
const OLDER_LIMIT = 96;
const OLDER_REACH = { assistants: 31, ageMs: 24 * HOUR };
const MAX_EVENTS = 240;
type Candidate = Pick<SessionRow, "lane" | "detail" | "decisionRequestedAt" | "keptQuestion">;

export function excerpt(page: Page): Evidence {
  if (page.error || page.gap || page.staleCursor) throw new Error("대화 발췌를 확인할 수 없습니다.");
  const turns: Turn[] = [];
  const full = new Map<Turn, string>();
  const digest = createHash("sha256").update(page.epoch);
  const laterInputs: string[] = [];
  const deliveries: NonNullable<Evidence["deliveries"]> = [];
  const replies = new Map<string, string>();
  const boardMessageHashes=new Map<string,string>();
  let messageIds: string[] = [];
  let clarification: ClarificationObservation | undefined;
  let lastInputSender: string | undefined;
  const events: QuestionEvent[] = [];
  const clarificationMessages = new Map<string, ClarificationObservation>();
  for (const { item, seqEnd, timestamp } of page.entries) {
    if (item.type === "tool_call" && (item.agentMessage || item.name === "heartbeat")) {
      messageIds = [];
      clarification = undefined;
      laterInputs.push(item.callId);
      lastInputSender = undefined;
      const prefix = "paseo-agent-message:";
      if (item.status === "completed" && item.callId.startsWith(prefix) && item.agentMessage?.event === "message") {
        lastInputSender = item.agentMessage.sender.id;
        deliveries.push({ id:item.callId.slice(prefix.length), sender:item.agentMessage.sender.id,
          bodyHash:createHash("sha256").update(item.agentMessage.text).digest("hex") });
      }
    }
    if (item.type !== "assistant_message" && item.type !== "user_message") continue;
    const role = item.type === "assistant_message" ? "assistant" : "user";
    const text = item.text.trim();
    if (item.type === "user_message") {
      lastInputSender = undefined;
      messageIds = [item.messageId, item.clientMessageId].filter((id): id is string => !!id);
      if (messageIds.length) {
        const hash=createHash("sha256").update(item.text).digest("hex");
        for (const id of messageIds) boardMessageHashes.set(id,hash);
      }
      clarification = text.startsWith("[Coordinator Board · 추가 질문]")
        ? { bodyHash: createHash("sha256").update(item.text).digest("hex") } : undefined;
      if (clarification) {
        for (const id of messageIds) clarificationMessages.set(id, clarification);
      }
    }
    if (item.type === "user_message") {
      events.push({ role: "user", seq: seqEnd, ids: messageIds, text: text.slice(0, 2000), ...(timestamp ? { at: timestamp } : {}) });
    }
    // A valid question block at the end is shown as choices, so the message reads without it. The evidence
    // identity still covers the message as written.
    const split = role === "assistant" ? splitQuestionBlock(text) : { text };
    const shown = split.text || split.block?.questions[0].text || "";
    if (item.type === "assistant_message" && shown) {
      if (clarification) clarification.response = shown.slice(0, 16000);
      for (const id of messageIds) replies.set(id, shown.length > 1200 ? shown.slice(0, 1199) + "…" : shown);
    }
    if (!text) continue;
    laterInputs.length = 0;
    turns.push({ role, text: shown.slice(-2000), ...(timestamp ? { at:timestamp } : {}), ...(shown.length > 2000 ? { truncated: true } : {}),
      ...(split.block ? { block: split.block } : {}) });
    full.set(turns.at(-1)!, item.text);
    if (role === "assistant") {
      const key = createHash("sha256").update(JSON.stringify([page.epoch, seqEnd, item.text])).digest("hex").slice(0, 24);
      const settles = settlingLines(text);
      const event: AssistantEvent = { ...turns.at(-1)!, role, seq: seqEnd, key, ...(settles ? { settles } : {}) };
      events.push(event);
      full.set(event, item.text);
    }
    digest.update(JSON.stringify([seqEnd, role, text]));
  }
  if (laterInputs.length) digest.update(JSON.stringify(laterInputs));
  const kept = turns.slice(-4);
  const last = turns.at(-1);
  const recent = events.slice(-MAX_EVENTS);
  // Only the turns the excerpt keeps: long ones keep the definitions their cut-off start holds.
  for (const turn of [...kept, ...recent]) {
    if (turn.role !== "assistant" || !turn.truncated) continue;
    const definitions = labelDefinitions(full.get(turn)!.trim());
    if (definitions.length) turn.definitions = definitions;
  }
  return { ...(last?.role === "assistant" && waitsForIdle(full.get(last) ?? "") ? {deliverWhenIdle:true} : {}), id: digest.digest("hex").slice(0, 24), turns: kept,
    ...(clarification && messageIds.length ? { lastInputIds: messageIds } : {}),
    ...(clarificationMessages.size ? { clarificationMessages } : {}),
    ...(boardMessageHashes.size ? {boardMessageHashes} : {}),
    ...(replies.size ? { replies } : {}), ...(laterInputs.length ? {laterInput:true} : {}), ...(deliveries.length ? {deliveries} : {}),
    ...(lastInputSender ? { lastInputSender } : {}), epoch: page.epoch, ...(recent.length ? { events: recent } : {}) };
}

// Whether to read further back for a question the board has not seen: no input from the person, no question and no settling
// line in what was read, and within the reach. Questions the board saw before are kept in the host settings instead.
export function wantsOlder(page: Pick<Page, "entries" | "hasOlder" | "startCursor">, now = Date.now()) {
  if (!page.hasOlder || !page.startCursor) return false;
  let assistants = 0;
  for (const { item } of page.entries) {
    if (item.type === "user_message") return false;
    if (item.type !== "assistant_message" || !item.text.trim()) continue;
    const split = splitQuestionBlock(item.text.trim());
    // Read as a coordinator digest would be: a quoted question row in a digest table is not a question here, so it does
    // not stop the read before the coordinator's own question. For other sessions this only reads further.
    if (split.block || questionIn(split.text, true) || settlingLines(item.text)) return false;
    if (++assistants >= OLDER_REACH.assistants) return false;
  }
  const oldest = page.entries.find(entry => entry.timestamp)?.timestamp;
  return !oldest || !(now - Date.parse(oldest) > OLDER_REACH.ageMs);
}

export function lastConversationQuestion(evidence: Evidence, coordinatorDigest = false) {
  const last = evidence.turns.at(-1);
  return last?.role === "assistant" ? turnQuestion(last, coordinatorDigest) : null;
}

// An excerpt made by hand (older callers, tests) may have only `turns`: read them as the messages in order.
function withEvents(e: Evidence): Evidence {
  if (e.events) return e;
  const events = e.turns.map((turn, seq): QuestionEvent => turn.role === "assistant"
    ? { ...turn, role: "assistant", seq, key: createHash("sha256").update(JSON.stringify([e.id, seq, turn.text])).digest("hex").slice(0, 24) }
    : { role: "user", seq, ids: [], text: turn.text, ...(turn.at ? { at: turn.at } : {}) });
  return { ...e, events };
}

const scans = new WeakMap<SessionRow, QuestionScan>();
/** The open questions classify found for this row, if it looked. */
export function scanOf(row: SessionRow) {
  return scans.get(row);
}

/** The card's question details: from the message when the board read it, otherwise from the board's record. */
export function questionDetails(item: FoundQuestion) {
  const shown = { question: item.question, markdown: item.markdown, context: item.context };
  const block = item.turn ? item.turn.block : item.record?.block;
  // A block carries its own options, so the labels in the text are not looked up.
  if (block) return { ...shown, choices: [], missingLabels: [], block };
  if (!item.turn) return { ...shown, choices: item.record?.choices ?? [], missingLabels: [], block: undefined };
  const earlier = (item.earlier ?? []).slice(-3).reverse();
  return { ...shown, ...questionChoices({ question: item.markdown, context: item.context, message: item.turn, earlier }), block: undefined };
}

/** The open question of an excerpt with the text before it and the options it names. */
export function conversationQuestionDetails(evidence: Evidence, coordinatorDigest = false, context: QuestionContext = {}) {
  const main = scanQuestions(withEvents(evidence), coordinatorDigest, context).open.at(-1);
  return main ? questionDetails(main) : null;
}

export function classify(e: Evidence, row: SessionRow, decision?: Preferences["judgments"][string], isCoordinator = false, options: QuestionContext = {}): Candidate {
  if (row.lane === "human" || row.lane === "running" || row.lane === "unknown" || row.detail.includes("오류")) return row;
  const scan = scanQuestions(withEvents(e), isCoordinator, options);
  scans.set(row, scan);
  const last = e.turns.at(-1);
  // A coordinator judgment that no person is needed does not hide a question still waiting for the person.
  if (decision?.evidenceId === e.id && (decision.kind === "question" || !scan.open.length)) {
    const askedAt = decision.kind === "question" && (last?.role === "assistant" && turnQuestion(last, isCoordinator) ? last.at ?? decision.requestedAt : decision.requestedAt);
    return { lane: decision.kind === "question" ? "human" : decision.kind, detail: "코디네이터 판단 · " + decision.text,
      ...(askedAt ? {decisionRequestedAt:askedAt} : {}) };
  }
  return asked(scan, row.status === "closed", options.now) ?? row;
}

// The card for the latest open question. Older open questions ride along on it.
function asked(scan: QuestionScan, ended: boolean, now?: number): Candidate | null {
  const main = scan.open.at(-1);
  const notice = questionNotice(scan, ended, now);
  if (!main || !notice) return null;
  return { lane: "human", detail: "세션의 확인 요청 · " + main.question, ...(main.askedAt ? { decisionRequestedAt: main.askedAt } : {}), keptQuestion: notice };
}

/**
 * A session the board did not read (working, ended, unreachable or its excerpt failed) still shows the questions the
 * board raised before. A pending permission request takes the card while it waits.
 */
export function applyRecordedQuestions(row: SessionRow, prefs: Preferences, ledger?: LedgerView, now = Date.now()) {
  if (scans.has(row) || row.nativePending || !prefs.raisedQuestions?.[row.id]?.questions.length) return false;
  const scan = scanQuestions(null, row.id === prefs.coordinator, questionContext(prefs, row.id, ledger, now));
  scans.set(row, scan);
  const card = asked(scan, row.status === "closed", now);
  // A working session keeps its lane and status line, so what reads "running" (merge holds, progress) still sees it.
  // Its card still counts in My decisions (`displayLane`).
  if (card && row.lane === "running") Object.assign(row, { keptQuestion: card.keptQuestion, ...(card.decisionRequestedAt ? { decisionRequestedAt: card.decisionRequestedAt } : {}) });
  else if (card) Object.assign(row, card);
  return true;
}

/**
 * Sessions with questions not handled that the board can no longer find (archived, deleted, or on a host it cannot
 * reach). They stay as ended cards. A session still listed elsewhere (another project) is left to that scope.
 */
export function recordedSessionRows(prefs: Preferences, selected: ReadonlySet<string>, discovered: ReadonlySet<string>, ledger?: LedgerView, now = Date.now()) {
  const rows: SessionRow[] = [];
  for (const [id, saved] of Object.entries(prefs.raisedQuestions ?? {})) {
    if (discovered.has(id) || !selected.has(saved.projectId)) continue;
    const row: SessionRow = { id, title: saved.title, projectId: saved.projectId, projectTitle: saved.projectTitle, workspaceTitle: saved.workspaceTitle,
      model: null, status: "closed", lane: "idle", detail: "", ...(saved.serverId ? { serverId: saved.serverId } : {}) };
    if (applyRecordedQuestions(row, prefs, ledger, now) && row.lane === "human") rows.push(row);
  }
  return rows;
}

// The board reads excerpts only for resting sessions without an error to review.
export function usesConversationEvidence(row: Pick<SessionRow, "lane" | "detail">) {
  return (row.lane === "idle" || row.lane === "review") && !row.detail.includes("오류");
}

export function applyConversationEvidence(evidence: Evidence, row: SessionRow, prefs: Preferences, ledger?: LedgerView, now?: number) {
  if (!usesConversationEvidence(row)) return false;
  const judgment = prefs.judgments[row.id];
  Object.assign(row, classify(evidence, row, judgment?.projectId === row.projectId ? judgment : undefined, row.id === prefs.coordinator,
    questionContext(prefs, row.id, ledger, now)), { evidenceId: evidence.id });
  return true;
}

// The latest entries, and further back only while an unanswered question could be there (`wantsOlder`).
export async function readTimeline(timeline: ReturnType<Sdk["agents"]["ref"]>["timeline"]) {
  let page = await timeline.refetch({ direction: "tail", projection: "projected", limit: 48 });
  for (let read = 0; read < OLDER_PAGES && !page.error && wantsOlder(page); read++) {
    const older = await timeline.refetch({ direction: "before", cursor: page.startCursor!, projection: "projected", limit: OLDER_LIMIT }).catch(() => null);
    if (!older || older.error || older.gap || older.staleCursor || older.epoch !== page.epoch) break;
    page = { ...page, entries: [...older.entries, ...page.entries], startCursor: older.startCursor, hasOlder: older.hasOlder };
  }
  return page;
}

export class ConversationReader {
  private readonly cache = new Map<string, { serverId?: string; stamp: string; at: number; page: Promise<Evidence> }>();

  retain(ids: Set<string>) {
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
  }

  // A closed session is normally answered from the cache only. `closed` fetches its stored timeline anyway,
  // for a read a coordinator was explicitly allowed to make (the handover from the previous coordinator).
  async read(paseo: Sdk, row: SessionRow, fresh = false, { closed = false, openReply = false }: { closed?: boolean; openReply?: boolean } = {}): Promise<Evidence | null> {
    const entry = this.cache.get(row.id);
    const cached = entry?.serverId === row.serverId ? entry : undefined;
    if (row.status === "closed" && !closed) {
      return cached?.stamp === row.activityAt ? cached?.page ?? null : null;
    }
    if (row.status !== "idle" && row.status !== "error" && row.status !== "closed" && !(openReply && row.status === "running")) return null;
    if (!fresh && cached && cached.stamp === row.activityAt && Date.now() - cached.at < 60_000) return cached.page;
    const page = withAssignmentHost(paseo, row.serverId, client => readTimeline(client.agents.ref(row.id).timeline)).then(excerpt);
    this.cache.set(row.id, { serverId: row.serverId, stamp: row.activityAt ?? "", at: Date.now(), page });
    try { return await page; }
    catch (error) {
      if (this.cache.get(row.id)?.page === page) this.cache.delete(row.id);
      throw error;
    }
  }

  async decorate(paseo: Sdk, rows: SessionRow[], prefs: Preferences, ledger?: LedgerView) {
    this.retain(new Set([...rows.map(row => row.id), ...(prefs.coordinator ? [prefs.coordinator] : [])]));
    const observed = new Map<string, Evidence>();
    let cursor = 0;
    const work = async () => {
      while (cursor < rows.length) {
        const row = rows[cursor++];
        try {
          const evidence = await this.read(paseo, row);
          if (evidence && applyConversationEvidence(evidence, row, prefs, ledger)) {
            observed.set(row.id, evidence);
          }
        } catch {
          row.detail += " · 최근 대화 조회 실패";
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, work));
    return observed;
  }
}
