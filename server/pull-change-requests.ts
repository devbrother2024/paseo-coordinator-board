import { createHash } from "node:crypto";
import { join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import type { SessionRow } from "../shared/contract";
import { pullUrl, type PullRequestItem } from "../shared/prs";
import { pullJudgmentKey } from "../shared/pull-judgments";
import {
  changeRequestRecipient, holdsMergeCard, prunePullChangeRequests, requestPullChanges, withdrawPullChangeRequest,
  type PullChangeInput, type PullChangeRequest, type PullChangeResult,
} from "../shared/pull-change-requests";
import type { ReplyEntry } from "../shared/reply-history";
import { boardPhotoMessageId } from "../shared/session-photos";
import type { Evidence } from "./conversation";
import { REPLY_MAY_BE } from "./decision-message";
import { canReceiveBoardInput } from "./discovery";
import type { PreferenceStore, Preferences } from "./preferences";
import { describePhotos, readLocalPhoto, removeLocalPhotos, saveLocalPhotos } from "./reply-photos";
import { canChangeQueue, type QueueAction, type QueueView } from "../shared/busy-delivery";
import type { WorkImage } from "../shared/work-images";
import { SessionPhotoStore } from "./session-photos";

type Sdk = PluginHandlerContext["paseo"];
type View = {
  pullRequests: { items: PullRequestItem[] }; sessions: SessionRow[]; coordinator: string | null;
  projects: readonly { id: string; title: string }[];
};
// An attempt whose delivery is unknown keeps other requests for the same PR out for this long.
const holdMs = 10 * 60_000;
const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
const own = <T>(record: Record<string, T>, key: string) => Object.hasOwn(record, key) ? record[key] : undefined;

function messageUuid(requestKey: string) {
  const h = hash(["coordinator-board/pull-change", requestKey]);
  return [h.slice(0, 8), h.slice(8, 12), "4" + h.slice(13, 16), "8" + h.slice(17, 20), h.slice(20, 32)].join("-");
}

// The project name comes from Paseo. Control and direction characters are removed.
const plain = (value: string) => value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();

// The card's context is board-generated and stays apart from the person's own words, which follow it untouched.
// This message has no source, so the session reads it as the person's. The PR is therefore named only by repository,
// number, link and commit: its title is text anyone who can edit the PR on GitHub controls, and it is left out.
export function pullChangeMessage(pr: Pick<PullRequestItem, "repo" | "number" | "headSha">, project: { id: string; title?: string },
  recipientId: string, text: string) {
  const projectTitle = project.title ? plain(project.title) : "";
  const heading = [projectTitle, pr.repo + " #" + pr.number].filter(Boolean).join(" · ").slice(0, 180);
  return "[Coordinator Board · " + heading + "]\n" + JSON.stringify({
    projectId: project.id, projectTitle: projectTitle || null, source: "pull-request", repo: pr.repo, number: pr.number,
    url: pullUrl(pr.repo, pr.number), headSha: pr.headSha, recipientSessionId: recipientId,
    action: "change-request", mayBe: REPLY_MAY_BE,
  }) + "\n\n" + text;
}

// Change requests in recent decision activity, with the first answer of the session that took each one.
export function changeRequestHistory(scope: Pick<Preferences, "pullChangeRequests">, selected: ReadonlySet<string>,
  evidence: ReadonlyMap<string, Evidence>): { entries: ReplyEntry[]; responses: Map<string, string>; confirmed: string[] } {
  const entries: ReplyEntry[] = [];
  const responses = new Map<string, string>();
  const confirmed: string[] = [];
  for (const [key, saved] of Object.entries(scope.pullChangeRequests)) {
    // A request still waiting for its recipient has not been sent. It shows on the PR row, not in the history.
    if (!selected.has(saved.projectId) || saved.status === "queued") continue;
    const seen = evidence.get(saved.recipientId);
    // A request whose delivery was unknown is confirmed once the board reads that exact message in the recipient's conversation.
    const arrived = saved.status === "pending" && seen?.boardMessageHashes?.get(saved.messageId) === saved.messageHash;
    if (arrived) confirmed.push(key);
    const request = { ...saved, status: arrived ? "sent" as const : saved.status };
    const reply = request.status === "sent" ? seen?.replies?.get(request.messageId) : undefined;
    if (reply && reply !== request.response) responses.set(key, reply);
    entries.push({
      key: "change:" + key, title: request.title, projectId: request.projectId, at: request.at, answer: request.text || undefined,
      recipientId: request.recipientId, coordinator: request.coordinator, messageId: request.messageId, status: request.status,
      origin: { sessionId: request.coordinator ? null : request.recipientId, cardId: key, revision: request.headSha, questions: [] },
      ...(request.imageCount ? { imageCount: request.imageCount } : {}),
      response: reply ?? request.response,
    });
  }
  return { entries, responses, confirmed };
}

export function confirmChangeRequest(scope: Pick<Preferences, "pullChangeRequests">, key: string, messageId: string) {
  const record = own(scope.pullChangeRequests, key);
  if (record?.messageId === messageId && record.status === "pending") record.status = "sent";
}

// Whether the board may not merge this head now: the person asked for changes on it and has not reopened the card.
export function mergeHeldByChangeRequest(scope: Pick<Preferences, "pullChangeRequests">, repo: string, number: number, headSha: string) {
  return holdsMergeCard(own(scope.pullChangeRequests, pullJudgmentKey(repo, number)), headSha);
}

type Agent = NonNullable<NonNullable<Awaited<ReturnType<ReturnType<Sdk["agents"]["ref"]>["refresh"]>>>["agent"]>;
// In a turn, with nothing that blocks board input. A provider that cannot take input mid-turn makes the request wait.
const inTurn = (agent: Agent) => agent.status === "running" && !!agent.activeTurn && !agent.pendingPermissions.length &&
  agent.attentionReason !== "permission" && agent.attentionReason !== "error";
const gone = (agent: Agent | null | undefined, id: string) =>
  !agent || agent.id !== id || !!agent.internal || !!agent.archivedAt || agent.status === "closed" || agent.status === "error";

// The wait of a queued change request, as the PR row shows it. One written about a head the PR has moved past will
// not be sent, so it shows as stopped: the person can still read it and cancel it.
export function changeQueueView(request: PullChangeRequest, headSha?: string): QueueView | undefined {
  if (request.status !== "queued" || !request.queue || request.withdrawnAt) return undefined;
  return { messageId: request.messageId, recipientId: request.recipientId, answer: request.text || undefined, at: request.at,
    imageCount: request.queue.photos.length, stopped: request.queue.stopped || (!!headSha && headSha !== request.headSha),
    ...(request.queue.parallel ? { parallel: request.queue.parallel } : {}) };
}

export class PullChangeRequests {
  private sending = new Set<string>();
  private resuming = false;
  private sessionPhotos: SessionPhotoStore;
  private queuePhotos: string;
  constructor(private store: PreferenceStore, private getView: (sdk: Sdk) => Promise<View>, private now: () => number = Date.now) {
    this.sessionPhotos = new SessionPhotoStore(join(store.directory, "session-photos"));
    this.queuePhotos = join(store.directory, "queued-change-request-photos");
  }

  register(server: PluginServerContext, onChange: () => void) {
    server.handle(requestPullChanges, async (input, { paseo }) => {
      try { return await this.send(paseo, input); }
      finally { onChange(); }
    });
    server.handle(withdrawPullChangeRequest, async input => {
      const ok = this.withdraw(input);
      if (ok) onChange();
      return { ok };
    });
  }

  async send(sdk: Sdk, input: PullChangeInput): Promise<PullChangeResult> {
    const key = pullJudgmentKey(input.repo, input.number);
    if (this.sending.has(key)) return { status: "unconfirmed" };
    this.sending.add(key);
    try { return await this.deliver(sdk, input, key); }
    finally { this.sending.delete(key); }
  }

  private async deliver(sdk: Sdk, input: PullChangeInput, key: string): Promise<PullChangeResult> {
    const photos = describePhotos(input.images);
    const fingerprint = hash([input.projectId, input.repo, input.number, input.headSha, input.recipientId, input.text, photos]);
    const scope = this.store.read();
    if (!scope.projects.includes(input.projectId)) return { status: "changed" };
    const saved = own(scope.pullChangeRequests, key);
    // A request the person took back by reopening the card is over. Whatever comes next is a new request with a new
    // message, even under the same key and words.
    // So is a request still waiting that was written about a head the PR has moved past: it is never sent, and the
    // request about the new head takes its place.
    const stale = saved?.status === "queued" && saved.headSha !== input.headSha;
    const prior = saved?.withdrawnAt || stale ? undefined : saved;
    const uuid = messageUuid(saved?.withdrawnAt ? input.requestKey + "\n" + saved.withdrawnAt : input.requestKey);
    const fresh = photos.length ? boardPhotoMessageId(uuid) : uuid;
    // The recorded request keeps its own message ID, so its retries find it even when it was sent after a reopening.
    const retried = !!prior && (prior.requestKey === input.requestKey || prior.messageId === fresh);
    const messageId = retried ? prior.messageId : fresh;
    if (retried) {
      // The same request again only checks the earlier attempt. It is never sent twice.
      if (prior.fingerprint !== fingerprint) return { status: "unconfirmed" };
      if (prior.status === "queued") return { status: "queued", recipientId: prior.recipientId };
      return prior.status === "sent" ? { status: "sent", recipientId: prior.recipientId } : this.confirm(sdk, key, prior);
    }
    if (prior?.status === "pending" && this.now() - Date.parse(prior.at) < holdMs) return { status: "unconfirmed" };
    // A request already waiting for this PR took the merge card down. Another one waits until that is sent or cancelled.
    if (prior?.status === "queued") return { status: "changed" };

    const view = await this.getView(sdk);
    const pr = view.pullRequests.items.find(item => item.repo === input.repo && item.number === input.number && item.projectIds.includes(input.projectId));
    // Only a PR that is a merge card now, on the head the person saw, takes a change request.
    if (!pr || pr.headSha !== input.headSha || pr.reason !== "ready" || pr.lane !== "review") return { status: "changed" };
    const recipient = changeRequestRecipient(pr, view.sessions, view.coordinator);
    if (!recipient || recipient.id !== input.recipientId) return { status: "changed" };
    const handle = sdk.agents.ref(recipient.id);
    const agent = (await handle.refresh())?.agent;
    if (gone(agent, recipient.id)) return { status: "changed" };
    // The same rule as a card reply: a Claude or Codex session takes it in its current turn, another provider's turn
    // makes it wait, and a session waiting on a permission request or in an error state never takes board input.
    const ready = canReceiveBoardInput(agent!, true);
    if (!ready && !inTurn(agent!)) return { status: "busy" };

    const project = view.projects.find(entry => entry.id === input.projectId);
    const text = pullChangeMessage(pr, { id: input.projectId, title: project?.title }, recipient.id, input.text);
    const record: PullChangeRequest = {
      repo: input.repo, number: input.number, projectId: input.projectId, headSha: input.headSha, title: pr.title.slice(0, 512),
      text: input.text, recipientId: recipient.id, coordinator: recipient.coordinator, messageId, messageHash: hash(text), fingerprint,
      requestKey: input.requestKey,
      at: new Date(this.now()).toISOString(), status: ready ? "pending" : "queued", ...(photos.length ? { imageCount: photos.length } : {}),
      ...(ready ? {} : { queue: { stopped: false, photos } }),
    };
    const write = () => {
      this.store.change(current => {
        const latest = own(current.pullChangeRequests, key);
        if (!current.projects.includes(input.projectId) || current.coordinator !== view.coordinator ||
            latest?.messageId !== saved?.messageId || latest?.withdrawnAt !== saved?.withdrawnAt) {
          throw Error("changed");
        }
        if (ready && input.images?.length) this.sessionPhotos.save(recipient.id, messageId, input.images);
        if (stale && latest) removeLocalPhotos(this.queuePhotos, latest.messageId, latest.queue?.photos.length ?? 0);
        current.pullChangeRequests[key] = record;
        current.pullChangeRequests = prunePullChangeRequests(current.pullChangeRequests);
      });
      return true;
    };
    try {
      // A waiting request keeps its photos on the host until it goes out.
      if (!(ready ? write() : saveLocalPhotos(this.queuePhotos, messageId, input.images ?? [], write))) return { status: "changed" };
    } catch { return { status: "changed" }; }
    if (!ready) return { status: "queued", recipientId: recipient.id };
    try {
      // The person wrote this and pressed send, so it goes without a source. The board adds no sentence of its own.
      await handle.send(text, { messageId, activeTurnBehavior: "steer", ...(input.images?.length ? { images: input.images } : {}) });
    } catch { return { status: "unconfirmed" }; }
    this.finish(key, messageId);
    return { status: "sent", recipientId: recipient.id };
  }

  hasWaiting(recipientId?: string) {
    return Object.values(this.store.read().pullChangeRequests).some(request => request.status === "queued" && !request.withdrawnAt &&
      !!request.queue && !request.queue.stopped && request.queue.parallel !== "held" && (!recipientId || request.recipientId === recipientId));
  }

  // Sends waiting requests whose recipient can take input now. Each one is checked again first: the PR is still open
  // and ready on the head the person wrote about, and the recipient is still the session it was written for. A request
  // that no longer fits stops, and the person cancels it on the PR row.
  async resume(sdk: Sdk, recipientId?: string) {
    if (this.resuming || !this.hasWaiting(recipientId)) return;
    this.resuming = true;
    try {
      const view = await this.getView(sdk);
      for (const [key, request] of Object.entries(this.store.read().pullChangeRequests)) {
        if (request.status !== "queued" || request.withdrawnAt || !request.queue || request.queue.stopped || request.queue.parallel === "held") continue;
        if (recipientId && request.recipientId !== recipientId) continue;
        if (this.sending.has(key)) continue;
        this.sending.add(key);
        try { await this.resumeOne(sdk, view, key, request); }
        finally { this.sending.delete(key); }
      }
    } finally { this.resuming = false; }
  }

  private stillFor(view: View, request: PullChangeRequest) {
    const pr = view.pullRequests.items.find(item => item.repo === request.repo && item.number === request.number && item.projectIds.includes(request.projectId));
    if (!pr || pr.headSha !== request.headSha || pr.reason !== "ready") return undefined;
    const owner = request.coordinator ? view.coordinator : pr.judgment?.ownerSessionHost ? undefined : pr.judgment?.ownerSessionId;
    return owner === request.recipientId ? pr : undefined;
  }

  private async resumeOne(sdk: Sdk, view: View, key: string, request: PullChangeRequest) {
    const stop = () => this.store.change(current => {
      const record = own(current.pullChangeRequests, key);
      if (record?.messageId === request.messageId && record.queue && record.queue.parallel !== "held") record.queue.stopped = true;
    });
    const scope = this.store.read();
    const pr = scope.projects.includes(request.projectId) && scope.coordinator === view.coordinator ? this.stillFor(view, request) : undefined;
    if (!pr) return stop();
    const handle = sdk.agents.ref(request.recipientId);
    let agent: Agent | null | undefined;
    try { agent = (await handle.refresh())?.agent; } catch { return; }
    if (gone(agent, request.recipientId)) return stop();
    if (!canReceiveBoardInput(agent!, true)) return;
    const images: WorkImage[] = [];
    for (const [index, photo] of request.queue!.photos.entries()) {
      const image = readLocalPhoto(this.queuePhotos, request.messageId, index, photo);
      if (!image) return stop();
      images.push(image);
    }
    const project = view.projects.find(entry => entry.id === request.projectId);
    const text = pullChangeMessage(pr, { id: request.projectId, title: project?.title }, request.recipientId, request.text);
    let claimed = false;
    this.store.change(current => {
      const record = own(current.pullChangeRequests, key);
      // The person may have cancelled or held it while the board was looking.
      if (!record || record.messageId !== request.messageId || record.status !== "queued" || record.withdrawnAt ||
          !record.queue || record.queue.stopped || record.queue.parallel === "held") return;
      if (images.length) this.sessionPhotos.save(request.recipientId, request.messageId, images);
      record.status = "pending"; record.messageHash = hash(text); record.at = new Date(this.now()).toISOString();
      delete record.queue;
      claimed = true;
    });
    if (!claimed) return;
    removeLocalPhotos(this.queuePhotos, request.messageId, images.length);
    try { await handle.send(text, { messageId: request.messageId, activeTurnBehavior: "steer", ...(images.length ? { images } : {}) }); }
    catch { return; }
    this.finish(key, request.messageId);
  }

  // The waiting request a queue action names, while it is still the one on record.
  queuedTarget(input: Pick<QueueAction, "card" | "messageId">) {
    const card = input.card;
    if (card.kind !== "pull") return undefined;
    const scope = this.store.read();
    const request = own(scope.pullChangeRequests, pullJudgmentKey(card.repo, card.number));
    if (!request || !scope.projects.includes(card.projectId) || request.projectId !== card.projectId || request.headSha !== card.headSha ||
        request.messageId !== input.messageId || request.status !== "queued" || request.withdrawnAt || !request.queue) return undefined;
    return request;
  }

  // Whether the request still waits for a recipient that cannot take it yet. A parallel request is offered only then.
  async stillWaiting(sdk: Sdk, input: Pick<QueueAction, "card" | "messageId">) {
    const request = this.queuedTarget(input);
    if (!request) return false;
    const view = await this.getView(sdk);
    if (!this.stillFor(view, request)) return false;
    const agent = (await sdk.agents.ref(request.recipientId).refresh())?.agent;
    return !gone(agent, request.recipientId) && !canReceiveBoardInput(agent!, true);
  }

  // Cancel, hold for a parallel session, or resume. Cancelling removes the request, so the merge card returns.
  control(input: QueueAction, provider: string | null | undefined, minutes: number) {
    const request = this.queuedTarget(input);
    if (!request || input.card.kind !== "pull") return undefined;
    const queue = request.queue!;
    if (!canChangeQueue({ at: request.at, stopped: queue.stopped, parallel: queue.parallel }, input.action, provider, minutes)) return undefined;
    const images: WorkImage[] = [];
    if (input.action === "parallel") {
      for (const [index, photo] of queue.photos.entries()) {
        const image = readLocalPhoto(this.queuePhotos, request.messageId, index, photo);
        if (!image) return undefined;
        images.push(image);
      }
    }
    const key = pullJudgmentKey(request.repo, request.number);
    let done = false;
    this.store.change(current => {
      const record = own(current.pullChangeRequests, key);
      if (record?.messageId !== request.messageId || record.status !== "queued" || !record.queue) return;
      if (input.action === "cancel") delete current.pullChangeRequests[key];
      else record.queue.parallel = input.action === "parallel" ? "held" : "resumed";
      done = true;
    });
    if (!done) return undefined;
    if (input.action === "cancel") removeLocalPhotos(this.queuePhotos, request.messageId, queue.photos.length);
    // The coordinator is told which PR by repository and number. The PR's title is text others can edit on GitHub.
    return { title: request.repo + " #" + request.number, recipientId: request.recipientId, answer: request.text, images };
  }

  // Looks for an earlier attempt in the conversation of the session it was sent to.
  private async confirm(sdk: Sdk, key: string, prior: PullChangeRequest): Promise<PullChangeResult> {
    try {
      const page = await sdk.agents.ref(prior.recipientId).timeline.refetch({ direction: "tail", projection: "projected", limit: 128 });
      const arrived = !page.error && !page.gap && !page.staleCursor && page.entries.some(({ item }) => item.type === "user_message" &&
        (item.messageId === prior.messageId || item.clientMessageId === prior.messageId) && hash(item.text) === prior.messageHash);
      if (!arrived) return { status: "unconfirmed" };
    } catch { return { status: "unconfirmed" }; }
    this.finish(key, prior.messageId);
    return { status: "sent", recipientId: prior.recipientId };
  }

  private finish(key: string, messageId: string) {
    this.store.change(current => confirmChangeRequest(current, key, messageId));
  }

  // The person reopens the merge card, also when the request's delivery is still unknown. Nothing is sent; the record
  // stays in recent decision activity.
  withdraw(input: { projectId: string; repo: string; number: number; headSha: string }) {
    const key = pullJudgmentKey(input.repo, input.number);
    let withdrawn = false;
    let photos: [string, number] | undefined;
    this.store.change(current => {
      const record = own(current.pullChangeRequests, key);
      if (!record || !current.projects.includes(input.projectId) || record.projectId !== input.projectId ||
          record.headSha !== input.headSha || record.withdrawnAt) return;
      // A request that never went out leaves nothing behind.
      if (record.status === "queued") { photos = [record.messageId, record.queue?.photos.length ?? 0]; delete current.pullChangeRequests[key]; }
      else record.withdrawnAt = new Date(this.now()).toISOString();
      withdrawn = true;
    });
    if (photos) removeLocalPhotos(this.queuePhotos, photos[0], photos[1]);
    return withdrawn;
  }
}
