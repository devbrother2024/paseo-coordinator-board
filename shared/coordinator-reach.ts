import { z } from "zod";

// Why the board can or cannot hand something to a session. "ok" is the only state that takes board input.
export const coordinatorReachStates = ["ok", "closed", "error", "archived", "workspace-archived", "project-missing", "missing", "unknown"] as const;
export type CoordinatorReachState = typeof coordinatorReachStates[number];
export const coordinatorReachSchema = z.object({
  state: z.enum(coordinatorReachStates),
  // The folder the session worked in, so a recovery guide can name the project to add again.
  directory: z.string().max(4096).optional(),
});
export type CoordinatorReach = z.infer<typeof coordinatorReachSchema>;

type ReachAgent = { id: string; status?: string | null; workspaceId?: string | null; archivedAt?: string | null; internal?: boolean; cwd?: string | null };
type ReachWorkspace = { archivingAt?: string | null };
type ReachProject = { projectId: string; projectKey?: string; projectRootPath: string };
// The part of the Paseo SDK this needs. The plugin server and the app client both provide it.
export type ReachSdk = {
  agents: { ref(id: string): { refresh(): Promise<{ agent: ReachAgent; project?: { projectKey?: string } | null } | null> } };
  workspaces: { ref(id: string): { refresh(): Promise<ReachWorkspace | null> } };
  projects: { list(): Promise<{ projects: ReachProject[] }> };
};

export const receivesBoardInput = (state: CoordinatorReachState) => state === "ok";
// A closed or failed session still shows its conversation. An archived workspace opens an empty screen.
export const opensSession = (state: CoordinatorReachState) => state === "ok" || state === "closed" || state === "error" || state === "unknown";
// A check that failed does not stop a reply: the session may be fine.
export const blocksReplies = (state: CoordinatorReachState) => state !== "ok" && state !== "unknown";

// Sessions in the active list are neither archived nor in an archived workspace.
export function listedSessionReach(status: string | null | undefined): CoordinatorReachState {
  return status === "closed" || status === "error" ? status : "ok";
}

// `workspace` is undefined when the session has none to check, and null when it is no longer active.
export function classifyReach(input: { agent: ReachAgent | null; workspace?: ReachWorkspace | null; projectKnown?: boolean | null }): CoordinatorReachState {
  const { agent, workspace } = input;
  if (!agent || agent.internal) return "missing";
  // Some hosts archive the sessions of a removed project and others only drop them from the active list.
  // Either way the archived workspace is the cause, so it comes before the session's own archive mark.
  if (workspace === null || workspace?.archivingAt) return input.projectKnown === false ? "project-missing" : "workspace-archived";
  if (agent.archivedAt) return "archived";
  return listedSessionReach(agent.status);
}

// The folder a session works in can prove its project is present. Only a project key or the
// board's own operating folder can prove it is gone: a worktree session works outside its project root.
async function projectKnown(paseo: ReachSdk, key: string | undefined, cwd: string | undefined, operatingFolder: string | undefined,
  sameFolder: SameFolder): Promise<boolean | null> {
  const folders = [cwd, operatingFolder].filter((folder): folder is string => !!folder);
  if (key === undefined && !folders.length) return null;
  try {
    const { projects } = await paseo.projects.list();
    for (const project of projects) {
      if (key !== undefined && (project.projectId === key || project.projectKey === key)) return true;
      for (const folder of folders) if (await sameFolder(folder, project.projectRootPath)) return true;
    }
    return key !== undefined || operatingFolder !== undefined ? false : null;
  } catch {
    return null;
  }
}

// Paths differ in separators and letter case between hosts. A caller that can ask the file system passes its own comparison.
export type SameFolder = (a: string, b: string) => boolean | Promise<boolean>;

export async function readSessionReach(paseo: ReachSdk, id: string, known: { workspaceId?: string; directory?: string } = {},
  sameFolder: SameFolder = (a, b) => a === b): Promise<CoordinatorReach> {
  let entry: Awaited<ReturnType<ReturnType<ReachSdk["agents"]["ref"]>["refresh"]>>;
  try { entry = await paseo.agents.ref(id).refresh(); } catch { return { state: "unknown" }; }
  const agent = entry?.agent.id === id && !entry.agent.internal ? entry.agent : null;
  const workspaceId = agent?.workspaceId ?? known.workspaceId;
  if (!workspaceId) return { state: classifyReach({ agent }) };
  let workspace: ReachWorkspace | null;
  try { workspace = await paseo.workspaces.ref(workspaceId).refresh(); }
  // An archived session is known to be archived even when its workspace cannot be read.
  catch { return { state: agent?.archivedAt ? "archived" : "unknown" }; }
  if (workspace && !workspace.archivingAt) return { state: classifyReach({ agent, workspace }) };
  const directory = agent?.cwd || known.directory;
  const state = classifyReach({
    // A session Paseo no longer returns is still explained by the archived workspace it lived in.
    agent: agent ?? { id }, workspace: null,
    projectKnown: await projectKnown(paseo, entry?.project?.projectKey, agent?.cwd ?? undefined, known.directory, sameFolder),
  });
  return { state, ...(directory ? { directory } : {}) };
}
