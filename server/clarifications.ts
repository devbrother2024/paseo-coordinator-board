import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import {
  clarificationKey,
  clarificationTarget,
  sourceQuestion,
  type ClarificationCard,
  type ClarificationEntry,
  type ClarificationInput,
  type ClarificationView,
} from "../shared/clarifications";
import { join } from "node:path";
import { SessionPhotoStore } from "./session-photos";
import { describePhotos, photoReceiptId } from "./reply-photos";
import type { PreferenceStore, Preferences } from "./preferences";
import type { SessionRow, Note } from "../shared/contract";
import type { Evidence } from "./conversation";
import { isCurrentMembership, managedSessions } from "./session-links";
import { canReceiveBoardInput, discoverSessions, permissionVersion } from "./discovery";
import { isManagedCoordinator } from "./preferences";
import { discoverBoardSessions } from "./board-sessions";
import { withAssignmentHost } from "./host-assignment";

export { restoreClarifiedDecision } from "./session-decisions";

type Sdk = PluginHandlerContext["paseo"];
type Stored = Preferences["clarifications"][string];
type Target = NonNullable<ReturnType<typeof clarificationTarget>>;
type View = ClarificationView & { notes: Record<string, Note> };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const changed = "원래 질문이나 작업 세션이 바뀌었습니다. 카드를 새로 고쳐 주세요.";
const uncertain = "추가 질문의 전송 여부를 확인하지 못했습니다. 같은 내용으로 다시 확인해 주세요.";

function requestId(key: string) {
  const hex = hash("coordinator-board/clarification/" + key);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    "4" + hex.slice(13, 16),
    "8" + hex.slice(17, 20),
    hex.slice(20, 32),
  ].join("-");
}
function body(input: ClarificationInput, target: Target) {
  return (
    "[Coordinator Board · 추가 질문]\n" +
    JSON.stringify({
      card: input.card,
      sourceSessionId: target.sourceSessionId,
      sourceHost: target.sourceHost,
      recipientSessionId: input.recipientId,
      title: target.title,
      originalQuestion: target.question,
    }) +
    "\n\n이 결정에 대한 추가 질문입니다. 아래 질문에 설명으로 답해 주세요. 결정·승인·병합·작업 실행은 별도입니다.\n\n" +
    input.question
  );
}

function inScope(scope: Preferences, card: ClarificationCard) {
  return card.projectId === null ? scope.projects.length > 0 : scope.projects.includes(card.projectId);
}

export function clarificationHistory(
  store: PreferenceStore,
  rows: Map<string, SessionRow>,
  evidence: Map<string, Evidence>,
): ClarificationEntry[] {
  const scope = store.read();
  const result: ClarificationEntry[] = [];
  const updates = new Map<string, string | undefined>();
  for (const entry of Object.values(scope.clarifications)) {
    if (!inScope(scope, entry.card) || !rows.has(entry.recipientId)) continue;
    const message = evidence.get(entry.recipientId)?.clarificationMessages?.get(entry.messageId);
    const accepted = message?.bodyHash === entry.bodyHash;
    const response = (accepted ? message.response : undefined) ?? entry.response;
    if (accepted && (entry.response !== response || entry.status !== "sent")) updates.set(entry.messageId, response);
    result.push({
      cardKey: entry.cardKey,
      messageId: entry.messageId,
      recipientId: entry.recipientId,
      at: entry.at,
      question: entry.question,
      imageCount: entry.imageCount,
      status: accepted ? "sent" : entry.status,
      response,
    });
  }
  if (updates.size)
    store.change((current) => {
      for (const [id, response] of updates) {
        const record = current.clarifications[id];
        if (record) {
          record.response = response;
          record.status = "sent";
        }
      }
    });
  return result.sort((a, b) => a.at.localeCompare(b.at));
}

