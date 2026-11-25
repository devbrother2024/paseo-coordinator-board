import { expect, test } from "bun:test";
import { ledgerPullSession, pullSessionNote } from "../client/pull-work-session";
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
