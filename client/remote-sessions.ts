import type { getPaseoClient } from "@getpaseo/plugin/client";
import { githubRepository } from "../shared/github-repository";
import { readPages } from "../shared/pages";
import type { PullRequestView } from "../shared/prs";

import { workspacePull, type WorkspacePull } from "../shared/workspace-pull";
import { coordinatorWaitInTimeline, type CoordinatorWait } from "../shared/coordinator-wait";

type Client = ReturnType<typeof getPaseoClient>;
type AgentEntry = Awaited<ReturnType<Client["agents"]["list"]>>["entries"][number];
type Workspace = Awaited<ReturnType<Client["workspaces"]["list"]>>["entries"][number];
export type LocalProject = { id: string; title: string; selected: boolean };
export type Repository = Pick<PullRequestView["projects"][number],"projectId"|"repo"|"mode">;
export type RemoteScope = { selected: string[]; known: string[]; repos: [string,string][] };
export type RemoteSession = {
  sessionId: string; projectId: string; title: string; activityAt?: string; workspacePull?: WorkspacePull; wait?: CoordinatorWait;
};
export type RemoteWaitingSession = Pick<RemoteSession, "sessionId" | "title"> & {
  serverId: string; hostLabel: string; wait: CoordinatorWait;
};
export type RemoteWaitCache = Map<string, { activityAt: string; wait: CoordinatorWait | undefined }>;

export function remoteScope(projects: LocalProject[], repositories: Repository[]): RemoteScope {
  const selected = projects.filter(p => p.selected).map(p => p.id).sort();
  const known = projects.map(p => p.id).sort();
  const repos: [string,string][] = [];
  for (const source of repositories) {
    if (source.repo && source.mode !== "off" && selected.includes(source.projectId)) {
      repos.push([source.projectId,source.repo]);
    }
  }
  return { selected, known, repos: repos.sort(([a],[b]) => a.localeCompare(b)) };
}

function repositoriesByProject(workspaces: Workspace[]) {
  const projectRepos = new Map<string, Set<string | null>>();
  const projectsByRepo = new Map<string, Set<string>>();
  for (const ws of workspaces) {
    if (!ws.projectId || ws.internal || ws.archivingAt) continue;
    for (const url of [ws.gitRuntime?.remoteUrl, ws.project?.checkout?.remoteUrl]) {
      if (!url) continue;
      const repo = githubRepository(url);
      const repos = projectRepos.get(ws.projectId) ?? new Set();
      repos.add(repo);
      projectRepos.set(ws.projectId, repos);
      if (repo) {
        const ids = projectsByRepo.get(repo) ?? new Set();
        ids.add(ws.projectId);
        projectsByRepo.set(repo, ids);
      }
    }
  }
  return { projectRepos, projectsByRepo };
}

export function matchRemoteSessions(entries: AgentEntry[], workspaces: Workspace[], scope: RemoteScope, historyId?:string): RemoteSession[] {
  return matchProjects(entries.filter(({ agent }) => historyId ? agent.id === historyId
    : agent.status === "running" && !pendingPermission(agent)), workspaces, scope);
}

function pendingPermission(agent: AgentEntry["agent"]) {
  return agent.pendingPermissions.length > 0 || agent.attentionReason === "permission";
}

function resting(agent: AgentEntry["agent"]) {
  return agent.status === "idle" && !agent.archivedAt && !agent.internal && !agent.activeTurn &&
    !pendingPermission(agent) && !agent.lastError && agent.attentionReason !== "error";
}

function matchProjects(entries: AgentEntry[], workspaces: Workspace[], scope: RemoteScope): RemoteSession[] {
  const byWorkspace = new Map(workspaces.map(ws => [ws.id, ws]));
  const {projectRepos, projectsByRepo} = repositoriesByProject(workspaces);
  const result = new Map<string, RemoteSession>();
  for (const {agent, project} of entries) {
    const ws = agent.workspaceId ? byWorkspace.get(agent.workspaceId) : undefined;
    if ((agent.workspaceId && !ws) || agent.archivedAt || agent.internal || ws?.internal || ws?.archivingAt) continue;
    const id = ws?.projectId || project.projectKey;
    if (!id || id === "unassigned") continue;
    let matched = id;
    if (!scope.selected.includes(id)) {
      if (scope.known.includes(id)) continue;
      const repos = projectRepos.get(id);
      if (!repos || repos.size !== 1) continue;
      const [repo] = repos;
      if (!repo || projectsByRepo.get(repo)?.size !== 1) continue;
      const local = scope.repos.filter(([,slug]) => slug === repo);
      if (local.length !== 1) continue;
      matched = local[0][0];
    }
    const work = workspacePull(ws);
    result.set(agent.id, {...(work ? {workspacePull:work} : {}),sessionId: agent.id, projectId: matched, title: agent.title?.trim() ?? "",
      ...(agent.updatedAt && {activityAt: agent.updatedAt})});
  }
  return [...result.values()];
}

