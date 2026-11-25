import { createHash } from "node:crypto";
import { defineAgentTool, type AgentToolContext, type AgentToolDefinition, type AgentToolResult } from "@getpaseo/plugin/server";
import { z } from "zod";
import { boardActionName, boardGuideName, coordinatorContract } from "../shared/coordinator-contract";

// A coordinator tool as the board keeps it. `input` is the contract: what a conversation loaded and
// keeps. `accepts` is what the installed board takes for the same action, which may have grown since.
// `usage` is guidance beyond the description, for what only board_action reaches: the guide serves it.
// An `actionOnly` tool has no definition of its own and runs through board_action alone.
export type CoordinatorTool = AgentToolDefinition & { usage?: string; accepts?: z.ZodType; actionOnly?: boolean };

export function coordinatorTool<Input extends z.ZodType, Accepts extends z.ZodType = Input>(tool: {
  name: string; title?: string; description: string; usage?: string; input: Input; accepts?: Accepts; actionOnly?: boolean;
  execute(input: z.output<Accepts>, context: AgentToolContext): AgentToolResult | Promise<AgentToolResult>;
}): CoordinatorTool {
  const { usage, accepts, actionOnly, ...definition } = tool;
  return {
    ...defineAgentTool(definition as Parameters<typeof defineAgentTool>[0]),
    ...(usage ? { usage } : {}), ...(accepts ? { accepts } : {}), ...(actionOnly ? { actionOnly } : {}),
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

// What a conversation cannot learn from its own tool definitions: actions without a definition, and
// actions that accept more than their definition lists. Empty while there is none. It changes when
// one appears or its accepted input changes, and a conversation that read another revision is told
// once to read the guide. Wording is not part of it.
export function guideRevision(actions: ReadonlyMap<string, BoardAction>): string {
  const beyond = [...actions.values()].filter(action => !action.tool || action.beyond.length).sort((a, b) => a.name.localeCompare(b.name))
    .map(action => [action.name, action.tool, inputShape(schemaOf(action.accepts))]);
  return beyond.length ? createHash("sha256").update(JSON.stringify(beyond)).digest("hex").slice(0, 12) : "";
}

const names = (actions: ReadonlyMap<string, BoardAction>) => [...actions.keys()].join(", ");

export function boardActionTool(actions: ReadonlyMap<string, BoardAction>): CoordinatorTool {
  return defineAgentTool({
    name: boardActionName,
    description: "Run a board action by name with the installed board's own input checks. Use it for an action, or an input field, that the tool definitions in this conversation do not have. "
      + `${boardGuideName} lists the actions and what each accepts now. This grants nothing beyond the board's named tools.`,
    input: z.strictObject({
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
    description: "Read what the installed board accepts now, and what it added since this conversation received its board tools: actions without a tool of their own, and input fields that the tool definitions here do not list. "
      + `Without a topic, list the actions. With an action name as topic, return that action's usage and current input schema. Read it when a board tool result says so, and before using ${boardActionName}.`,
    input: z.strictObject({
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
          `${boardActionName}({ action, input }) runs any action below with the installed board's checks. Use it for an action without a tool, or for a field your tool definition lacks.`,
          `${boardGuideName}({ topic: "<action>" }) returns that action's usage and current input schema. Read it before passing a field under onlyThroughBoardAction or running an action with tool: false.`,
          "A result and its permission checks are the same through either path.",
        ],
        actions: [...actions.values()].map(action => ({ name: action.name, summary: action.summary, tool: action.tool, onlyThroughBoardAction: action.beyond })),
      }) };
    },
  });
}
