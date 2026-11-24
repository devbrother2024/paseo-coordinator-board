import { expect, test } from "bun:test";
import {
  blocksReplies, classifyReach, coordinatorReachSchema, coordinatorReachStates, listedSessionReach, opensSession, readSessionReach, receivesBoardInput,
} from "../shared/coordinator-reach";
import { chipOutcome, chipPlan, reachNotice } from "../client/coordinator-reach";

const id = "coordinator-fixture";
const folder = "/synthetic/operate";
type Agent = { id: string; status: string; workspaceId?: string; archivedAt?: string | null; internal?: boolean; cwd?: string };
type Fixture = {
  agent?: Agent | null; agentError?: boolean; projectKey?: string;
  workspace?: { archivingAt?: string | null } | null; workspaceError?: boolean;
  projects?: { projectId: string; projectKey?: string; projectRootPath: string }[]; projectsError?: boolean;
};

function sdk(f: Fixture) {
  const calls: string[] = [];
  return {
    calls,
    agents: { ref: (agentId: string) => ({ refresh: async () => {
      calls.push("agent:" + agentId);
      if (f.agentError) throw Error("synthetic transport failure");
      return f.agent ? { agent: f.agent, project: f.projectKey ? { projectKey: f.projectKey } : null } : null;
    } }) },
    workspaces: { ref: (workspaceId: string) => ({ refresh: async () => {
      calls.push("workspace:" + workspaceId);
      if (f.workspaceError) throw Error("synthetic transport failure");
      return f.workspace === undefined ? { archivingAt: null } : f.workspace;
    } }) },
    projects: { list: async () => {
      calls.push("projects");
      if (f.projectsError) throw Error("synthetic transport failure");
      return { projects: f.projects ?? [] };
    } },
  };
}
const idle: Agent = { id, status: "idle", workspaceId: "operating-workspace", cwd: folder };
const operating = { projectId: "operate", projectRootPath: folder };

test("a live session in an active workspace is reachable without reading the project list", async () => {
  const paseo = sdk({ agent: idle, projectKey: "operate" });
  expect(await readSessionReach(paseo, id)).toEqual({ state: "ok" });
  expect(paseo.calls).toEqual(["agent:" + id, "workspace:operating-workspace"]);
  expect(receivesBoardInput("ok")).toBe(true);
});

test("a workspace archived with its project is told apart from one archived alone", async () => {
  const gone = sdk({ agent: idle, projectKey: "operate", workspace: null, projects: [{ projectId: "other", projectRootPath: "/synthetic/other" }] });
  expect(await readSessionReach(gone, id)).toEqual({ state: "project-missing", directory: folder });
  const kept = sdk({ agent: idle, projectKey: "operate", workspace: null, projects: [operating] });
  expect(await readSessionReach(kept, id)).toEqual({ state: "workspace-archived", directory: folder });
  const archiving = sdk({ agent: idle, projectKey: "operate", workspace: { archivingAt: "2026-11-24T05:27:00Z" }, projects: [operating] });
  expect((await readSessionReach(archiving, id)).state).toBe("workspace-archived");
});

test("a project is recognised by its key or by the folder the session works in", async () => {
  const byKey = sdk({ agent: idle, projectKey: "remote-key", workspace: null, projects: [{ projectId: "p1", projectKey: "remote-key", projectRootPath: "/synthetic/elsewhere" }] });
  expect((await readSessionReach(byKey, id)).state).toBe("workspace-archived");
  const byFolder = sdk({ agent: idle, projectKey: "renamed", workspace: null, projects: [operating] });
  expect((await readSessionReach(byFolder, id)).state).toBe("workspace-archived");
});

test("without a project key the board does not claim the project is gone, unless it knows the operating folder", async () => {
  const unplaced = sdk({ agent: idle, workspace: null, projects: [] });
  expect((await readSessionReach(unplaced, id)).state).toBe("workspace-archived");
  const known = sdk({ agent: { ...idle, cwd: undefined }, workspace: null, projects: [] });
  expect(await readSessionReach(known, id, { directory: folder })).toEqual({ state: "project-missing", directory: folder });
  const unreadable = sdk({ agent: idle, projectKey: "operate", workspace: null, projectsError: true });
  expect((await readSessionReach(unreadable, id)).state).toBe("workspace-archived");
});