export class ClarificationSender {
  private active = new Map<
    string,
    { key: string; fingerprint: string; result: Promise<{ ok: true; messageId: string; recipientId: string }> }
  >();
  private sessionPhotos: SessionPhotoStore;
  constructor(
    private store: PreferenceStore,
    private getView: (sdk: Sdk, card: ClarificationCard) => Promise<View>,
    private isCurrentRecord: (card: ClarificationCard, view: View) => boolean = () => true,
  ) {
    this.sessionPhotos = new SessionPhotoStore(join(store.directory, "session-photos"));
  }

  send(sdk: Sdk, input: ClarificationInput) {
    const id = requestId(input.requestKey);
    const key = clarificationKey(input.card);
    const identity = [key, input.recipientId, input.question, describePhotos(input.images)];
    if (input.card.kind === "tracked" && input.card.sessionQuestion) {
      const { projectId, sessionId, version } = input.card.sessionQuestion;
      identity.push(JSON.stringify([projectId, sessionId, version]));
    }
    const fingerprint = hash(JSON.stringify(identity));
    const running = this.active.get(id);
    if (running) {
      if (running.fingerprint !== fingerprint) throw Error("같은 요청 키로 다른 질문을 보낼 수 없습니다.");
      return running.result;
    }
    if ([...this.active.values()].some((r) => r.key === key))
      throw Error("이 카드의 추가 질문을 전송하고 있습니다.");
    const result = this.deliver(sdk, input, id, fingerprint).finally(() => this.active.delete(id));
    this.active.set(id, { key, fingerprint, result });
    return result;
  }

  private async deliver(sdk: Sdk, input: ClarificationInput, id: string, fingerprint: string) {
    const key = clarificationKey(input.card);
    const scope = this.store.readDispatchScope();
    if (!inScope(scope, input.card)) throw Error(changed);
    id = photoReceiptId(id, !!input.images?.length, scope.clarifications);
    const previous = scope.clarifications[id];
    const receipt = { ok: true as const, messageId: id, recipientId: input.recipientId };
    if (previous?.status === "sent") {
      if (previous.fingerprint !== fingerprint) throw Error("같은 요청 키로 다른 질문을 보낼 수 없습니다.");
      return receipt;
    }
    const placement = scope.dispatchReceipts[input.recipientId];
    const serverId = placement?.remote ? placement.location.serverId : undefined;
    return withAssignmentHost(sdk, serverId, recipientSdk =>
      this.deliverTo(sdk, recipientSdk, serverId, input, scope, key, receipt, fingerprint, previous));
  }

