import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeRequestRecipient, changeRequestWords, takesChangeRequest } from "../shared/pull-change-requests";
import { applyPullJudgments, pullJudgmentKey } from "../shared/pull-judgments";
import { changeRequestHistory, PullChangeRequests } from "../server/pull-change-requests";
import { PreferenceStore } from "../server/preferences";

const pr = (ownerSessionId?: string, ownerSessionHost?: string) => ({ projectIds: ["alpha"],
  judgment: { verdict: "ready" as const, reason: "Checks pass", at: "2026-11-24T01:00:00.000Z", ...(ownerSessionId ? { ownerSessionId } : {}), ...(ownerSessionHost ? { ownerSessionHost } : {}) } });
const session = (extra = {}) => ({ id: "worker-1", projectId: "alpha", status: "idle", ...extra });

test("the request goes to the owner session, or to the coordinator when the owner cannot take it", () => {
  expect(changeRequestRecipient(pr("worker-1"), [session()], "coord")).toEqual({ id: "worker-1", coordinator: false });
  // A running owner is still the recipient. Whether it can take input right now is checked when sending.
  expect(changeRequestRecipient(pr("worker-1"), [session({ status: "running" })], "coord")).toEqual({ id: "worker-1", coordinator: false });
  const coordinator = { id: "coord", coordinator: true };
  // No owner named, not on this board (archived or gone), ended, failed, or waiting on a permission request.
  expect(changeRequestRecipient(pr(), [session()], "coord")).toEqual(coordinator);
  expect(changeRequestRecipient({ projectIds: ["alpha"] }, [session()], "coord")).toEqual(coordinator);
  expect(changeRequestRecipient(pr("worker-1"), [], "coord")).toEqual(coordinator);
  expect(changeRequestRecipient(pr("worker-1"), [session({ status: "closed" })], "coord")).toEqual(coordinator);
  expect(changeRequestRecipient(pr("worker-1"), [session({ status: "error" })], "coord")).toEqual(coordinator);
  expect(changeRequestRecipient(pr("worker-1"), [session({ nativePending: true })], "coord")).toEqual(coordinator);
  // A session on another host or in another project is not sent to from here.
  expect(changeRequestRecipient(pr("worker-1", "peer-a"), [session()], "coord")).toEqual(coordinator);
  expect(changeRequestRecipient(pr("worker-1"), [session({ serverId: "peer-a" })], "coord")).toEqual(coordinator);
  expect(changeRequestRecipient(pr("worker-1"), [session({ projectId: "beta" })], "coord")).toEqual(coordinator);
  // The owner is the coordinator itself.
  expect(changeRequestRecipient(pr("coord"), [session({ id: "coord" })], "coord")).toEqual(coordinator);
  // Nobody can take it.
  expect(changeRequestRecipient(pr(), [session()], null)).toBeNull();
  expect(changeRequestRecipient(pr("worker-1"), [session()], null)).toEqual({ id: "worker-1", coordinator: false });
});

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const head = "a".repeat(40);
const newer = "b".repeat(40);
const key = pullJudgmentKey("org/example", 7);

function fixture(options: { owner?: string } = { owner: "worker-1" }) {
  const dir = mkdtempSync(join(tmpdir(), "coordinator-change-")); directories.push(dir);
  const store = new PreferenceStore(join(dir, "scope.json"));
  store.change(scope => { scope.projects = ["alpha"]; scope.coordinator = "coord"; });
  const pull = { repo: "org/example", number: 7, title: "Add cache", url: "https://github.com/org/example/pull/7", headSha: head, projectIds: ["alpha"],
    lane: "review" as const, reason: "ready" as const, gate: "judged" as const, updatedAt: "2026-11-25T00:00:00Z",
    judgment: { verdict: "ready" as const, reason: "Checks pass", at: "2026-11-25T01:00:00.000Z", ...(options.owner ? { ownerSessionId: options.owner } : {}) } };
  const view = { pullRequests: { items: [pull] }, coordinator: "coord" as string | null, projects: [{ id: "alpha", title: "Alpha" }],
    sessions: [{ id: "worker-1", title: "Cache work", projectId: "alpha", projectTitle: "Alpha", workspaceTitle: "main", model: null, status: "idle", lane: "idle" as const, detail: "" }] };
  const live = (id: string) => ({ id, status: "idle", activeTurn: null, pendingPermissions: [] as unknown[], attentionReason: null as string | null, provider: "claude", internal: false, archivedAt: null as string | null });
  const agents: Record<string, ReturnType<typeof live> | undefined> = { "worker-1": live("worker-1"), coord: live("coord") };
  const sent: { id: string; text: string; options: Record<string, unknown> }[] = [];
  const timeline: Record<string, { item: { type: string; messageId: string; text: string } }[]> = {};
  const state = { failSend: false, now: Date.parse("2026-11-25T02:00:00.000Z") };
  const sdk = { agents: { ref: (id: string) => ({
    refresh: async () => ({ agent: agents[id] }),
    send: async (text: string, options: Record<string, unknown>) => { if (state.failSend) throw Error("offline"); sent.push({ id, text, options }); },
    timeline: { refetch: async () => ({ entries: timeline[id] ?? [], error: null }) },
  }) } };
  const requests = new PullChangeRequests(store, async () => view, () => state.now);
  const input = (extra = {}) => ({ projectId: "alpha", repo: "org/example", number: 7, headSha: head, recipientId: "worker-1",
    text: "Please keep the old flag working.\n\nWhy was it removed?", requestKey: "change-key-0001", ...extra });
  const send = (extra = {}) => requests.send(sdk as never, input(extra));
  return { store, view, pull, agents, sent, timeline, state, requests, send, input };
}