test("closed, failed and archived sessions each keep their own reason", async () => {
  expect((await readSessionReach(sdk({ agent: { ...idle, status: "closed" } }), id)).state).toBe("closed");
  expect((await readSessionReach(sdk({ agent: { ...idle, status: "error" } }), id)).state).toBe("error");
  // Only the session was archived: its workspace is still active.
  const archived = sdk({ agent: { ...idle, status: "closed", archivedAt: "2026-11-24T06:18:00Z" } });
  expect(await readSessionReach(archived, id)).toEqual({ state: "archived" });
  expect((await readSessionReach(sdk({ agent: { id, status: "closed", archivedAt: "2026-11-24T06:18:00Z" } }), id)).state).toBe("archived");
  // An archived workspace explains more than the closed session inside it.
  expect((await readSessionReach(sdk({ agent: { ...idle, status: "closed" }, projectKey: "operate", workspace: null, projects: [operating] }), id)).state).toBe("workspace-archived");
});

test("a session archived together with its workspace is explained by the workspace, on either kind of host", async () => {
  const archivedAt = "2026-11-24T05:27:00Z";
  // Newer hosts archive the sessions inside a removed project's workspace.
  const together = sdk({ agent: { ...idle, status: "closed", archivedAt }, projectKey: "operate", workspace: null, projects: [] });
  expect(await readSessionReach(together, id)).toEqual({ state: "project-missing", directory: folder });
  const kept = sdk({ agent: { ...idle, status: "closed", archivedAt }, projectKey: "operate", workspace: null, projects: [operating] });
  expect(await readSessionReach(kept, id)).toEqual({ state: "workspace-archived", directory: folder });
  // Older hosts leave the session untouched and only drop it from the active list.
  const untouched = sdk({ agent: idle, projectKey: "operate", workspace: null, projects: [] });
  expect(await readSessionReach(untouched, id)).toEqual({ state: "project-missing", directory: folder });
  // An archived session stays archived when its workspace cannot be read.
  expect((await readSessionReach(sdk({ agent: { ...idle, archivedAt }, workspaceError: true }), id)).state).toBe("archived");
  expect(classifyReach({ agent: { id, archivedAt }, workspace: null, projectKnown: false })).toBe("project-missing");
  expect(classifyReach({ agent: { id, archivedAt }, workspace: { archivingAt: null } })).toBe("archived");
});

test("a session that is absent, internal or answers for another ID is missing", async () => {
  expect((await readSessionReach(sdk({ agent: null }), id)).state).toBe("missing");
  expect((await readSessionReach(sdk({ agent: { ...idle, internal: true } }), id)).state).toBe("missing");
  expect((await readSessionReach(sdk({ agent: { ...idle, id: "someone-else" } }), id)).state).toBe("missing");
});

test("a missing session whose known workspace was archived names the workspace", async () => {
  const paseo = sdk({ agent: null, workspace: null, projects: [] });
  expect(await readSessionReach(paseo, id, { workspaceId: "operating-workspace", directory: folder })).toEqual({ state: "project-missing", directory: folder });
  expect((await readSessionReach(sdk({ agent: null }), id, { workspaceId: "operating-workspace" })).state).toBe("missing");
});

test("a failed lookup is reported as unknown instead of as a missing session", async () => {
  expect((await readSessionReach(sdk({ agentError: true }), id)).state).toBe("unknown");
  expect((await readSessionReach(sdk({ agent: idle, workspaceError: true }), id)).state).toBe("unknown");
});

test("a session without a workspace is judged by its own state", async () => {
  const paseo = sdk({ agent: { id, status: "running" } });
  expect((await readSessionReach(paseo, id)).state).toBe("ok");
  expect(paseo.calls).toEqual(["agent:" + id]);
  expect(classifyReach({ agent: { id, status: "idle" }, workspace: undefined })).toBe("ok");
});

