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
const build = () => {
  const tools = [plan(), audit()];
  const actions = boardActions(tools);
  return { tools, actions, action: boardActionTool(actions), guide: boardGuideTool(actions, guideRevision(actions), async () => "current") };
};

test("board_action runs an action with the installed checks", async () => {
  const { tools, action } = build();
  const direct = await tools[0].execute({ projectId: "alpha" }, context);
  const viaAction = await action.execute({ contract: 1, action: "plan_assignment", input: { projectId: "alpha" } }, context);
  expect(viaAction).toEqual(direct);
  expect(JSON.parse(viaAction.text!)).toEqual({ by: "coordinator-1", input: { projectId: "alpha" } });
  // The installed schema parses the input: trimming applies as it does on a direct call.
  const trimmed = await action.execute({ contract: 1, action: "plan_assignment", input: { projectId: "  alpha " } }, context);
  expect(JSON.parse(trimmed.text!).input).toEqual({ projectId: "alpha" });
  // An action that takes no required input runs without one.
  expect((await action.execute({ contract: 1, action: "audit_board" }, context)).text).toBe("audited all");
  // An error the action throws is the action's own error.
  const failing = boardActionTool(boardActions([coordinatorTool({ name: "refuse", description: "Refuse.", usage: "Refuses.", input: z.strictObject({}),
    execute: () => { throw new Error("코디네이터 지정이 해제되었습니다."); } })]));
  expect(failing.execute({ contract: 1, action: "refuse", input: {} }, context)).rejects.toThrow("코디네이터 지정이 해제되었습니다.");
});

test("a field added after the contract is reachable only through board_action", async () => {
  const { tools, action } = build();
  const withRoute = { projectId: "alpha", route: { model: "model-a" } };
  // The tool definition is the contract, so a direct call cannot carry the new field.
  expect(tools[0].input.safeParse(withRoute).success).toBe(false);
  const result = await action.execute({ contract: 1, action: "plan_assignment", input: withRoute }, context);
  expect(JSON.parse(result.text!).input).toEqual(withRoute);
  // A feature without a tool definition is an action as well.
  expect((await action.execute({ contract: 1, action: "audit_board", input: { depth: 2 } }, context)).text).toBe("audited 2");
});

test("board_action explains an unknown action and a rejected input", async () => {
  const { action } = build();
  const unknown = await action.execute({ contract: 1, action: "constructor", input: {} }, context);
  expect(unknown.isError).toBe(true);
  for (const text of ["plan_assignment", "audit_board", "알 수 없는 보드 기능", "Unknown board action"]) expect(unknown.text).toContain(text);

  const rejected = await action.execute({ contract: 1, action: "plan_assignment", input: { projectId: 3, extra: true } }, context);
  expect(rejected.isError).toBe(true);
  for (const text of ["입력이 지금 보드의 형식과 맞지 않습니다", "does not match", "projectId", "extra", "\"additionalProperties\":false", "\"route\""]) expect(rejected.text).toContain(text);
  // Nothing ran.
  expect(rejected.text).not.toContain("coordinator-1");
  const missing = await action.execute({ contract: 1, action: "plan_assignment" }, context);
  expect(missing.isError).toBe(true);
  expect(missing.text).toContain("projectId");
  expect(rejected.text).not.toContain("—");
});

test("board_action and the guide take an open input and any contract number", () => {
  const { action, guide } = build();
  expect(action.input.safeParse({ contract: 1, action: "x", input: { anything: { nested: [1, "two"] } } }).success).toBe(true);
  // A conversation holding an older or newer definition is not turned away by the input check.
  for (const contract of [1, 2, 40]) {
    expect(action.input.safeParse({ contract, action: "x" }).success).toBe(true);
    expect(guide.input.safeParse({ contract }).success).toBe(true);
  }
  expect(action.input.safeParse({ action: "x" }).success).toBe(false);
  expect(action.input.safeParse({ contract: 1, action: "x", input: [] }).success).toBe(false);
  expect(guide.input.safeParse({ contract: 1, topic: "plan_assignment" }).success).toBe(true);
  const schema = z.toJSONSchema(action.input, { io: "input" }) as any;
  expect(schema.properties.contract.description).toContain("Always 1");
  expect(schema.properties.input.additionalProperties).toEqual({});
});

test("the guide lists actions and describes one", async () => {
  const { actions, guide } = build();
  const overview = JSON.parse((await guide.execute({ contract: 1 }, context)).text!);
  expect(overview.board).toEqual({ contract: 1, guide: guideRevision(actions) });
  expect(overview.conversation.definitions).toBe("current");
  expect(overview.use.join(" ")).toContain("board_action");
  expect(overview.actions).toEqual([
    { name: "plan_assignment", summary: "Plan an assignment.", tool: true, onlyThroughBoardAction: ["route", "route.effort", "route.model"] },
    { name: "audit_board", summary: "List board records that need a check.", tool: false, onlyThroughBoardAction: [] },
  ]);

  const topic = JSON.parse((await guide.execute({ contract: 1, topic: "plan_assignment" }, context)).text!);
  expect(topic.action).toBe("plan_assignment");
  expect(topic.usage).toBe("Pass the selected projectId. Pass route only when the human chose one.");
  expect(topic.tool).toBe(true);
  expect(topic.onlyThroughBoardAction).toEqual(["route", "route.effort", "route.model"]);
  expect(Object.keys(topic.input.properties)).toEqual(["projectId", "route"]);
  expect(JSON.parse((await guide.execute({ contract: 1, topic: "audit_board" }, context)).text!).tool).toBe(false);

  const unknown = await guide.execute({ contract: 1, topic: "toString" }, context);
  expect(unknown.isError).toBe(true);
  for (const text of ["plan_assignment", "audit_board"]) expect(unknown.text).toContain(text);
});

test("the guide says when the conversation's definitions are older, or cannot be told", async () => {
  const actions = boardActions([plan()]);
  const read = async (definitions: "current" | "older" | "unknown") =>
    JSON.parse((await boardGuideTool(actions, "rev", async () => definitions).execute({ contract: 1 }, context)).text!).conversation;
  expect((await read("older")).note).toContain("board_action");
  expect((await read("older")).note).toContain("older");
  expect((await read("unknown")).definitions).toBe("unknown");
  // A failed lookup is not a failed guide.
  const failing = boardGuideTool(actions, "rev", async () => { throw new Error("offline"); });
  expect(JSON.parse((await failing.execute({ contract: 1 }, context)).text!).conversation.definitions).toBe("unknown");
});

test("the guide revision follows usage and accepted input, not order", () => {
  const base = guideRevision(boardActions([plan(), audit()]));
  expect(base).toMatch(/^[a-f0-9]{12}$/);
  expect(guideRevision(boardActions([audit(), plan()]))).toBe(base);
  const reworded = coordinatorTool({ ...plan(), usage: "Pass the selected projectId." });
  expect(guideRevision(boardActions([reworded, audit()]))).not.toBe(base);
  const widened = coordinatorTool({ ...audit(), usage: audit().usage!, accepts: z.strictObject({ depth: z.number().optional(), since: z.string().optional() }) });
  expect(guideRevision(boardActions([plan(), widened]))).not.toBe(base);
  expect(guideRevision(boardActions([plan(), audit()]), 2)).not.toBe(base);
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
