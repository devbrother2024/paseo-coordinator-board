import { expect, test } from "bun:test";
import { z } from "zod";
import { boardActionTool, boardActions, boardGuideTool, coordinatorTool, guideRevision, inputPaths } from "../server/board-guide";

const context = { agent: { id: "coordinator-1", provider: "claude" }, paseo: {} } as any;

// The tool definition a conversation holds takes projectId only. The installed board also accepts a route.
const plan = () => coordinatorTool({
  name: "plan_assignment", description: "Plan an assignment.", usage: "Pass the selected projectId. Pass route only when the human chose one.",
  input: z.strictObject({ projectId: z.string().min(1) }),
  accepts: z.strictObject({ projectId: z.string().trim().min(1), route: z.strictObject({ model: z.string(), effort: z.string().nullable().optional() }).optional() }),
  execute: (input, { agent }) => ({ text: JSON.stringify({ by: agent.id, input }) }),
});
// A feature the board added without a tool definition of its own.
const audit = () => coordinatorTool({
  name: "audit_board", description: "List board records that need a check.", usage: "Pass depth to limit the listing.", actionOnly: true,
  input: z.strictObject({ depth: z.number().int().positive().optional() }),
  execute: input => ({ text: `audited ${input.depth ?? "all"}` }),
});
const exact_other = () => coordinatorTool({ name: "read_board", description: "List.", input: z.strictObject({}), execute: () => ({ text: "[]" }) });
const build = () => {
  const tools = [plan(), audit()];
  const actions = boardActions(tools);
  return { tools, actions, action: boardActionTool(actions), guide: boardGuideTool(actions, guideRevision(actions), async () => "current") };
};

test("board_action runs an action with the installed checks", async () => {
  const { tools, action } = build();
  const direct = await tools[0].execute({ projectId: "alpha" }, context);
  const viaAction = await action.execute({ action: "plan_assignment", input: { projectId: "alpha" } }, context);
  expect(viaAction).toEqual(direct);
  expect(JSON.parse(viaAction.text!)).toEqual({ by: "coordinator-1", input: { projectId: "alpha" } });
  // The installed schema parses the input: trimming applies as it does on a direct call.
  const trimmed = await action.execute({ action: "plan_assignment", input: { projectId: "  alpha " } }, context);
  expect(JSON.parse(trimmed.text!).input).toEqual({ projectId: "alpha" });
  // An action that takes no required input runs without one.
  expect((await action.execute({ action: "audit_board" }, context)).text).toBe("audited all");
  // An error the action throws is the action's own error.
  const failing = boardActionTool(boardActions([coordinatorTool({ name: "refuse", description: "Refuse.", usage: "Refuses.", input: z.strictObject({}),
    execute: () => { throw new Error("코디네이터 지정이 해제되었습니다."); } })]));
  expect(failing.execute({ action: "refuse", input: {} }, context)).rejects.toThrow("코디네이터 지정이 해제되었습니다.");
});

test("a field added after the contract is reachable only through board_action", async () => {
  const { tools, action } = build();
  const withRoute = { projectId: "alpha", route: { model: "model-a" } };
  // The tool definition is the contract, so a direct call cannot carry the new field.
  expect(tools[0].input.safeParse(withRoute).success).toBe(false);
  const result = await action.execute({ action: "plan_assignment", input: withRoute }, context);
  expect(JSON.parse(result.text!).input).toEqual(withRoute);
  // A feature without a tool definition is an action as well.
  expect((await action.execute({ action: "audit_board", input: { depth: 2 } }, context)).text).toBe("audited 2");
});

test("board_action explains an unknown action and a rejected input", async () => {
  const { action } = build();
  const unknown = await action.execute({ action: "constructor", input: {} }, context);
  expect(unknown.isError).toBe(true);
  for (const text of ["plan_assignment", "audit_board", "알 수 없는 보드 기능", "Unknown board action"]) expect(unknown.text).toContain(text);

  const rejected = await action.execute({ action: "plan_assignment", input: { projectId: 3, extra: true } }, context);
  expect(rejected.isError).toBe(true);
  for (const text of ["입력이 지금 보드의 형식과 맞지 않습니다", "does not match", "projectId", "extra", "\"additionalProperties\":false", "\"route\""]) expect(rejected.text).toContain(text);
  // Nothing ran.
  expect(rejected.text).not.toContain("coordinator-1");
  const missing = await action.execute({ action: "plan_assignment" }, context);
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain("projectId");
  expect(rejected.text).not.toContain("—");
});

test("board_action and the guide take an open input and ask the model for nothing else", () => {
  const { action, guide } = build();
  expect(action.input.safeParse({ action: "x", input: { anything: { nested: [1, "two"] } } }).success).toBe(true);
  expect(action.input.safeParse({ action: "x" }).success).toBe(true);
  expect(action.input.safeParse({ action: "x", input: [] }).success).toBe(false);
  expect(action.input.safeParse({ input: {} }).success).toBe(false);
  expect(guide.input.safeParse({}).success).toBe(true);
  expect(guide.input.safeParse({ topic: "plan_assignment" }).success).toBe(true);
  const schema = z.toJSONSchema(action.input, { io: "input" }) as any;
  expect(Object.keys(schema.properties).sort()).toEqual(["action", "input"]);
  expect(schema.properties.input.additionalProperties).toEqual({});
  expect(Object.keys((z.toJSONSchema(guide.input, { io: "input" }) as any).properties)).toEqual(["topic"]);
});

