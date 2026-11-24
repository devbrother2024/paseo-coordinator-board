import type { SessionRow } from "../shared/contract";
import { discoverSessions, sessionRow } from "./discovery";
import { assignmentReceiptKey } from "./dispatch";
import { registeredAssignmentHosts, type HostSdk } from "./host-assignment";
import { maxDispatchReceipts, type DispatchReceipt, type PreferenceStore } from "./preferences";

const maxRemoteReads = 4;
const remoteTimeoutMs = 5_000;
let activeReads = 0;
const waiting: (() => void)[] = [];

async function remoteRead<T>(run: () => Promise<T>, timeoutMs: number, releaseLate?: (value: T) => Promise<void>) {
  if (activeReads < maxRemoteReads) activeReads++;
  else await new Promise<void>(resolve => waiting.push(resolve));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    const pending = run();
    if (releaseLate) void pending.then(value => expired ? releaseLate(value) : undefined).catch(() => {});
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error("Remote board lookup timed out"));
      }, timeoutMs);
    });
    return await Promise.race([pending, deadline]);
  }
  finally {
    clearTimeout(timer);
    const next = waiting.shift();
    if (next) next();
    else activeReads--;
  }
}

type BoundedRead = <T>(run: () => Promise<T>) => Promise<T>;

export async function withRemoteReadHost<T>(paseo: HostSdk, id: string, run: (sdk: HostSdk, read: BoundedRead) => Promise<T>,
  timeoutMs = remoteTimeoutMs) {
  const read: BoundedRead = task => remoteRead(task, timeoutMs);
  const dispose = (sdk: HostSdk) => read(() => sdk.dispose()).catch(() => {});
  const sdk = await remoteRead(() => paseo.hosts.client(id), timeoutMs, dispose);
  try { return await run(sdk, read); }
  finally { await dispose(sdk); }
}

type ReceiptEntries = Map<string, DispatchReceipt>;
type DiscoveryOptions = { timeoutMs?: number; reserveSlot?: boolean };

export async function discoverBoardSessions(paseo: HostSdk, prefs: PreferenceStore, targets?: ReadonlySet<string>,
  { timeoutMs = remoteTimeoutMs, reserveSlot = false }: DiscoveryOptions = {}): Promise<SessionRow[]> {
  const scope = prefs.readDispatchScope();
  const locals = await discoverSessions(paseo);
  const localById = new Map(locals.map(row => [row.id, row]));
  const receipts = Object.entries(scope.dispatchReceipts);
  const ended: ReceiptEntries = new Map();
  const inactive: ReceiptEntries = new Map();
  const limit = maxDispatchReceipts - Number(reserveSlot);
  for (const [id, receipt] of receipts) {
    if (receipt.remote || !receipt.delivered) continue;
    const row = localById.get(id);
    if (!row) ended.set(id, receipt);
    else if (row.projectId === receipt.projectId && (row.status === "idle" || row.status === "closed") &&
        row.lane !== "running" && !row.nativePending) inactive.set(id, receipt);
  }

  const selected = receipts.filter(([id, receipt]) => receipt.remote && !localById.has(id) &&
    (!reserveSlot || receipt.delivered) && (!targets || targets.has(id)));
  const hosts = selected.length ? await remoteRead(() => registeredAssignmentHosts(paseo, scope), timeoutMs).catch(() => []) : [];
  const remotes = await Promise.all(hosts.filter(host => !host.local && host.online).map(async host => {
    const entries = selected.filter(([, receipt]) => receipt.location.serverId === host.id);
    if (!entries.length) return [];
    try {
      return await withRemoteReadHost(paseo, host.id, (sdk, read) => readWorkers(sdk, host, entries, read, ended, inactive), timeoutMs);
    } catch { return []; }
  }));
  const removed = new Set<string>();
  if (ended.size || (!targets && receipts.length > limit && inactive.size)) {
    prefs.change(current => {
      const remove = ([id, observed]: [string, DispatchReceipt]) => {
        const saved = current.dispatchReceipts[id];
        if (!saved?.delivered || saved.fingerprint !== observed.fingerprint || saved.createdAt !== observed.createdAt) return false;
        delete current.dispatchReceipts[id];
        removed.add(id);
        return true;
      };
      for (const entry of ended) remove(entry);
      if (targets) return;
      let excess = Object.keys(current.dispatchReceipts).length - limit;
      if (excess <= 0) return;
      const oldest = [...inactive].sort(([, a], [, b]) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
      for (const entry of oldest) {
        if (remove(entry) && --excess === 0) break;
      }
    });
  }
  for (const row of locals) {
    const receipt = scope.dispatchReceipts[row.id];
    if (receipt && !receipt.remote && receipt.projectId === row.projectId && !removed.has(row.id)) row.assignment = receipt.location;
  }
  return [...locals, ...remotes.flat().filter(row => !removed.has(row.id))];
}

async function readWorkers(sdk: HostSdk, host: { id: string; label: string }, entries: [string, DispatchReceipt][],
  read: BoundedRead, ended: ReceiptEntries, inactive: ReceiptEntries) {
  const workspaces = new Map<string, ReturnType<ReturnType<HostSdk["workspaces"]["ref"]>["refresh"]>>();
  const rows = await Promise.all(entries.map(async ([id, receipt]) => {
    try {
      const result = await read(() => sdk.agents.ref(id).refresh());
      const agent = result?.agent;
      if (receipt.delivered && (!result || (agent?.id === id && agent.archivedAt))) ended.set(id, receipt);
      if (!agent || agent.id !== id || agent.internal || agent.archivedAt || agent.workspaceId !== receipt.workspaceId ||
          agent.metadata?.[assignmentReceiptKey] !== receipt.fingerprint) return;
      if (receipt.delivered && (agent.status === "idle" || agent.status === "closed") && !agent.activeTurn &&
          !agent.backgroundWork?.count && !agent.pendingPermissions.length && agent.attentionReason !== "permission") {
        inactive.set(id, receipt);
      }
      let workspaceRead = workspaces.get(receipt.workspaceId);
      if (!workspaceRead) {
        workspaceRead = read(() => sdk.workspaces.ref(receipt.workspaceId).refresh());
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
