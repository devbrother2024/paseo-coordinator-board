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
import { describePhotos } from "./reply-photos";
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

// Names shown in the heading and context come from GitHub and Paseo. Control and direction characters are removed.
const plain = (value: string) => value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();

// The card's context is board-generated and stays apart from the person's own words, which follow it untouched.
export function pullChangeMessage(pr: Pick<PullRequestItem, "repo" | "number" | "title" | "headSha">, project: { id: string; title?: string },
  recipientId: string, text: string) {
  const title = plain(pr.title), projectTitle = project.title ? plain(project.title) : "";
  const heading = [projectTitle, title].filter(Boolean).join(" · ").slice(0, 180);
  return "[Coordinator Board · " + heading + "]\n" + JSON.stringify({
    projectId: project.id, projectTitle: projectTitle || null, source: "pull-request", repo: pr.repo, number: pr.number,
    url: pullUrl(pr.repo, pr.number), title, headSha: pr.headSha, recipientSessionId: recipientId,
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
    if (!selected.has(saved.projectId)) continue;
    const seen = evidence.get(saved.recipientId);
    // A request whose delivery was unknown is confirmed once the board reads that exact message in the recipient's conversation.
    const arrived = saved.status === "pending" && seen?.boardMessageHashes?.get(saved.messageId) === saved.messageHash;
    if (arrived) confirmed.push(key);
    const request = arrived ? { ...saved, status: "sent" as const } : saved;
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
export function mergeHeldByChangeRequest(scope: Pick<Preferences, "pullChangeRequests" | "pullJudgments">, repo: string, number: number, headSha: string) {
  const key = pullJudgmentKey(repo, number);
  const verdict = own(scope.pullJudgments, key);
  return holdsMergeCard(own(scope.pullChangeRequests, key), headSha, verdict?.headSha === headSha ? verdict.at : undefined);
}

export class PullChangeRequests {
  private sending = new Set<string>();
  private sessionPhotos: SessionPhotoStore;
  constructor(private store: PreferenceStore, private getView: (sdk: Sdk) => Promise<View>, private now: () => number = Date.now) {
    this.sessionPhotos = new SessionPhotoStore(join(store.directory, "session-photos"));
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
    const prior = saved?.withdrawnAt ? undefined : saved;
    const uuid = messageUuid(saved?.withdrawnAt ? input.requestKey + "\n" + saved.withdrawnAt : input.requestKey);
    const messageId = photos.length ? boardPhotoMessageId(uuid) : uuid;
    if (prior?.messageId === messageId) {
      // The same request again only checks the earlier attempt. It is never sent twice.
      if (prior.fingerprint !== fingerprint) return { status: "unconfirmed" };
      return prior.status === "sent" ? { status: "sent", recipientId: prior.recipientId } : this.confirm(sdk, key, prior);
    }
    if (prior?.status === "pending" && this.now() - Date.parse(prior.at) < holdMs) return { status: "unconfirmed" };

    const view = await this.getView(sdk);
    const pr = view.pullRequests.items.find(item => item.repo === input.repo && item.number === input.number && item.projectIds.includes(input.projectId));
    // Only a PR that is a merge card now, on the head the person saw, takes a change request.
    if (!pr || pr.headSha !== input.headSha || pr.reason !== "ready" || pr.lane !== "review") return { status: "changed" };
    const recipient = changeRequestRecipient(pr, view.sessions, view.coordinator);
    if (!recipient || recipient.id !== input.recipientId) return { status: "changed" };
    const handle = sdk.agents.ref(recipient.id);
    const agent = (await handle.refresh())?.agent;
    if (!agent || agent.id !== recipient.id || agent.internal || agent.archivedAt || agent.status === "closed" || agent.status === "error") {
      return { status: "changed" };
    }
    // A session waiting on a permission request never takes board input, and a busy work session waits.
    if (!canReceiveBoardInput(agent, recipient.coordinator)) return { status: "busy" };

    const project = view.projects.find(entry => entry.id === input.projectId);
    const text = pullChangeMessage(pr, { id: input.projectId, title: project?.title }, recipient.id, input.text);
    const record: PullChangeRequest = {
      repo: input.repo, number: input.number, projectId: input.projectId, headSha: input.headSha, title: pr.title.slice(0, 512),
      text: input.text, recipientId: recipient.id, coordinator: recipient.coordinator, messageId, messageHash: hash(text), fingerprint,
      at: new Date(this.now()).toISOString(), status: "pending", ...(photos.length ? { imageCount: photos.length } : {}),
    };
    try {
      this.store.change(current => {
        const latest = own(current.pullChangeRequests, key);
        if (!current.projects.includes(input.projectId) || current.coordinator !== view.coordinator ||
            latest?.messageId !== saved?.messageId || latest?.withdrawnAt !== saved?.withdrawnAt) {
          throw Error("changed");
        }
        if (input.images?.length) this.sessionPhotos.save(recipient.id, messageId, input.images);
        current.pullChangeRequests[key] = record;
        current.pullChangeRequests = prunePullChangeRequests(current.pullChangeRequests);
      });
    } catch { return { status: "changed" }; }
    try {
      // The person wrote this and pressed send, so it goes without a source. The board adds no sentence of its own.
      await handle.send(text, { messageId, activeTurnBehavior: "steer", ...(input.images?.length ? { images: input.images } : {}) });
    } catch { return { status: "unconfirmed" }; }
    this.finish(key, messageId);
    return { status: "sent", recipientId: recipient.id };
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
    this.store.change(current => {
      const record = own(current.pullChangeRequests, key);
      if (!record || !current.projects.includes(input.projectId) || record.projectId !== input.projectId ||
          record.headSha !== input.headSha || record.withdrawnAt) return;
      record.withdrawnAt = new Date(this.now()).toISOString();
      withdrawn = true;
    });
    return withdrawn;
  }
}
