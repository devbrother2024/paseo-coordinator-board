import { createHash } from "node:crypto";
import type { DispatchInput } from "../shared/dispatch";
import { assignmentHost, assignmentReasons, pairedProject, type TaskPlatform } from "../shared/host-assignment";
import {
  countActiveSessions, PlacementError, readHostInventory, registeredAssignmentHosts, withAssignmentHost, type HostSdk,
} from "./host-assignment";
import { creationUuid, dispatchWorker, sendRemoteAssignment } from "./dispatch";
import type { Preferences, PreferenceStore } from "./preferences";

type PlacementRequest = { platform?: TaskPlatform; host?: string; expectedHostId?: string };
type Receipt = Preferences["dispatchReceipts"][string];

export async function planWorkerPlacement(paseo: HostSdk, scope: Preferences, projectId: string, request: PlacementRequest) {
  if (!scope.projects.includes(projectId)) throw new Error("이 호스트에서 관리할 프로젝트를 먼저 선택해 주세요.");
  const registered = await registeredAssignmentHosts(paseo, scope);
  if (!registered.length) {
    if (request.host || request.expectedHostId) throw new PlacementError("host-unknown");
    if (request.platform && request.platform !== "any") throw new PlacementError("platform-offline");
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
    originServerId: local.id,
    sourceProjectId: host.projectId!,
    location: { serverId: host.id, label: host.label, reason, running: host.running! },
    explanation: assignmentReasons[reason].join(" / "),
    workspaces: host.spaces.map(w => ({ id: w.id, projectId, title: w.title?.trim() || w.name })),
  };
}

function dispatchScope(scope: Preferences, coordinator: string) {
  return { projects: scope.projects, routing: scope.routing, coordinator, excludedProviders: scope.excludedProviders,
    usageRouting: scope.usageRouting, workerModeOverrides: scope.workerModeOverrides };
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
    const initial = ownerScope();
    if (!initial.projects.includes(job.projectId)) throw new Error("이 호스트에서 관리할 프로젝트를 먼저 선택해 주세요.");
    const sessionId = creationUuid(job.requestKey, "agent");
    const fingerprint = createHash("sha256").update(JSON.stringify({ ...job, platform: job.platform ?? "any" })).digest("hex");
    const previous = initial.dispatchReceipts[sessionId];
    const scope = () => dispatchScope(ownerScope(), coordinator);
    const checkScope = (current: Preferences) => {
      if (current.coordinator !== coordinator || !current.projects.includes(job.projectId) ||
          current.assignmentRevision !== initial.assignmentRevision || current.routingRevision !== initial.routingRevision)
        throw new PlacementError("placement-changed");
    };
    if (previous && previous.fingerprint !== fingerprint) throw new Error("이미 다른 작업에 사용한 요청입니다. 새 작업으로 시작해 주세요.");

    let receipt: Receipt;
    let originServerId: string;
    let limit: number | null;
    if (previous) {
      const [local, ...registered] = await registeredAssignmentHosts(paseo, initial);
      const destination = previous.remote ? registered.find(host => host.id === previous.location.serverId) : local;
      if (!local || !destination?.online || !destination.enabled) throw new PlacementError("host-offline");
      const paired = destination.policy.pairs[job.projectId];
      if (!previous.delivered && paired && paired !== previous.sourceProjectId) throw new PlacementError("placement-changed");
      receipt = previous;
      originServerId = local.id;
      limit = destination.limit;
    } else {
      // Keep the original local interface for older callers. Its workspace id
      // belongs to this daemon. Multi-host callers select a project and pin the plan's host.
      if (!job.expectedHostId && !job.host && !job.platform) return dispatchWorker(paseo, job, scope);
      const planned = await planWorkerPlacement(paseo, initial, job.projectId, job);
      if (!planned) return dispatchWorker(paseo, job, scope);
      if (!planned.workspaces.some(workspace => workspace.id === job.workspaceId)) throw new PlacementError("placement-changed");
      if (planned.serverId && (await paseo.agents.ref(sessionId).refresh())?.agent) {
        throw new Error("이미 다른 작업에 사용한 요청입니다. 새 작업으로 시작해 주세요.");
      }
      receipt = { fingerprint, projectId: job.projectId, sourceProjectId: planned.sourceProjectId, workspaceId: job.workspaceId,
        remote: !!planned.serverId, location: planned.location };
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
              this.store.change(current => { current.dispatchReceipts[sessionId].delivered = true; });
            },
          }),
          beforeCreate: async () => {
            const agent = (await sdk.agents.ref(sessionId).refresh())?.agent;
            if (!agent && limit !== null && await countActiveSessions(sdk) >= limit) throw new PlacementError("at-capacity");
            this.store.change(current => {
              checkScope(current);
              const reserved = current.dispatchReceipts[sessionId];
              if (reserved && (reserved.fingerprint !== fingerprint || reserved.location.serverId !== receipt.location.serverId))
                throw new PlacementError("placement-changed");
              if (!reserved) current.dispatchReceipts[sessionId] = receipt;
            });
          },
        });
      });
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
}
