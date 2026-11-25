import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { SessionRow } from "../shared/contract";
import type { Preferences } from "./preferences";
import { contextBefore, labelDefinitions, questionChoices, type LabelDefinition } from "../shared/question-choices";
import { withAssignmentHost } from "./host-assignment";
import { waitsForIdle } from "../shared/busy-delivery";
import { asksForDecision } from "../shared/question-request";

type Sdk = PluginHandlerContext["paseo"];
type Page = Awaited<ReturnType<ReturnType<Sdk["agents"]["ref"]>["timeline"]["refetch"]>>;
// `definitions` keeps option definitions such as "(a) …" from the part of a long turn that `text` cuts off.
export type Turn = { role: "user" | "assistant"; text: string; truncated?: boolean; at?: string; definitions?: LabelDefinition[] };
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
};
type Candidate = Pick<SessionRow, "lane" | "detail" | "decisionRequestedAt">;

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
    } else if (text) {
      if (clarification) clarification.response = text.slice(0, 16000);
      for (const id of messageIds) replies.set(id, text.length > 1200 ? text.slice(0, 1199) + "…" : text);
    }
    if (!text) continue;
    laterInputs.length = 0;
    turns.push({ role, text: text.slice(-2000), ...(timestamp ? { at:timestamp } : {}), ...(text.length > 2000 ? { truncated: true } : {}) });
    full.set(turns.at(-1)!, item.text);
    digest.update(JSON.stringify([seqEnd, role, text]));
  }
  if (laterInputs.length) digest.update(JSON.stringify(laterInputs));
  const kept = turns.slice(-4);
  // Only the turns the excerpt keeps: long ones keep the definitions their cut-off start holds.
  for (const turn of kept) {
    if (turn.role !== "assistant" || !turn.truncated) continue;
    const definitions = labelDefinitions(full.get(turn)!.trim());
    if (definitions.length) turn.definitions = definitions;
  }
  const last = turns.at(-1);
  return { ...(last?.role === "assistant" && waitsForIdle(full.get(last) ?? "") ? {deliverWhenIdle:true} : {}), id: digest.digest("hex").slice(0, 24), turns: kept,
    ...(clarification && messageIds.length ? { lastInputIds: messageIds } : {}),
    ...(clarificationMessages.size ? { clarificationMessages } : {}),
    ...(boardMessageHashes.size ? {boardMessageHashes} : {}),
    ...(replies.size ? { replies } : {}), ...(laterInputs.length ? {laterInput:true} : {}), ...(deliveries.length ? {deliveries} : {}),
    ...(lastInputSender ? { lastInputSender } : {}) };
}

function questionIn(text: string, coordinatorDigest = false) {
  const original = text.split("\n");
  // Keep the source line indexes when ignoring code examples during question detection.
  const lines = text.replace(/^`{3}[\s\S]*?^`{3}[^\n]*/gm, block => block.replace(/[^\n]/g, ""))
    .split("\n").map(line => line.trim());
  // A coordinator's digest quotes questions belonging to other sessions in typed table rows.
  const quotedRow = (line: string) => coordinatorDigest && /^\|[^|]+\|\s*(?:question|질문)\s*(?:\+[^|]*)?\|/i.test(line);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (quotedRow(lines[i]) || lines[i].startsWith(">") || !asksForDecision(lines[i])) continue;
    // A request inside a list belongs to the line right above that opens the list ("결정할 것: …" and its answer options), so the card starts there. A list with no request line above it keeps its own start.
    const listItem = /^(?:[-*+]|\d+[.)])\s/;
    let start = i;
    while (listItem.test(lines[start]) && start > 0 && lines[start - 1] && !lines[start - 1].startsWith(">") && !quotedRow(lines[start - 1])) {
      start--;
      if (!listItem.test(lines[start])) { if (asksForDecision(lines[start])) i = start; break; }
    }
    // Include the checklist or options after a request heading.
    const included = (line: string) => !line.startsWith(">") && !quotedRow(line);
    return {
      // Existing replies and ledger matches identify this question by its compact text.
      question: lines.slice(i).filter(line => line && included(line)).join(" ").slice(0, 340),
      markdown: original.slice(i).filter((_, index) => included(lines[i + index])).join("\n").trimEnd(),
      // The explanation the session wrote before asking, for display only.
      context: contextBefore(original.slice(0, i).filter((_, index) => included(lines[index]))),
    };
  }
  return null;
}

