import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changeRequestRecipient, changeRequestWords, takesChangeRequest } from "../shared/pull-change-requests";
import { applyPullJudgments, pullJudgmentKey } from "../shared/pull-judgments";
import { changeQueueView, changeRequestHistory, mergeHeldByChangeRequest, pullChangeMessage, PullChangeRequests } from "../server/pull-change-requests";
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
  return { dir, store, view, pull, agents, sent, timeline, state, requests, send, input, sdk };
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
  f.agents["worker-1"]!.attentionReason = "error";
  expect(await f.send()).toEqual({ status: "busy" });
  // A permission request holds it in the middle of a turn as well.
  Object.assign(f.agents["worker-1"]!, { status: "running", activeTurn: "turn-1", attentionReason: null, pendingPermissions: [{ id: "p2" }] });
  expect(await f.send()).toEqual({ status: "busy" });
  expect(f.sent).toHaveLength(0);
  expect(f.store.read().pullChangeRequests).toEqual({});

  Object.assign(f.agents["worker-1"]!, { status: "idle", activeTurn: null, pendingPermissions: [] });
  expect(await f.send()).toEqual({ status: "sent", recipientId: "worker-1" });
  const [message] = f.sent;
  expect(message.id).toBe("worker-1");
  // The person's words go out as written, after the card's context, and without a source.
  expect(Object.keys(message.options).sort()).toEqual(["activeTurnBehavior", "messageId"]);
  const [heading, context, blank, ...body] = message.text.split("\n");
  expect(heading).toBe("[Coordinator Board · Alpha · org/example #7]");
  // The PR is named by repository, number, link and commit only. Its title comes from GitHub, where others can edit it,
  // so it never rides in a message that reads as the person's own.
  expect(JSON.parse(context)).toEqual({ projectId: "alpha", projectTitle: "Alpha", source: "pull-request", repo: "org/example", number: 7,
    url: "https://github.com/org/example/pull/7", headSha: head, recipientSessionId: "worker-1",
    action: "change-request", mayBe: ["decision", "question", "change-request"] });
  expect(message.text).not.toContain("Add cache");
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
  // It may have arrived, so the merge card comes down until it is confirmed or the person reopens the card.
  const { gate: _gate, ...plain } = lost.pull;
  expect(applyPullJudgments([plain], { enabled: false, coordinator: false, judgments: {}, ledgerPulls: new Set(), changeRequests: lost.store.read().pullChangeRequests })[0])
    .toMatchObject({ lane: "progress", gate: "change-requested", changeRequest: "pending" });
  lost.state.failSend = false;
  // The retry only looks for the earlier message. Another request waits while that one may still have arrived.
  expect(await lost.send()).toEqual({ status: "unconfirmed" });
  expect(await lost.send({ requestKey: "change-key-0002", text: "A different request" })).toEqual({ status: "unconfirmed" });
  expect(lost.sent).toHaveLength(0);
  lost.timeline["worker-1"] = [{ item: { type: "user_message", messageId: pending.messageId, text: "[Coordinator Board · Alpha · org/example #7]\nsomething else" } }];
  expect(await lost.send()).toEqual({ status: "unconfirmed" });
  const arrived = fixture();
  arrived.state.failSend = true;
  await arrived.send();
  const record = arrived.store.read().pullChangeRequests[key];
  const text = "[Coordinator Board · Alpha · org/example #7]\n" + JSON.stringify({ projectId: "alpha", projectTitle: "Alpha", source: "pull-request", repo: "org/example", number: 7,
    url: "https://github.com/org/example/pull/7", headSha: head, recipientSessionId: "worker-1",
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

test("a request sent again after the card was reopened is a new request, even with the same key and words", async () => {
  const f = fixture();
  const target = { projectId: "alpha", repo: "org/example", number: 7, headSha: head };
  expect(await f.send()).toEqual({ status: "sent", recipientId: "worker-1" });
  const first = f.store.read().pullChangeRequests[key].messageId;
  expect(f.requests.withdraw(target)).toBe(true);
  // The reopened card is a merge card again. Without a new send it would stay up while the board said "sent".
  expect(await f.send()).toEqual({ status: "sent", recipientId: "worker-1" });
  expect(f.sent).toHaveLength(2);
  const again = f.store.read().pullChangeRequests[key];
  expect(again.messageId).not.toBe(first);
  expect(f.sent[1].options.messageId).toBe(again.messageId);
  expect(again.withdrawnAt).toBeUndefined();
  expect(again.status).toBe("sent");
  // And once more: each reopening starts a new request.
  f.state.now += 60_000;
  expect(f.requests.withdraw(target)).toBe(true);
  expect(await f.send()).toEqual({ status: "sent", recipientId: "worker-1" });
  expect(new Set(f.sent.map(message => message.options.messageId)).size).toBe(3);
  // A retry of the request sent after reopening is still that request: it is confirmed, never sent again or refused.
  expect(await f.send()).toEqual({ status: "sent", recipientId: "worker-1" });
  expect(f.sent).toHaveLength(3);
  const unsure = fixture();
  await unsure.send();
  expect(unsure.requests.withdraw(target)).toBe(true);
  unsure.state.failSend = true;
  expect(await unsure.send()).toEqual({ status: "unconfirmed" });
  unsure.state.failSend = false;
  const record = unsure.store.read().pullChangeRequests[key];
  expect(record).toMatchObject({ status: "pending", requestKey: "change-key-0001" });
  expect(await unsure.send()).toEqual({ status: "unconfirmed" });
  unsure.timeline["worker-1"] = [{ item: { type: "user_message", messageId: record.messageId, text: unsure.sent[0].text } }];
  expect(await unsure.send()).toEqual({ status: "sent", recipientId: "worker-1" });
  expect(unsure.sent).toHaveLength(1);
  expect(unsure.store.read().pullChangeRequests[key].status).toBe("sent");
  // A request whose delivery is unknown can be reopened too, and does not hold the next one.
  const lost = fixture();
  lost.state.failSend = true;
  expect(await lost.send()).toEqual({ status: "unconfirmed" });
  expect(lost.requests.withdraw(target)).toBe(true);
  lost.state.failSend = false;
  expect(await lost.send({ requestKey: "change-key-0002" })).toEqual({ status: "sent", recipientId: "worker-1" });
});

test("a pending request is confirmed when the board reads it in the recipient's conversation", async () => {
  const f = fixture();
  f.state.failSend = true;
  await f.send();
  const record = f.store.read().pullChangeRequests[key];
  const seen = (hash: string) => new Map([["worker-1", { id: "e", turns: [], boardMessageHashes: new Map([[record.messageId, hash]]) }]]);
  expect(changeRequestHistory(f.store.read(), new Set(["alpha"]), seen("0".repeat(64))).confirmed).toEqual([]);
  expect(changeRequestHistory(f.store.read(), new Set(["alpha"]), new Map()).confirmed).toEqual([]);
  const history = changeRequestHistory(f.store.read(), new Set(["alpha"]), seen(record.messageHash));
  expect(history.confirmed).toEqual([key]);
  expect(history.entries[0].status).toBe("sent");
});

test("a change request names its PR without the PR title, and carries no control or direction characters", () => {
  const message = pullChangeMessage({ repo: "org/example", number: 7, headSha: head }, { id: "alpha", title: "Al\u2066pha\n" }, "worker-1", "Keep\u202e this as typed");
  const [heading, context] = message.split("\n");
  expect(heading).toBe("[Coordinator Board · Al pha · org/example #7]");
  expect(JSON.parse(context)).toMatchObject({ projectTitle: "Al pha", repo: "org/example", number: 7, action: "change-request" });
  expect(JSON.parse(context).title).toBeUndefined();
  // The person's own words are never rewritten.
  expect(message.endsWith("\n\nKeep\u202e this as typed")).toBe(true);
});

test("one unreadable change request record is dropped without losing the rest of the settings", () => {
  const f = fixture();
  const path = join(f.dir, "scope.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  const good = { repo: "org/example", number: 7, projectId: "alpha", headSha: head, title: "Add cache", text: "Keep the old flag", recipientId: "worker-1", coordinator: false,
    messageId: "00000000-0000-4000-8000-000000000001", messageHash: "d".repeat(64), fingerprint: "e".repeat(64), at: "2026-11-25T02:00:00.000Z", status: "sent" };
  saved.pullChangeRequests = { [key]: good, "org/example#8": { ...good, number: 8, headSha: "not a commit" }, "org/example#9": "broken", "org/example#10": null };
  writeFileSync(path, JSON.stringify(saved));
  const scope = f.store.read();
  expect(Object.keys(scope.pullChangeRequests)).toEqual([key]);
  expect(scope.projects).toEqual(["alpha"]);
  expect(scope.coordinator).toBe("coord");
  // A field of the wrong shape altogether reads as no requests.
  writeFileSync(path, JSON.stringify({ ...saved, pullChangeRequests: [good] }));
  expect(f.store.read().pullChangeRequests).toEqual({});
  writeFileSync(path, JSON.stringify({ ...saved, pullChangeRequests: undefined }));
  expect(f.store.read().pullChangeRequests).toEqual({});
});

test("a session in its turn takes the request at once when its provider can, and otherwise the request waits", async () => {
  // Claude and Codex take input in the middle of a turn, for a work session as for the coordinator.
  for (const provider of ["claude", "codex"]) {
    const f = fixture();
    Object.assign(f.agents["worker-1"]!, { status: "running", activeTurn: "turn-1", provider });
    expect(await f.send()).toEqual({ status: "sent", recipientId: "worker-1" });
    expect(f.sent[0].options.activeTurnBehavior).toBe("steer");
    // It still carries the PR it is about: the session did not ask this question itself.
    expect(f.sent[0].text.startsWith("[Coordinator Board · Alpha · org/example #7]\n")).toBe(true);
  }
  // Another provider's turn cannot take it, so it waits. Nothing is sent, and the merge card is down meanwhile.
  const f = fixture();
  Object.assign(f.agents["worker-1"]!, { status: "running", activeTurn: "turn-1", provider: "opencode" });
  expect(await f.send()).toEqual({ status: "queued", recipientId: "worker-1" });
  expect(await f.send()).toEqual({ status: "queued", recipientId: "worker-1" });
  expect(await f.send({ requestKey: "change-key-0002", text: "Another one" })).toEqual({ status: "changed" });
  expect(f.sent).toHaveLength(0);
  const waiting = f.store.read().pullChangeRequests[key];
  expect(waiting).toMatchObject({ status: "queued", queue: { stopped: false, photos: [] }, text: "Please keep the old flag working.\n\nWhy was it removed?" });
  expect(changeQueueView(waiting)).toMatchObject({ messageId: waiting.messageId, recipientId: "worker-1", stopped: false, imageCount: 0 });
  const { gate: _gate, ...plain } = f.pull;
  expect(applyPullJudgments([plain], { enabled: true, coordinator: true, judgments: {}, ledgerPulls: new Set(), changeRequests: f.store.read().pullChangeRequests })[0])
    .toMatchObject({ lane: "progress", gate: "change-requested", changeRequest: "queued" });
  expect(mergeHeldByChangeRequest(f.store.read(), "org/example", 7, head)).toBe(true);
  expect(changeRequestHistory(f.store.read(), new Set(["alpha"]), new Map()).entries).toEqual([]);
  expect(f.requests.hasWaiting("worker-1")).toBe(true);
  expect(f.requests.hasWaiting("coord")).toBe(false);
  // Still in its turn: it keeps waiting. Once the session rests, the request goes out once, as the person wrote it.
  Object.assign(f.pull, { lane: "progress", gate: "change-requested" });
  await f.requests.resume(f.sdk as never, "worker-1");
  expect(f.sent).toHaveLength(0);
  Object.assign(f.agents["worker-1"]!, { status: "idle", activeTurn: null });
  await f.requests.resume(f.sdk as never, "coord");
  expect(f.sent).toHaveLength(0);
  await Promise.all([f.requests.resume(f.sdk as never, "worker-1"), f.requests.resume(f.sdk as never)]);
  await f.requests.resume(f.sdk as never);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({ id: "worker-1", options: { messageId: waiting.messageId, activeTurnBehavior: "steer" } });
  expect(Object.keys(f.sent[0].options).sort()).toEqual(["activeTurnBehavior", "messageId"]);
  expect(f.sent[0].text.endsWith("\n\nPlease keep the old flag working.\n\nWhy was it removed?")).toBe(true);
  expect(f.store.read().pullChangeRequests[key]).toMatchObject({ status: "sent" });
  expect(f.store.read().pullChangeRequests[key].queue).toBeUndefined();
  expect(f.requests.hasWaiting()).toBe(false);
});

test("a waiting request stops when the PR or its recipient is no longer what the person wrote for", async () => {
  const cases: [string, (f: ReturnType<typeof fixture>) => void][] = [
    ["a new head", f => { f.pull.headSha = newer; }],
    ["GitHub no longer ready", f => { Object.assign(f.pull, { reason: "checks-failed" }); }],
    ["another owner", f => { f.pull.judgment.ownerSessionId = "worker-2"; }],
    ["the project left the board", f => { f.store.change(scope => { scope.projects = []; }); }],
    ["the session ended", f => { f.agents["worker-1"]!.archivedAt = "2026-11-25T03:00:00.000Z"; }],
  ];
  for (const [name, change] of cases) {
    const f = fixture();
    Object.assign(f.agents["worker-1"]!, { status: "running", activeTurn: "turn-1", provider: "opencode" });
    expect(await f.send()).toEqual({ status: "queued", recipientId: "worker-1" });
    change(f);
    Object.assign(f.agents["worker-1"]!, { status: "idle", activeTurn: null });
    await f.requests.resume(f.sdk as never);
    f.store.change(scope => { if (!scope.projects.length) scope.projects = ["alpha"]; });
    expect([name, f.sent.length]).toEqual([name, 0]);
    expect([name, f.store.read().pullChangeRequests[key].queue?.stopped]).toEqual([name, true]);
    expect(f.requests.hasWaiting()).toBe(false);
  }
  // A recipient that turns to a permission request keeps the request waiting instead of stopping it.
  const f = fixture();
  Object.assign(f.agents["worker-1"]!, { status: "running", activeTurn: "turn-1", provider: "opencode" });
  await f.send();
  f.agents["worker-1"]!.pendingPermissions = [{ id: "p1" }];
  await f.requests.resume(f.sdk as never);
  expect(f.sent).toHaveLength(0);
  expect(f.store.read().pullChangeRequests[key].queue?.stopped).toBe(false);
});

test("a waiting request can be cancelled, held for a parallel session and resumed", async () => {
  const queued = async () => {
    const f = fixture();
    Object.assign(f.agents["worker-1"]!, { status: "running", activeTurn: "turn-1", provider: "opencode" });
    await f.send();
    const messageId = f.store.read().pullChangeRequests[key].messageId;
    const card = { kind: "pull" as const, projectId: "alpha", repo: "org/example", number: 7, headSha: head };
    return { f, messageId, card };
  };
  // Cancelling removes the request: nothing was sent, and the merge card returns.
  const a = await queued();
  expect(a.f.requests.control({ card: { ...a.card, headSha: newer }, messageId: a.messageId, action: "cancel" }, "opencode", 10)).toBeUndefined();
  expect(a.f.requests.control({ card: a.card, messageId: "00000000-0000-4000-8000-00000000000f", action: "cancel" }, "opencode", 10)).toBeUndefined();
  expect(a.f.requests.control({ card: a.card, messageId: a.messageId, action: "cancel" }, "opencode", 10)).toMatchObject({ recipientId: "worker-1" });
  expect(a.f.store.read().pullChangeRequests).toEqual({});
  expect(mergeHeldByChangeRequest(a.f.store.read(), "org/example", 7, head)).toBe(false);
  // Reopening the merge card does the same for a request that never went out.
  const w = await queued();
  expect(w.f.requests.withdraw({ projectId: "alpha", repo: "org/example", number: 7, headSha: head })).toBe(true);
  expect(w.f.store.read().pullChangeRequests).toEqual({});
  // A parallel session is offered by the same rule as card replies: at once for a provider without mid-turn input.
  const b = await queued();
  expect(await b.f.requests.stillWaiting(b.f.sdk as never, { card: b.card, messageId: b.messageId })).toBe(true);
  expect(b.f.requests.control({ card: b.card, messageId: b.messageId, action: "resume" }, "opencode", 10)).toBeUndefined();
  expect(b.f.requests.control({ card: b.card, messageId: b.messageId, action: "parallel" }, "opencode", 10))
    .toEqual({ title: "org/example #7", recipientId: "worker-1", answer: "Please keep the old flag working.\n\nWhy was it removed?", images: [] });
  expect(b.f.store.read().pullChangeRequests[key].queue?.parallel).toBe("held");
  // While it is held, the original session resting does not send it.
  Object.assign(b.f.pull, { lane: "progress", gate: "change-requested" });
  Object.assign(b.f.agents["worker-1"]!, { status: "idle", activeTurn: null });
  expect(b.f.requests.hasWaiting()).toBe(false);
  await b.f.requests.resume(b.f.sdk as never);
  expect(b.f.sent).toHaveLength(0);
  expect(await b.f.requests.stillWaiting(b.f.sdk as never, { card: b.card, messageId: b.messageId })).toBe(false);
  // The person resumes it, and it goes to the original session.
  expect(b.f.requests.control({ card: b.card, messageId: b.messageId, action: "parallel" }, "opencode", 10)).toBeUndefined();
  expect(b.f.requests.control({ card: b.card, messageId: b.messageId, action: "resume" }, "opencode", 10)).toBeDefined();
  await b.f.requests.resume(b.f.sdk as never);
  expect(b.f.sent).toHaveLength(1);
  expect(b.f.store.read().pullChangeRequests[key].status).toBe("sent");
});

test("a request left waiting when the PR moved on can still be seen, cancelled or replaced", async () => {
  const f = fixture();
  Object.assign(f.agents["worker-1"]!, { status: "running", activeTurn: "turn-1", provider: "opencode" });
  expect(await f.send()).toEqual({ status: "queued", recipientId: "worker-1" });
  const waiting = f.store.read().pullChangeRequests[key];
  // A new commit arrives. The request was written about the earlier head, so it no longer holds the new one.
  f.pull.headSha = newer;
  expect(mergeHeldByChangeRequest(f.store.read(), "org/example", 7, newer)).toBe(false);
  // It is still shown, as stopped and with the head it was written for, so the person can cancel it.
  expect(changeQueueView(waiting, newer)).toMatchObject({ messageId: waiting.messageId, stopped: true });
  expect(changeQueueView(waiting, head)).toMatchObject({ stopped: false });
  // Cancelling names the head it was written for.
  const card = { kind: "pull" as const, projectId: "alpha", repo: "org/example", number: 7, headSha: head };
  const again = fixture();
  Object.assign(again.agents["worker-1"]!, { status: "running", activeTurn: "turn-1", provider: "opencode" });
  await again.send();
  again.pull.headSha = newer;
  expect(again.requests.control({ card, messageId: again.store.read().pullChangeRequests[key].messageId, action: "cancel" }, "opencode", 10)).toBeDefined();
  expect(again.store.read().pullChangeRequests).toEqual({});
  // A new request about the new head replaces it instead of being refused for good. The old one is never sent.
  Object.assign(f.agents["worker-1"]!, { status: "idle", activeTurn: null });
  expect(await f.send({ headSha: newer, requestKey: "change-key-0002", text: "Now the flag is back, but the test is missing." }))
    .toEqual({ status: "sent", recipientId: "worker-1" });
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].text.endsWith("\n\nNow the flag is back, but the test is missing.")).toBe(true);
  expect(f.store.read().pullChangeRequests[key]).toMatchObject({ headSha: newer, status: "sent" });
  await f.requests.resume(f.sdk as never);
  expect(f.sent).toHaveLength(1);
});
