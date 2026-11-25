import { createHash } from "node:crypto";
import type { AgentToolDefinition, AgentToolResult, PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { SessionRow } from "../shared/contract";
import { boardActionName, boardGuideName, contractToolsSince, coordinatorContract, type CoordinatorContract } from "../shared/coordinator-contract";
import {
  behindServedTools, compactedToolStamp, conversationProvider, guideNoteDue, nextToolStamp, providerKeepsTools, toolStaleness, validConversationId,
  type CoordinatorTools, type ServedTools, type ToolCall, type ToolStamp, type ToolStaleness,
} from "../shared/coordinator-tools";
import { inputShape, type Definitions } from "./board-guide";
import type { PreferenceStore } from "./preferences";

type Tool = Pick<AgentToolDefinition, "name" | "input">;
type Sdk = Pick<PluginHandlerContext["paseo"], "agents">;
// How far back the board looks for a compaction. A stamp that is behind is checked after every
// coordinator turn, on each board tool call and on each board refresh, so the newest entries suffice.
const compactionWindow = 200;

// The contract surface: each tool's name and the shape of its input. The code that runs a tool lives
// in the board and always runs the installed build, and wording is not part of the contract.
export function contractSurface(tools: readonly Tool[]): Record<string, unknown> | undefined {
  try {
    return Object.fromEntries([...tools].sort((a, b) => a.name.localeCompare(b.name))
      .map(tool => [tool.name, inputShape(z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }))]));
  } catch {
    return undefined;
  }
}

export function toolsFingerprint(tools: readonly Tool[]): string | undefined {
  const surface = contractSurface(tools);
  return surface && createHash("sha256").update(JSON.stringify(surface)).digest("hex");
}

// The provider conversation a session runs now, and whether its provider keeps loaded tool definitions.
// /clear in Claude starts a new conversation under the same session. A provider profile is judged by
// the implementation it runs on, which the session's persistence record names.
export async function providerConversation(paseo: Sdk, id: string): Promise<{ session: string | null; keepsTools: boolean }> {
  const agent = (await paseo.agents.ref(id).refresh())?.agent;
  const persistence = agent?.id === id ? agent.persistence : undefined;
  const session = persistence?.sessionId;
  return { session: validConversationId(session) ? session : null, keepsTools: providerKeepsTools(conversationProvider(persistence)) };
}

export class CoordinatorToolStamps {
  private current: ServedTools | undefined;
  // When this board began serving the current contract. A restart of the same build keeps the time.
  private servedSince = Date.now();
  constructor(private readonly prefs: PreferenceStore, private readonly contract: CoordinatorContract = coordinatorContract) {}

  // The coordinator tool definitions this board build hands out, and the revision of its guide.
  serve(tools: readonly Tool[], guide = "", now = new Date()) {
    const fingerprint = toolsFingerprint(tools);
    this.current = fingerprint ? { fingerprint, contract: this.contract.version, compatibleFrom: this.contract.compatibleFrom, guide } : undefined;
    this.servedSince = now.getTime();
    if (!fingerprint) return;
    try {
      const scope = this.prefs.read();
      const served = scope.toolsServed;
      if (served?.fingerprint === fingerprint) this.servedSince = Date.parse(served.at);
      // Nothing is written for a board with no conversation to compare.
      else if (Object.keys(scope.toolStamps).length) this.prefs.change(value => { value.toolsServed = { fingerprint, at: now.toISOString() }; });
    } catch {
      // The time this process started serving is the safe line.
    }
  }

  get fingerprint() { return this.current?.fingerprint; }
  get served() { return this.current; }

  stamp(agentId: string): ToolStamp | undefined {
    const saved = this.prefs.read().toolStamps[agentId];
    if (!saved) return undefined;
    const { at: _at, ...stamp } = saved;
    return stamp;
  }