export function lastConversationQuestion(evidence: Evidence, coordinatorDigest = false) {
  const last = evidence.turns.at(-1);
  return last?.role === "assistant" ? questionIn(last.text, coordinatorDigest) : null;
}

/** The last question with the text before it and the options it names, looked up in this and earlier assistant turns. */
export function conversationQuestionDetails(evidence: Evidence, coordinatorDigest = false) {
  const question = lastConversationQuestion(evidence, coordinatorDigest);
  const last = evidence.turns.at(-1);
  if (!question || !last) return null;
  const earlier = evidence.turns.slice(0, -1).filter(turn => turn.role === "assistant").reverse();
  return { ...question, ...questionChoices({ question: question.markdown, context: question.context, message: last, earlier }) };
}

export function classify(e: Evidence, row: SessionRow, decision?: Preferences["judgments"][string], isCoordinator = false): Candidate {
  if (row.lane === "human" || row.lane === "running" || row.lane === "unknown" || row.detail.includes("오류")) return row;
  const last = e.turns.at(-1);
  if (decision?.evidenceId === e.id) {
    const askedAt = decision.kind === "question" && (last?.role === "assistant" && questionIn(last.text, isCoordinator) ? last.at ?? decision.requestedAt : decision.requestedAt);
    return { lane: decision.kind === "question" ? "human" : decision.kind, detail: "코디네이터 판단 · " + decision.text,
      ...(askedAt ? {decisionRequestedAt:askedAt} : {}) };
  }
  if (!last) return row;
  if (last.role === "assistant") {
    const question = questionIn(last.text, isCoordinator);
    if (question) return { lane: "human", detail: "세션의 확인 요청 · " + question.question, ...(last.at ? {decisionRequestedAt:last.at} : {}) };
  } else {
    const previous = e.turns.slice(0, -1).findLast(t => t.role === "assistant");
    if (previous && questionIn(previous.text, isCoordinator)) {
      return { lane: "review", detail: "질문 뒤에 메시지가 왔습니다. 같은 질문에 대한 답인지 확인하세요." };
    }
  }
  return row;
}

// The board reads excerpts only for resting sessions without an error to review.
export function usesConversationEvidence(row: Pick<SessionRow, "lane" | "detail">) {
  return (row.lane === "idle" || row.lane === "review") && !row.detail.includes("오류");
}

export function applyConversationEvidence(evidence: Evidence, row: SessionRow, prefs: Preferences) {
  if (!usesConversationEvidence(row)) return false;
  const judgment = prefs.judgments[row.id];
  Object.assign(row, classify(evidence, row, judgment?.projectId === row.projectId ? judgment : undefined, row.id === prefs.coordinator),
    { evidenceId: evidence.id });
  return true;
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
    const page = withAssignmentHost(paseo, row.serverId, client =>
      client.agents.ref(row.id).timeline.refetch({ direction: "tail", projection: "projected", limit: 48 })).then(excerpt);
    this.cache.set(row.id, { serverId: row.serverId, stamp: row.activityAt ?? "", at: Date.now(), page });
    try { return await page; }
    catch (error) {
      if (this.cache.get(row.id)?.page === page) this.cache.delete(row.id);
      throw error;
    }
  }

  async decorate(paseo: Sdk, rows: SessionRow[], prefs: Preferences) {
    this.retain(new Set([...rows.map(row => row.id), ...(prefs.coordinator ? [prefs.coordinator] : [])]));
    const observed = new Map<string, Evidence>();
    let cursor = 0;
    const work = async () => {
      while (cursor < rows.length) {
        const row = rows[cursor++];
        try {
          const evidence = await this.read(paseo, row);
          if (evidence && applyConversationEvidence(evidence, row, prefs)) {
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
