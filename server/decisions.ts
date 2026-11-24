import { decorateDecision, restoreClarifiedDecision } from "./session-decisions";
import { join } from "node:path";
import { SessionPhotoStore } from "./session-photos";
import { describePhotos, photoReceiptId } from "./reply-photos";
import { sessionReplyMessage } from "./decision-message";
import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { DecisionInput } from "../shared/decision-actions";
import type { SessionRow } from "../shared/contract";
import { classify, ConversationReader } from "./conversation";
import { isCurrentMembership, managedSessions } from "./session-links";
import { canReceiveBoardInput } from "./discovery";
import { discoverBoardSessions } from "./board-sessions";
import { withAssignmentHost } from "./host-assignment";
import type { NoteStore } from "./notes";
import { verifiedBoardFact } from "./board-facts";
import { isManagedCoordinator, type Preferences, type PreferenceStore } from "./preferences";

export { decorateDecision } from "./session-decisions";

type Sdk = PluginHandlerContext["paseo"];
type Receipt = { ok: true; recipientId: string; messageId: string };
const changed = "결정 카드 또는 수신자가 바뀌었습니다. 보드를 새로 고쳐 주세요.";
const blocked = "이 세션의 현재 상태에서는 보낼 수 없습니다. 원래 세션에서 권한 요청과 작업 상태를 확인하세요.";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function requireScope(scope: Preferences, input: DecisionInput) {
  const recipient = input.action === "coordinate" ? scope.coordinator : input.sessionId;
  if (!scope.projects.includes(input.projectId) || !recipient || recipient !== input.recipientId) throw Error(changed);
}

function messageUuid(key: string) {
  const h = hash(["coordinator-board/decision", key]);
  return [h.slice(0, 8), h.slice(8, 12), "4" + h.slice(13, 16), "8" + h.slice(17, 20), h.slice(20, 32)].join("-");
}

export class DecisionSender {
  private active = new Map<string, { fingerprint: string; result: Promise<Receipt> }>();
  private sendingCards = new Set<string>();
  private sessionPhotos: SessionPhotoStore;
  constructor(private store: PreferenceStore, private notes: NoteStore, private reader: ConversationReader) {
    this.sessionPhotos = new SessionPhotoStore(join(store.directory, "session-photos"));
  }

  send(paseo: Sdk, input: DecisionInput): Promise<Receipt> {
    const messageId = messageUuid(input.requestKey);
    const photos = describePhotos(input.images);
    const content = [input.projectId, input.sessionId, input.recipientId, input.version, input.action, input.text];
    // Keep text-only keys compatible with receipts written before photo support.
    const fingerprint = hash(photos.length ? [...content, photos] : content);
    const running = this.active.get(messageId);
    if (running) {
      if (running.fingerprint === fingerprint) return running.result;
      return Promise.reject(Error("같은 전송 키로 다른 답을 보낼 수 없습니다."));
    }
    if (this.sendingCards.has(input.sessionId)) return Promise.reject(Error("이 카드의 이전 전송을 확인하고 있습니다."));
    this.sendingCards.add(input.sessionId);
    const result = this.deliver(paseo, input, messageId, fingerprint).finally(() => {
      this.active.delete(messageId);
      this.sendingCards.delete(input.sessionId);
    });
    this.active.set(messageId, { fingerprint, result });
    return result;
  }

  private async deliver(paseo: Sdk, input: DecisionInput, messageId: string, fingerprint: string): Promise<Receipt> {
    const scope = this.store.read();
    requireScope(scope, input);
    messageId = photoReceiptId(messageId, !!input.images?.length, scope.decisionReceipts);
    const requestId = messageId;
    let earlier = scope.decisionReceipts[messageId];
    if (!earlier) {
      const previous = Object.entries(scope.decisionReceipts).find(([, saved]) =>
        saved.sessionId === input.sessionId && saved.version === input.version &&
        (saved.fingerprint === fingerprint || saved.status === "pending"));
      if (previous) {
        [messageId, earlier] = previous;
        if (earlier.fingerprint !== fingerprint) throw Error("이 카드의 이전 전송 결과를 수신 세션에서 먼저 확인해 주세요.");
      }
    }
    messageId = earlier?.messageId ?? messageId;
    const receipt: Receipt = { ok: true, recipientId: input.recipientId, messageId };
    const rows = await discoverBoardSessions(paseo, this.store, new Set([input.sessionId, input.recipientId]));
    const managed = managedSessions(rows, this.store.read());
    const row = managed.find(r => r.id === input.sessionId && r.projectId === input.projectId);
    const destination = managed.find(r => r.id === input.recipientId) ??
      (isManagedCoordinator(scope, input.recipientId) ? rows.find(r => r.id === input.recipientId) : undefined);
    if (!row || !destination) throw Error(changed);
    return withAssignmentHost(paseo, destination.serverId, sdk =>
      this.deliverTo(paseo, sdk, row, destination, scope, input, receipt, requestId, fingerprint, earlier));
  }

