import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { discoverBoardSessions } from "../server/board-sessions";
import { ClarificationSender } from "../server/clarifications";
import { ConversationReader } from "../server/conversation";
import { DecisionSender, decorateDecision } from "../server/decisions";
import { creationUuid } from "../server/dispatch";
import { NoteStore } from "../server/notes";
import { createOperations } from "../server/operations";
import { maxDispatchTombstones, PreferenceStore } from "../server/preferences";
import { isCurrentMembership } from "../server/session-links";
import { dispatchHosts, saveDispatchHost } from "../shared/dispatch-hosts";
import { requestWork } from "../shared/operations";
import type { DispatchInput } from "../shared/dispatch";
import { sessionClarificationCard } from "../shared/clarifications";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
const page = <T,>(entries: T[]) => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });
const expectedRoute = { provider: "codex", model: "gpt-5.4", effort: "high" };
const coordinator = "board-owner";
const projectId = "alpha-mac";
const winProjectId = "alpha-win";
const local = { serverId: "mac-host", label: "Mac" };
const remote = { serverId: "win-host", label: "Windows", status: "online", enabled: true, metadata: {}, registrationId: "host-registration" };
const modeId = "auto-review";
const unsupportedSteer = "Update the Paseo host to steer a running turn from an agent. Leave the behavior out to queue the message, or use interrupt.";

type Agent = {
  id: string; workspaceId: string; title: string; status: string; pendingPermissions: { id: string; title: string; kind?: "tool" }[];
  updatedAt: string; currentModeId?: string; metadata?: Record<string, unknown>; archivedAt?: string;
};
type Create = { agentId: string; config: { provider: string; modeId?: string }; title: string;
  idempotencyKey: string; parent: unknown; prompt?: string; metadata: Record<string, unknown> };
type Send = { sourceAgentId?: string; sourceAgentServerId?: string; messageId: string; activeTurnBehavior?: "steer" | "interrupt" };
type TimelineItem =
  | { type: "tool_call"; callId: string; name: string; status: string; agentMessage: { event: "message"; sender: { id: string }; text: string } }
  | { type: "assistant_message" | "user_message"; text: string; messageId?: string };

function daemon(projectId: string, path: string, remoteUrl: string) {
  const projects = [{ projectId, projectRootPath: path, projectDisplayName: projectId }];
  const workspace = { id: projectId + "-space", projectId, name: "Main work", workspaceDirectory: path, gitRuntime: { remoteUrl } };
  const agentProject = { projectKey: projectId, projectName: projectId, workspaceName: workspace.name };
  const agents = new Map<string, Agent>();
  const creates = new Map<string, Create>();
  const sends: { id: string; text: string; options: Send }[] = [];
  const sendAttempts: Send[] = [];
  const timelines = new Map<string, TimelineItem[]>();
  const state = { loseNextSendAck: false, permissionsOnCreate: false, disposals: 0,
    failLoad: false, failRef: false, workingReads: 0, mostReads: 0, readIds: [] as string[],
    pauseReads: new Map<string, Promise<void>>(), agentSteerUnsupported: false,
    rejectNextSend: undefined as ((agent: Agent) => Error) | undefined };
  function add(id: string, status = "idle", more: Partial<Agent> = {}) {
    const agent = { id, workspaceId: workspace.id, title: id, status, pendingPermissions: [], updatedAt: "2026-01-01T00:00:00Z", ...more };
    agents.set(id, agent);
    return agent;
  }
  const sdk = {
    projects: { list: async () => ({ projects }) },
    workspaces: {
      list: async () => page([workspace]),
      ref: (id: string) => ({ refresh: async () => id === workspace.id ? workspace : null, agents: { create: async (input: Create) => {
        expect(id).toBe(workspace.id);
        const previous = creates.get(input.agentId);
        if (previous) expect(input).toEqual(previous);
        else {
          creates.set(input.agentId, input);
          add(input.agentId, "idle", { title: input.title, metadata: input.metadata, currentModeId: input.config.modeId,
            pendingPermissions: state.permissionsOnCreate ? [{ id: "allow-fs", kind: "tool", title: "Confirm file access" }] : [] });
        }
        return { id: input.agentId, workspaceId: id };
      } } }),
    },
    agents: {
      list: async ({ filter }: { filter?: { statuses?: string[] } } = {}) => {
        if (state.failLoad && filter?.statuses) throw Error("Load unavailable");
        return page([...agents.values()].filter(agent => !filter?.statuses || filter.statuses.includes(agent.status))
          .map(agent => ({ agent, project: agentProject })));
      },
      ref: (id: string) => ({
        refresh: async () => {
          state.readIds.push(id);
          state.workingReads++;
          state.mostReads = Math.max(state.workingReads, state.mostReads);
          try {
            await new Promise(resolve => setTimeout(resolve, 0));
            await state.pauseReads.get(id);
            if (state.failRef) throw Error("Agent lookup unavailable");
            return agents.has(id) ? { agent: agents.get(id), project: agentProject } : null;
          } finally { state.workingReads--; }
        },
        timeline: { refetch: async () => ({
          epoch: "fixture", entries: (timelines.get(id) ?? []).map((item, seqEnd) => ({ item, seqEnd })),
        }) },
        send: async (text: string, options: Send) => {
          sendAttempts.push(options);
          if (state.agentSteerUnsupported && options.sourceAgentId && options.activeTurnBehavior === "steer") throw Error(unsupportedSteer);
          if (state.rejectNextSend) {
            const reject = state.rejectNextSend;
            state.rejectNextSend = undefined;
            throw reject(agents.get(id)!);
          }
          sends.push({ id, text, options });
          const item: TimelineItem = options.sourceAgentId
            ? { type: "tool_call", name: "agent_message", status: "completed", callId: "paseo-agent-message:" + options.messageId,
              agentMessage: { event: "message", sender: { id: options.sourceAgentId }, text } }
            : { type: "user_message", text, messageId: options.messageId };
          timelines.set(id, [...timelines.get(id) ?? [], item]);
          if (state.loseNextSendAck) {
            state.loseNextSendAck = false;
            throw new Error("Connection lost after message acceptance");
          }
        },
      }),
    },
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "codex", available: true }] }),
      listModels: async () => ({ models: [{ id: expectedRoute.model, label: "Codex", isDefault: true, thinkingOptions: [{ id: "high" }] }] }),
      listModes: async () => ({ modes: [{ id: modeId, label: "Auto review" }] }),
    },
    dispose: async () => { state.disposals++; },
  };
  return { sdk, workspace, projects, agents, creates, sends, sendAttempts, timelines, state, add };
}