test("the guide lists actions and describes one", async () => {
  const { actions, guide } = build();
  const overview = JSON.parse((await guide.execute({}, context)).text!);
  expect(overview.board).toEqual({ contract: 1, guide: guideRevision(actions) });
  expect(overview.conversation.definitions).toBe("current");
  expect(overview.use.join(" ")).toContain("board_action");
  expect(overview.actions).toEqual([
    { name: "plan_assignment", summary: "Plan an assignment.", tool: true, onlyThroughBoardAction: ["route", "route.effort", "route.model"] },
    { name: "audit_board", summary: "List board records that need a check.", tool: false, onlyThroughBoardAction: [] },
  ]);

  const topic = JSON.parse((await guide.execute({ topic: "plan_assignment" }, context)).text!);
  expect(topic.action).toBe("plan_assignment");
  expect(topic.usage).toBe("Pass the selected projectId. Pass route only when the human chose one.");
  // Without separate usage text, the tool's own description is the usage.
  expect(JSON.parse((await boardGuideTool(boardActions([exact_other()]), "", async () => "current").execute({ topic: "read_board" }, context)).text!).usage).toBe("List.");
  expect(topic.tool).toBe(true);
  expect(topic.onlyThroughBoardAction).toEqual(["route", "route.effort", "route.model"]);
  expect(Object.keys(topic.input.properties)).toEqual(["projectId", "route"]);
  expect(JSON.parse((await guide.execute({ topic: "audit_board" }, context)).text!).tool).toBe(false);

  const unknown = await guide.execute({ topic: "toString" }, context);
  expect(unknown.isError).toBe(true);
  for (const text of ["plan_assignment", "audit_board"]) expect(unknown.text).toContain(text);
});

test("the guide says when the conversation's definitions are older, or cannot be told", async () => {
  const actions = boardActions([plan()]);
  const read = async (definitions: "current" | "older" | "unknown") =>
    JSON.parse((await boardGuideTool(actions, "rev", async () => definitions).execute({}, context)).text!).conversation;
  expect((await read("current")).note).toContain("onlyThroughBoardAction");
  expect((await read("older")).note).toContain("board_action");
  expect((await read("older")).note).toContain("older");
  expect((await read("unknown")).definitions).toBe("unknown");
  // A failed lookup is not a failed guide.
  const failing = boardGuideTool(actions, "rev", async () => { throw new Error("offline"); });
  expect(JSON.parse((await failing.execute({}, context)).text!).conversation.definitions).toBe("unknown");
});

test("the guide revision follows what only board_action can reach, not wording or order", () => {
  // With nothing beyond the tool definitions there is nothing for a conversation to learn.
  const exact = coordinatorTool({ name: "plan_assignment", description: "Plan an assignment.", input: z.strictObject({ projectId: z.string() }), execute: () => ({}) });
  expect(guideRevision(boardActions([exact]))).toBe("");
  expect(guideRevision(boardActions([coordinatorTool({ ...exact, description: "Plan where a worker runs.", usage: "Pass the selected projectId." })]))).toBe("");

  const base = guideRevision(boardActions([plan(), exact_other()]));
  expect(base).toMatch(/^[a-f0-9]{12}$/);
  expect(guideRevision(boardActions([exact_other(), plan()]))).toBe(base);
  // Rewording a description, usage text or a field description is not news.
  const reworded = coordinatorTool({ ...plan(), description: "Plan where a worker runs.", usage: "Pass the selected projectId.",
    accepts: z.strictObject({ projectId: z.string().trim().min(1), route: z.strictObject({ model: z.string().describe("The model ID."), effort: z.string().nullable().optional() }).optional() }) });
  expect(guideRevision(boardActions([reworded, exact_other()]))).toBe(base);
  // Another accepted field, and a feature without a tool definition, are.
  const widened = coordinatorTool({ ...plan(), accepts: z.strictObject({ projectId: z.string().trim().min(1), route: z.strictObject({ model: z.string(), effort: z.string().nullable().optional() }).optional(), host: z.string().optional() }) });
  expect(guideRevision(boardActions([widened, exact_other()]))).not.toBe(base);
  expect(guideRevision(boardActions([plan(), exact_other(), audit()]))).not.toBe(base);
});

test("action names are unique and never shadow the contract tools", () => {
  expect(() => boardActions([plan(), plan()])).toThrow("plan_assignment");
  for (const name of ["board_action", "read_board_guide"]) {
    expect(() => boardActions([coordinatorTool({ name, description: "x", usage: "x", input: z.object({}), execute: () => ({}) })])).toThrow(name);
  }
});

test("input paths list every nested field once", () => {
  const schema = z.toJSONSchema(z.strictObject({
    job: z.strictObject({ title: z.string(), route: z.object({ model: z.string() }).optional(), tags: z.array(z.object({ label: z.string() })).optional() }),
    choice: z.union([z.object({ a: z.string() }), z.object({ b: z.string() })]).optional(),
  }), { io: "input" });
  expect(inputPaths(schema)).toEqual(["choice", "choice.a", "choice.b", "job", "job.route", "job.route.model", "job.tags", "job.tags[].label", "job.title"]);
  expect(inputPaths({})).toEqual([]);
});