  private async deliverTo(paseo: Sdk, sdk: Sdk, row: SessionRow, destination: SessionRow, scope: Preferences,
    input: DecisionInput, receipt: Receipt, requestId: string, fingerprint: string,
    earlier?: Preferences["decisionReceipts"][string],
  ): Promise<Receipt> {
    const { messageId } = receipt;
    const recipient = sdk.agents.ref(input.recipientId);
    if (earlier) {
      if (earlier.fingerprint !== fingerprint) throw Error("같은 전송 키로 다른 답을 보낼 수 없습니다.");
      if (earlier.status === "sent") {
        if (requestId !== messageId && !scope.decisionReceipts[requestId]) {
          this.store.change(current => { current.decisionReceipts[requestId] = { ...current.decisionReceipts[messageId], messageId }; });
        }
        return receipt;
      }
      // A worker can restart after the daemon accepted a message but before the receipt was saved.
      const page = await recipient.timeline.refetch({ direction: "tail", projection: "projected", limit: 128 });
      const latestScope = this.store.read();
      requireScope(latestScope, input);
      if (!isCurrentMembership(row, latestScope) || (!isCurrentMembership(destination, latestScope) && !isManagedCoordinator(latestScope, destination.id))) throw Error(changed);
      const accepted = !page.error && !page.gap && !page.staleCursor && page.entries.some(({ item }) =>
        item.type === "user_message" && (item.clientMessageId === messageId || item.messageId === messageId) &&
        (earlier.messageHash ? hash(item.text) === earlier.messageHash : item.text === input.text));
      if (!accepted) throw Error("이전 전송 결과를 확인하지 못했습니다. 수신 세션에서 확인해 주세요.");
      this.finish(input, messageId, requestId);
      return receipt;
    }

    if (row.nativePending || row.status !== "idle") throw Error(blocked);
    requireScope(this.store.read(), input);
    const evidence = await this.reader.read(paseo, row, true);
    if (!evidence) throw Error(changed);
    const targets = row.id === destination.id ? [destination] : [row, destination];
    const latest = await Promise.all(targets.map(target => {
      const refresh = async (client: Sdk) => ({ id: target.id, agent: (await client.agents.ref(target.id).refresh())?.agent });
      return target.serverId === destination.serverId ? refresh(sdk) : withAssignmentHost(paseo, target.serverId, refresh);
    }));
    for (const { id, agent } of latest) {
      if (!agent || agent.id !== id || agent.internal || agent.archivedAt || !canReceiveBoardInput(agent,input.action==="coordinate" && id===input.recipientId && id!==input.sessionId)) throw Error(blocked);
      if (id === input.sessionId && row.activityAt !== agent.updatedAt) throw Error(changed);
    }
    const note = this.notes.visible(new Set([row.id]))[row.id];
    let text = "";
    this.store.change(current => {
      requireScope(current, input);
      if (!isCurrentMembership(row, current) || (!isCurrentMembership(destination, current) && !isManagedCoordinator(current, destination.id))) throw Error(changed);
      const judgment = current.judgments[row.id];
      if (verifiedBoardFact(row, evidence, current, note)) throw Error(changed);
      Object.assign(row, classify(evidence, row, judgment?.projectId === row.projectId ? judgment : undefined, row.id === current.coordinator), { evidenceId: evidence.id });
      decorateDecision(row, note, current, evidence);
      restoreClarifiedDecision(row, note, current, evidence);
      if (!row.decision || row.decision.source === "permission" || row.decision.version !== input.version) throw Error(changed);
      text = sessionReplyMessage(row,input);
      if (input.images?.length) this.sessionPhotos.save(input.recipientId, messageId, input.images);
      current.decisionReceipts[messageId] = {
        ...(input.images?.length ? {messageId} : {}),
        messageHash:hash(text),
        activity: { origin:{sessionId:row.id, sessionHost:row.serverId, sessionProjectId:row.serverId ? row.projectId : undefined,
          cardId:row.id, revision:input.version, questions:[{id:input.version}]},
          title: row.decision.question || row.title, at: new Date().toISOString(), projectId: input.projectId,
          ...(input.images?.length ? {imageCount:input.images.length} : {}),
          answer: input.text, recipientId: input.recipientId, coordinator: input.action === "coordinate" },
        fingerprint, sessionId: row.id, version: input.version, evidenceId: evidence.id, status: "pending", beforeAnswer: current.answers[row.id]?.version, ...(note?.kind === "question" ? { noteRevision: note.revision } : {}),
      };
    });
    try {
      await recipient.send(text, { messageId, activeTurnBehavior: "steer", ...(input.images?.length ? {images:input.images} : {}) });
    } catch {
      throw Error("전송 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하거나 수신 세션을 열어 주세요.");
    }
    this.finish(input, messageId);
    return receipt;
  }

  private finish(input: DecisionInput, messageId: string, requestId = messageId) {
    this.store.change(current => {
      const delivery = current.decisionReceipts[messageId];
      delivery.status = "sent";
      if (requestId !== messageId) current.decisionReceipts[requestId] = { ...delivery, messageId };
      if (input.action === "reply" && current.projects.includes(input.projectId) && current.answers[input.sessionId]?.version === delivery.beforeAnswer) {
        current.answers[input.sessionId] = { version: input.version, noteRevision: delivery.noteRevision };
      }
    });
  }
}
