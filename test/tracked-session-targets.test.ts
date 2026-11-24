import { expect, test } from "bun:test";
import { trackedSessionOwner, trackedWorkSession, findRemoteWorkSession, createRemoteWorkSessionLookup } from "../client/tracked-session-targets";
import { trackedDecisionSchema, trackedRecipient } from "../shared/tracked-decisions";
import type { SessionRow } from "../shared/contract";

const record = (overrides: Record<string, unknown>) => trackedDecisionSchema.parse({
  source: "ledger", id: "check", key: "ledger-check", projectId: null, title: "Sign in again",
  fingerprint: "a".repeat(64), matchedSessionId: null, matchedPull: null, ...overrides,
});

test("a host-wide manual check links to its owner even without a source work session", () => {
  const item = record({where: "human", sourceCoordinatorId: "owner"});
  expect(trackedSessionOwner(item, "another")).toBe("owner");
  expect(trackedRecipient(item, "another", [])).toBeNull();
});

test("worker replies and owner navigation have independent targets", () => {
  const worker: SessionRow = {id: "worker", title: "Export", projectId: "p", projectTitle: "Studio", workspaceTitle: "Work", model: null, lane: "idle", detail: ""};
  const item = record({where: "session", projectId: "p", sessionId: "worker", sourceCoordinatorId: "owner"});
  expect(trackedSessionOwner(item, "another")).toBe("owner");
  expect(trackedRecipient(item, "another", [worker])).toBe("worker");
});

test("the matched work session takes priority over the original ID", () => {
  const item = record({where: "session", sessionId: "other", matchedSessionId: "owner", sourceCoordinatorId: "owner"});
  expect(trackedWorkSession(item, directory([{ id: "owner", projectId: "studio" }]))).toEqual({ kind: "local", id: "owner" });
});

test("a missing imported owner cannot fall back to the board coordinator", () => {
  expect(trackedSessionOwner(record({where: "human", sourceCoordinatorId: null}), "board")).toBeNull();
  expect(trackedSessionOwner(record({where: "human"}), "board")).toBe("board");
  expect(trackedSessionOwner(record({where: "session"}), "board")).toBeUndefined();
});

const west = { serverId: "peer-a", label: "Review desk", registeredLabel: "Review desk" };
const east = { serverId: "peer-b", label: "Other desk", registeredLabel: "Other desk" };
const worker = { id: "worker", projectId: "studio" };
const work = record({ where: "session", sessionId: worker.id, projectId: worker.projectId });
const directory = (sessions: { id: string; projectId: string }[] = [], hosts = [west, east]) => ({
  hostId: "local", hostLabel: "Current board", sessions, hosts, folders: {},
});

test("a work session without a host hint is found by ID on a visible peer when local lookup misses", async () => {
  expect(trackedWorkSession(work, directory([worker]))).toEqual({ kind: "local", id: worker.id });
  const source = trackedWorkSession(work, directory([{ id: "another-worker", projectId: "studio" }]));
  expect(source).toEqual({ kind: "remote", id: worker.id, hosts: [west, east] });
  const lookup = async (host: string, id: string) => host === west.serverId && id === worker.id;
  if (source?.kind !== "remote") throw Error("Expected a peer lookup");
  expect(await findRemoteWorkSession(source, lookup)).toEqual(west);
  expect(await findRemoteWorkSession(source, async () => false)).toBeUndefined();
  expect(trackedWorkSession(work, directory([], []))).toEqual({ kind: "unavailable" });
  expect(trackedWorkSession(record({}), directory())).toBeUndefined();
  expect(trackedRecipient(work, "coordinator", [])).toBeNull();
});

test("an explicit peer ID or registered name selects that host even with a local copy", () => {
  for (const sessionHost of ["peer-a", "rEvIeW DeSk"]) {
    const hosts = [{ ...west, label: "Review desk · peer-a" }, east];
    expect(trackedWorkSession({ ...work, sessionHost }, directory([worker], hosts))).toEqual({
      kind: "remote", id: worker.id, hosts: [hosts[0]],
    });
  }
  expect(trackedWorkSession({ ...work, sessionHost: "CURRENT BOARD" }, directory([worker]))).toEqual({ kind: "local", id: worker.id });
  expect(trackedWorkSession({ ...work, sessionHost: "local" }, directory())).toEqual({ kind: "remote", id: worker.id, hosts: [west, east] });
  expect(trackedWorkSession({ ...work, sessionHost: west.serverId }, directory([], [east]))).toEqual({ kind: "unavailable" });
});

test("multiple peer matches are ambiguous even with a duplicate registered name", async () => {
  const hosts = [west, { ...east, registeredLabel: west.registeredLabel }];
  const source = trackedWorkSession({ ...work, sessionHost: west.registeredLabel }, directory([], hosts));
  expect(source).toEqual({ kind: "remote", id: worker.id, hosts });
  if (source?.kind !== "remote") throw Error("Expected a peer lookup");
  expect(await findRemoteWorkSession(source, async () => true)).toBeUndefined();
});

test("peer lookup accepts idle sessions, ignores ineligible identities, and shares requests", async () => {
  const reads: string[] = [];
  const lookup = createRemoteWorkSessionLookup(host => ({
    agents: { ref: id => ({ refresh: async () => {
      reads.push(host + "/" + id);
      if (id === "offline") throw Error("Host disconnected");
      return { agent: { id: id === "wrong" ? "someone-else" : id, status: "idle",
        internal: id === "internal", archivedAt: id === "archived" ? "yesterday" : null } };
    } }) },
  }));
  expect(await Promise.all([lookup("peer-a", "worker"), lookup("peer-a", "worker")])).toEqual([true, true]);
  expect(reads).toEqual(["peer-a/worker"]);
  for (const id of ["offline", "wrong", "internal", "archived"]) expect(await lookup("peer-a", id)).toBe(false);
});
