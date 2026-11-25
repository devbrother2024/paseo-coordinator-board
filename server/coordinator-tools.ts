import { createHash } from "node:crypto";
import type { AgentToolDefinition, AgentToolResult, PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { SessionRow } from "../shared/contract";
import {
  nextToolStamp, providerKeepsTools, toolStaleness, validConversationId,
  type CoordinatorTools, type ToolStamp, type ToolStaleness,
} from "../shared/coordinator-tools";
import type { PreferenceStore } from "./preferences";

type Tool = Pick<AgentToolDefinition, "name" | "description" | "input"> & { title?: string };
type Sdk = Pick<PluginHandlerContext["paseo"], "agents">;

const tidy = (text: string) => text.replace(/\s+/g, " ").trim();

// Key order, the order of required field names, and spacing in descriptions do not change what a
// conversation can call, so they do not change the fingerprint either.
export function canonical(value: unknown, key?: string): unknown {
  if (typeof value === "string") return key === "description" || key === "title" ? tidy(value) : value;
  if (Array.isArray(value)) {
    const items = value.map(item => canonical(item));
    return key === "required" && items.every(item => typeof item === "string") ? [...items].sort() : items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical((value as Record<string, unknown>)[name], name)]));
  }
  return value;
}

// What a conversation receives from a tool: its name, wording and input schema. The code that runs a
// tool lives in the board and always runs the installed build, so it is not part of the fingerprint.
export function toolsFingerprint(tools: readonly Tool[]): string | undefined {
  try {
    const described = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map(tool => ({
      name: tool.name, title: tool.title ?? null, description: tool.description,
      input: z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }),
    }));
    return createHash("sha256").update(JSON.stringify(canonical(described))).digest("hex");
  } catch {
    return undefined;
  }
}

// The provider conversation a session runs now. /clear in Claude starts a new one under the same session.
export async function providerSession(paseo: Sdk, id: string): Promise<string | null> {
  const agent = (await paseo.agents.ref(id).refresh())?.agent;
  const session = agent?.id === id ? agent.persistence?.sessionId : undefined;
  return validConversationId(session) ? session : null;
}

export class CoordinatorToolStamps {
  private current: string | undefined;
  constructor(private readonly prefs: PreferenceStore) {}

  // The coordinator tool definitions this board build hands out.
  serve(tools: readonly Tool[]) {
    this.current = toolsFingerprint(tools);
  }

  get fingerprint() { return this.current; }

  stamp(agentId: string): ToolStamp | undefined {
    const saved = this.prefs.read().toolStamps[agentId];
    return saved && { session: saved.session, fingerprint: saved.fingerprint };
  }

  // A board coordinator called a board tool from `session`. Stamps a conversation on its first call.
  called(agentId: string, session: string | null, now = new Date()): ToolStaleness {
    const scope = this.prefs.read();
    if (scope.coordinator !== agentId && scope.pendingCoordinator?.id !== agentId) return "unknown";
    const previous = this.stamp(agentId);
    const next = nextToolStamp(previous, this.current, session);
    if (next && next !== previous) {
      this.prefs.change(value => {
        const keep = new Set([agentId, value.coordinator, value.pendingCoordinator?.id]);
        for (const id of Object.keys(value.toolStamps)) if (!keep.has(id)) delete value.toolStamps[id];
        value.toolStamps[agentId] = { ...next, at: now.toISOString() };
      });
    }
    return toolStaleness(next, this.current, session);
  }

  staleness(agentId: string, session: string | null): ToolStaleness {
    return toolStaleness(this.stamp(agentId), this.current, session);
  }
}

export const staleToolNote = "Note: the board was updated after this conversation received its board tools, so newer tool features are unavailable here. " +
  "Ask the person to replace the coordinator on the board, or to type /clear in this session. " +
  "참고: 이 대화는 보드 업데이트 전의 도구 정의를 쓰고 있어 새 기능을 쓸 수 없습니다. 사람에게 보드에서 코디네이터를 교체하거나 이 세션에 /clear 를 직접 입력해 달라고 요청하세요.";

const isJson = (text: string) => {
  if (!/^\s*[[{]/.test(text)) return false;
  try { JSON.parse(text); return true; } catch { return false; }
};

// Adds the note without breaking the result. Paseo turns `text` into the only content item the
// conversation reads, so a JSON result keeps its text and carries the note in structured content.
export function withStaleNote(result: AgentToolResult): AgentToolResult {
  const structured = result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
    ? result.structuredContent as Record<string, unknown> : result.structuredContent === undefined ? {} : null;
  const note = structured ? { structuredContent: { ...structured, boardToolsNotice: staleToolNote } } : {};
  if (result.text && isJson(result.text)) return { ...result, ...note };
  return { ...result, ...note, text: result.text ? `${result.text}\n\n${staleToolNote}` : staleToolNote };
}

// Every board tool call from a Claude coordinator stamps its conversation. In a stale conversation the
// result also says why newer features are missing. Recording never changes or fails the tool's own result.
export function stampingTool(tool: AgentToolDefinition, stamps: CoordinatorToolStamps): AgentToolDefinition {
  return {
    ...tool,
    async execute(input, context) {
      const result: AgentToolResult = await tool.execute(input, context);
      if (!providerKeepsTools(context.agent.provider)) return result;
      let staleness: ToolStaleness = "unknown";
      try {
        staleness = stamps.called(context.agent.id, await providerSession(context.paseo, context.agent.id));
      } catch {
        console.warn("Could not record the coordinator tool fingerprint.");
      }
      return staleness === "stale" ? withStaleNote(result) : result;
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

// Reads the coordinator's conversation only when its stamp differs from the tools served now.
export async function readCoordinatorTools(paseo: Sdk, stamps: Pick<CoordinatorToolStamps, "stamp" | "fingerprint" | "staleness">,
  row: Pick<SessionRow, "id" | "status" | "serverId" | "provider"> | undefined): Promise<CoordinatorTools | undefined> {
  if (!row || row.serverId || !providerKeepsTools(row.provider)) return undefined;
  const stamp = stamps.stamp(row.id);
  if (!stamp || !stamps.fingerprint || stamp.fingerprint === stamps.fingerprint) return undefined;
  let session: string | null;
  try { session = await providerSession(paseo, row.id); } catch { return undefined; }
  return coordinatorToolsView(stamps.staleness(row.id, session), row);
}
