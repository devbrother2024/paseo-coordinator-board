import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { dispatchHosts, saveDispatchHost } from "../shared/dispatch-hosts";
import {
  assignmentFailures, defaultAssignmentPolicy, hostIdentity, inferHostPlatform, workspacePathIsAbsolute,
  type AssignmentFailure, type AssignmentHost, type HostProject,
} from "../shared/host-assignment";
import { boardHosts } from "../shared/hosts";
import { githubRepository } from "../shared/github-repository";
import { readPages } from "../shared/pages";
import type { PreferenceStore, Preferences } from "./preferences";

export type HostSdk = PluginHandlerContext["paseo"];
type Workspace = Awaited<ReturnType<HostSdk["workspaces"]["list"]>>["entries"][number];
type Project = Awaited<ReturnType<HostSdk["projects"]["list"]>>["projects"][number];
type Agent = Awaited<ReturnType<HostSdk["agents"]["list"]>>["entries"][number]["agent"];
type Host = Omit<AssignmentHost, "running" | "workspaces" | "platform"> & {
  metadata: Record<string, string>;
  policy: Preferences["assignmentHosts"][string];
  resolved: boolean;
};

export class PlacementError extends Error {
  constructor(readonly failure: AssignmentFailure) {
    super(assignmentFailures[failure].join(" / "));
  }
}

export async function registeredAssignmentHosts(paseo: HostSdk, scope: Preferences): Promise<Host[]> {
  // Earlier daemons and lightweight SDK callers only expose local operations.
  let directory;
  try { directory = await paseo.hosts?.list(); }
  catch { return []; }
  if (!directory?.self) return [];
  const { self } = directory;
  const local = { id: self.serverId, label: self.label, local: true, online: true, metadata: {}, resolved: true };
  const seen = new Set([local.id]);
  const registered = [local, ...[...directory.hosts].sort((a, b) => Number(b.status === "online") - Number(a.status === "online")).flatMap(host => {
    const id = host.serverId ?? host.registrationId;
    if (seen.has(id) || !hostIdentity.safeParse(id).success) return [];
    seen.add(id);
    return [{
      id, label: host.label || host.serverId || "Paseo", local: false,
      online: host.enabled && host.status === "online" && !!host.serverId, metadata: host.metadata, resolved: !!host.serverId,
    }];
  })];
  const labels = new Map(boardHosts({ id: self.serverId, label: self.label }, registered.map(host => ({
    serverId: host.id, label: cleanLabel(host.label), status: host.online ? "online" : "offline",
  }))).map(host => [host.serverId, host.label]));
  return registered.map(host => {
    const policy = Object.hasOwn(scope.assignmentHosts, host.id) ? scope.assignmentHosts[host.id] : defaultAssignmentPolicy;
    return { ...host, label: labels.get(host.id)!, policy, enabled: policy.enabled, limit: policy.limit };
  });
}

function cleanLabel(label: string) {
  return label.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim().slice(0, 200) || "Paseo";
}

export async function withAssignmentHost<T>(paseo: HostSdk, serverId: string | undefined, run: (sdk: HostSdk) => Promise<T>) {
  if (!serverId) return run(paseo);
  const remote = await paseo.hosts.client(serverId);
  try { return await run(remote); }
  finally { await remote.dispose(); }
}

function repoKey(remote: string | null | undefined) {
  if (!remote || remote.length > 1024) return null;
  const github = githubRepository(remote);
  if (github) return "github.com/" + github.toLowerCase();
  try {
    const text = remote.trim();
    const scp = !text.includes("://") && /^(?:[^@/\s]+@)?([a-z0-9.-]+):([^\s]+)$/i.exec(text);
    const url = new URL(scp ? `ssh://${scp[1]}/${scp[2]}` : text);
    if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || !url.hostname) return null;
    const path = url.pathname.replace(/\/$/, "").replace(/\.git$/i, "");
    return path.length > 1 ? url.host.toLowerCase() + path : null;
  } catch { return null; }
}

export function assignmentWorkspace(workspace: Workspace) {
  return !workspace.internal && !workspace.background && !workspace.archivingAt &&
    !!workspace.workspaceDirectory && workspacePathIsAbsolute(workspace.workspaceDirectory) &&
    (!workspace.setupStatus || workspace.setupStatus === "completed");
}