test("nothing is sent unless the PR is a merge card on that head and the recipient can take input", async () => {
  const f = fixture();
  expect(await f.send({ projectId: "beta" })).toEqual({ status: "changed" });
  expect(await f.send({ headSha: newer })).toEqual({ status: "changed" });
  expect(await f.send({ recipientId: "coord" })).toEqual({ status: "changed" });
  // The PR left My decisions: no verdict yet, or GitHub no longer calls it ready.
  Object.assign(f.pull, { lane: "progress", gate: "awaiting" });
  expect(await f.send()).toEqual({ status: "changed" });
  Object.assign(f.pull, { lane: "progress", reason: "checks-failed", gate: undefined });
  expect(await f.send()).toEqual({ status: "changed" });
  Object.assign(f.pull, { lane: "review", reason: "ready", gate: "judged" });
  // The session is gone or archived since the board last looked.
  f.agents["worker-1"]!.archivedAt = "2026-11-25T01:30:00.000Z";
  expect(await f.send()).toEqual({ status: "changed" });
  f.agents["worker-1"]!.archivedAt = null;
  // A session waiting on a permission request is never sent to, and a busy work session waits.
  f.agents["worker-1"]!.pendingPermissions = [{ id: "p1" }];
  expect(await f.send()).toEqual({ status: "busy" });
  f.agents["worker-1"]!.pendingPermissions = [];
  f.agents["worker-1"]!.attentionReason = "permission";
  expect(await f.send()).toEqual({ status: "busy" });
  f.agents["worker-1"]!.attentionReason = null;
  Object.assign(f.agents["worker-1"]!, { status: "running", activeTurn: "turn-1" });
  expect(await f.send()).toEqual({ status: "busy" });
  expect(f.sent).toHaveLength(0);
  expect(f.store.read().pullChangeRequests).toEqual({});

  Object.assign(f.agents["worker-1"]!, { status: "idle", activeTurn: null });
  expect(await f.send()).toEqual({ status: "sent", recipientId: "worker-1" });
  const [message] = f.sent;
  expect(message.id).toBe("worker-1");
  // The person's words go out as written, after the card's context, and without a source.
  expect(Object.keys(message.options).sort()).toEqual(["activeTurnBehavior", "messageId"]);
  const [heading, context, blank, ...body] = message.text.split("\n");
  expect(heading).toBe("[Coordinator Board · Alpha · Add cache]");
  expect(JSON.parse(context)).toEqual({ projectId: "alpha", projectTitle: "Alpha", source: "pull-request", repo: "org/example", number: 7,
    url: "https://github.com/org/example/pull/7", title: "Add cache", headSha: head, recipientSessionId: "worker-1",
    action: "change-request", mayBe: ["decision", "question", "change-request"] });
  expect(blank).toBe("");
  expect(body.join("\n")).toBe("Please keep the old flag working.\n\nWhy was it removed?");
  // The record takes the merge card down for this head.
  const saved = f.store.read().pullChangeRequests;
  expect(saved[key]).toMatchObject({ status: "sent", headSha: head, recipientId: "worker-1", coordinator: false, title: "Add cache" });
  const { gate: _gate, ...plain } = f.pull;
  expect(applyPullJudgments([plain], { enabled: true, coordinator: true, judgments: {}, ledgerPulls: new Set(), changeRequests: saved })[0])
    .toMatchObject({ lane: "progress", gate: "change-requested" });
});

test("a request with no owner goes to the coordinator, which may take it while working", async () => {
  const f = fixture({ owner: undefined });
  Object.assign(f.agents.coord!, { status: "running", activeTurn: "turn-9" });
  expect(await f.send()).toEqual({ status: "changed" });
  expect(await f.send({ recipientId: "coord" })).toEqual({ status: "sent", recipientId: "coord" });
  expect(f.sent[0].id).toBe("coord");
  expect(f.store.read().pullChangeRequests[key].coordinator).toBe(true);
  // Without a coordinator nobody can take it.
  const none = fixture({ owner: undefined });
  none.view.coordinator = null;
  none.store.change(scope => { scope.coordinator = null; });
  expect(await none.send({ recipientId: "coord" })).toEqual({ status: "changed" });
  expect(none.sent).toHaveLength(0);
});

