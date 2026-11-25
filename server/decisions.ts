import { applyDoneNotes, decorateDecision, restoreClarifiedDecision } from "./session-decisions";
import { questionContext } from "./open-questions";
import { join } from "node:path";
import { SessionPhotoStore } from "./session-photos";
import { describePhotos, photoReceiptId, saveLocalPhotos, readLocalPhoto, removeLocalPhotos } from "./reply-photos";
import { sessionReplyMessage } from "./decision-message";
import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { changedDecisionMessage as changed, type DecisionInput } from "../shared/decision-actions";
import type { SessionRow } from "../shared/contract";
import { canChangeQueue, type QueueAction } from "../shared/busy-delivery";
import type { WorkImage } from "../shared/work-images";
import { classify, ConversationReader, scanOf } from "./conversation";
import { isCurrentMembership, managedSessions } from "./session-links";
import { canReceiveBoardInput } from "./discovery";
import { discoverBoardSessions } from "./board-sessions";
import { withAssignmentHost } from "./host-assignment";
import type { NoteStore } from "./notes";
import { verifiedBoardFact } from "./board-facts";
import { isManagedCoordinator, type Preferences, type PreferenceStore } from "./preferences";

export { decorateDecision } from "./session-decisions";

type Sdk = PluginHandlerContext["paseo"];
type Receipt = { ok: true; queued?:true; recipientId: string; messageId: string };
const waiting = "예약이 변경되었습니다. / The queued reply changed.";
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
  private queuePhotos:string;
  private sessionPhotos: SessionPhotoStore;
  constructor(private store: PreferenceStore, private notes: NoteStore, private reader: ConversationReader) {
    this.queuePhotos = join(store.directory,"queued-conversation-photos");
    this.sessionPhotos = new SessionPhotoStore(join(store.directory, "session-photos"));
  }

  send(paseo: Sdk, input: DecisionInput): Promise<Receipt> {
    return this.run(paseo,input);
  }

  private run(paseo:Sdk, input:DecisionInput, queuedId?:string, inspectOnly=false):Promise<Receipt> {
    const messageId = messageUuid(input.requestKey);
    const photos = describePhotos(input.images);
    const content = [input.projectId, input.sessionId, input.recipientId, input.version, input.action, input.text];
    // Keep text-only keys compatible with receipts written before photo support.
    const fingerprint = hash(photos.length ? [...content, photos] : content);
    const running = this.active.get(messageId);
    if (running && inspectOnly) throw Error(waiting);
    if (running) {
      if (running.fingerprint === fingerprint) return running.result;
      return Promise.reject(Error("같은 전송 키로 다른 답을 보낼 수 없습니다."));
    }
    if (this.sendingCards.has(input.sessionId)) return Promise.reject(Error("이 카드의 이전 전송을 확인하고 있습니다."));
    this.sendingCards.add(input.sessionId);
    const result = this.deliver(paseo, input, messageId, fingerprint, queuedId, inspectOnly).finally(() => {
      this.active.delete(messageId);
      this.sendingCards.delete(input.sessionId);
    });
    this.active.set(messageId, { fingerprint, result });
    return result;
  }

  private async deliver(paseo: Sdk, input: DecisionInput, messageId: string, fingerprint: string, queuedId?:string, inspectOnly=false): Promise<Receipt> {
    const scope = this.store.read();
    requireScope(scope, input);
    messageId = photoReceiptId(messageId, !!input.images?.length, scope.decisionReceipts);
    const requestId = messageId;
    const queued = Object.entries(scope.queuedDecisions).find(([id,q]) => id === messageId ||
      (q.input.sessionId === input.sessionId && q.input.version === input.version));
    if (queued && queued[1].fingerprint !== fingerprint) throw Error(waiting);
    if (queuedId && (queued?.[0] !== queuedId || queued[1].stopped || queued[1].parallel === "held")) throw Error(waiting);
    if (queued && !queuedId) return {ok:true,queued:true,messageId:queued[0],recipientId:input.recipientId};
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
      this.deliverTo(paseo, sdk, row, destination, scope, input, receipt, requestId, fingerprint, earlier, queuedId, inspectOnly));
  }

  private async deliverTo(paseo: Sdk, sdk: Sdk, row: SessionRow, destination: SessionRow, scope: Preferences,
    input: DecisionInput, receipt: Receipt, requestId: string, fingerprint: string,
    earlier?: Preferences["decisionReceipts"][string], queuedId?:string, inspectOnly=false,
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

    const activeReply = row.status === "running" && input.action === "reply" && row.id === destination.id;
    if (queuedId && (row.status==="closed" || row.status==="error")) throw Error(changed);
    if (row.nativePending || (row.status !== "idle" && !activeReply)) throw Error(blocked);
    requireScope(this.store.read(), input);
    const evidence = await this.reader.read(paseo, row, true, {openReply:activeReply});
    if (!evidence) throw Error(changed);
    const targets = row.id === destination.id ? [destination] : [row, destination];
    const latest = await Promise.all(targets.map(target => {
      const refresh = async (client: Sdk) => ({ id: target.id, agent: (await client.agents.ref(target.id).refresh())?.agent });
      return target.serverId === destination.serverId ? refresh(sdk) : withAssignmentHost(paseo, target.serverId, refresh);
    }));
    for (const { id, agent } of latest) {
      if (!agent || agent.id !== id || agent.internal || agent.archivedAt) throw Error(changed);
      const runningReply = activeReply && agent.status === "running" && agent.activeTurn &&
        !agent.pendingPermissions.length && agent.attentionReason !== "permission" && agent.attentionReason !== "error";
      if (!runningReply && !canReceiveBoardInput(agent,input.action==="coordinate" && id===input.recipientId && id!==input.sessionId)) throw Error(blocked);
      if (id === input.sessionId && row.activityAt !== agent.updatedAt) throw Error(changed);
    }
    const note = this.notes.visible(new Set([row.id]))[row.id];
    // Reconstruct the open card from fresh evidence with the same classification used when it was shown.
    // The actual recipient state above still controls whether the reply can go out.
    if (activeReply) row = {...row, status:"idle", lane:"idle", detail:""};
    const current = this.store.read();
    requireScope(current, input);
    if (!isCurrentMembership(row, current) || (!isCurrentMembership(destination, current) && !isManagedCoordinator(current, destination.id))) throw Error(changed);
    const prior = current.queuedDecisions[messageId];
    if (queuedId && (!prior || prior.stopped || prior.parallel === "held" || prior.serverId !== (destination.serverId ?? null))) throw Error(waiting);
    const judgment = current.judgments[row.id];
    Object.assign(row, classify(evidence, row, judgment?.projectId === row.projectId ? judgment : undefined, row.id === current.coordinator,
      questionContext(current, row.id)), { evidenceId: evidence.id });
    // After classification, so a question still waiting for the person outranks a status report after it.
    if (verifiedBoardFact(row, evidence, current, note)) throw Error(changed);
    // As the snapshot does: a done note that already closed a question no longer hides the card it uncovered.
    if (note) applyDoneNotes([row], { [row.id]: note }, current);
    decorateDecision(row, note, current, evidence);
    const found = row.decision;
    restoreClarifiedDecision(row, note, current, evidence);
    // A card restored from before a clarification is not the question the session's turn is about now.
    const restored = row.decision !== found;
    if (!row.decision || row.decision.source === "permission" || row.decision.version !== input.version) throw Error(changed);
    const agent = latest.find(target => target.id === destination.id)!.agent!;
    // A bare reply joins the session's current turn only while the card's question is its latest message and nothing came
    // in after it. Otherwise the turn may be about something else: the reply waits for the turn to end and then goes
    // with the card information that binds it to the question.
    const asked = row.decision.source === "conversation" ? scanOf(row)?.open.at(-1) : undefined;
    const lastEvent = evidence.events?.at(-1);
    const bare = !restored &&
      (!asked || (!!asked.turn && lastEvent?.role === "assistant" && lastEvent.seq === asked.turn.seq && !evidence.laterInput));
    const waitForTurn = activeReply && (!bare || !canReceiveBoardInput(agent,!row.decision.deliverWhenIdle));
    // The question the shown card asks. A card restored from before a clarification asks the question it was saved with,
    // not the newest one the session asked since: find that question among the open ones by its words. If it cannot be
    // found, the receipt names no question the board knows, so the reply closes none (it stays open rather than closing
    // the wrong one).
    const answered = row.decision.source !== "conversation" ? undefined
      : !restored ? row.keptQuestion?.key
      : scanOf(row)?.open.findLast(item => item.question === row.decision!.question)?.key ?? "unmatched-restored-card";
    const decision = row.decision;
    if (inspectOnly && !waitForTurn) throw Error(waiting);
    if (waitForTurn) {
      if (!prior && !inspectOnly) {
        const {images,...request} = input;
        const entry = {input:request,at:new Date().toISOString(),title:decision.question,
          fingerprint,serverId:destination.serverId ?? null,photos:describePhotos(images),stopped:false};
        const saved = saveLocalPhotos(this.queuePhotos,messageId,images ?? [],()=>{
          this.store.change(scope=>{scope.queuedDecisions[messageId]=entry;});
          return true;
        });
        if (!saved) throw Error("예약 사진 저장 실패 / Could not save queued photos.");
      }
      return {...receipt,queued:true};
    }
    const text = (activeReply || queuedId) && bare ? input.text : sessionReplyMessage(row,input);
    if (input.images?.length) this.sessionPhotos.save(input.recipientId, messageId, input.images);
    this.store.change(current => {
      if (prior) delete current.queuedDecisions[messageId];
      current.decisionReceipts[messageId] = {
        ...(input.images?.length ? {messageId} : {}),
        messageHash:hash(text),
        activity: { origin:{sessionId:row.id, sessionHost:row.serverId, sessionProjectId:row.serverId ? row.projectId : undefined,
          cardId:row.id, revision:input.version, questions:[{id:input.version}]},
          title: decision.question || row.title, at: new Date().toISOString(), projectId: input.projectId,
          ...(input.images?.length ? {imageCount:input.images.length} : {}),
          answer: input.text, recipientId: input.recipientId, coordinator: input.action === "coordinate" },
        fingerprint, sessionId: row.id, version: input.version, evidenceId: evidence.id, status: "pending", beforeAnswer: current.answers[row.id]?.version, ...(note?.kind === "question" ? { noteRevision: note.revision } : {}),
        // The conversation question this reply answers. Its arrival closes that question and no other.
        ...(answered ? { question: answered } : {}),
      };
    });
    if (queuedId) removeLocalPhotos(this.queuePhotos,queuedId,input.images?.length ?? 0);
    try {
      await recipient.send(text, { messageId, activeTurnBehavior: "steer", ...(input.images?.length ? {images:input.images} : {}) });
    } catch {
      throw Error("전송 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하거나 수신 세션을 열어 주세요.");
    }
    this.finish(input, messageId);
    return receipt;
  }

  private queuedInput(id:string, entry:Preferences["queuedDecisions"][string]):DecisionInput {
    const images:WorkImage[] = entry.photos.map((photo,index) => {
      const image = readLocalPhoto(this.queuePhotos,id,index,photo);
      if (!image) throw Error(changed);
      return image;
    });
    return {...entry.input,...(images.length ? {images} : {})};
  }

  hasWaiting(sessionId?:string) {
    return Object.values(this.store.read().queuedDecisions).some(entry =>
      !entry.stopped && entry.parallel !== "held" && (!sessionId || entry.input.sessionId === sessionId));
  }

  async resume(sdk:Sdk, sessionId?:string) {
    for (const [id,entry] of Object.entries(this.store.read().queuedDecisions)) {
      if (entry.stopped || entry.parallel === "held" || (sessionId && entry.input.sessionId !== sessionId)) continue;
      try { await this.run(sdk,this.queuedInput(id,entry),id); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== changed) continue;
        this.store.change(scope => {
          const current = scope.queuedDecisions[id];
          if (current && current.parallel !== "held") current.stopped = true;
        });
      }
    }
  }

  async verifyQueue(sdk:Sdk,id:string) {
    const entry = this.store.read().queuedDecisions[id];
    if (!entry) return false;
    await this.run(sdk,this.queuedInput(id,entry),id,true);
    return true;
  }

  control(input:QueueAction, provider:string | null | undefined, minutes:number) {
    const card = input.card;
    if (card.kind !== "session") return;
    const scope = this.store.read(), entry = scope.queuedDecisions[input.messageId];
    if (!entry || !scope.projects.includes(card.projectId) || entry.input.projectId !== card.projectId ||
        entry.input.sessionId !== card.sessionId || entry.input.version !== card.version) return;
    if (!canChangeQueue(entry, input.action, provider, minutes)) return;
    const request = {title:entry.title, recipientId:entry.input.recipientId, answer:entry.input.text,
      images:input.action === "parallel" ? this.queuedInput(input.messageId,entry).images : undefined};
    this.store.change(current => {
      if (input.action === "cancel") delete current.queuedDecisions[input.messageId];
      else current.queuedDecisions[input.messageId].parallel = input.action === "parallel" ? "held" : "resumed";
    });
    if (input.action === "cancel") removeLocalPhotos(this.queuePhotos,input.messageId,entry.photos.length);
    return request;
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