function scenario() {
  const dir = mkdtempSync(join(tmpdir(), "board-host-assignment-"));
  paths.push(dir);
  const store = new PreferenceStore(join(dir, "scope.json"));
  store.change(scope => {
    scope.coordinator = coordinator;
    scope.projects = [projectId];
    scope.usageRouting = false;
    scope.routing.C = [expectedRoute];
    scope.assignmentHosts[local.serverId] = { platform: "mac", enabled: true, limit: null, pairs: {} };
  });
  const mac = daemon(projectId, "/Users/you/projects/alpha", "https://git.example.com/team/alpha.git");
  const win = daemon(winProjectId, "D:\\projects\\alpha", "git@git.example.com:team/alpha.git");
  mac.add(coordinator);
  mac.add("mac-one", "running");
  mac.add("mac-two", "running");
  const registration = { ...remote };
  const registry = { single: false, failed: false };
  const sdk = { ...mac.sdk, agents: { ...mac.sdk.agents, ref: (id: string) => ({
    ...mac.sdk.agents.ref(id), address: { agentId: id, serverId: local.serverId },
  }) }, hosts: {
    list: async () => {
      if (registry.failed) throw Error("Host directory unavailable");
      return { self: local, hosts: registry.single ? [] : [registration] };
    },
    client: async (id: string) => {
      expect(id).toBe(remote.serverId);
      if (registration.status !== "online") throw Object.assign(new Error("Offline"), { code: "host_offline" });
      return win.sdk;
    },
  } } as unknown as PluginHandlerContext["paseo"];
  const operations = createOperations(store, join(dir, "workspaces"));
  const handlers = new Map<string, (input: unknown, context: { paseo: typeof sdk }) => Promise<unknown>>();
  operations.register({
    handle: (contract: { name: string }, handler: (input: unknown, context: { paseo: typeof sdk }) => Promise<unknown>) => handlers.set(contract.name, handler),
  } as unknown as PluginServerContext);
  async function call<T>(contract: { name: string; input: { parse(input: unknown): unknown }; output: { parse(input: unknown): T } }, input: unknown) {
    return contract.output.parse(await handlers.get(contract.name)!(contract.input.parse(input), { paseo: sdk }));
  }
  async function tool(name: string, input: unknown) {
    const tool = operations.tools.find(tool => tool.name === name)!;
    const result = await tool.execute(tool.input.parse(input), { paseo: sdk, agent: { id: coordinator } } as Parameters<typeof tool.execute>[1]);
    return JSON.parse(result.text!);
  }
  const plan = (options = {}) => tool("plan_board_assignment", { projectId, ...options });
  const assign = (job: DispatchInput) => tool("assign_board_worker", { job });
  const job: DispatchInput = { projectId, workspaceId: win.workspace.id, expectedHostId: remote.serverId, expectedRoute,
    expectedModeId: modeId, title: "Check checkout", prompt: "Review the checkout.", grade: "C", requestKey: "example-worker-key", platform: "any" };
  return { dir, sdk, store, mac, win, registration, registry, call, tool, plan, assign, job };
}

