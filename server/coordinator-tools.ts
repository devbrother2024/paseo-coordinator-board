import { createHash } from "node:crypto";
import type { AgentToolDefinition, AgentToolResult, PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { SessionRow } from "../shared/contract";
import { boardActionName, boardGuideName, coordinatorContract, type CoordinatorContract } from "../shared/coordinator-contract";
import {
  guideNoteDue, nextToolStamp, providerKeepsTools, toolStaleness, validConversationId,
  type CoordinatorTools, type ServedTools, type ToolCall, type ToolStamp, type ToolStaleness,
} from "../shared/coordinator-tools";
import { heldContract, type Definitions } from "./board-guide";
import type { PreferenceStore } from "./preferences";

type Tool = Pick<AgentToolDefinition, "name" | "input">;
type Sdk = Pick<PluginHandlerContext["paseo"], "agents">;

// Keys whose value is a map of names to schemas, and keys whose value is data rather than a schema.
const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const dataKeys = new Set(["enum", "const", "default", "examples"]);

// The shape of an input schema: what a call may carry. Wording (descriptions and titles), key order
// and the order of required field names do not change what a conversation can call.
export function inputShape(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(inputShape);
  if (!schema || typeof schema !== "object") return schema;
  const source = schema as Record<string, unknown>;
  const shape: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const value = source[key];
    if (key === "description" || key === "title") continue;
    if (dataKeys.has(key)) shape[key] = value;
    else if (key === "required" && Array.isArray(value) && value.every(item => typeof item === "string")) shape[key] = [...value].sort();
    else if (schemaMaps.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      const map = value as Record<string, unknown>;
      shape[key] = Object.fromEntries(Object.keys(map).sort().map(name => [name, inputShape(map[name])]));
    } else shape[key] = inputShape(value);
  }
  return shape;
}

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

// The provider conversation a session runs now. /clear in Claude starts a new one under the same session.
export async function providerSession(paseo: Sdk, id: string): Promise<string | null> {
  const agent = (await paseo.agents.ref(id).refresh())?.agent;
  const session = agent?.id === id ? agent.persistence?.sessionId : undefined;
  return validConversationId(session) ? session : null;
}

export class CoordinatorToolStamps {
  private current: ServedTools | undefined;
  constructor(private readonly prefs: PreferenceStore, private readonly contract: CoordinatorContract = coordinatorContract) {}

  // The coordinator tool definitions this board build hands out, and the revision of its guide.
  serve(tools: readonly Tool[], guide = "") {
    const fingerprint = toolsFingerprint(tools);
    this.current = fingerprint ? { fingerprint, contract: this.contract.version, compatibleFrom: this.contract.compatibleFrom, guide } : undefined;
  }

  get fingerprint() { return this.current?.fingerprint; }
  get served() { return this.current; }

  stamp(agentId: string): ToolStamp | undefined {
    const saved = this.prefs.read().toolStamps[agentId];
    if (!saved) return undefined;
    const { at: _at, ...stamp } = saved;
    return stamp;
  }

  private write(agentId: string, change: (stamp: ToolStamp | undefined) => ToolStamp | undefined, now: Date) {
    const previous = this.stamp(agentId);
    const next = change(previous);
    if (next && next !== previous) {
      this.prefs.change(value => {
        const keep = new Set([agentId, value.coordinator, value.pendingCoordinator?.id]);
        for (const id of Object.keys(value.toolStamps)) if (!keep.has(id)) delete value.toolStamps[id];
        value.toolStamps[agentId] = { ...next, at: now.toISOString() };
      });
    }
    return next;
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
  async definitions(paseo: Sdk, agent: { id: string; provider: string }): Promise<Definitions> {
    if (!this.current || !providerKeepsTools(agent.provider)) return "unknown";
    const session = await providerSession(paseo, agent.id);
    if (!session) return "unknown";
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

// Adds the note without breaking the result. Paseo turns `text` into the only content item the
// conversation reads, so a JSON result keeps its text and carries the note in structured content.
// `told` says whether the conversation can have read it.
export function withGuideNote(result: AgentToolResult): { result: AgentToolResult; told: boolean } {
  const structured = result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
    ? result.structuredContent as Record<string, unknown> : result.structuredContent === undefined ? {} : null;
  const note = structured ? { structuredContent: { ...structured, boardToolsNotice: guideNote } } : {};
  if (result.text && isJson(result.text)) return { result: { ...result, ...note }, told: false };
  return { result: { ...result, ...note, text: result.text ? `${result.text}\n\n${guideNote}` : guideNote }, told: true };
}

// Every board tool call from a Claude coordinator stamps its conversation. A conversation that has not
// read the current guide is told so once, on a result it can read. Recording never changes or fails
// the tool's own result.
export function stampingTool<T extends AgentToolDefinition>(tool: T, stamps: CoordinatorToolStamps): T {
  return {
    ...tool,
    async execute(input, context) {
      const result: AgentToolResult = await tool.execute(input, context);
      if (!providerKeepsTools(context.agent.provider)) return result;
      try {
        const session = await providerSession(context.paseo, context.agent.id);
        const guide = tool.name === boardGuideName;
        const call: ToolCall = { ...(guide || tool.name === boardActionName ? { held: heldContract(input) } : {}), readGuide: guide && !result.isError };
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
export function coordinatorToolsView(staleness: ToolStaleness, row: Pick<SessionRow, "status" | "serverId" | "provider"> | undefined): CoordinatorTools | undefined {
  if (staleness !== "stale" || !row || row.serverId) return undefined;
  if (row.status === "closed" || row.status === "error" || !providerKeepsTools(row.provider)) return undefined;
  return { stale: true };
}

// Reads the coordinator's conversation only when its stamp would be stale in the same conversation.
export async function readCoordinatorTools(paseo: Sdk, stamps: Pick<CoordinatorToolStamps, "stamp" | "served" | "staleness">,
  row: Pick<SessionRow, "id" | "status" | "serverId" | "provider"> | undefined): Promise<CoordinatorTools | undefined> {
  if (!row || row.serverId || !providerKeepsTools(row.provider)) return undefined;
  const stamp = stamps.stamp(row.id);
  if (!stamp || toolStaleness(stamp, stamps.served, stamp.session) !== "stale") return undefined;
  let session: string | null;
  try { session = await providerSession(paseo, row.id); } catch { return undefined; }
  return coordinatorToolsView(stamps.staleness(row.id, session), row);
}