  // `at` is when the conversation was stamped, or last seen to load its tools again. It does not move
  // when the board only learns more about the same definitions.
  private write(agentId: string, change: (stamp: ToolStamp | undefined) => ToolStamp | undefined, now: Date, restart = false) {
    const saved = this.prefs.read().toolStamps[agentId];
    const previous = this.stamp(agentId);
    const next = change(previous);
    if (next && next !== previous) {
      const at = saved && saved.session === next.session && !restart ? saved.at : now.toISOString();
      this.prefs.change(value => {
        const keep = new Set([agentId, value.coordinator, value.pendingCoordinator?.id]);
        for (const id of Object.keys(value.toolStamps)) if (!keep.has(id)) delete value.toolStamps[id];
        value.toolStamps[agentId] = { ...next, at };
      });
    }
    return next;
  }

  // Looks for a compaction after the stamp and after this board began serving its contract, for a stamp
  // that is behind what the board serves. A conversation compacted since then loads the board tools it
  // serves now. An earlier compaction loaded the definitions of that time, so it shows nothing.
  // Whatever cannot be read leaves the stamp as it is.
  async refresh(paseo: Sdk, agentId: string, now = new Date()): Promise<void> {
    const saved = this.prefs.read().toolStamps[agentId];
    if (!saved || !behindServedTools(this.stamp(agentId), this.current)) return;
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", projection: "projected", limit: compactionWindow });
      const since = Math.max(Date.parse(saved.at), this.servedSince);
      const compacted = page.entries.some(({ item, timestamp }) => item.type === "compaction" && item.status === "completed" && Date.parse(timestamp) > since);
      if (compacted) this.write(agentId, stamp => stamp && stamp.session === saved.session ? compactedToolStamp(stamp, this.current) : stamp, now, true);
    } catch {
      // Unknown stays unknown.
    }
  }

  // A board coordinator called a board tool from `session`. Stamps a conversation on its first call,
  // and records what a contract tool call says about the definitions the conversation holds.
  called(agentId: string, session: string | null, call: ToolCall = {}, now = new Date()): { staleness: ToolStaleness; noteDue: boolean } {
    const scope = this.prefs.read();
    if (scope.coordinator !== agentId && scope.pendingCoordinator?.id !== agentId) return { staleness: "unknown", noteDue: false };
    const next = this.write(agentId, stamp => nextToolStamp(stamp, this.current, session, call), now);
    return { staleness: toolStaleness(next, this.current, session), noteDue: next?.session === session && guideNoteDue(next, this.current) };
  }

  // The conversation was told to read the guide revision served now.
  noted(agentId: string, session: string | null, now = new Date()) {
    const guide = this.current?.guide;
    if (guide === undefined) return;
    this.write(agentId, stamp => stamp && stamp.session === session && stamp.noted !== guide ? { ...stamp, noted: guide } : stamp, now);
  }

  staleness(agentId: string, session: string | null): ToolStaleness {
    return toolStaleness(this.stamp(agentId), this.current, session);
  }

  // How the definitions held by the coordinator's current conversation compare with this board.
  async definitions(paseo: Sdk, agent: { id: string }): Promise<Definitions> {
    if (!this.current) return "unknown";
    await this.refresh(paseo, agent.id);
    const { session, keepsTools } = await providerConversation(paseo, agent.id);
    if (!session || !keepsTools) return "unknown";
    const stamp = this.stamp(agent.id);
    // A conversation the board has not stamped loads its board tools now.
    if (!stamp || stamp.session !== session) return "current";
    return stamp.contract === undefined || stamp.early || stamp.contract < this.current.contract ? "older" : "current";
  }
}

export const guideNote = `Board note: this conversation has not read the board's current tool guide. Call ${boardGuideName} once (load it first if it is listed as a newly available tool). `
  + `It lists what the installed board accepts now. For an action or a field missing from the tool definitions this conversation holds, use ${boardActionName}. `
  + "The tools you already hold keep working, and this needs no replacement, /clear or /compact. "
  + `보드 알림: 이 대화는 보드의 지금 도구 안내를 아직 읽지 않았습니다. ${boardGuideName} 를 한 번 불러 주세요(새로 쓸 수 있는 도구로 표시돼 있으면 먼저 불러옵니다). `
  + `지금 설치된 보드가 받는 입력이 나옵니다. 이 대화가 가진 도구 정의에 없는 기능이나 항목은 ${boardActionName} 으로 부릅니다. `
  + "이미 가진 도구는 그대로 동작하며, 이 일로 교체나 /clear, /compact 는 필요 없습니다.";