test("tools match projects across path and Git URL formats and expose the reason for the selected host", async () => {
  const s = scenario();
  const directory = await s.call(dispatchHosts, { settings: true });
  expect(directory.hosts.find(host => host.id === remote.serverId)).toMatchObject({ detected: "windows", online: true });
  expect((await s.plan()).location).toMatchObject({ serverId: remote.serverId, reason: "least-busy", running: 0 });
  expect((await s.plan({ platform: "windows" })).workspaces).toEqual([{ id: s.win.workspace.id, projectId, title: s.win.workspace.name }]);
  expect((await s.plan({ host: "Mac" })).location).toMatchObject({ serverId: local.serverId, reason: "explicit-host" });
  s.win.add("win-one", "running");
  s.win.add("win-two", "initializing");
  expect((await s.plan()).location).toMatchObject({ serverId: local.serverId, reason: "board-tie", running: 2 });
});

test("settings can pin a project pair, cap a host, and explain unavailable placements without creating an agent", async () => {
  const s = scenario();
  s.win.workspace.gitRuntime.remoteUrl = "https://git.example.com/team/different.git";
  await expect(s.plan({ platform: "windows" })).rejects.toThrow(/워크스페이스/);
  expect(s.store.read().assignmentNotice).toMatchObject({ projectId, failure: "project-unavailable" });
  const settings = { enabled: true, platform: "windows", limit: 1, pairs: { [projectId]: winProjectId } };
  await s.call(saveDispatchHost, { settings, serverId: remote.serverId, expectedRevision: 0 });
  expect((await s.plan({ platform: "windows" })).location.serverId).toBe(remote.serverId);
  s.win.add("another-session", "running");
  await expect(s.plan({ host: "Windows" })).rejects.toThrow(/상한/);
  s.registration.status = "offline";
  await expect(s.assign({ ...s.job, platform: "windows" })).rejects.toThrow(/연결/);
  expect(s.store.read().assignmentNotice?.failure).toBe("host-offline");
  expect(s.mac.creates.size + s.win.creates.size).toBe(0);
});

test("remote assignments keep their location on replay and won't repeat an accepted attributed prompt", async () => {
  const s = scenario();
  s.win.state.loseNextSendAck = true;
  await expect(s.assign(s.job)).rejects.toThrow(/Could not confirm delivery/);
  expect(s.win.sendAttempts).toHaveLength(1);
  const [child] = s.win.creates.keys();
  expect(s.win.creates.get(child)).toMatchObject({ parent: { agentId: coordinator, serverId: local.serverId } });
  expect(s.win.creates.get(child)?.prompt).toBeUndefined();
  expect(s.win.sends).toEqual([{
    id: child, text: s.job.prompt, options: { sourceAgentId: coordinator, sourceAgentServerId: local.serverId,
      messageId: expect.any(String) },
  }]);
  s.win.agents.get(child)!.pendingPermissions = [{ id: "permission-1", title: "Confirm permission" }];
  s.win.add("win-load-one", "running");
  s.win.add("win-load-two", "running");
  s.win.add("win-load-three", "running");
  expect((await s.plan()).location.serverId).toBe(local.serverId);
  const receipt = await s.assign(s.job);
  expect(receipt).toMatchObject({ sessionId: child, location: { serverId: remote.serverId } });
  expect(s.store.read().dispatchReceipts[child].routeSource).toBe("board");
  expect(s.win.creates.get(child)?.metadata["coordinator-board/dispatch-route-source"]).toBe("board");
  expect(await s.assign(s.job)).toEqual(receipt);
  expect(s.win.sends).toHaveLength(1);
  expect(s.win.creates.size).toBe(1);
  expect(s.mac.creates.size).toBe(0);
  expect(s.win.state.disposals).toBeGreaterThan(0);
  await expect(s.assign({ ...s.job, expectedHostId: local.serverId })).rejects.toThrow(/다른 작업/);
});

