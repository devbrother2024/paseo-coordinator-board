import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contribute from "../index.server";
import { reachNotice } from "../client/coordinator-reach";
import { boardScope, boardSnapshot } from "../shared/contract";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// A board with one managed project, one worker, and a coordinator the board created in its operating folder.
async function fixture({ managed = true, language }: { managed?: boolean; language?: "ko" | "en" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "board-unreachable-")); roots.push(root);
  const data = join(root, "plugin-data", "coordinator-board"); mkdirSync(data, { recursive: true });
  const operatingRoot = join(root, "plugin-workspaces");
  const name = language === "ko" ? "코디네이터 운영 (삭제 금지)"
    : language === "en" ? "Coordinator operations (do not delete)" : "coordinator-board";
  const operatingFolder = join(operatingRoot, name);
  const state = {
    projects: [{ projectId: "studio", projectDisplayName: "Studio", projectRootPath: "/synthetic/studio" },
      { projectId: "operate", projectDisplayName: "Operations", projectRootPath: operatingFolder }],
    workspaces: [{ id: "space", projectId: "studio", projectDisplayName: "Studio", name: "space", archivingAt: null as string | null },
      { id: "operating-space", projectId: "operate", projectDisplayName: "Operations", name: "operate", archivingAt: null as string | null }],
    agents: new Map<string, any>([
      ["worker", { id: "worker", title: "Worker", status: "idle", updatedAt: "1", workspaceId: "space", pendingPermissions: [], cwd: "/synthetic/studio" }],
      ["coordinator", { id: "coordinator", title: "Coordinator", status: "idle", updatedAt: "1", pendingPermissions: [],
        workspaceId: managed ? "operating-space" : "space", cwd: managed ? operatingFolder : "/synthetic/studio" }],
    ]),
    lookups: [] as string[],
    failLookup: false,
  };
  const page = (entries: unknown[]) => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });
  const active = () => state.workspaces.filter(w => state.projects.some(p => p.projectId === w.projectId));
  const placement = (agent: any) => ({ projectKey: agent.workspaceId === "operating-space" ? "operate" : "studio", projectName: "Fixture" });
  const sdk = {
    projects: { list: async () => ({ projects: state.projects }) },
    workspaces: { list: async () => page(active()), ref: (id: string) => ({ refresh: async () => active().find(w => w.id === id) ?? null }) },
    agents: {
      // Paseo leaves out sessions that are archived or whose workspace is no longer active.
      list: async () => page([...state.agents.values()].filter(a => !a.archivedAt && active().some(w => w.id === a.workspaceId))
        .map(agent => ({ agent, project: placement(agent) }))),
      ref: (id: string) => ({
        refresh: async () => {
          state.lookups.push(id);
          if (state.failLookup) throw Error("synthetic transport failure");
          const agent = state.agents.get(id);
          return agent ? { agent, project: placement(agent) } : null;
        },
        timeline: { refetch: async () => ({ epoch: "fixture-" + id, entries: [] }) },
      }),
    },
  };
  if (managed) writeFileSync(join(data, "scope.json"), JSON.stringify({ projects: ["studio"], coordinator: "coordinator", judgments: {},
    createdCoordinator: { id: "coordinator", previous: null, workspaceId: "operating-space", config: { provider: "codex/fixture-model" }, language } }));
  const handlers = new Map<string, any>();
  const old = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
  try { contribute({ handle: (def: any, fn: any) => handlers.set(def.name, fn), registerSettings() {}, addHook: () => () => {} } as never); }
  finally { if (old === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = old; }
  const rpc = async (def: any, input: unknown) => def.output.parse(await handlers.get(def.name)(def.input.parse(input), { paseo: sdk }));
  if (!managed) {
    await rpc(boardScope, { kind: "project", projectId: "studio", enabled: true });
    await rpc(boardScope, { kind: "coordinator", sessionId: "coordinator" });
  }
  return { state, operatingRoot, operatingFolder, rpc, snapshot: () => rpc(boardSnapshot, { fresh: true }) as Promise<any> };
}

