import { createHash } from "node:crypto";
import type { DispatchInput } from "../shared/dispatch";
import { assignmentHost, assignmentReasons, inferHostPlatform, pairedProject, type TaskPlatform } from "../shared/host-assignment";
import { discoverBoardSessions, withRemoteReadHost } from "./board-sessions";
import {
  countActiveSessions, PlacementError, readHostInventory, registeredAssignmentHosts, withAssignmentHost, type HostSdk,
} from "./host-assignment";
import { creationUuid, dispatchWorker, sendRemoteAssignment } from "./dispatch";
import { maxDispatchReceipts, pruneDispatchReceipts, type DispatchReceipt, type Preferences, type PreferenceStore } from "./preferences";

type PlacementRequest = { platform?: TaskPlatform; host?: string; expectedHostId?: string };
type RegisteredHosts = Awaited<ReturnType<typeof registeredAssignmentHosts>>;
const projectRequired = "이 호스트에서 관리할 프로젝트를 먼저 선택해 주세요. / Select a project managed by this board first.";
const keyConflict = "이미 다른 작업에 사용한 요청입니다. 새 작업으로 시작해 주세요. / This request key belongs to a different task. Start a new request.";

function localServerId(paseo: HostSdk, coordinator: string | null) {
  try { return coordinator ? paseo.agents.ref(coordinator).address.serverId : undefined; }
  catch { return undefined; }
}

function localPolicy(scope: Preferences, id: string | undefined) {
  return id && Object.hasOwn(scope.assignmentHosts, id) ? scope.assignmentHosts[id] : undefined;
}

export async function planWorkerPlacement(paseo: HostSdk, scope: Preferences, projectId: string, request: PlacementRequest,
  registered?: RegisteredHosts) {
  if (!scope.projects.includes(projectId)) throw new Error(projectRequired);
  registered ??= await registeredAssignmentHosts(paseo, scope);
  if (!registered.length) {
    const id = localServerId(paseo, scope.coordinator);
    if (request.host || (request.expectedHostId && request.expectedHostId !== id)) throw new PlacementError("host-unknown");
    const policy = localPolicy(scope, id);
    if (policy?.enabled === false) throw new PlacementError("host-offline");
    const platform = policy?.platform ?? inferHostPlatform({ platform: process.platform }, []);
    if (request.platform && request.platform !== "any" && request.platform !== platform) throw new PlacementError("platform-offline");
    if (policy?.limit != null) {
      const load = await countActiveSessions(paseo).catch(() => { throw new PlacementError("load-unavailable"); });
      if (load >= policy.limit) throw new PlacementError("at-capacity");
    }
    return null;
  }
  const [local] = registered;
  const inventories = await Promise.all(registered.map(host => readHostInventory(paseo, host, scope, true)));
  const source = inventories[0].projects.find(project => project.id === projectId);
  const candidates = registered.map((host, index) => {
    const inventory = inventories[index];
    const pinned = Object.hasOwn(host.policy.pairs, projectId) ? host.policy.pairs[projectId] : undefined;
    const project = host.local ? source : source && pairedProject(source, inventory.projects, pinned);
    const spaces = inventory.available.filter(w => w.projectId === project?.id);
    return { ...host, platform: inventory.platform, running: inventory.running, workspaces: spaces.map(w => w.id),
      spaces, projectId: project?.id };
  });
  const byPreference = assignmentHost(candidates, { platform: request.platform ?? "any", host: request.host });
  const picked = request.expectedHostId
    ? assignmentHost(candidates, { ...request, platform: request.platform ?? "any" })
    : byPreference;
  if ("failure" in picked) throw new PlacementError(picked.failure);
  const { host } = picked;
  const reason = "host" in byPreference && byPreference.host.id === host.id ? byPreference.reason : "previewed-host";
  return {
    serverId: host.local ? undefined : host.id,
    localOnly: host.local && registered.length === 1,
    originServerId: local.id,
    sourceProjectId: host.projectId!,
    location: { serverId: host.id, label: host.label, reason, running: host.running },
    explanation: assignmentReasons[reason].join(" / "),
    workspaces: host.spaces.map(w => ({ id: w.id, projectId, title: w.title?.trim() || w.name })),
  };
}

