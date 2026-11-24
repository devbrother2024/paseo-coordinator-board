import type { SessionRow } from "../shared/contract";
import { discoverSessions, sessionRow } from "./discovery";
import { assignmentReceiptKey } from "./dispatch";
import { registeredAssignmentHosts, type HostSdk } from "./host-assignment";
import type { DispatchReceipt, PreferenceStore } from "./preferences";

const maxRemoteReads = 4;
let activeReads = 0;
const waiting: (() => void)[] = [];

async function remoteRead<T>(run: () => Promise<T>) {
  if (activeReads < maxRemoteReads) activeReads++;
  else await new Promise<void>(resolve => waiting.push(resolve));
  try { return await run(); }
  finally {
    const next = waiting.shift();
    if (next) next();
    else activeReads--;
  }
}

export async function discoverBoardSessions(paseo: HostSdk, prefs: PreferenceStore, targets?: ReadonlySet<string>): Promise<SessionRow[]> {
  const scope = prefs.readDispatchScope();
  const locals = await discoverSessions(paseo);
  const localIds = new Set(locals.map(row => row.id));
  const receipts = Object.entries(scope.dispatchReceipts);
  const ended = new Map(receipts.filter(([id, receipt]) => !receipt.remote && receipt.delivered && !localIds.has(id)));
  for (const row of locals) {
    const receipt = scope.dispatchReceipts[row.id];
    if (receipt && !receipt.remote && receipt.projectId === row.projectId) row.assignment = receipt.location;
  }

  const selected = receipts.filter(([id, receipt]) => receipt.remote && !localIds.has(id) && (!targets || targets.has(id)));
  const hosts = selected.length ? await registeredAssignmentHosts(paseo, scope) : [];
  const remotes = await Promise.all(hosts.filter(host => !host.local && host.online).map(async host => {
    const entries = selected.filter(([, receipt]) => receipt.location.serverId === host.id);
    if (!entries.length) return [];
    try {
      const sdk = await remoteRead(() => paseo.hosts.client(host.id));
      try { return await readWorkers(sdk, host, entries, ended); }
      finally { await remoteRead(() => sdk.dispose()); }
    } catch { return []; }
  }));
  if (ended.size) prefs.change(current => {
    for (const [id, observed] of ended) {
      const saved = current.dispatchReceipts[id];
      if (saved?.delivered && saved.fingerprint === observed.fingerprint && saved.createdAt === observed.createdAt)
        delete current.dispatchReceipts[id];
    }
  });
  return [...locals, ...remotes.flat()];
}

async function readWorkers(sdk: HostSdk, host: { id: string; label: string }, entries: [string, DispatchReceipt][],
  ended: Map<string, DispatchReceipt>) {
  const workspaces = new Map<string, ReturnType<ReturnType<HostSdk["workspaces"]["ref"]>["refresh"]>>();
  const rows = await Promise.all(entries.map(async ([id, receipt]) => {
    try {
      const result = await remoteRead(() => sdk.agents.ref(id).refresh());
      const agent = result?.agent;
      if (receipt.delivered && (!result || (agent?.id === id && agent.archivedAt))) ended.set(id, receipt);
      if (!agent || agent.id !== id || agent.internal || agent.archivedAt || agent.workspaceId !== receipt.workspaceId ||
          agent.metadata?.[assignmentReceiptKey] !== receipt.fingerprint) return;
      let workspaceRead = workspaces.get(receipt.workspaceId);
      if (!workspaceRead) {
        workspaceRead = remoteRead(() => sdk.workspaces.ref(receipt.workspaceId).refresh());
        workspaces.set(receipt.workspaceId, workspaceRead);
      }
      const workspace = await workspaceRead;
      if (!workspace || workspace.internal || workspace.archivingAt || workspace.projectId !== receipt.sourceProjectId) return;
      const row = sessionRow(agent, result.project, workspace);
      return { ...row, sourceProjectId: row.projectId, sourceProjectTitle: row.projectTitle, projectId: receipt.projectId,
        serverId: host.id, assignment: { ...receipt.location, label: host.label } };
    } catch {
      // A failed lookup cannot establish that a worker was deleted or archived.
      return;
    }
  }));
  return rows.filter(row => row !== undefined);
}