test("a listed coordinator is reachable and costs no extra lookup", async () => {
  const f = await fixture();
  const view = await f.snapshot();
  expect(view.coordinator).toBe("coordinator");
  expect(view.coordinatorReach).toEqual({ state: "ok" });
  expect(f.state.lookups).not.toContain("coordinator");
});

test("removing the operating project in Paseo is reported with the folder to add again", async () => {
  const f = await fixture();
  f.state.projects = f.state.projects.filter(p => p.projectId !== "operate");
  const view = await f.snapshot();
  expect(view.coordinatorReach).toEqual({ state: "project-missing", directory: f.operatingFolder });
  // The board keeps the designation: the session may come back, and the person decides whether to replace it.
  expect(view.coordinator).toBe("coordinator");
  expect(view.sessions.map((s: any) => s.id)).toEqual(["worker"]);
});

test("a host that also archives the sessions of a removed project is reported the same way", async () => {
  const f = await fixture();
  f.state.projects = f.state.projects.filter(p => p.projectId !== "operate");
  Object.assign(f.state.agents.get("coordinator"), { status: "closed", archivedAt: "2026-11-24T05:27:00Z" });
  expect((await f.snapshot()).coordinatorReach).toEqual({ state: "project-missing", directory: f.operatingFolder });
});

test("an archived operating workspace whose project remains is reported as such", async () => {
  const f = await fixture();
  f.state.workspaces = f.state.workspaces.filter(w => w.id !== "operating-space");
  expect((await f.snapshot()).coordinatorReach).toEqual({ state: "workspace-archived", directory: f.operatingFolder });
});

test("the removed project is still named when Paseo no longer returns the session at all", async () => {
  const f = await fixture();
  f.state.projects = f.state.projects.filter(p => p.projectId !== "operate");
  f.state.agents.delete("coordinator");
  expect((await f.snapshot()).coordinatorReach).toEqual({ state: "project-missing", directory: f.operatingFolder });
});

test("closed, failed, archived and deleted coordinators each report their own state", async () => {
  const f = await fixture();
  const coordinator = f.state.agents.get("coordinator");
  coordinator.status = "closed";
  expect((await f.snapshot()).coordinatorReach).toEqual({ state: "closed" });
  coordinator.status = "error";
  expect((await f.snapshot()).coordinatorReach).toEqual({ state: "error" });
  coordinator.archivedAt = "2026-11-24T06:18:00Z";
  expect((await f.snapshot()).coordinatorReach).toEqual({ state: "archived" });
  f.state.agents.delete("coordinator");
  expect((await f.snapshot()).coordinatorReach).toEqual({ state: "missing" });
});

test("a lookup failure is unknown, and the rest of the board still loads", async () => {
  const f = await fixture();
  f.state.workspaces = f.state.workspaces.filter(w => w.id !== "operating-space");
  f.state.failLookup = true;
  const view = await f.snapshot();
  expect(view.coordinatorReach).toEqual({ state: "unknown" });
  expect(view.sessions).toHaveLength(1);
});

test("an existing session chosen as coordinator is checked the same way, and no coordinator means no state", async () => {
  const f = await fixture({ managed: false });
  await expect(f.snapshot()).resolves.toMatchObject({ coordinatorReach: { state: "ok" } });
  f.state.agents.get("coordinator").archivedAt = "2026-11-24T06:18:00Z";
  expect((await f.snapshot()).coordinatorReach).toEqual({ state: "archived" });
  await f.rpc(boardScope, { kind: "coordinator", sessionId: null });
  const cleared = await f.snapshot();
  expect(cleared.coordinator).toBeNull();
  expect(cleared.coordinatorReach).toBeUndefined();
});