  private async deliverTo(sdk: Sdk, recipientSdk: Sdk, serverId: string | undefined, input: ClarificationInput,
    scope: Preferences, key: string, receipt: { ok: true; messageId: string; recipientId: string }, fingerprint: string, previous?: Stored,
  ) {
    const id = receipt.messageId;
    const handle = recipientSdk.agents.ref(input.recipientId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw Error("같은 요청 키로 다른 질문을 보낼 수 없습니다.");
      const all = await discoverBoardSessions(sdk, this.store, new Set([input.recipientId]));
      const scopeNow = this.store.read();
      if (
        !inScope(scopeNow, input.card) ||
        !(
          managedSessions(all, scopeNow).some(r => r.id === input.recipientId && r.serverId === serverId) ||
          (!serverId && isManagedCoordinator(scopeNow, input.recipientId) && all.some(r => r.id === input.recipientId && !r.serverId))
        )
      )
        throw Error(changed);
      const page = await handle.timeline.refetch({ direction: "tail", projection: "projected", limit: 128 });
      if (
        page.error ||
        page.gap ||
        page.staleCursor ||
        !page.entries.some(
          ({ item }) =>
            item.type === "user_message" &&
            (item.clientMessageId === id || item.messageId === id) &&
            hash(item.text) === previous.bodyHash,
        )
      )
        throw Error(uncertain);
      if (!inScope(this.store.read(), input.card)) throw Error(changed);
    } else {
      if (Object.values(scope.clarifications).some((r) => r.cardKey === key && r.status === "pending"))
        throw Error(uncertain);
      // Refresh the destination first so that the final card read verifies ownership,
      // permissions and revision after the asynchronous transport lookup.
      const destination = (await handle.refresh())?.agent;
      if (
        !destination ||
        destination.id !== input.recipientId ||
        destination.archivedAt ||
        destination.internal || destination.status==="closed" || destination.status==="error"
      )
        throw Error("질문을 받을 수 있는 대기 중인 세션을 확인해 주세요.");
      const view = await this.getView(sdk, input.card);
      const target = clarificationTarget(input.card, view);
      if (!target || target.recipientId !== input.recipientId) throw Error(changed);
      const original = sourceQuestion(input.card);
      const source = target.sourceHost ? undefined : view.sessions.find((s) =>
        s.id === target.sourceSessionId && s.projectId === (original?.projectId ?? input.card.projectId)
      );
      const recipient = view.sessions.find((s) => s.id === input.recipientId);
      if (recipient?.serverId !== serverId) throw Error(changed);
      const ids = new Set([input.recipientId, ...(original ? [original.sessionId] : [])]);
      for (const sessionId of ids) {
        const refresh = (client: Sdk) => client.agents.ref(sessionId).refresh();
        const live = (await (sessionId === input.recipientId || source?.serverId === serverId
          ? refresh(recipientSdk) : withAssignmentHost(sdk, source?.serverId, refresh)))?.agent;
        if (!live || live.id !== sessionId || live.archivedAt || live.internal) throw Error(changed);
        if (
          sessionId === input.recipientId &&
          !canReceiveBoardInput(live,target.recipientId===view.coordinator || target.recipientId===target.sourceCoordinatorId)
        )
          throw Error(changed);
        if (
          sessionId === original?.sessionId &&
          (source?.nativePending ? permissionVersion(live) !== source.permissionVersion : live.updatedAt !== source?.activityAt)
        )
          throw Error(changed);
      }
      if (target.sourceCoordinatorId === input.recipientId) {
        const rows = await discoverSessions(sdk);
        const scopeNow = this.store.read();
        const visible = managedSessions(rows, scopeNow).some(r => r.id === input.recipientId);
        const operating = scopeNow.coordinator === input.recipientId && isManagedCoordinator(scopeNow, input.recipientId) &&
          rows.some(r => r.id === input.recipientId);
        if (!visible && !operating) throw Error(changed);
      }
      if (!this.isCurrentRecord(input.card, view)) throw Error(changed);
      const text = body(input, target);
      const preserve = original && source?.decision && source.decision.version === original.version &&
        source.decision.source !== "permission" && source.id === input.recipientId;
      const entry: Stored = {
        card: input.card,
        cardKey: key,
        sourceSessionId: target.sourceSessionId,
        recipientId: input.recipientId,
        messageId: id,
        fingerprint,
        bodyHash: hash(text),
        at: new Date().toISOString(),
        question: input.question,
        status: "pending",
        ...(input.images?.length ? { imageCount: input.images.length } : {}),
        ...(preserve ? {
          savedDecision: source.decision,
          sourceEvidenceId: source.evidenceId,
          sourceRequestedAt: source.decisionRequestedAt,
          noteRevision: view.notes[source.id]?.revision ?? 0,
        } : {}),
      };
      this.store.change((current) => {
        if (
          !inScope(current, input.card) ||
          current.coordinator !== view.coordinator ||
          (original && (current.answers[original.sessionId]?.version === original.version ||
            JSON.stringify(current.judgments[original.sessionId]) !== JSON.stringify(scope.judgments[original.sessionId]))) ||
          (source && !isCurrentMembership(source, current)) ||
          !(
            (recipient && isCurrentMembership(recipient, current)) ||
            isManagedCoordinator(current, input.recipientId)
          )
        )
          throw Error(changed);
        if (input.images?.length) this.sessionPhotos.save(input.recipientId, id, input.images);
        current.clarifications[id] = entry;
      });
      try {
        await handle.send(text, {
          messageId: id,
          activeTurnBehavior: "steer",
          ...(input.images?.length ? { images: input.images } : {}),
        });
      } catch {
        throw Error(uncertain);
      }
    }
    this.store.change((current) => {
      current.clarifications[id].status = "sent";
    });
    return receipt;
  }
}