test("the coordinator can pin a different catalog route on the remote host and replay it once", async () => {
  const s = scenario();
  s.win.sdk.providers.listModels = async () => ({ models: [
    { id: expectedRoute.model, label: "Codex", isDefault: true, thinkingOptions: [{ id: "high" }] },
    { id: "alternate-model", label: "Alternate model", isDefault: false, thinkingOptions: [{ id: "low" }] },
  ] });
  const alternate = { ...expectedRoute, model: "alternate-model", effort: "low" };
  const job: DispatchInput = { ...s.job, expectedRoute: alternate, routeSource: "coordinator" };
  expect((await s.plan()).routes.find((entry: { grade: string }) => entry.grade === job.grade).route).toEqual(expectedRoute);
  await expect(s.assign({ ...job, routeSource: undefined })).rejects.toThrow(/미리보기/);
  expect(s.win.creates.size).toBe(0);

  s.win.state.loseNextSendAck = true;
  await expect(s.assign(job)).rejects.toThrow(/Could not confirm delivery/);
  const [sessionId] = s.win.creates.keys();
  expect(s.win.creates.get(sessionId)).toMatchObject({
    config: { provider: "codex/alternate-model", thinkingOptionId: "low", modeId },
    metadata: { "coordinator-board/dispatch-route-source": "coordinator" },
  });
  expect(s.store.read().dispatchReceipts[sessionId].routeSource).toBe("coordinator");
  await expect(s.assign({ ...job, routeSource: undefined })).rejects.toThrow(/different task/);
  s.win.sdk.providers.listModels = async () => ({ models: [] });
  const result = await s.assign(job);
  expect(result).toMatchObject({ sessionId, route: alternate, location: { serverId: remote.serverId } });
  expect(await s.assign(job)).toEqual(result);
  expect(s.win.creates.size).toBe(1);
  expect(s.mac.creates.size).toBe(0);
  expect(s.win.sendAttempts).toEqual([{
    sourceAgentId: coordinator, sourceAgentServerId: local.serverId, messageId: creationUuid(job.requestKey, "prompt"),
  }]);
  expect(s.win.sends).toHaveLength(1);
});

test("remote first instructions work without agent steering and replay only once", async () => {
  const s = scenario();
  s.win.state.agentSteerUnsupported = true;
  const receipt = await s.assign(s.job);
  expect(await s.assign(s.job)).toEqual(receipt);
  expect(s.win.creates.size).toBe(1);
  expect(s.win.sends).toEqual([{
    id: receipt.sessionId, text: s.job.prompt,
    options: { sourceAgentId: coordinator, sourceAgentServerId: local.serverId, messageId: creationUuid(s.job.requestKey, "prompt") },
  }]);
  expect(s.win.sendAttempts).toHaveLength(1);
  expect(s.mac.sends).toBeEmpty();
});

test("a steering compatibility rejection waits for explicit replay with the same attributed message ID", async () => {
  const s = scenario();
  s.win.state.rejectNextSend = () => Error(unsupportedSteer);
  const options = { sourceAgentId: coordinator, sourceAgentServerId: local.serverId, messageId: creationUuid(s.job.requestKey, "prompt") };
  await expect(s.assign(s.job)).rejects.toThrow(/같은 요청 키.*Retry with the same request key/);
  expect(s.win.sendAttempts).toEqual([options]);
  expect(s.win.sends).toBeEmpty();
  const [sessionId] = s.win.creates.keys();
  const receipt = await s.assign(s.job);
  expect(receipt.sessionId).toBe(sessionId);
  expect(await s.assign(s.job)).toEqual(receipt);
  expect(s.win.sendAttempts).toEqual([options, options]);
  expect(s.win.sends).toHaveLength(1);
  expect(s.win.creates.size).toBe(1);
});

test("the same request key recovers a created worker that never got its first instruction", async () => {
  const s = scenario();
  s.win.state.rejectNextSend = () => Error("Connection closed before acceptance");
  await expect(s.assign(s.job)).rejects.toThrow(/Could not confirm delivery/);
  expect(s.win.sends).toBeEmpty();
  const [sessionId] = s.win.creates.keys();
  expect(s.store.read().dispatchReceipts[sessionId].delivered).toBeUndefined();

  const receipt = await s.assign(s.job);
  expect(receipt.sessionId).toBe(sessionId);
  expect(s.win.creates.size).toBe(1);
  expect(s.win.sendAttempts).toEqual([s.win.sends[0].options, s.win.sends[0].options]);
  expect(s.win.sends).toHaveLength(1);
});

test("a permission request that appears before explicit replay stops delivery", async () => {
  const s = scenario();
  s.win.state.rejectNextSend = agent => {
    agent.pendingPermissions = [{ id: "permission-1", title: "Confirm permission" }];
    return Error(unsupportedSteer);
  };
  await expect(s.assign(s.job)).rejects.toThrow(/Could not confirm delivery/);
  await expect(s.assign(s.job)).rejects.toThrow(/Check whether the remote session is ready/);
  expect(s.win.sendAttempts).toHaveLength(1);
  expect(s.win.sends).toBeEmpty();
});