test("sessions already in the active list need no further lookup", () => {
  expect(listedSessionReach("idle")).toBe("ok");
  expect(listedSessionReach("running")).toBe("ok");
  expect(listedSessionReach("closed")).toBe("closed");
  expect(listedSessionReach("error")).toBe("error");
  expect(listedSessionReach(undefined)).toBe("ok");
});

test("only a reachable session takes board input, while closed and failed sessions can still be opened", () => {
  for (const state of coordinatorReachStates) {
    expect(receivesBoardInput(state)).toBe(state === "ok");
    expect(opensSession(state)).toBe(["ok", "closed", "error", "unknown"].includes(state));
    // A failed check never stops a reply: the session may be fine.
    expect(blocksReplies(state)).toBe(!["ok", "unknown"].includes(state));
  }
});

test("the wire format accepts every state and rejects an invented one", () => {
  for (const state of coordinatorReachStates) expect(coordinatorReachSchema.parse({ state }).state).toBe(state);
  expect(() => coordinatorReachSchema.parse({ state: "asleep" })).toThrow();
});

const ko = (korean: string) => korean, en = (_: string, english: string) => english;

test("every unreachable state explains itself and its recovery in both languages", () => {
  expect(reachNotice({ state: "ok" }, ko)).toBeNull();
  expect(reachNotice(undefined, ko)).toBeNull();
  for (const state of coordinatorReachStates.filter(s => s !== "ok")) {
    for (const t of [ko, en]) {
      const notice = reachNotice({ state, directory: folder }, t)!;
      expect(notice.title.length).toBeGreaterThan(8);
      expect(notice.effect.length).toBeGreaterThan(8);
      expect(notice.steps.length).toBeGreaterThan(0);
      expect([notice.title, notice.effect, ...notice.steps].join(" ")).not.toContain("—");
    }
    expect(reachNotice({ state }, ko)!.title).not.toBe(reachNotice({ state }, en)!.title);
  }
});

test("the recovery guide for a removed project names the folder to add again", () => {
  const steps = reachNotice({ state: "project-missing", directory: folder }, ko)!.steps.join("\n");
  expect(steps).toContain(folder);
  expect(steps).toContain("프로젝트로 다시 추가");
  expect(steps).toContain("새 코디네이터로 교체");
  expect(reachNotice({ state: "project-missing" }, en)!.steps.join("\n")).toContain("project again");
});

test("a ledger owner other than the coordinator is named as itself", () => {
  expect(reachNotice({ state: "archived" }, ko, "owner")!.title).toContain("원장");
  expect(reachNotice({ state: "archived" }, en, "owner")!.title).toContain("ledger");
  // Replacing the board's coordinator does not bring back another session.
  expect(reachNotice({ state: "archived" }, ko, "owner")!.steps.join("\n")).not.toContain("새 코디네이터로 교체하세요");
});

test("a chip opens a viewable session and explains one that cannot be opened", () => {
  expect(chipOutcome({ state: "ok" })).toBe("open");
  expect(chipOutcome({ state: "closed" })).toBe("open");
  expect(chipOutcome({ state: "error" })).toBe("open");
  expect(chipOutcome({ state: "archived" })).toBe("explain");
  expect(chipOutcome({ state: "workspace-archived" })).toBe("explain");
  expect(chipOutcome({ state: "project-missing" })).toBe("explain");
  expect(chipOutcome({ state: "missing" })).toBe("explain");
  // A check that failed is no reason to keep a healthy session closed.
  expect(chipOutcome({ state: "unknown" })).toBe("open");
});

test("a state the board already holds needs no lookup, and only an unlisted session is looked up before opening", () => {
  expect(chipPlan({ state: "project-missing" }, false)).toBe("blocked");
  expect(chipPlan({ state: "workspace-archived" }, true)).toBe("blocked");
  expect(chipPlan({ state: "ok" }, false)).toBe("open");
  expect(chipPlan({ state: "closed" }, false)).toBe("open");
  expect(chipPlan({ state: "unknown" }, false)).toBe("open");
  expect(chipPlan(undefined, true)).toBe("check");
  expect(chipPlan(undefined, false)).toBe("open");
});
