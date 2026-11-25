import { expect, test } from "bun:test";
import { confirmAfterLookup, judgedOwnerSession, ledgerPullSession, mergeGate, pullSessionNote, remoteAnswerMaxAgeMs, remoteSessionView } from "../client/pull-work-session";
import { createRemoteWorkSessionLookup, createRemoteWorkSessionStates, findRemoteWorkSessionState, workSessionPresence } from "../client/tracked-session-targets";
import { trackedDecisionSchema } from "../shared/tracked-decisions";

const card = (overrides: Record<string, unknown>) => trackedDecisionSchema.parse({
  source: "ledger", id: "merge", key: "ledger-merge", projectId: "studio", title: "Merge sample", kind: "merge",
  fingerprint: "a".repeat(64), matchedSessionId: null, matchedPull: null,
  mergeTarget: { repo: "example/app", number: 12 }, ...overrides,
});
const pr = { repo: "example/app", number: 12, projectIds: ["studio"] };
const west = { serverId: "peer-a", label: "Review desk", registeredLabel: "Review desk" };
const east = { serverId: "peer-b", label: "Other desk", registeredLabel: "Other desk" };
const directory = (sessions: { id: string; projectId: string }[] = []) => ({
  hostId: "local", hostLabel: "Current board", sessions, hosts: [west, east], folders: {},
});
const none = new Set<string>();

test("a PR row takes its work session from the ledger card for the same PR on another host", () => {
  const items = [card({ sessionId: "worker", sessionHost: "Review desk" })];
  expect(ledgerPullSession(pr, items, directory(), none)).toEqual({ kind: "remote", id: "worker", hosts: [west] });
  // Another PR, another project, or a card without a session gives nothing.
  expect(ledgerPullSession({ ...pr, number: 13 }, items, directory(), none)).toBeUndefined();
  expect(ledgerPullSession({ ...pr, projectIds: ["elsewhere"] }, items, directory(), none)).toBeUndefined();
  expect(ledgerPullSession(pr, [card({})], directory(), none)).toBeUndefined();
  // A host name nobody registered cannot be checked, so the row keeps no chip.
  expect(ledgerPullSession(pr, [card({ sessionId: "worker", sessionHost: "Unknown desk" })], directory(), none)).toBeUndefined();
});

test("a ledger card session on this host links locally, and a session the row already shows is not repeated", () => {
  const items = [card({ sessionId: "worker" })];
  expect(ledgerPullSession(pr, items, directory([{ id: "worker", projectId: "studio" }]), none)).toEqual({ kind: "local", id: "worker" });
  expect(ledgerPullSession(pr, items, directory([{ id: "worker", projectId: "studio" }]), new Set(["worker"]))).toBeUndefined();
  expect(ledgerPullSession(pr, [card({ sessionId: "worker", sessionHost: "peer-a" })], directory(), new Set(["worker"]))).toBeUndefined();
});

test("a remote work session reports whether it is still running; failed lookups find nothing", async () => {
  const reads: string[] = [];
  const states = createRemoteWorkSessionStates(host => ({
    agents: { ref: id => ({ refresh: async () => {
      reads.push(host + "/" + id);
      if (host === "peer-b") throw Error("Host disconnected");
      return { agent: { id, status: id === "busy" ? "running" : "idle", internal: false, archivedAt: null } };
    } }) },
  }));
  expect(await findRemoteWorkSessionState({ kind: "remote", id: "busy", hosts: [west] }, states)).toEqual({ host: west, running: true });
  expect(await findRemoteWorkSessionState({ kind: "remote", id: "calm", hosts: [west, east] }, states)).toEqual({ host: west, running: false });
  expect(await findRemoteWorkSessionState({ kind: "remote", id: "calm", hosts: [east] }, states)).toBeUndefined();
  // The presence check used by ledger chips shares the same reads.
  expect(await workSessionPresence(states)("peer-a", "busy")).toBe(true);
  expect(reads.filter(entry => entry === "peer-a/busy")).toHaveLength(1);
  expect(await createRemoteWorkSessionLookup(() => { throw Error("offline"); })("peer-a", "busy")).toBe(false);
});

test("the PR row says no verified session only when nothing was found", () => {
  expect(pullSessionNote(1, undefined)).toBe("none");
  expect(pullSessionNote(0, { checking: true })).toBe("checking");
  expect(pullSessionNote(0, { checking: false, found: true })).toBe("none");
  expect(pullSessionNote(0, { checking: false, found: false })).toBe("unverified");
  expect(pullSessionNote(0, undefined)).toBe("unverified");
});