test("a new remote worker that asks for permission does not receive a work prompt", async () => {
  const s = scenario();
  s.win.state.permissionsOnCreate = true;
  await expect(s.assign(s.job)).rejects.toThrow(/작업 지시/);
  expect(s.win.creates.size).toBe(1);
  expect(s.win.sends).toHaveLength(0);
  const rows = await discoverBoardSessions(s.sdk, s.store);
  expect(rows.find(row => row.serverId === remote.serverId)).toMatchObject({ projectId, nativePending: true, lane: "human",
    detail: "응답을 기다리는 요청 1건 · Confirm file access" });
});

test("remote session questions join the managed project and the user's reply uses that worker's host", async () => {
  const s = scenario();
  const { sessionId } = await s.assign(s.job);
  const { sessionId: otherWorker } = await s.assign({ ...s.job, requestKey: "example-unrelated-worker" });
  s.win.timelines.set(sessionId, [{ type: "assistant_message", text: "Which option do you prefer?" }]);
  const scope = s.store.read();
  const reader = new ConversationReader();
  const rows = await discoverBoardSessions(s.sdk, s.store);
  const remoteRow = rows.find(row => row.id === sessionId)!;
  expect(remoteRow).toMatchObject({ serverId: remote.serverId, projectId, sourceProjectId: winProjectId, assignment: { label: "Windows" } });
  expect(isCurrentMembership(remoteRow, scope)).toBe(true);
  expect(isCurrentMembership(remoteRow, { ...scope, projects: [] })).toBe(false);
  expect((await s.tool("plan_board_assignment", {})).sessions.find((row: { id: string }) => row.id === sessionId)).toMatchObject({ projectId });
  const evidence = (await reader.decorate(s.sdk, rows, scope)).get(sessionId);
  decorateDecision(remoteRow, undefined, scope, evidence);
  expect(remoteRow.decision?.question).toBe("Which option do you prefer?");
  const notes = new NoteStore(join(s.dir, "notes.json"));
  const reply = { projectId, sessionId, recipientId: sessionId, version: remoteRow.decision!.version, action: "reply" as const,
    text: "The second option", requestKey: "example-reply-key" };
  s.win.state.readIds = [];
  await new DecisionSender(s.store, notes, reader).send(s.sdk, reply);
  expect(s.win.state.readIds).not.toContain(otherWorker);
  expect(s.win.sends.at(-1)).toMatchObject({ id: sessionId, text: expect.stringContaining("The second option") });
  expect(s.mac.sends).toHaveLength(0);
  s.win.agents.get(sessionId)!.metadata = {};
  expect((await discoverBoardSessions(s.sdk, s.store)).some(row => row.id === sessionId)).toBe(false);
});

test("a board clarification for a remote worker sends on that worker's host", async () => {
  const s = scenario();
  const { sessionId } = await s.assign(s.job);
  s.win.timelines.set(sessionId, [{ type: "assistant_message", text: "Which option do you prefer?" }]);
  const sessions = await discoverBoardSessions(s.sdk, s.store);
  const row = sessions.find(row => row.id === sessionId)!;
  const scope = s.store.read();
  const evidence = await new ConversationReader().decorate(s.sdk, sessions, scope);
  decorateDecision(row, undefined, scope, evidence.get(sessionId));
  const sender = new ClarificationSender(s.store, async () => ({ sessions, notes: {}, coordinator }));
  const card = sessionClarificationCard(row)!;
  const input = { card, recipientId: sessionId, question: "What does the first option change?", requestKey: "example-clarification-key" };
  const result = await sender.send(s.sdk, input);
  expect(await sender.send(s.sdk, input)).toEqual(result);
  expect(s.win.sends.filter(entry => entry.options.messageId === result.messageId)).toEqual([
    expect.objectContaining({ id: sessionId, text: expect.stringContaining(input.question) }),
  ]);
  expect(s.mac.sends).toBeEmpty();
});

test("selected placement fields enter the same explicit work request and change its retry identity", async () => {
  const s = scenario();
  const request = { coordinator, requestKey: "example-work-request", text: "Check the installer.", platform: "windows", host: "Windows" };
  await s.call(requestWork, request);
  expect(s.mac.sends[0]).toMatchObject({ id: coordinator, text: "Check the installer.\n\nplatform: windows\nhost: \"Windows\"" });
  await expect(s.call(requestWork, { ...request, platform: "mac" })).rejects.toThrow(/새 요청/);
  expect(s.mac.sends).toHaveLength(1);
});

