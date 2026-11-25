import { githubRepository } from "../shared/github-repository";
import { readPages } from "../shared/pages";
import { registeredAssignmentHosts, withAssignmentHost, type HostSdk } from "./host-assignment";
import type { Preferences } from "./preferences";

// Where the board has seen this session on another host: a ledger card's agentId and sessionHost.
export type OwnerHint = { sessionHost: string; projectId: string | null; mergeTarget?: { repo: string; number: number } | null };
type PullScope = { repo: string; number: number; projectIds: readonly string[] };
type HostEntry = { id: string; label: string; local: boolean; resolved: boolean };
export type RemoteOwnerDeps = {
  hosts: () => Promise<readonly HostEntry[]>;
  // Repositories of the session's workspace on that host, or null when the host does not have it.
  read: (serverId: string, sessionId: string) => Promise<string[] | null>;
};

// Hosts that may hold this session, from ledger cards for this PR or its project and from the board's own assignments.
export function ownerHostCandidates(sessionId: string, pull: PullScope, hints: readonly OwnerHint[],
  receipts: Preferences["dispatchReceipts"], hosts: readonly HostEntry[]) {
  const remote = hosts.filter(host => !host.local && host.resolved);
  const ids = new Set<string>();
  for (const hint of hints) {
    if (hint.mergeTarget && (hint.mergeTarget.repo !== pull.repo || hint.mergeTarget.number !== pull.number)) continue;
    if (hint.projectId !== null && !pull.projectIds.includes(hint.projectId)) continue;
    const exact = remote.filter(host => host.id === hint.sessionHost);
    const named = exact.length ? exact : remote.filter(host => host.label.toLowerCase() === hint.sessionHost.toLowerCase());
    if (named.length === 1) ids.add(named[0].id);
  }
  const receipt = Object.hasOwn(receipts, sessionId) ? receipts[sessionId] : undefined;
  if (receipt?.remote && pull.projectIds.includes(receipt.projectId) && remote.some(host => host.id === receipt.location.serverId)) {
    ids.add(receipt.location.serverId);
  }
  return [...ids];
}

// A session on another host can own a PR only after that host shows it working in the PR's repository.
// Returns that host's serverId, so the board can check the same host later, or null.
export async function verifyRemoteOwner(sessionId: string, pull: PullScope, hints: readonly OwnerHint[],
  receipts: Preferences["dispatchReceipts"], deps: RemoteOwnerDeps): Promise<string | null> {
  let hosts: readonly HostEntry[];
  try { hosts = await deps.hosts(); } catch { return null; }
  for (const serverId of ownerHostCandidates(sessionId, pull, hints, receipts, hosts).slice(0, 3)) {
    let repos: string[] | null;
    try { repos = await deps.read(serverId, sessionId); } catch { continue; }
    if (repos?.includes(pull.repo)) return serverId;
  }
  return null;
}

type Workspace = Awaited<ReturnType<HostSdk["workspaces"]["list"]>>["entries"][number];

export function remoteOwnerDeps(paseo: HostSdk, scope: Preferences): RemoteOwnerDeps {
  return {
    hosts: async () => (await registeredAssignmentHosts(paseo, scope)).map(({ id, label, local, resolved }) => ({ id, label, local, resolved })),
    read: (serverId, sessionId) => withAssignmentHost(paseo, serverId, async sdk => {
      const result = await sdk.agents.ref(sessionId).refresh();
      const agent = result?.agent;
      if (!agent || agent.id !== sessionId || agent.archivedAt || agent.internal || !agent.workspaceId) return null;
      const workspaces = await readPages<Workspace>(page => sdk.workspaces.list({ filter: { includeBackground: true }, sort: [{ key: "project_id", direction: "asc" }], page }));
      const workspace = workspaces.find(row => row.id === agent.workspaceId);
      if (!workspace || workspace.archivingAt || workspace.internal) return null;
      return [workspace.gitRuntime?.remoteUrl, workspace.project?.checkout?.remoteUrl].flatMap(url => {
        const repo = githubRepository(url);
        return repo ? [repo] : [];
      });
    }),
  };
}