test("the operating folder's project is marked so settings can warn before it is removed", async () => {
  const f = await fixture();
  const projects = (await f.snapshot()).projects;
  expect(projects.find((p: any) => p.id === "operate")).toMatchObject({ operating: true, operatingActive: true, selected: false });
  expect(projects.find((p: any) => p.id === "studio").operating).toBeUndefined();
  const picked = await fixture({ managed: false });
  // A work project that merely hosts a chosen coordinator session is not the operating folder.
  expect((await picked.snapshot()).projects.find((p: any) => p.id === "studio").operating).toBeUndefined();
});

test.each(["ko", "en"] as const)("the %s operations project is identified and recovery names its own folder", async language => {
  const f = await fixture({ language });
  const otherName = language === "ko" ? "Coordinator operations (do not delete)" : "코디네이터 운영 (삭제 금지)";
  const siblings = ["coordinator-board", otherName].map(name => ({
    projectId: name, projectDisplayName: name, projectRootPath: join(f.operatingRoot, name),
  }));
  f.state.projects.push(...siblings);
  const view = await f.snapshot();
  expect(view.projects.filter((p: any) => p.operating).map((p: any) => [p.id, p.operatingActive]))
    .toEqual([["operate", true], ...siblings.map(p => [p.projectId, false])]);
  f.state.projects = f.state.projects.filter(p => p.projectId !== "operate");
  f.state.agents.delete("coordinator");

  const { coordinatorReach } = await f.snapshot();
  expect(coordinatorReach).toEqual({ state: "project-missing", directory: f.operatingFolder });
  const notice = reachNotice(coordinatorReach, (ko, en) => language === "ko" ? ko : en);
  expect(notice?.steps[0]).toContain(`"${f.operatingFolder}"`);
  expect(notice?.steps[0]).toContain(language === "ko" ? 'paseo project create "<폴더>"' : 'paseo project create "<folder>"');
});

test("the operating folder is recognised through another spelling of its path", async () => {
  const { sameFolder } = await import("../server/coordinator-reach");
  const root = mkdtempSync(join(tmpdir(), "board-same-folder-")); roots.push(root);
  const folder = join(root, "operate"); mkdirSync(folder);
  expect(await sameFolder(folder, folder + "/")).toBe(true);
  expect(await sameFolder(folder, join(root, "other", "..", "operate"))).toBe(true);
  expect(await sameFolder(folder, root)).toBe(false);
  if (process.platform !== "win32") {
    symlinkSync(folder, join(root, "link"));
    expect(await sameFolder(folder, join(root, "link"))).toBe(true);
  }
  // Folders that no longer exist are compared by their resolved names.
  expect(await sameFolder(join(root, "gone"), join(root, "gone", "."))).toBe(true);
  expect(await sameFolder(join(root, "gone"), join(root, "Gone"))).toBe(process.platform === "win32");
  const missing = join(root, "코디네이터 운영 (삭제 금지)");
  expect(await sameFolder(missing, missing.normalize("NFD"), async () => new Map())).toBe(process.platform === "darwin");
  expect(await sameFolder("", folder)).toBe(false);
});

test("operating project warnings reuse selected identities without probing unrelated unmanaged paths", async () => {
  const { operatingProjects } = await import("../server/coordinator-reach");
  const { ProjectRootReader } = await import("../server/project-root");
  const read: string[] = [];
  const operatingFolder = join(tmpdir(), "fixture-operating-folder");
  const folderReader = new ProjectRootReader({ disk: {
    stat: async path => { read.push(path); return { dev: 1n, ino: 8n, isDirectory: () => true }; },
    realpath: async path => path,
  } });
  const scopes = { coordinator: null };
  const catalog = [
    { id: "operating", path: operatingFolder },
    { id: "selected-alias", path: join(tmpdir(), "fixture-selected-alias"), rootKey: "1:8:" + operatingFolder.toLowerCase() },
    { id: "unrelated", path: join(tmpdir(), "fixture-offline-volume") },
  ];
  expect(await operatingProjects(catalog, [operatingFolder], scopes, undefined, folderReader, [operatingFolder]))
    .toEqual(new Map([["operating", true], ["selected-alias", true]]));
  expect(read).toEqual([operatingFolder]);
});