test.each([false, true])("a single board host keeps local dispatch when load is unknown or the registry fails (%s)", async failed => {
  const s = scenario();
  s.registry.single = true;
  s.registry.failed = failed;
  s.mac.state.failLoad = true;
  const job = { ...s.job, workspaceId: s.mac.workspace.id, expectedHostId: local.serverId, platform: "mac" as const };
  expect((await s.plan({ platform: "mac" })).workspaces.map((entry: { id: string }) => entry.id)).toEqual([s.mac.workspace.id]);
  const receipt = await s.assign(job);
  expect(await s.assign(job)).toEqual(receipt);
  expect(s.mac.creates.size).toBe(1);
  expect(s.win.creates.size).toBe(0);
  expect(s.store.read().dispatchReceipts).toEqual({});
  await expect(s.assign({ ...job, expectedHostId: remote.serverId })).rejects.toThrow(/host/i);
  await expect(s.plan({ platform: "windows" })).rejects.toThrow(/operating system/i);
});

test("discovery drops completed missing or archived receipts and preserves uncertain or unreachable ones", async () => {
  const s = scenario();
  const jobs = await Promise.all([s.job, { ...s.job, requestKey: "example-archived-job" },
    { ...s.job, requestKey: "example-unconfirmed-job" }].map(s.assign));
  const [missing, archived, pending] = jobs.map(job => job.sessionId);
  s.win.agents.delete(missing);
  s.win.agents.get(archived)!.archivedAt = new Date().toISOString();
  s.win.agents.delete(pending);
  s.store.change(scope => { scope.dispatchReceipts[pending].delivered = false; });
  s.win.state.failRef = true;
  await discoverBoardSessions(s.sdk, s.store);
  expect(Object.keys(s.store.read().dispatchReceipts)).toHaveLength(3);
  s.win.state.failRef = false;
  await discoverBoardSessions(s.sdk, s.store);
  expect(Object.keys(s.store.read().dispatchReceipts)).toEqual([pending]);
  expect(new Set(Object.keys(s.store.read().dispatchTombstones))).toEqual(new Set([missing, archived]));
  s.win.state.readIds = [];
  await discoverBoardSessions(s.sdk, s.store);
  expect(s.win.state.readIds).toEqual([pending]);
});

test("a retry after receipt cleanup cannot create a second worker on a less busy host", async () => {
  const s = scenario();
  // Workspace IDs can coincide across independent hosts.
  s.win.workspace.id = s.mac.workspace.id;
  const job = { ...s.job, workspaceId: s.mac.workspace.id, expectedHostId: undefined };
  const receipt = await s.assign(job);
  expect(receipt.location.serverId).toBe(remote.serverId);
  s.win.agents.get(receipt.sessionId)!.archivedAt = new Date().toISOString();
  await discoverBoardSessions(s.sdk, s.store);
  expect(s.store.read().dispatchReceipts[receipt.sessionId]).toBeUndefined();
  for (const id of ["win-one", "win-two", "win-three"]) s.win.add(id, "running");
  expect((await s.plan()).location.serverId).toBe(local.serverId);
  await expect(s.assign(job)).rejects.toThrow(/다른 작업/);
  expect(s.mac.creates.size).toBe(0);
  expect(s.win.creates.size).toBe(1);
  expect(s.win.sends).toHaveLength(1);
});

test("an online host with an unknown request history blocks an unverified creation", async () => {
  const s = scenario();
  s.win.state.failRef = true;
  await expect(s.assign({ ...s.job, workspaceId: s.mac.workspace.id, expectedHostId: local.serverId })).rejects.toThrow(/Check the host connections/);
  expect(s.mac.creates.size + s.win.creates.size).toBe(0);
  s.win.state.failRef = false;
  expect((await s.assign({ ...s.job, workspaceId: s.mac.workspace.id, expectedHostId: local.serverId })).location.serverId).toBe(local.serverId);
});

