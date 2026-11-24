import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { resolve } from "node:path";
import type { SessionRow } from "../shared/contract";
import { listedSessionReach, readSessionReach, type CoordinatorReach } from "../shared/coordinator-reach";
import type { Preferences } from "./preferences";
import { ProjectRootReader } from "./project-root";

type Sdk = Pick<PluginHandlerContext["paseo"], "agents" | "workspaces" | "projects">;
type Scope = Pick<Preferences, "coordinator" | "createdCoordinator">;

const defaultRoots = new ProjectRootReader();

function matchFolders(left: string, right: string, leftKey?: string, rightKey?: string) {
  if (left === right) return true;
  if (leftKey && rightKey) return leftKey === rightKey;
  return process.platform === "win32" && left.toLowerCase() === right.toLowerCase();
}

// Equal paths need no I/O. Other spellings and symlinks are checked against the same bounded disk reader as the board.
export async function sameFolder(a: string, b: string,
  keysFor = (paths: string[]) => defaultRoots.folderKeys(paths)) {
  if (!a || !b) return false;
  const left = resolve(a), right = resolve(b);
  if (left === right) return true;
  const keys = await keysFor([left, right]);
  return matchFolders(left, right, keys.get(left), keys.get(right));
}

// The active session list already rules out archived sessions and workspaces. Only a coordinator
// missing from it needs the extra lookups that explain why.
export async function coordinatorReach(paseo: Sdk, scope: Scope, listed: Pick<SessionRow, "id" | "status"> | undefined,
  operatingFolder: string, projects: readonly { path: string }[], roots: ProjectRootReader): Promise<CoordinatorReach | undefined> {
  const id = scope.coordinator;
  if (!id) return undefined;
  if (listed?.id === id) return { state: listedSessionReach(listed.status) };
  // The board knows the workspace and folder of a coordinator it created, even if Paseo no longer returns the session.
  const created = scope.createdCoordinator?.id === id ? { workspaceId: scope.createdCoordinator.workspaceId, directory: operatingFolder } : {};
  let identities: ReturnType<ProjectRootReader["folderKeys"]> | undefined;
  try {
    return await readSessionReach(paseo, id, created, (a, b) => sameFolder(a, b, ([left, right]) => {
      // Only an archived workspace needs this comparison. Share one deadline across all its candidate roots.
      return identities ??= roots.folderKeys([left, resolve(operatingFolder), right, ...projects.flatMap(p => p.path ? [resolve(p.path)] : [])]);
    }));
  } catch { return { state: "unknown" }; }
}

// Removing this project in Paseo archives the workspace the board's coordinator lives in.
export async function operatingProjects(projects: readonly { id: string; path: string; rootKey?: string }[], operatingFolder: string,
  scope: Scope, listed: Pick<SessionRow, "id" | "projectId" | "sourceProjectId"> | undefined, roots: ProjectRootReader) {
  const folder = resolve(operatingFolder);
  const ids = new Set<string>();
  if (listed && listed.id === scope.coordinator && scope.createdCoordinator?.id === listed.id) ids.add(listed.sourceProjectId ?? listed.projectId);
  const candidates = projects.flatMap(project => {
    if (!project.path) return [];
    const path = resolve(project.path);
    if (path === folder) ids.add(project.id);
    // Reuse selected roots. For unmanaged projects only comparable spellings need a disk lookup.
    if (ids.has(project.id) || (!project.rootKey && path.toLowerCase() !== folder.toLowerCase())) return [];
    return [{ ...project, path }];
  });
  if (candidates.length) {
    const keys = await roots.folderKeys([folder, ...candidates.filter(project => !project.rootKey).map(project => project.path)]);
    for (const project of candidates) {
      if (matchFolders(project.path, folder, project.rootKey ?? keys.get(project.path), keys.get(folder))) ids.add(project.id);
    }
  }
  return ids;
}
