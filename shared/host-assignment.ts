import { z } from "zod";

export const hostPlatform = z.enum(["mac", "windows", "linux"]);
export const taskPlatform = z.enum(["any", ...hostPlatform.options]);
export const hostName = z.string().trim().min(1).max(256);
export const placementFields = { platform: taskPlatform.optional(), host: hostName.optional() };
export const hostIdentity = z.string().min(1).max(256).refine(id => !["__proto__", "constructor", "prototype"].includes(id));
export const pairedProjectId = z.string().min(1).max(4096).refine(id => !["__proto__", "constructor", "prototype"].includes(id));
export const hostSessionLimit = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
export const assignmentPolicy = z.object({
  platform: hostPlatform.nullable(),
  enabled: z.boolean(),
  limit: hostSessionLimit.nullable(),
  pairs: z.record(pairedProjectId, pairedProjectId),
});
export const defaultAssignmentPolicy = { platform: null, enabled: true, limit: null, pairs: {} } satisfies z.infer<typeof assignmentPolicy>;
export type HostPlatform = z.output<typeof hostPlatform>;
export type TaskPlatform = z.output<typeof taskPlatform>;

export const assignmentReason = z.enum(["explicit-host", "platform", "least-busy", "board-tie", "only-host", "previewed-host"]);
export const assignmentFailure = z.enum([
  "host-unknown", "host-offline", "platform-offline", "project-unavailable", "at-capacity", "load-unavailable", "placement-changed",
  "receipt-capacity", "receipt-check-unavailable",
]);
export type AssignmentReason = z.output<typeof assignmentReason>;
export type AssignmentFailure = z.output<typeof assignmentFailure>;

export const platformLabels: Record<TaskPlatform, [string, string]> = {
  any: ["운영체제 무관", "Any operating system"],
  mac: ["macOS", "macOS"],
  windows: ["Windows", "Windows"],
  linux: ["Linux", "Linux"],
};
export const assignmentFailures: Record<AssignmentFailure, [string, string]> = {
  "host-unknown": ["이름이 일치하는 배정 호스트를 하나로 확인할 수 없습니다.", "Could not identify a single assignment host by that name."],
  "host-offline": ["지정한 호스트가 연결되지 않았거나 배정이 꺼져 있습니다.", "The selected host is offline or disabled for assignments."],
  "platform-offline": ["이 운영체제로 배정할 수 있는 호스트가 연결되지 않았습니다.", "No connected assignment host matches the requested operating system."],
  "project-unavailable": ["대상 호스트에서 이 프로젝트의 작업 가능한 워크스페이스를 찾지 못했습니다.", "No eligible workspace for this project was found on the destination hosts."],
  "at-capacity": ["대상 호스트의 동시 세션 상한에 도달했습니다.", "The eligible hosts have reached their concurrent session limits."],
  "load-unavailable": ["대상 호스트의 진행 중 세션 수를 확인하지 못했습니다.", "Could not check the active session count on the eligible hosts."],
  "placement-changed": ["호스트 또는 워크스페이스 배정이 바뀌었습니다. 미리보기를 다시 확인해 주세요.", "The host or workspace selection changed. Preview the assignment again."],
  "receipt-capacity": ["보드가 배정 기록 한도에 도달했습니다. 지시 전달이 확인된 세션은 작업을 마친 뒤 보관해 자리를 비울 수 있습니다. 전달이 확인되지 않은 기록은 생성 30일 뒤 자동으로 정리됩니다.", "The board has reached its assignment record limit. Archiving a completed session with confirmed delivery frees a slot. Unconfirmed records expire 30 days after creation."],
  "receipt-check-unavailable": ["다른 호스트에 같은 요청으로 만든 세션이 있는지 확인하지 못했습니다. 호스트 연결을 확인한 뒤 다시 시도해 주세요.", "Could not check other hosts for a session created by this request. Check the host connections and try again."],
};
export const assignmentReasons: Record<AssignmentReason, [string, string]> = {
  "explicit-host": ["지정한 호스트", "Requested host"],
  platform: ["필요한 운영체제", "Required operating system"],
  "least-busy": ["진행 중인 세션이 가장 적음", "Fewest active sessions"],
  "board-tie": ["진행 중인 세션 수가 같아 현재 보드에 배정", "Equal load, preferred the board host"],
  "only-host": ["배정 가능한 호스트", "Only eligible host"],
  "previewed-host": ["미리보기에서 고른 호스트", "Host selected in the preview"],
};

