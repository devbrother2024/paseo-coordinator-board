import type { TrackedDecision } from "../shared/tracked-decisions";
import { sameProject, type ProjectFolders } from "../shared/project-folders";

export function trackedSessionOwner(item: TrackedDecision, coordinator: string | null) {
  // Older board-owned records predate the explicit ledger owner.
  return item.sourceCoordinatorId === undefined && (item.where === "manager" || item.where === "human")
    ? coordinator : item.sourceCoordinatorId;
}

export type WorkSessionHost = { serverId: string; label: string; registeredLabel: string };
export type RemoteWorkSession = { kind: "remote"; id: string; hosts: readonly WorkSessionHost[] };
export type WorkSessionTarget = RemoteWorkSession | { kind: "local"; id: string } | { kind: "unavailable" };
type WorkSessionDirectory = {
  hostId?: string; hostLabel: string; sessions: readonly { id: string; projectId: string }[];
  hosts: readonly WorkSessionHost[]; folders?: ProjectFolders;
};

export function trackedWorkSession(item: TrackedDecision, directory: WorkSessionDirectory): WorkSessionTarget | undefined {
  const id = item.matchedSessionId || item.sessionId;
  if (!id) return;
  const { hostId, hostLabel, sessions, hosts, folders = {} } = directory;
  const hint = item.sessionHost;
  const exact = hosts.find(host => host.serverId === hint);
  const localHint = !hint || hint === hostId || (!exact && hint.toLowerCase() === hostLabel.toLowerCase());
  // A project card's own session is judged as its reply is: by project, or by a project on the same folder.
  if (localHint && sessions.some(row => row.id === id &&
    (item.projectId === null || row.id === item.matchedSessionId || sameProject(row.projectId, item.projectId, folders)))) {
    return { kind: "local", id };
  }
  const candidates = exact ? [exact]
    : localHint ? hosts : hosts.filter(host => host.registeredLabel.toLowerCase() === hint?.toLowerCase());
  return candidates.length ? { kind: "remote", id, hosts: candidates } : { kind: "unavailable" };
}

export type WorkSessionLookup = (host: string, id: string) => Promise<boolean>;
type WorkSessionReader = { agents: { ref(id: string): {
  refresh(): Promise<{ agent: { id: string; internal?: boolean | null; archivedAt?: string | null } } | null>;
} } };

export function createRemoteWorkSessionLookup(client: (host: string) => WorkSessionReader): WorkSessionLookup {
  const cache = new Map<string, Promise<boolean>>();
  return (host, id) => {
    const key = JSON.stringify([host, id]);
    const existing = cache.get(key);
    if (existing) return existing;
    const next = Promise.resolve().then(async () => {
      const result = await client(host).agents.ref(id).refresh();
      return !!result && result.agent.id === id && !result.agent.internal && !result.agent.archivedAt;
    }).catch(() => false);
    cache.set(key, next);
    return next;
  };
}

export async function findRemoteWorkSession(source: RemoteWorkSession, lookup: WorkSessionLookup) {
  const found = await Promise.all(source.hosts.map(host => lookup(host.serverId, source.id)));
  const matches = source.hosts.filter((_, index) => found[index]);
  return matches.length === 1 ? matches[0] : undefined;
}