const isJson = (text: string) => {
  if (!/^\s*[[{]/.test(text)) return false;
  try { JSON.parse(text); return true; } catch { return false; }
};

// Adds the note to a result the conversation reads as text. A JSON result is returned as it came, so
// its shape never changes; the note waits for the next text result. `told` says whether it was added.
export function withGuideNote(result: AgentToolResult): { result: AgentToolResult; told: boolean } {
  if (result.text && isJson(result.text)) return { result, told: false };
  return { result: { ...result, text: result.text ? `${result.text}\n\n${guideNote}` : guideNote }, told: true };
}

// Every board tool call from a Claude Code coordinator stamps its conversation. A conversation that has
// not read the current guide is told so once, on a result it can read. Recording never changes or
// fails the tool's own result.
export function stampingTool<T extends AgentToolDefinition>(tool: T, stamps: CoordinatorToolStamps): T {
  return {
    ...tool,
    async execute(input, context) {
      const result: AgentToolResult = await tool.execute(input, context);
      try {
        const { session, keepsTools } = await providerConversation(context.paseo, context.agent.id);
        if (!keepsTools) return result;
        await stamps.refresh(context.paseo, context.agent.id);
        const guide = tool.name === boardGuideName;
        // Only the list of actions says what was added, so only reading the list counts as reading the guide.
        const overview = guide && !result.isError && (input as { topic?: unknown } | null)?.topic === undefined;
        const since = Object.hasOwn(contractToolsSince, tool.name) ? contractToolsSince[tool.name] : undefined;
        const call: ToolCall = { ...(since === undefined ? {} : { since }), readGuide: overview };
        const { noteDue } = stamps.called(context.agent.id, session, call);
        if (!noteDue || guide) return result;
        const noted = withGuideNote(result);
        if (noted.told) stamps.noted(context.agent.id, session);
        return noted.result;
      } catch {
        console.warn("Could not record the coordinator tool stamp.");
        return result;
      }
    },
  };
}

// The notice for the board's own Claude coordinator. One on another host or another provider, a closed
// or failed one (the reach notice covers those), or one whose conversation the board cannot read gets none.
export function coordinatorToolsView(staleness: ToolStaleness, row: Pick<SessionRow, "status" | "serverId"> | undefined, keepsTools: boolean): CoordinatorTools | undefined {
  if (staleness !== "stale" || !row || row.serverId || !keepsTools) return undefined;
  if (row.status === "closed" || row.status === "error") return undefined;
  return { stale: true };
}

// Reads the coordinator's conversation only when its stamp would be stale in the same conversation.
// Only a conversation on a provider that keeps its definitions is ever stamped.
export async function readCoordinatorTools(paseo: Sdk, stamps: Pick<CoordinatorToolStamps, "stamp" | "served" | "staleness" | "refresh">,
  row: Pick<SessionRow, "id" | "status" | "serverId"> | undefined): Promise<CoordinatorTools | undefined> {
  if (!row || row.serverId) return undefined;
  const before = stamps.stamp(row.id);
  if (!before || toolStaleness(before, stamps.served, before.session) !== "stale") return undefined;
  // The person may have compacted the conversation since.
  await stamps.refresh(paseo, row.id);
  const stamp = stamps.stamp(row.id);
  if (!stamp || toolStaleness(stamp, stamps.served, stamp.session) !== "stale") return undefined;
  let conversation: Awaited<ReturnType<typeof providerConversation>>;
  try { conversation = await providerConversation(paseo, row.id); } catch { return undefined; }
  return coordinatorToolsView(stamps.staleness(row.id, conversation.session), row, conversation.keepsTools);
}
