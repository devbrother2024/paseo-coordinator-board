import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { SessionRow } from "../shared/contract";
import { listedSessionReach, readSessionReach, type CoordinatorReach } from "../shared/coordinator-reach";
import type { Preferences } from "./preferences";

type Sdk = Pick<PluginHandlerContext["paseo"], "agents" | "workspaces" | "projects">;
type Scope = Pick<Preferences, "coordinator" | "createdCoordinator">;

// Two spellings of one folder: other separators, another letter case, or a link. The file system
// decides when both exist. Otherwise the resolved paths are compared, ignoring case only on Windows.
export function sameFolder(a: string, b: string) {
  if (!a || !b) return false;
  try {
    const first = statSync(a, { bigint: true }), second = statSync(b, { bigint: true });
    if (first.ino !== 0n && second.ino !== 0n) return first.ino === second.ino && first.dev === second.dev;
  } catch {
    // A removed folder is compared by name.
  }
  const left = resolve(a), right = resolve(b);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// The active session list already rules out archived sessions and workspaces. Only a coordinator
// missing from it needs the extra lookups that explain why.
export async function coordinatorReach(paseo: Sdk, scope: Scope, listed: Pick<SessionRow, "id" | "status"> | undefined,
  operatingFolder: string): Promise<CoordinatorReach | undefined> {
  const id = scope.coordinator;
  if (!id) return undefined;
  if (listed?.id === id) return { state: listedSessionReach(listed.status) };
  // The board knows the workspace and folder of a coordinator it created, even if Paseo no longer returns the session.
  const created = scope.createdCoordinator?.id === id ? { workspaceId: scope.createdCoordinator.workspaceId, directory: operatingFolder } : {};
  try { return await readSessionReach(paseo, id, created, sameFolder); } catch { return { state: "unknown" }; }
}

// Removing this project in Paseo archives the workspace the board's coordinator lives in.
export function operatingProjects(projects: readonly { id: string; path: string }[], operatingFolder: string,
  scope: Scope, listed: Pick<SessionRow, "id" | "projectId" | "sourceProjectId"> | undefined) {
  const ids = new Set(projects.filter(project => sameFolder(project.path, operatingFolder)).map(project => project.id));
  if (listed && listed.id === scope.coordinator && scope.createdCoordinator?.id === listed.id) ids.add(listed.sourceProjectId ?? listed.projectId);
  return ids;
}
