import { join } from "node:path";
import type { SessionRow } from "../shared/contract";
import { displayLane } from "../shared/decision-count";
import { applyConversationEvidence, excerpt, type Evidence } from "./conversation";
import { discoverSessions, sessionRow } from "./discovery";
import { assignmentReceiptKey } from "./dispatch";
import { registeredAssignmentHosts, type HostSdk } from "./host-assignment";
import { NoteStore } from "./notes";
import { maxDispatchReceipts, pruneDispatchTombstones, retireDispatchReceipt, type DispatchReceipt, type PreferenceStore } from "./preferences";
import { decorateDecision, pendingDecisionSessions, restoreClarifiedDecision } from "./session-decisions";

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
type RetirementCandidate = { receipt: DispatchReceipt; remote?: { row: SessionRow; evidence: Evidence } };
type DiscoveryOptions = { timeoutMs?: number; reserveSlot?: boolean };

export async function discoverBoardSessions(paseo: HostSdk, prefs: PreferenceStore, targets?: ReadonlySet<string>,
  { timeoutMs = remoteTimeoutMs, reserveSlot = false }: DiscoveryOptions = {}): Promise<SessionRow[]> {
  const scope = prefs.readDispatchScope();
  const locals = await discoverSessions(paseo);
  const localById = new Map(locals.map(row => [row.id, row]));
  const receipts = Object.entries(scope.dispatchReceipts);
  const ended: ReceiptEntries = new Map();
  const limit = maxDispatchReceipts - Number(reserveSlot);
  const inactive = !targets && receipts.length > limit ? new Map<string, RetirementCandidate>() : undefined;
  for (const [id, receipt] of receipts) {
    if (receipt.remote || !receipt.delivered) continue;
    const row = localById.get(id);
    if (!row) ended.set(id, receipt);
    else if (row.projectId === receipt.projectId && (row.status === "idle" || row.status === "closed") &&
        row.lane !== "running" && !row.nativePending) inactive?.set(id, { receipt });
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
  if (ended.size || inactive?.size) {
    prefs.change(current => {
      const remove = (id: string, observed: DispatchReceipt) => {
        const saved = current.dispatchReceipts[id];
        if (!saved?.delivered || saved.fingerprint !== observed.fingerprint || saved.createdAt !== observed.createdAt) return false;
        retireDispatchReceipt(current, id);
        removed.add(id);
        return true;
      };
      for (const [id, receipt] of ended) remove(id, receipt);
      let excess = Object.keys(current.dispatchReceipts).length - limit;
      if (excess > 0 && inactive?.size) {
        const oldest = [...inactive].sort(([, a], [, b]) => (a.receipt.createdAt ?? "").localeCompare(b.receipt.createdAt ?? ""));
        const pending = pendingDecisionSessions(current);
        const notes = new NoteStore(join(prefs.directory, "notes.json")).visible(new Set(inactive.keys()));
        for (const [id, { receipt, remote }] of oldest) {
          if (remote) {
            const row = { ...remote.row };
            const note = notes[id];
            applyConversationEvidence(remote.evidence, row, current);
            decorateDecision(row, note, current, remote.evidence);
            restoreClarifiedDecision(row, note, current, remote.evidence);
            if (pending.has(id) || displayLane(row, note) === "human") continue;
          }
          if (remove(id, receipt) && --excess === 0) break;
        }
      }
      pruneDispatchTombstones(current);
    });
  }
  for (const row of locals) {
    const receipt = scope.dispatchReceipts[row.id];
    if (receipt && !receipt.remote && receipt.projectId === row.projectId && !removed.has(row.id)) row.assignment = receipt.location;
  }
  return [...locals, ...remotes.flat().filter(row => !removed.has(row.id))];
}

async function readWorkers(sdk: HostSdk, host: { id: string; label: string }, entries: [string, DispatchReceipt][],
  read: BoundedRead, ended: ReceiptEntries, inactive?: Map<string, RetirementCandidate>) {
  const workspaces = new Map<string, ReturnType<ReturnType<HostSdk["workspaces"]["ref"]>["refresh"]>>();
  const rows = await Promise.all(entries.map(async ([id, receipt]) => {
    try {
      const result = await read(() => sdk.agents.ref(id).refresh());
      const agent = result?.agent;
      if (receipt.delivered && (!result || (agent?.id === id && agent.archivedAt))) ended.set(id, receipt);
      if (!agent || agent.id !== id || agent.internal || agent.archivedAt || agent.workspaceId !== receipt.workspaceId ||
          agent.metadata?.[assignmentReceiptKey] !== receipt.fingerprint) return;
      let workspaceRead = workspaces.get(receipt.workspaceId);
      if (!workspaceRead) {
        workspaceRead = read(() => sdk.workspaces.ref(receipt.workspaceId).refresh());
        workspaces.set(receipt.workspaceId, workspaceRead);
      }
      const workspace = await workspaceRead;
      if (!workspace || workspace.internal || workspace.archivingAt || workspace.projectId !== receipt.sourceProjectId) return;
      // Remote cards use the provider title because they do not open the local request form.
      const source = sessionRow(agent, result.project, workspace, { includeToolTitles: true });
      const row = { ...source, sourceProjectId: source.projectId, sourceProjectTitle: source.projectTitle, projectId: receipt.projectId,
        serverId: host.id, assignment: { ...receipt.location, label: host.label } };
      if (inactive && receipt.delivered && (agent.status === "idle" || agent.status === "closed") && !agent.activeTurn &&
          !agent.backgroundWork?.count && row.lane !== "human") {
        // Missing evidence cannot establish that the session has no open question.
        const evidence = await read(() => sdk.agents.ref(id).timeline.refetch({
          direction: "tail", projection: "projected", limit: 48,
        })).then(excerpt).catch(() => null);
        if (evidence) inactive.set(id, { receipt, remote: { row, evidence } });
      }
      return row;
    } catch {
      // A failed lookup cannot establish that a worker was deleted or archived.
      return;
    }
  }));
  return rows.filter(row => row !== undefined);
}