function assignmentProjects(projects: Project[], workspaces: Workspace[], scope?: Preferences): HostProject[] {
  const repositories = new Map<string, Set<string>>();
  for (const workspace of workspaces) {
    if (workspace.internal || workspace.archivingAt) continue;
    const repos = repositories.get(workspace.projectId) ?? new Set<string>();
    for (const remote of [workspace.gitRuntime?.remoteUrl, workspace.project?.checkout?.remoteUrl]) {
      const identity = repoKey(remote);
      if (identity) repos.add(identity);
    }
    repositories.set(workspace.projectId, repos);
  }
  return projects.map(project => {
    const override = scope?.projectRepositories[project.projectId];
    return {
      id: project.projectId,
      name: project.projectCustomName || project.projectDisplayName,
      repos: override?.mode === "manual" && override.repo
        ? ["github.com/" + override.repo.toLowerCase()]
        : [...repositories.get(project.projectId) ?? []],
    };
  });
}

export async function countActiveSessions(paseo: HostSdk) {
  const entries = await readPages(page => paseo.agents.list({
    filter: { statuses: ["initializing", "running"], includeArchived: false, includeBackground: true, includeInternal: false },
    sort: [{ key: "created_at", direction: "asc" }], page,
  }));
  return new Set(entries.map(({ agent }) => agent).filter((agent: Agent) =>
    !agent.archivedAt && !agent.internal && (agent.status === "running" || agent.status === "initializing")
  ).map(agent => agent.id)).size;
}

export async function readHostInventory(paseo: HostSdk, host: Host, scope?: Preferences, measure = false) {
  const automatic = host.local ? inferHostPlatform({ platform: process.platform }, []) : inferHostPlatform(host.metadata, []);
  const empty = { detected: automatic, platform: host.policy.platform ?? automatic, projects: [] as HostProject[],
    available: [] as Workspace[], running: null as number | null };
  if (!host.online) return empty;
  try {
    return await withAssignmentHost(paseo, host.local ? undefined : host.id, async sdk => {
      const [{ projects }, workspaces, running] = await Promise.all([
        sdk.projects.list(),
        readPages(page => sdk.workspaces.list({ filter: { includeBackground: false }, sort: [{ key: "project_id", direction: "asc" }], page })),
        measure ? countActiveSessions(sdk).catch(() => null) : null,
      ]);
      const paths = [...projects.map(project => project.projectRootPath), ...workspaces.map(workspace => workspace.workspaceDirectory)];
      const detected = automatic ?? inferHostPlatform(host.metadata, paths.filter((path): path is string => !!path));
      return { detected, platform: host.policy.platform ?? detected, projects: assignmentProjects(projects, workspaces, host.local ? scope : undefined),
        available: workspaces.filter(assignmentWorkspace), running };
    });
  } catch {
    if (host.local) throw new PlacementError("load-unavailable");
    return empty;
  }
}

export function registerDispatchHosts(server: PluginServerContext, store: PreferenceStore, invalidate: () => void) {
  server.handle(dispatchHosts, async ({ settings }, { paseo }) => {
    const scope = store.read();
    const hosts = await registeredAssignmentHosts(paseo, scope);
    const inventories = settings && hosts.length > 1 ? await Promise.all(hosts.map(host => readHostInventory(paseo, host, scope))) : [];
    return {
      revision: scope.assignmentRevision,
      projects: (inventories[0]?.projects ?? []).filter(project => scope.projects.includes(project.id)),
      hosts: hosts.map((host, index) => ({
        id: host.id, local: host.local, label: host.label, online: host.online, resolved: host.resolved, settings: host.policy,
        detected: inventories[index]?.detected ?? inferHostPlatform(host.local ? { platform: process.platform } : host.metadata, []),
        projects: inventories[index]?.projects.map(({ id, name }) => ({ id, name })) ?? [],
      })),
    };
  });
  server.handle(saveDispatchHost, async (input, { paseo }) => {
    const initial = store.read();
    const hosts = await registeredAssignmentHosts(paseo, initial);
    const host = hosts.find(host => host.id === input.serverId && host.resolved);
    if (!host) throw new PlacementError("host-unknown");
    const changedPairs = Object.entries(input.settings.pairs).filter(([id, target]) => host.policy.pairs[id] !== target);
    if (changedPairs.length) {
      if (host.local || !host.online) throw new PlacementError("host-offline");
      const inventory = await readHostInventory(paseo, host);
      if (changedPairs.some(([, target]) => !inventory.projects.some(project => project.id === target))) throw new PlacementError("project-unavailable");
    }
    store.change(scope => {
      if (scope.assignmentRevision !== input.expectedRevision) throw new PlacementError("placement-changed");
      if (changedPairs.some(([id]) => !scope.projects.includes(id))) throw new PlacementError("project-unavailable");
      scope.assignmentHosts[host.id] = input.settings;
      scope.assignmentRevision++;
    });
    invalidate();
    return { ok: true as const };
  });
}
