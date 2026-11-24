import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { discoverBoardSessions } from "../server/board-sessions";
import { ConversationReader } from "../server/conversation";
import { DecisionSender, decorateDecision } from "../server/decisions";
import { NoteStore } from "../server/notes";
import { createOperations } from "../server/operations";
import { PreferenceStore } from "../server/preferences";
import { isCurrentMembership } from "../server/session-links";
import { dispatchHosts, saveDispatchHost } from "../shared/dispatch-hosts";
import { requestWork } from "../shared/operations";
import type { DispatchInput } from "../shared/dispatch";

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

type Agent = {
  id: string; workspaceId: string; title: string; status: string; pendingPermissions: { id: string; title: string }[];
  updatedAt: string; currentModeId?: string; metadata?: Record<string, unknown>;
};
type Create = { agentId: string; config: { provider: string; modeId?: string }; title: string;
  idempotencyKey: string; parent: unknown; prompt?: string; metadata: Record<string, unknown> };
type Send = { sourceAgentId?: string; sourceAgentServerId?: string; messageId: string };
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
  const timelines = new Map<string, TimelineItem[]>();
  const state = { loseNextSendAck: false, permissionsOnCreate: false, disposals: 0 };
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
            pendingPermissions: state.permissionsOnCreate ? [{ id: "allow-fs", title: "Confirm file access" }] : [] });
        }
        return { id: input.agentId, workspaceId: id };
      } } }),
    },
    agents: {
      list: async ({ filter }: { filter?: { statuses?: string[] } } = {}) => page([...agents.values()]
        .filter(agent => !filter?.statuses || filter.statuses.includes(agent.status)).map(agent => ({ agent, project: agentProject }))),
      ref: (id: string) => ({
        refresh: async () => agents.has(id) ? { agent: agents.get(id), project: agentProject } : null,
        timeline: { refetch: async () => ({
          epoch: "fixture", entries: (timelines.get(id) ?? []).map((item, seqEnd) => ({ item, seqEnd })),
        }) },
        send: async (text: string, options: Send) => {
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
  return { sdk, workspace, projects, agents, creates, sends, timelines, state, add };
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
  const sdk = { ...mac.sdk, hosts: {
    list: async () => ({ self: local, hosts: [registration] }),
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
  return { dir, sdk, store, mac, win, registration, call, tool, plan, assign, job };
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
  await expect(s.assign(s.job)).rejects.toThrow(/Connection lost/);
  const [child] = s.win.creates.keys();
  expect(s.win.creates.get(child)).toMatchObject({ parent: { agentId: coordinator, serverId: local.serverId } });
  expect(s.win.creates.get(child)?.prompt).toBeUndefined();
  expect(s.win.sends).toEqual([{
    id: child, text: s.job.prompt, options: { sourceAgentId: coordinator, sourceAgentServerId: local.serverId,
      messageId: expect.any(String), activeTurnBehavior: "steer" },
  }]);
  s.win.agents.get(child)!.pendingPermissions = [{ id: "permission-1", title: "Confirm permission" }];
  s.win.add("win-load-one", "running");
  s.win.add("win-load-two", "running");
  s.win.add("win-load-three", "running");
  expect((await s.plan()).location.serverId).toBe(local.serverId);
  const receipt = await s.assign(s.job);
  expect(receipt).toMatchObject({ sessionId: child, location: { serverId: remote.serverId } });
  expect(await s.assign(s.job)).toEqual(receipt);
  expect(s.win.sends).toHaveLength(1);
  expect(s.win.creates.size).toBe(1);
  expect(s.mac.creates.size).toBe(0);
  expect(s.win.state.disposals).toBeGreaterThan(0);
  await expect(s.assign({ ...s.job, expectedHostId: local.serverId })).rejects.toThrow(/다른 작업/);
});

test("a new remote worker that asks for permission does not receive a work prompt", async () => {
  const s = scenario();
  s.win.state.permissionsOnCreate = true;
  await expect(s.assign(s.job)).rejects.toThrow(/작업 지시/);
  expect(s.win.creates.size).toBe(1);
  expect(s.win.sends).toHaveLength(0);
  const rows = await discoverBoardSessions(s.sdk, s.store.read());
  expect(rows.find(row => row.serverId === remote.serverId)).toMatchObject({ projectId, nativePending: true, lane: "human" });
});

test("remote session questions join the managed project and the user's reply uses that worker's host", async () => {
  const s = scenario();
  const { sessionId } = await s.assign(s.job);
  s.win.timelines.set(sessionId, [{ type: "assistant_message", text: "Which option do you prefer?" }]);
  const scope = s.store.read();
  const reader = new ConversationReader();
  const rows = await discoverBoardSessions(s.sdk, scope);
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
  await new DecisionSender(s.store, notes, reader).send(s.sdk, reply);
  expect(s.win.sends.at(-1)).toMatchObject({ id: sessionId, text: expect.stringContaining("The second option") });
  expect(s.mac.sends).toHaveLength(0);
  s.win.agents.get(sessionId)!.metadata = {};
  expect((await discoverBoardSessions(s.sdk, scope)).some(row => row.id === sessionId)).toBe(false);
});

test("selected placement fields enter the same explicit work request and change its retry identity", async () => {
  const s = scenario();
  const request = { coordinator, requestKey: "example-work-request", text: "Check the installer.", platform: "windows", host: "Windows" };
  await s.call(requestWork, request);
  expect(s.mac.sends[0]).toMatchObject({ id: coordinator, text: "Check the installer.\n\nplatform: windows\nhost: \"Windows\"" });
  await expect(s.call(requestWork, { ...request, platform: "mac" })).rejects.toThrow(/새 요청/);
  expect(s.mac.sends).toHaveLength(1);
});