test("the merge button waits for a remote work session lookup before it can skip the running confirmation", () => {
  expect(mergeGate(false, { pending: true, running: false })).toBe("wait");
  expect(mergeGate(true, { pending: true, running: false })).toBe("wait");
  expect(mergeGate(false, { pending: false, running: true })).toBe("confirm");
  expect(mergeGate(true, undefined)).toBe("confirm");
  expect(mergeGate(false, { pending: false, running: false })).toBe("open");
  expect(mergeGate(false, undefined)).toBe("open");
});

test("after a board refresh a recent answer keeps the merge button usable; an old or missing one holds it", () => {
  const before = {}, after = {};
  const idle = { key: "worker", lookup: before, at: 1_000, state: { running: false } };
  expect(remoteSessionView(idle, "worker", before, 500_000)).toEqual({ shown: { running: false }, pending: false });
  // A refresh replaced the lookup within 90 seconds: the last answer still counts.
  const recent = remoteSessionView(idle, "worker", after, 1_000 + remoteAnswerMaxAgeMs);
  expect(recent).toEqual({ shown: { running: false }, pending: false });
  expect(mergeGate(false, { pending: recent.pending, running: !!recent.shown?.running })).toBe("open");
  // Older than that, the button waits for the new lookup.
  const old = remoteSessionView(idle, "worker", after, 1_001 + remoteAnswerMaxAgeMs);
  expect(old.pending).toBe(true);
  expect(mergeGate(false, { pending: old.pending, running: !!old.shown?.running })).toBe("wait");
  // When the new answer says running, merging asks again.
  const running = remoteSessionView({ key: "worker", lookup: after, at: 2_000, state: { running: true } }, "worker", after, 2_000);
  expect(mergeGate(false, { pending: running.pending, running: !!running.shown?.running })).toBe("confirm");
  // Another session or host set, or nothing yet, holds the button.
  expect(remoteSessionView(idle, "other", before, 1_000)).toEqual({ shown: undefined, pending: true });
  expect(remoteSessionView(undefined, "worker", before, 1_000)).toEqual({ shown: undefined, pending: true });
});

test("Confirm merge waits for the newest answer and asks again only for a session that turned running", () => {
  expect(confirmAfterLookup({ running: true }, false)).toBe("ask");
  expect(confirmAfterLookup({ running: true }, true)).toBe("merge");
  expect(confirmAfterLookup({ running: false }, false)).toBe("merge");
  expect(confirmAfterLookup(null, false)).toBe("merge");
  expect(confirmAfterLookup(undefined, false)).toBe("merge");
});

test("the confirmation read asks the host again instead of reusing this refresh's answer", async () => {
  let status = "idle";
  let reads = 0;
  const client = () => ({ agents: { ref: (id: string) => ({ refresh: async () => { reads++; return { agent: { id, status, internal: false, archivedAt: null } }; } }) } });
  const shared = createRemoteWorkSessionStates(client);
  const fresh = createRemoteWorkSessionStates(client, false);
  const source = { kind: "remote" as const, id: "worker", hosts: [west] };
  expect(await findRemoteWorkSessionState(source, shared)).toEqual({ host: west, running: false });
  // The worker starts running after the preview opened.
  status = "running";
  expect(await findRemoteWorkSessionState(source, shared)).toEqual({ host: west, running: false });
  const confirming = await findRemoteWorkSessionState(source, fresh);
  expect(confirming).toEqual({ host: west, running: true });
  expect(confirmAfterLookup(confirming, false)).toBe("ask");
  expect(reads).toBe(2);
});

test("a remote owner the coordinator named joins the PR row on the host where the board verified it", () => {
  const judged = (extra = {}) => ({ judgment: { verdict: "ready" as const, reason: "Checks pass", at: "2026-11-25T00:00:00.000Z", ownerSessionId: "far-worker", ownerSessionHost: "peer-a", ...extra } });
  expect(judgedOwnerSession(judged(), [west, east], none)).toEqual({ kind: "remote", id: "far-worker", hosts: [west] });
  // A local owner (no host), a host no longer connected, or a session the row already links gives nothing.
  expect(judgedOwnerSession(judged({ ownerSessionHost: undefined }), [west, east], none)).toBeUndefined();
  expect(judgedOwnerSession(judged({ ownerSessionHost: "gone" }), [west, east], none)).toBeUndefined();
  expect(judgedOwnerSession(judged(), [west, east], new Set(["far-worker"]))).toBeUndefined();
  expect(judgedOwnerSession({}, [west], none)).toBeUndefined();
});