function dispatchScope(scope: Preferences, coordinator: string) {
  return { projects: scope.projects, routing: scope.routing, coordinator, excludedProviders: scope.excludedProviders,
    usageRouting: scope.usageRouting, workerModeOverrides: scope.workerModeOverrides };
}

async function verifyOtherHosts(paseo: HostSdk, registered: RegisteredHosts, destinationId: string | undefined, sessionId: string) {
  const peers = registered.filter(host => host.online && (destinationId ? host.id !== destinationId : !host.local));
  if (!peers.length) return;
  const results = await Promise.allSettled(peers.map(async host => host.local
    ? paseo.agents.ref(sessionId).refresh()
    : withRemoteReadHost(paseo, host.id, (sdk, read) => read(() => sdk.agents.ref(sessionId).refresh()))));
  if (results.some(result => result.status === "fulfilled" && result.value?.agent)) throw new Error(keyConflict);
  if (results.some(result => result.status === "rejected")) throw new PlacementError("receipt-check-unavailable");
}

export class WorkerAssignment {
  private queue = Promise.resolve();
  constructor(private readonly store: PreferenceStore, private readonly invalidate: () => void) {}

  plan(paseo: HostSdk, scope: Preferences, projectId: string, request: PlacementRequest) {
    return this.recordFailure(projectId, request, () => planWorkerPlacement(paseo, scope, projectId, request));
  }

  assign(paseo: HostSdk, job: DispatchInput, coordinator: string, ownerScope: () => Preferences) {
    // A fresh load measurement and the creation occupy the same queue. A second
    // board request sees the first session even when the destination has a limit of one.
    const next = this.queue.then(() => this.recordFailure(job.projectId, job,
      () => this.create(paseo, job, coordinator, ownerScope)));
    this.queue = next.then(() => {}, () => {});
    return next;
  }

  private async recordFailure<T>(projectId: string, request: PlacementRequest, run: () => Promise<T>) {
    try { return await run(); }
    catch (error) {
      if (error instanceof PlacementError) {
        this.store.change(scope => {
          if (scope.projects.includes(projectId)) scope.assignmentNotice = {
            projectId, platform: request.platform ?? "any", failure: error.failure, ...(request.host && { host: request.host }),
          };
        });
        this.invalidate();
      }
      throw error;
    }
  }