test("a retry confirms the earlier request instead of sending again", async () => {
  const f = fixture();
  expect(await f.send()).toEqual({ status: "sent", recipientId: "worker-1" });
  expect(await f.send()).toEqual({ status: "sent", recipientId: "worker-1" });
  expect(f.sent).toHaveLength(1);
  // The same key with other words is not the same request.
  expect(await f.send({ text: "Something else" })).toEqual({ status: "unconfirmed" });

  const lost = fixture();
  lost.state.failSend = true;
  expect(await lost.send()).toEqual({ status: "unconfirmed" });
  const pending = lost.store.read().pullChangeRequests[key];
  expect(pending.status).toBe("pending");
  // Not confirmed yet: the merge card stays so the person can press again.
  const { gate: _gate, ...plain } = lost.pull;
  expect(applyPullJudgments([plain], { enabled: false, coordinator: false, judgments: {}, ledgerPulls: new Set(), changeRequests: lost.store.read().pullChangeRequests })[0].lane).toBe("review");
  lost.state.failSend = false;
  // The retry only looks for the earlier message. Another request waits while that one may still have arrived.
  expect(await lost.send()).toEqual({ status: "unconfirmed" });
  expect(await lost.send({ requestKey: "change-key-0002", text: "A different request" })).toEqual({ status: "unconfirmed" });
  expect(lost.sent).toHaveLength(0);
  lost.timeline["worker-1"] = [{ item: { type: "user_message", messageId: pending.messageId, text: "[Coordinator Board · Alpha · Add cache]\nsomething else" } }];
  expect(await lost.send()).toEqual({ status: "unconfirmed" });
  const arrived = fixture();
  arrived.state.failSend = true;
  await arrived.send();
  const record = arrived.store.read().pullChangeRequests[key];
  const text = "[Coordinator Board · Alpha · Add cache]\n" + JSON.stringify({ projectId: "alpha", projectTitle: "Alpha", source: "pull-request", repo: "org/example", number: 7,
    url: "https://github.com/org/example/pull/7", title: "Add cache", headSha: head, recipientSessionId: "worker-1",
    action: "change-request", mayBe: ["decision", "question", "change-request"] }) + "\n\nPlease keep the old flag working.\n\nWhy was it removed?";
  arrived.timeline["worker-1"] = [{ item: { type: "user_message", messageId: record.messageId, text } }];
  arrived.state.failSend = false;
  expect(await arrived.send()).toEqual({ status: "sent", recipientId: "worker-1" });
  expect(arrived.sent).toHaveLength(0);
  expect(arrived.store.read().pullChangeRequests[key].status).toBe("sent");
  // Ten minutes on, an attempt that never arrived no longer holds the PR.
  lost.state.now += 10 * 60_000;
  expect(await lost.send({ requestKey: "change-key-0002", text: "A different request" })).toEqual({ status: "sent", recipientId: "worker-1" });
  expect(lost.sent).toHaveLength(1);
});

test("withdrawing reopens the merge card without sending", async () => {
  const f = fixture();
  const target = { projectId: "alpha", repo: "org/example", number: 7, headSha: head };
  expect(f.requests.withdraw(target)).toBe(false);
  await f.send();
  expect(f.requests.withdraw({ ...target, headSha: newer })).toBe(false);
  expect(f.requests.withdraw({ ...target, projectId: "beta" })).toBe(false);
  expect(f.requests.withdraw(target)).toBe(true);
  expect(f.requests.withdraw(target)).toBe(false);
  expect(f.sent).toHaveLength(1);
  const saved = f.store.read().pullChangeRequests;
  expect(saved[key].withdrawnAt).toBe("2026-11-25T02:00:00.000Z");
  const { gate: _gate, ...plain } = f.pull;
  expect(applyPullJudgments([plain], { enabled: true, coordinator: true, judgments: {}, ledgerPulls: new Set([key]), changeRequests: saved })[0].lane).toBe("review");
  // It stays in recent decision activity, with the answer of the session that took it.
  const evidence = new Map([["worker-1", { id: "e", turns: [], replies: new Map([[saved[key].messageId, "The flag is back in the next commit."]]) }]]);
  const history = changeRequestHistory(f.store.read(), new Set(["alpha"]), evidence);
  expect(history.entries).toEqual([expect.objectContaining({ key: "change:" + key, title: "Add cache", projectId: "alpha", status: "sent", recipientId: "worker-1",
    answer: "Please keep the old flag working.\n\nWhy was it removed?", response: "The flag is back in the next commit.",
    origin: { sessionId: "worker-1", cardId: key, revision: head, questions: [] } })]);
  expect([...history.responses]).toEqual([[key, "The flag is back in the next commit."]]);
  expect(changeRequestHistory(f.store.read(), new Set(["beta"]), evidence).entries).toEqual([]);
});

test("only a merge card with a known head takes a change request, and each refusal says why in both languages", () => {
  const ready = { lane: "review" as const, reason: "ready" as const, headSha: head };
  expect(takesChangeRequest(ready)).toBe(true);
  expect(takesChangeRequest(ready, true)).toBe(false);
  expect(takesChangeRequest({ ...ready, lane: "progress" })).toBe(false);
  expect(takesChangeRequest({ ...ready, reason: "checks-pending" })).toBe(false);
  expect(takesChangeRequest({ ...ready, headSha: undefined })).toBe(false);
  for (const words of Object.values(changeRequestWords)) expect(words.every(text => text.length > 10)).toBe(true);
});
