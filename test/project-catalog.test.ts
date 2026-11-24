import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contribute from "../index.server";
import { ProjectRootReader } from "../server/project-root";
import { PreferenceStore } from "../server/preferences";
import { boardScope, boardSnapshot } from "../shared/contract";

const roots = new ProjectRootReader();
const projectRootKey = async (path: string) => (await roots.describe([{ id: path, path }], new Set([path])))[0].rootKey;

test("folder identity follows aliases without merging distinct or unavailable directories", async () => {
  const root = mkdtempSync(join(tmpdir(), "board-project-root-"));
  try {
    const original = join(root, "Studio");
    const other = join(root, "Backup");
    const alias = join(root, "Alias");
    mkdirSync(original);
    mkdirSync(other);
    symlinkSync(original, alias, "dir");
    const key = await projectRootKey(original);
    expect(key).toBeString();
    expect(await projectRootKey(alias)).toBe(key);
    const alternateCase = join(root, "studio");
    try {
      mkdirSync(alternateCase);
      expect(await projectRootKey(alternateCase)).not.toBe(key);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      expect(await projectRootKey(alternateCase)).toBe(key);
    }
    expect(await projectRootKey(other)).not.toBe(key);
    expect(await projectRootKey(join(root, "missing"))).toBeUndefined();
    expect(await projectRootKey("")).toBeUndefined();
    const file = join(root, "file");
    writeFileSync(file, "");
    expect(await projectRootKey(file)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a deleted project stays removable in settings but its missing ledger does not make the snapshot partial", async () => {
  const home = mkdtempSync(join(tmpdir(), "board-project-catalog-"));
  const data = join(home, "plugin-data", "coordinator-board");
  const prefs = new PreferenceStore(join(data, "scope.json"));
  const handlers = new Map();
  const oldHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    contribute({ handle: (def, handler) => handlers.set(def.name, handler), registerSettings() {}, addHook: () => () => {} } as never);
  } finally {
    if (oldHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = oldHome;
  }
  try {
    prefs.change(scope => {
      scope.projects = ["active", "deleted"];
      scope.projectRepositories = { active: { mode: "off" }, deleted: { mode: "off" } };
    });
    const source = (projectId: string, directory: string) => ({ source: projectId, projectId, projectTitle: projectId, directory });
    const active = join(home, "active");
    mkdirSync(active);
    writeFileSync(join(active, "decisions.json"), JSON.stringify({ items: [{ id: "question", title: "Review sample", where: "human" }] }));
    writeFileSync(join(data, "tracked-sources.json"), JSON.stringify({
      version: 1, sources: [source("active", active), source("deleted", join(home, "missing"))],
    }));
    const projects = [{ projectId: "active", projectDisplayName: "Active", projectRootPath: active }];
    const pageInfo = { hasMore: false, nextCursor: null };
    const entries: unknown[] = [];
    const paseo = { agents: { list: async () => ({ entries, pageInfo }), ref: () => ({
      timeline: { refetch: async () => ({ epoch: "sample", entries: [] }) },
    }) }, workspaces: { list: async () => ({ entries: [], pageInfo }) }, projects: { list: async () => ({ projects }) } };
    const rpc = async (def, input) => def.output.parse(await handlers.get(def.name)(input, { paseo }));
    const snapshot = () => rpc(boardSnapshot, { fresh: true });

    const board = await snapshot();
    expect(board.projects).toEqual([
      { id: "active", title: "Active", path: active, selected: true, rootKey: await projectRootKey(active), temporary: true },
      { id: "deleted", title: "deleted", path: "", selected: true, missing: true, temporary: false },
    ]);
    expect(board.trackedDecisions.status).toBe("ok");
    expect(board.trackedDecisions.items.map(item => item.id)).toEqual(["question"]);
    expect(prefs.read().projects).toEqual(["active", "deleted"]);

    await rpc(boardScope, { kind: "project", projectId: "deleted", enabled: false });
    expect((await snapshot()).projects.map(project => project.id)).toEqual(["active"]);
    expect(prefs.read().projects).toEqual(["active"]);
    projects.push({ projectId: "deleted", projectDisplayName: "Restored", projectRootPath: active });
    await rpc(boardScope, { kind: "project", projectId: "deleted", enabled: true });
    expect((await snapshot()).trackedDecisions).toMatchObject({
      status: "partial", items: [{ id: "question" }],
      diagnostics: { count: 1, issues: [{ kind: "source", source: "deleted", projectTitle: "deleted" }] },
    });
    entries.push({ agent: { id: "sample-agent", status: "idle", pendingPermissions: [] }, project: { projectKey: "", projectName: "Direct session" } });
    const fallback = (await snapshot()).projects.find(p => p.id === "unassigned");
    expect(fallback).toEqual({ id: "unassigned", title: "Direct session", path: "", selected: false, temporary: false });
    await rpc(boardScope, { kind: "project", projectId: "unassigned", enabled: true });
    expect((await snapshot()).sessions.some(row => row.id === "sample-agent")).toBe(true);
    expect((await snapshot()).projects.find(p => p.id === "unassigned").selected).toBe(true);

    entries.length = 0;
    expect((await snapshot()).projects.find(p => p.id === "unassigned")).toMatchObject({ selected: true, missing: true });
    expect(prefs.read().projects).toContain("unassigned");

  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