  private async create(paseo: HostSdk, job: DispatchInput, coordinator: string, ownerScope: () => Preferences) {
    ownerScope();
    const initial = this.store.readDispatchScope();
    if (!initial.projects.includes(job.projectId)) throw new Error(projectRequired);
    const sessionId = creationUuid(job.requestKey, "agent");
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...job, platform: job.platform ?? "any" })).digest("hex");
    const previous = initial.dispatchReceipts[sessionId];
    const retired = !previous ? initial.dispatchTombstones[sessionId] : undefined;
    const scope = () => dispatchScope(ownerScope(), coordinator);
    const checkScope = (current: Preferences) => {
      if (current.coordinator !== coordinator || !current.projects.includes(job.projectId) ||
          current.assignmentRevision !== initial.assignmentRevision || current.routingRevision !== initial.routingRevision)
        throw new PlacementError("placement-changed");
    };
    if ((previous && previous.fingerprint !== fingerprint) || (retired &&
        ((retired.requestKey && retired.requestKey !== job.requestKey) ||
          (job.expectedHostId && job.expectedHostId !== retired.serverId)))) throw new Error(keyConflict);
    const registered = await registeredAssignmentHosts(paseo, initial);
    const localTarget = {
      projectId: job.projectId,
      beforeCreate: async () => {
        await verifyOtherHosts(paseo, registered, undefined, sessionId);
        checkScope(ownerScope());
      },
    };

    let receipt: DispatchReceipt;
    let originServerId: string;
    let limit: number | null;
    let retain = true;
    if (previous) {
      const [local, ...remotes] = registered;
      const destination = previous.remote ? remotes.find(host => host.id === previous.location.serverId) : local;
      if (!local || !destination?.online || !destination.enabled) throw new PlacementError("host-offline");
      const paired = destination.policy.pairs[job.projectId];
      if (!previous.delivered && paired && paired !== previous.sourceProjectId) throw new PlacementError("placement-changed");
      receipt = previous;
      originServerId = local.id;
      limit = destination.limit;
    } else {
      // Keep the original local interface for older callers. Its workspace id
      // belongs to this daemon. Multi-host callers select a project and pin the plan's host.
      if (!retired && !job.expectedHostId && !job.host && !job.platform) return dispatchWorker(paseo, job, scope, localTarget);
      if (retired && retired.serverId !== localServerId(paseo, coordinator) &&
          !registered.some(host => host.id === retired.serverId && host.online && host.enabled)) {
        throw new PlacementError("host-offline");
      }
      const request = retired ? { ...job, expectedHostId: retired.serverId } : job;
      const planned = await planWorkerPlacement(paseo, initial, job.projectId, request, registered);
      if (!planned) return dispatchWorker(paseo, job, scope, localTarget);
      if (!planned.workspaces.some(workspace => workspace.id === job.workspaceId)) throw new PlacementError("placement-changed");
      retain = !planned.localOnly;
      receipt = { fingerprint, projectId: job.projectId, sourceProjectId: planned.sourceProjectId, workspaceId: job.workspaceId,
        remote: !!planned.serverId, location: planned.location, createdAt: new Date().toISOString(), requestKey: job.requestKey,
        routeSource: job.routeSource ?? "board" };
      originServerId = planned.originServerId;
      limit = initial.assignmentHosts[planned.location.serverId]?.limit ?? null;
    }

    try {
      const result = await withAssignmentHost(paseo, receipt.remote ? receipt.location.serverId : undefined, async sdk => {
        return dispatchWorker(sdk, job, scope, {
          projectId: receipt.sourceProjectId,
          ...(receipt.remote && {
            parentServerId: originServerId,
            receiptFingerprint: receipt.fingerprint,
            deliver: async (_worker, parent, id, text) => {
              if (this.store.read().dispatchReceipts[sessionId]?.delivered) return;
              if (parent !== coordinator) throw new PlacementError("placement-changed");
              await sendRemoteAssignment(sdk, sessionId, parent, originServerId, id, text, () => checkScope(ownerScope()));
              this.markDelivered(sessionId, fingerprint);
            },
          }),
          beforeCreate: async () => {
            if (!previous) await verifyOtherHosts(paseo, registered, receipt.location.serverId, sessionId);
            if (limit !== null && !(await sdk.agents.ref(sessionId).refresh())?.agent) {
              const running = await countActiveSessions(sdk).catch(() => { throw new PlacementError("load-unavailable"); });
              if (running >= limit) throw new PlacementError("at-capacity");
            }
            if (!retain) { checkScope(ownerScope()); return; }
            const current = ownerScope();
            checkScope(current);
            if (!current.dispatchReceipts[sessionId] && Object.keys(current.dispatchReceipts).length >= maxDispatchReceipts) {
              await discoverBoardSessions(paseo, this.store, undefined, { reserveSlot: true });
            }
            this.store.change(current => {
              checkScope(current);
              pruneDispatchReceipts(current);
              const reserved = current.dispatchReceipts[sessionId];
              if (reserved && (reserved.fingerprint !== fingerprint || reserved.location.serverId !== receipt.location.serverId))
                throw new PlacementError("placement-changed");
              if (!reserved) {
                if (Object.keys(current.dispatchReceipts).length >= maxDispatchReceipts) throw new PlacementError("receipt-capacity");
                current.dispatchReceipts[sessionId] = receipt;
                delete current.dispatchTombstones[sessionId];
              }
            });
          },
        });
      });
      if (retain && !receipt.remote) this.markDelivered(sessionId, fingerprint);
      if (this.store.read().assignmentNotice?.projectId === job.projectId) this.store.change(current => {
        if (current.assignmentNotice?.projectId === job.projectId) delete current.assignmentNotice;
      });
      this.invalidate();
      return { ...result, location: receipt.location };
    } catch (error) {
      if (["host_offline", "host_disabled", "host_unknown"].includes((error as { code?: string }).code ?? "")) throw new PlacementError("host-offline");
      throw error;
    }
  }

  private markDelivered(sessionId: string, fingerprint: string) {
    const receipt = this.store.read().dispatchReceipts[sessionId];
    if (!receipt || receipt.delivered || receipt.fingerprint !== fingerprint) return;
    this.store.change(scope => { scope.dispatchReceipts[sessionId].delivered = true; });
  }
}
