import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { SessionRow } from "../shared/contract";
import { listedSessionReach, readSessionReach, type CoordinatorReach } from "../shared/coordinator-reach";
import type { Preferences } from "./preferences";

type Sdk = Pick<PluginHandlerContext["paseo"], "agents" | "workspaces" | "projects">;
type Scope = Pick<Preferences, "coordinator" | "createdCoordinator">;

// Folder identities are remembered briefly: a snapshot compares every project, and a stat on a
// network drive is slow.
const identities = new Map<string, { value: string | null; at: number }>();
async function identity(path: string) {
  const now = Date.now(), cached = identities.get(path);
  if (cached && now - cached.at < 60_000) return cached.value;
  let value: string | null = null;
  try {
    const found = await stat(path, { bigint: true });
    if (found.ino !== 0n) value = found.dev + ":" + found.ino;
  } catch {
    // A removed folder is compared by name.
  }
  if (identities.size > 512) identities.clear();
  identities.set(path, { value, at: now });
  return value;
}

// Two spellings of one folder: other separators, another letter case, or a link. Equal resolved paths need
// no file system. Otherwise the file system decides when both exist, and letter case is ignored only on Windows.
export async function sameFolder(a: string, b: string) {
  if (!a || !b) return false;
  const left = resolve(a), right = resolve(b);
  if (left === right) return true;
  const [first, second] = await Promise.all([identity(left), identity(right)]);
  if (first && second) return first === second;
  return process.platform === "win32" && left.toLowerCase() === right.toLowerCase();
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
export async function operatingProjects(projects: readonly { id: string; path: string }[], operatingFolder: string,
  scope: Scope, listed: Pick<SessionRow, "id" | "projectId" | "sourceProjectId"> | undefined) {
  const matches = await Promise.all(projects.map(project => sameFolder(project.path, operatingFolder)));
  const ids = new Set(projects.filter((_, index) => matches[index]).map(project => project.id));
  if (listed && listed.id === scope.coordinator && scope.createdCoordinator?.id === listed.id) ids.add(listed.sourceProjectId ?? listed.projectId);
  return ids;
}