test("discovery prunes by project and age before remote lookups and limits concurrent requests", async () => {
  const s = scenario();
  const { sessionId } = await s.assign(s.job);
  const excluded = "00000000-0000-8000-8000-000000000001";
  const expired = "00000000-0000-8000-8000-000000000002";
  s.store.change(scope => {
    const entry = scope.dispatchReceipts[sessionId];
    scope.dispatchReceipts[excluded] = { ...entry, projectId: "unmanaged" };
    scope.dispatchReceipts[expired] = { ...entry, createdAt: "2020-01-01T00:00:00Z" };
    for (let i = 3; i <= 257; i++) {
      const id = `00000000-0000-8000-8000-${String(i).padStart(12, "0")}`;
      scope.dispatchReceipts[id] = { ...entry, delivered: false };
    }
  });
  s.win.state.readIds = [];
  s.win.state.mostReads = 0;
  await discoverBoardSessions(s.sdk, s.store);
  expect(s.win.state.readIds).toHaveLength(256);
  expect(s.win.state.readIds).not.toContain(excluded);
  expect(s.win.state.readIds).not.toContain(expired);
  expect(s.win.state.mostReads).toBeGreaterThan(1);
  expect(s.win.state.mostReads).toBeLessThanOrEqual(4);
  expect(Object.keys(s.store.read().dispatchReceipts)).toHaveLength(256);
  s.store.change(scope => { scope.dispatchReceipts[sessionId].delivered = false; });
  await expect(s.assign({ ...s.job, requestKey: "example-at-receipt-limit" })).rejects.toThrow(/30일.*30 days/);
  expect(s.win.creates.size).toBe(1);
});

test("a full receipt store frees ended sessions first, then the oldest delivered idle session", async () => {
  const s = scenario();
  const [running, oldest, newer, archived, deleted] = await Promise.all([
    s.job,
    { ...s.job, requestKey: "oldest-idle-worker" },
    { ...s.job, requestKey: "newer-idle-worker" },
    { ...s.job, requestKey: "archived-test-worker" },
    { ...s.job, requestKey: "deleted-test-worker" },
  ].map(s.assign)).then(results => results.map(result => result.sessionId));
  s.win.agents.get(running)!.status = "running";
  s.win.agents.get(archived)!.archivedAt = new Date().toISOString();
  s.win.agents.delete(deleted);
  s.store.change(scope => {
    for (const [id, days] of [[running, 10], [oldest, 8], [newer, 6]] as const) {
      scope.dispatchReceipts[id].createdAt = new Date(Date.now() - days * 86_400_000).toISOString();
    }
    for (let i = 0; i < 251; i++) {
      scope.dispatchReceipts[creationUuid("pending-" + i, "agent")] = { ...scope.dispatchReceipts[running], delivered: false };
    }
  });
  const add = async (index: number) => (await s.assign({ ...s.job, requestKey: "new-worker-at-limit-" + index })).sessionId;
  await add(1);
  let receipts = s.store.read().dispatchReceipts;
  expect(receipts[archived]).toBeUndefined();
  expect(receipts[deleted]).toBeUndefined();
  expect(receipts[oldest]).toBeDefined();
  expect(Object.keys(receipts)).toHaveLength(255);
  await add(2);
  const added = await add(3);
  receipts = s.store.read().dispatchReceipts;
  expect(Object.keys(receipts)).toHaveLength(256);
  expect(receipts[oldest]).toBeUndefined();
  expect(s.store.read().dispatchTombstones[oldest]).toMatchObject({ serverId: remote.serverId, requestKey: "oldest-idle-worker" });
  for (const id of [running, newer, added, creationUuid("pending-0", "agent")]) expect(receipts[id]).toBeDefined();
});

test("receipt pressure keeps remote conversation questions, question notes and pending replies on the board", async () => {
  const s = scenario();
  const [question, note, waiting, idle] = await Promise.all([
    s.job,
    { ...s.job, requestKey: "manual-question-note" },
    { ...s.job, requestKey: "pending-board-reply" },
    { ...s.job, requestKey: "idle-with-no-question" },
  ].map(s.assign)).then(results => results.map(result => result.sessionId));
  s.win.timelines.set(question, [{ type: "assistant_message", text: "Which option do you prefer?" }]);
  new NoteStore(join(s.dir, "notes.json")).update({
    sessionId: note, kind: "question", text: "Which branch should we use?", expectedRevision: 0,
  });
  s.store.change(scope => {
    scope.decisionReceipts["pending-reply"] = { sessionId: waiting, version: "fixture", fingerprint: "fixture", status: "pending" };
    for (const [id, days] of [[question, 10], [note, 9], [waiting, 8], [idle, 7]] as const) {
      scope.dispatchReceipts[id].createdAt = new Date(Date.now() - days * 86_400_000).toISOString();
    }
    for (let i = 0; i < 252; i++) {
      scope.dispatchReceipts[creationUuid("pending-" + i, "agent")] = { ...scope.dispatchReceipts[idle], delivered: false };
    }
  });
  await s.assign({ ...s.job, requestKey: "new-worker-with-open-questions" });
  const receipts = s.store.read().dispatchReceipts;
  expect(receipts[idle]).toBeUndefined();
  const rows = await discoverBoardSessions(s.sdk, s.store, new Set([question, note, waiting]));
  for (const id of [question, note, waiting]) {
    expect(receipts[id]).toBeDefined();
    expect(rows.find(row => row.id === id)?.serverId).toBe(remote.serverId);
  }
  const scope = s.store.read();
  const evidence = await new ConversationReader().decorate(s.sdk, rows, scope);
  const notes = new NoteStore(join(s.dir, "notes.json")).visible(new Set([note]));
  for (const row of rows) decorateDecision(row, notes[row.id], scope, evidence.get(row.id));
  expect(rows.find(row => row.id === question)?.decision?.source).toBe("conversation");
  expect(rows.find(row => row.id === note)?.decision?.source).toBe("person-note");
});