const windowsAbsolute = /^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+)/i;
export function workspacePathIsAbsolute(path: string) {
  return !path.includes("\0") && (windowsAbsolute.test(path) || /^\/(?!\/)/.test(path));
}

const platforms = new Map<string, HostPlatform>([
  ["mac", "mac"], ["macos", "mac"], ["darwin", "mac"],
  ["windows", "windows"], ["win32", "windows"], ["linux", "linux"],
]);

export function inferHostPlatform(metadata: Record<string, string>, paths: string[]): HostPlatform | null {
  const declared = platforms.get((metadata.platform ?? metadata.os)?.trim().toLowerCase());
  if (declared) return declared;
  const guesses = new Set<HostPlatform>();
  for (const path of paths) {
    if (windowsAbsolute.test(path)) guesses.add("windows");
    else if (/^\/(?:Users|Volumes|Applications|private\/var\/folders)\//.test(path)) guesses.add("mac");
    else if (/^\/(?:home|root)(?:\/|$)/.test(path)) guesses.add("linux");
  }
  return guesses.size === 1 ? [...guesses][0] : null;
}

export type HostProject = { id: string; name: string; repos: string[] };
export function pairedProject(source: HostProject, projects: HostProject[], pinned?: string) {
  if (pinned !== undefined) return projects.find(project => project.id === pinned) ?? null;
  const repositoryMatches = projects.filter(project =>
    source.repos.length === 1 && project.repos.length === 1 && project.repos[0] === source.repos[0]);
  if (repositoryMatches.length) return repositoryMatches.length === 1 ? repositoryMatches[0] : null;
  const name = source.name.trim().toLowerCase();
  if (!name) return null;
  const names = projects.filter(project => project.name.trim().toLowerCase() === name && (!source.repos.length || !project.repos.length));
  return names.length === 1 ? names[0] : null;
}

export type AssignmentHost = {
  id: string; label: string; local: boolean; online: boolean; enabled: boolean;
  platform: HostPlatform | null; running: number | null; limit: number | null; workspaces: readonly string[];
};

export function assignmentHost<T extends AssignmentHost>(hosts: T[],
  { platform, host, expectedHostId }: { platform: TaskPlatform; host?: string; expectedHostId?: string },
): { host: T; reason: AssignmentReason } | { failure: AssignmentFailure } {
  let candidates = hosts;
  if (host) {
    const name = host.trim();
    const exact = candidates.filter(row => row.label.trim() === name);
    candidates = exact.length ? exact : candidates.filter(row => row.label.trim().toLowerCase() === name.toLowerCase());
    if (candidates.length !== 1) return { failure: "host-unknown" };
  }
  if (expectedHostId) {
    candidates = candidates.filter(row => row.id === expectedHostId);
    if (!candidates.length) return { failure: "host-unknown" };
  }
  const online = candidates.filter(row => row.online && row.enabled && (platform === "any" || row.platform === platform));
  if (!online.length) {
    const platformMismatch = platform !== "any" && (!host && !expectedHostId || candidates.some(row => row.online && row.enabled));
    return { failure: platformMismatch ? "platform-offline" : "host-offline" };
  }
  const available = online.filter(row => row.workspaces.length > 0);
  if (!available.length) return { failure: "project-unavailable" };
  const [only] = available;
  if (available.length === 1 && only.local && only.running === null && only.limit === null) {
    return { host: only, reason: host ? "explicit-host" : platform !== "any" ? "platform" : "only-host" };
  }
  const measured = available.filter(row => row.running !== null);
  if (!measured.length) return { failure: "load-unavailable" };
  const eligible = measured.filter(row => row.limit === null || row.running! < row.limit);
  if (!eligible.length) return { failure: "at-capacity" };
  eligible.sort((a, b) => a.running! - b.running! || Number(b.local) - Number(a.local) || a.id.localeCompare(b.id));
  const selected = eligible[0];
  const reason = host ? "explicit-host" : platform !== "any" ? "platform" : eligible.length === 1 ? "only-host"
    : selected.local && selected.running === eligible[1].running ? "board-tie" : "least-busy";
  return { host: selected, reason };
}