export async function readRemoteSessions(
  client: Pick<Client, "agents" | "workspaces">,
  scope: RemoteScope,
  active = () => true,
  { cache = new Map(), skipWait, onRunning }: {
    cache?: RemoteWaitCache; skipWait?: (id: string) => boolean; onRunning?: (rows: RemoteSession[]) => void;
  } = {},
): Promise<RemoteSession[]> {
  if (!scope.selected.length || !active()) return [];
  // An already outstanding request may complete after a host is hidden. Stop
  // before asking for another page or reading that host's workspace metadata.
  const checkScope = () => { if (!active()) throw Error("Remote session scope changed"); };
  const agents = await readPages<AgentEntry>(page => {
    checkScope();
    return client.agents.list({
      filter: { statuses: ["running", "idle"], includeArchived: false, includeBackground: true, includeInternal: false },
      sort: [{ key: "created_at", direction: "asc" }], page,
    });
  });
  if (!active()) return [];
  if (!agents.length) {
    cache.clear();
    return [];
  }
  const spaces = await readPages<Workspace>(page => {
    checkScope();
    return client.workspaces.list({
      filter: { includeBackground: true }, sort: [{ key: "project_id", direction: "asc" }], page,
    });
  });
  if (!active()) return [];
  const idle = new Map(agents.filter(({ agent }) => resting(agent) && !skipWait?.(agent.id)).map(({ agent }) => [agent.id, agent]));
  const matches = matchProjects(agents.filter(({ agent }) => idle.has(agent.id) ||
    (agent.status === "running" && !pendingPermission(agent))), spaces, scope);
  const running = matches.filter(row => !idle.has(row.sessionId));
  onRunning?.(running);
  const candidates = matches.filter(row => idle.has(row.sessionId));
  const ids = new Set(candidates.map(row => row.sessionId));
  for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);

  let next = 0;
  const readWaits = async () => {
    while (active() && next < candidates.length) {
      const row = candidates[next++];
      if (skipWait?.(row.sessionId)) continue;
      const saved = cache.get(row.sessionId);
      if (row.activityAt && saved?.activityAt === row.activityAt) {
        if (saved.wait) row.wait = saved.wait;
        continue;
      }
      try {
        const handle = client.agents.ref(row.sessionId);
        const page = await handle.timeline.refetch({ direction: "tail", projection: "projected", limit: 48 });
        if (!active() || page.error || page.gap || page.staleCursor) continue;
        const current = handle.current();
        if (current && (!resting(current) || current.workspaceId !== idle.get(row.sessionId)?.workspaceId)) continue;
        const observed = coordinatorWaitInTimeline(page.entries);
        const wait = observed && { ...observed, since: observed.since ?? row.activityAt };
        if (row.activityAt) cache.set(row.sessionId, { activityAt: row.activityAt, wait });
        if (wait) row.wait = wait;
      } catch {
        // Keep running sessions and other matches when one conversation is unavailable.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, readWaits));
  return active() ? matches.filter(row => row.wait || !idle.has(row.sessionId)) : [];
}


// A history click can reference an idle or closed agent omitted from the running-only directory.
export async function readRemoteHistorySession(client:Pick<Client,"agents"|"workspaces">, id:string, expectedProject:string,
  scope:RemoteScope, active = () => true) {
  if (!active() || !scope.selected.includes(expectedProject)) return false;
  const result = await client.agents.ref(id).refresh();
  if (!active() || !result?.project || result.agent.id !== id || result.agent.archivedAt || result.agent.internal) return false;
  const workspaces = result.agent.workspaceId ? await readPages<Workspace>(page => {
    if (!active()) throw Error("Remote history scope changed");
    return client.workspaces.list({filter:{includeBackground:true},sort:[{key:"project_id",direction:"asc"}],page});
  }) : [];
  if (!active()) return false;
  const match = matchRemoteSessions([{agent:result.agent,project:result.project}],workspaces,scope,id)[0];
  if (!match) return false;
  const repo = scope.repos.find(([project])=>project === expectedProject)?.[1];
  return match.projectId === expectedProject || (!!repo && scope.repos.some(([project,slug])=>project === match.projectId && slug === repo));
}
