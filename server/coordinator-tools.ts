import { createHash } from "node:crypto";
import type { AgentToolDefinition, AgentToolResult, PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { SessionRow } from "../shared/contract";
import {
  nextToolStamp, providerKeepsTools, toolStaleness,
  type CoordinatorTools, type ToolStamp, type ToolStaleness,
} from "../shared/coordinator-tools";
import type { PreferenceStore } from "./preferences";

type Tool = Pick<AgentToolDefinition, "name" | "description" | "input"> & { title?: string };
type Sdk = Pick<PluginHandlerContext["paseo"], "agents">;

// What a conversation receives from a tool: its name, wording and input schema. The code that runs a
// tool lives in the board and always runs the installed build, so it is not part of the fingerprint.
export function toolsFingerprint(tools: readonly Tool[]): string | undefined {
  try {
    const described = [...tools].sort((a, b) => a.name.localeCompare(b.name)).map(tool => ({
      name: tool.name, title: tool.title ?? null, description: tool.description,
      input: z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any" }),
    }));
    return createHash("sha256").update(JSON.stringify(described)).digest("hex");
  } catch {
    return undefined;
  }
}

// The provider conversation a session runs now. /clear in Claude starts a new one under the same session.
export async function providerSession(paseo: Sdk, id: string): Promise<string | null> {
  const agent = (await paseo.agents.ref(id).refresh())?.agent;
  return agent?.id === id ? agent.persistence?.sessionId || null : null;
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

export function staleToolNote(provider: string) {
  const fix = providerKeepsTools(provider)
    ? "Ask the person to replace the coordinator on the board, or to type /clear in this session. 사람에게 보드에서 코디네이터를 교체하거나 이 세션에 /clear 를 직접 입력해 달라고 요청하세요."
    : "Ask the person to replace the coordinator on the board. 사람에게 보드에서 코디네이터를 교체해 달라고 요청하세요.";
  return "Note: the board was updated after this conversation received its board tools, so newer tool features are unavailable here. " +
    "참고: 이 대화는 보드 업데이트 전의 도구 정의를 쓰고 있어 새 기능을 쓸 수 없습니다. " + fix;
}

// Every board tool call stamps the caller's conversation. In a stale conversation the result also
// says why newer features are missing. Recording never changes or fails the tool's own result.
export function stampingTool(tool: AgentToolDefinition, stamps: CoordinatorToolStamps): AgentToolDefinition {
  return {
    ...tool,
    async execute(input, context) {
      const result: AgentToolResult = await tool.execute(input, context);
      let staleness: ToolStaleness = "unknown";
      try {
        staleness = stamps.called(context.agent.id, await providerSession(context.paseo, context.agent.id));
      } catch {
        console.warn("Could not record the coordinator tool fingerprint.");
      }
      if (staleness !== "stale") return result;
      const note = staleToolNote(context.agent.provider);
      return { ...result, text: result.text ? `${result.text}\n\n${note}` : note };
    },
  };
}

// The notice for the board's own coordinator. One on another host, a closed or failed one (the reach
// notice covers those), or one whose conversation the board cannot read gets none.
export function coordinatorToolsView(staleness: ToolStaleness, row: Pick<SessionRow, "status" | "serverId" | "provider"> | undefined): CoordinatorTools | undefined {
  if (staleness !== "stale" || !row || row.serverId) return undefined;
  if (row.status === "closed" || row.status === "error") return undefined;
  return { stale: true, certain: providerKeepsTools(row.provider) };
}

// Reads the coordinator's conversation only when its stamp differs from the tools served now.
export async function readCoordinatorTools(paseo: Sdk, stamps: Pick<CoordinatorToolStamps, "stamp" | "fingerprint" | "staleness">,
  row: Pick<SessionRow, "id" | "status" | "serverId" | "provider"> | undefined): Promise<CoordinatorTools | undefined> {
  if (!row || row.serverId) return undefined;
  const stamp = stamps.stamp(row.id);
  if (!stamp || !stamps.fingerprint || stamp.fingerprint === stamps.fingerprint) return undefined;
  let session: string | null;
  try { session = await providerSession(paseo, row.id); } catch { return undefined; }
  return coordinatorToolsView(stamps.staleness(row.id, session), row);
}
