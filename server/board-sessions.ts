import type { SessionRow } from "../shared/contract";
import { discoverSessions, sessionRow } from "./discovery";
import { assignmentReceiptKey } from "./dispatch";
import { registeredAssignmentHosts, withAssignmentHost, type HostSdk } from "./host-assignment";
import type { Preferences } from "./preferences";

export async function discoverBoardSessions(paseo: HostSdk, scope: Preferences): Promise<SessionRow[]> {
  const locals = await discoverSessions(paseo);
  const localIds = new Set(locals.map(row => row.id));
  const receipts = Object.entries(scope.dispatchReceipts);
  for (const row of locals) {
    const receipt = scope.dispatchReceipts[row.id];
    if (receipt && !receipt.remote && receipt.projectId === row.projectId) row.assignment = receipt.location;
  }
  const selected = receipts.filter(([id, receipt]) =>
    receipt.remote && scope.projects.includes(receipt.projectId) && !localIds.has(id));
  if (!selected.length) return locals;
  const hosts = await registeredAssignmentHosts(paseo, scope);
  const remotes = await Promise.all(hosts.filter(host => !host.local && host.online).map(async host => {
    const entries = selected.filter(([, receipt]) => receipt.location.serverId === host.id);
    if (!entries.length) return [];
    try {
      return await withAssignmentHost(paseo, host.id, async sdk => {
        const rows: SessionRow[] = [];
        const workspaces = new Map<string, ReturnType<ReturnType<HostSdk["workspaces"]["ref"]>["refresh"]>>();
        // Reuse each workspace lookup, including when multiple receipts share it.
        for (const [id, receipt] of entries) {
          try {
            const result = await sdk.agents.ref(id).refresh();
            const agent = result?.agent;
            if (!agent || agent.id !== id || agent.internal || agent.archivedAt || agent.workspaceId !== receipt.workspaceId ||
              agent.metadata?.[assignmentReceiptKey] !== receipt.fingerprint) continue;
            let workspaceRead = workspaces.get(receipt.workspaceId);
            if (!workspaceRead) {
              workspaceRead = sdk.workspaces.ref(receipt.workspaceId).refresh();
              workspaces.set(receipt.workspaceId, workspaceRead);
            }
            const workspace = await workspaceRead;
            if (!workspace || workspace.internal || workspace.archivingAt || workspace.projectId !== receipt.sourceProjectId) continue;
            const row = sessionRow(agent, result.project, workspace);
            rows.push({ ...row, sourceProjectId: row.projectId, sourceProjectTitle: row.projectTitle, projectId: receipt.projectId,
              serverId: host.id, assignment: { ...receipt.location, label: host.label } });
          } catch {
            // A missing or unreachable scope does not replace a verified project/session pairing.
          }
        }
        return rows;
      });
    } catch { return []; }
  }));
  return [...locals, ...remotes.flat()];
}
