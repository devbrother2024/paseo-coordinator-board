import { createHash } from "node:crypto";
import { defineAgentTool, type AgentToolContext, type AgentToolDefinition, type AgentToolResult } from "@getpaseo/plugin/server";
import { z } from "zod";
import { boardActionName, boardGuideName, coordinatorContract } from "../shared/coordinator-contract";

// A coordinator tool as the board keeps it. `input` is the contract: what a conversation loaded and
// keeps. `accepts` is what the installed board takes for the same action, which may have grown since.
// `usage` is the detailed guidance, served by the guide so that an update reaches running conversations.
// An `actionOnly` tool has no definition of its own and runs through board_action alone.
export type CoordinatorTool = AgentToolDefinition & { usage?: string; accepts?: z.ZodType; actionOnly?: boolean };

export function coordinatorTool<Input extends z.ZodType, Accepts extends z.ZodType = Input>(tool: {
  name: string; title?: string; description: string; usage: string; input: Input; accepts?: Accepts; actionOnly?: boolean;
  execute(input: z.output<Accepts>, context: AgentToolContext): AgentToolResult | Promise<AgentToolResult>;
}): CoordinatorTool {
  const { usage, accepts, actionOnly, ...definition } = tool;
  return {
    ...defineAgentTool(definition as Parameters<typeof defineAgentTool>[0]), usage,
    ...(accepts ? { accepts } : {}), ...(actionOnly ? { actionOnly } : {}),
  };
}

export type BoardAction = {
  name: string; summary: string; usage: string; accepts: z.ZodType; tool: boolean;
  // Fields the installed board accepts that the tool definition does not list.
  beyond: string[];
  execute: AgentToolDefinition["execute"];
};
export type Definitions = "current" | "older" | "unknown";

const schemaOf = (input: z.ZodType) => z.toJSONSchema(input, { io: "input", unrepresentable: "any" });

// Every field path a JSON Schema describes: "job", "job.route", "job.tags[].label".
export function inputPaths(schema: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, prefix: string) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    const part = node as Record<string, unknown>;
    if (part.properties && typeof part.properties === "object") {
      for (const [name, child] of Object.entries(part.properties)) {
        const path = prefix ? `${prefix}.${name}` : name;
        found.add(path);
        walk(child, path);
      }
    }
    walk(part.items, `${prefix}[]`);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const branches = part[key];
      if (Array.isArray(branches)) for (const branch of branches) walk(branch, prefix);
    }
  };
  walk(schema, "");
  return [...found].sort();
}

export function boardActions(tools: readonly CoordinatorTool[]): Map<string, BoardAction> {
  const actions = new Map<string, BoardAction>();
  for (const tool of tools) {
    if (actions.has(tool.name) || tool.name === boardActionName || tool.name === boardGuideName) throw new Error(`Duplicate board action: ${tool.name}`);
    const accepts = tool.accepts ?? tool.input;
    const listed = new Set(inputPaths(schemaOf(tool.input)));
    actions.set(tool.name, {
      name: tool.name, summary: tool.description, usage: tool.usage ?? tool.description, accepts, tool: !tool.actionOnly,
      beyond: tool.actionOnly ? [] : inputPaths(schemaOf(accepts)).filter(path => !listed.has(path)),
      execute: tool.execute,
    });
  }
  return actions;
}

const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted((value as Record<string, unknown>)[key])]))
  : value;

// Changes when the guidance or the accepted input of any action changes. A conversation that read
// another revision is told once to read the guide again.
export function guideRevision(actions: ReadonlyMap<string, BoardAction>, contract: number = coordinatorContract.version): string {
  const described = [...actions.values()].sort((a, b) => a.name.localeCompare(b.name))
    .map(action => [action.name, action.summary, action.usage, action.tool, sorted(schemaOf(action.accepts))]);
  return createHash("sha256").update(JSON.stringify([contract, described])).digest("hex").slice(0, 12);
}

// The contract number written in the definition the calling conversation holds. The description
// carries the number, and the format takes any, so a call from an older definition still arrives.
const contractField = () => z.number().int().positive()
  .describe(`Always ${coordinatorContract.version}. The contract number of this tool definition, so the board knows which definitions this conversation holds.`);
const names = (actions: ReadonlyMap<string, BoardAction>) => [...actions.keys()].join(", ");