test.each([false, true])("a retired receipt pins an unpinned retry across an outage (legacy receipt: %s)", async legacy => {
  const s = scenario();
  s.win.workspace.id = s.mac.workspace.id;
  const job = { ...s.job, workspaceId: s.mac.workspace.id, expectedHostId: undefined };
  const receipt = await s.assign(job);
  expect(receipt.location.serverId).toBe(remote.serverId);
  s.store.change(scope => {
    const saved = scope.dispatchReceipts[receipt.sessionId];
    saved.createdAt = "2020-01-01T00:00:00Z";
    if (legacy) delete saved.requestKey;
  });
  await discoverBoardSessions(s.sdk, s.store);
  const scope = s.store.read();
  expect(scope.dispatchReceipts[receipt.sessionId]).toBeUndefined();
  s.registration.status = "offline";
  expect((await s.plan()).location.serverId).toBe(local.serverId);
  await expect(s.assign(job)).rejects.toThrow(/offline or disabled/);
  expect(s.mac.creates.size).toBe(0);
  expect(scope.dispatchTombstones[receipt.sessionId]).toEqual({
    serverId: remote.serverId, ...(legacy ? {} : { requestKey: job.requestKey }), retiredAt: expect.any(String),
  });
  s.registration.status = "online";
  for (const id of ["win-one", "win-two", "win-three"]) s.win.add(id, "running");
  expect((await s.plan()).location.serverId).toBe(local.serverId);
  const retry = await s.assign(job);
  expect(retry.sessionId).toBe(receipt.sessionId);
  expect(retry.location.serverId).toBe(remote.serverId);
  expect(s.mac.creates.size).toBe(0);
  expect(s.win.creates.size).toBe(1);
  expect(s.win.sends).toHaveLength(1);
});

test("retired placement records expire and retain the newest entries at the limit", () => {
  const s = scenario();
  const expired = creationUuid("expired-placement-key", "agent");
  const oldest = creationUuid("fixture-placement-0", "agent");
  const latest = creationUuid("fixture-placement-" + maxDispatchTombstones, "agent");
  s.store.change(scope => {
    scope.dispatchTombstones[expired] = { serverId: local.serverId, retiredAt: "2020-01-01T00:00:00Z" };
    for (let i = 0; i <= maxDispatchTombstones; i++) {
      const requestKey = "fixture-placement-" + i;
      scope.dispatchTombstones[creationUuid(requestKey, "agent")] = {
        serverId: local.serverId, requestKey, retiredAt: new Date(Date.now() - 60_000 + i).toISOString(),
      };
    }
  });
  s.store.readDispatchScope();
  const retained = s.store.read().dispatchTombstones;
  expect(Object.keys(retained)).toHaveLength(maxDispatchTombstones);
  expect(retained[expired]).toBeUndefined();
  expect(retained[oldest]).toBeUndefined();
  expect(retained[latest]?.serverId).toBe(local.serverId);
});

test("four stalled remote reads time out and let the next session load", async () => {
  const s = scenario();
  const { sessionId } = await s.assign(s.job);
  let resume!: () => void;
  const pause = new Promise<void>(resolve => { resume = resolve; });
  const stalled = Array.from({ length: 4 }, (_, i) => creationUuid("slow-worker-" + i, "agent"));
  s.store.change(scope => {
    const receipt = scope.dispatchReceipts[sessionId];
    scope.dispatchReceipts = Object.fromEntries([...stalled, sessionId].map(id => [id, receipt]));
  });
  for (const id of stalled) s.win.state.pauseReads.set(id, pause);
  const discovery = discoverBoardSessions(s.sdk, s.store, undefined, { timeoutMs: 80 });
  const watchdog = AbortSignal.timeout(1200);
  try {
    const rows = await Promise.race([discovery, new Promise<never>((_, reject) => {
      watchdog.addEventListener("abort", () => reject(new Error("Remote queue did not advance")), { once: true });
    })]);
    expect(rows.some(row => row.id === sessionId)).toBe(true);
    expect(stalled.every(id => !!s.store.read().dispatchReceipts[id])).toBe(true);
  } finally {
    resume();
    await discovery;
  }
});