export function heldContract(input: unknown): number | undefined {
  const value = input && typeof input === "object" ? (input as { contract?: unknown }).contract : undefined;
  return typeof value === "number" ? value : undefined;
}

export function boardActionTool(actions: ReadonlyMap<string, BoardAction>): CoordinatorTool {
  return defineAgentTool({
    name: boardActionName,
    description: "Run a board action by name with the installed board's own input checks. Use it for an action, or an input field, that the tool definitions in this conversation do not have. "
      + `${boardGuideName} lists the actions and what each accepts now. This grants nothing beyond the board's named tools.`,
    input: z.strictObject({
      contract: contractField(),
      action: z.string().min(1).max(64).describe(`An action name from ${boardGuideName}.`),
      input: z.record(z.string(), z.unknown()).optional().describe("The action's input. Its fields are checked by the installed board, not by this definition."),
    }),
    async execute({ action, input }, context) {
      const entry = actions.get(action);
      if (!entry) {
        return { isError: true, text: `알 수 없는 보드 기능입니다: ${action}. 쓸 수 있는 기능: ${names(actions)} / Unknown board action: ${action}. Available actions: ${names(actions)}` };
      }
      const parsed = await entry.accepts.safeParseAsync(input ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 12).map(issue => `- ${issue.path.join(".") || "(input)"}: ${issue.message}`).join("\n");
        return { isError: true, text: `${action}의 입력이 지금 보드의 형식과 맞지 않습니다. / The input for ${action} does not match what the installed board accepts.\n${issues}\n`
          + `Current input schema: ${JSON.stringify(schemaOf(entry.accepts))}` };
      }
      return entry.execute(parsed.data, context);
    },
  });
}

const conversationNotes: Record<Definitions, string> = {
  current: "The tool definitions in this conversation match the installed contract. Fields under onlyThroughBoardAction exist only through board_action.",
  older: "Some board tool definitions in this conversation are older than the installed board. They keep working as they are. "
    + "For an action you use, read its topic and compare the input schema with the definition you hold; pass any field yours lacks through board_action. Nothing needs replacing.",
  unknown: "The board cannot tell which definitions this conversation holds. If a field in an action's input schema is missing from the definition you hold, pass it through board_action.",
};

export function boardGuideTool(actions: ReadonlyMap<string, BoardAction>, revision: string,
  definitions: (context: AgentToolContext) => Promise<Definitions> = async () => "unknown"): CoordinatorTool {
  return defineAgentTool({
    name: boardGuideName,
    description: "Read what the installed board accepts now: its actions, each one's detailed usage and current input schema, and what changed since this conversation received its board tools. "
      + "Without a topic, list the actions. With an action name as topic, describe that action. Read it once per conversation, and again when a board tool result says the guide changed.",
    input: z.strictObject({
      contract: contractField(),
      topic: z.string().min(1).max(64).optional().describe("An action name. Omit it for the list."),
    }),
    async execute({ topic }, context) {
      if (topic !== undefined) {
        const action = actions.get(topic);
        if (!action) return { isError: true, text: `알 수 없는 안내 주제입니다: ${topic}. 쓸 수 있는 주제: ${names(actions)} / Unknown guide topic: ${topic}. Available topics: ${names(actions)}` };
        return { text: JSON.stringify({
          action: action.name, summary: action.summary, usage: action.usage, tool: action.tool,
          onlyThroughBoardAction: action.beyond, input: schemaOf(action.accepts),
        }) };
      }
      const held = await definitions(context).catch((): Definitions => "unknown");
      return { text: JSON.stringify({
        board: { contract: coordinatorContract.version, guide: revision },
        conversation: { definitions: held, note: conversationNotes[held] },
        use: [
          "Call the board's named tools as this conversation defines them.",
          `${boardActionName}({ contract, action, input }) runs any action below with the installed board's checks. Use it for an action without a tool, or for a field your tool definition lacks.`,
          `${boardGuideName}({ contract, topic: "<action>" }) returns that action's detailed usage and current input schema. Read the topic before you first use an action.`,
          "A result and its permission checks are the same through either path.",
        ],
        actions: [...actions.values()].map(action => ({ name: action.name, summary: action.summary, tool: action.tool, onlyThroughBoardAction: action.beyond })),
      }) };
    },
  });
}
