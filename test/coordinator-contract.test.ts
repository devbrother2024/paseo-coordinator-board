import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contribute from "../index.server";
import { contractSurface } from "../server/coordinator-tools";
import { boardActionName, boardGuideName, coordinatorContract } from "../shared/coordinator-contract";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const snapshotPath = join(import.meta.dir, "fixtures", "coordinator-contract.json");
const changed = [
  "The coordinator tool contract changed: a tool name or an input format differs from test/fixtures/coordinator-contract.json.",
  "Running coordinator conversations keep the definitions they loaded, so this would ask every user to replace their coordinator.",
  "- To add a field or a feature, leave the tool's input as it is and put the field in the tool's `accepts` schema (or add an `actionOnly` tool).",
  "  It is then reachable through board_action and listed by read_board_guide, with no change for running conversations.",
  "- If the contract really has to break, raise coordinatorContract.version in shared/coordinator-contract.ts (and compatibleFrom when older",
  "  conversations cannot keep working), describe the change in README.md and OVERVIEW.md, then regenerate the snapshot with",
  "  UPDATE_COORDINATOR_CONTRACT=1 bun test test/coordinator-contract.test.ts",
  "코디네이터 도구 계약이 바뀌었습니다. 새 항목은 도구의 accepts(확장 길)로 내거나, 정말 깨야 하면 계약 버전을 올리고 README에 적으세요.",
].join("\n");

// The tools the real plugin hands to its coordinator.
async function coordinatorTools() {
  const root = mkdtempSync(join(tmpdir(), "board-contract-")); roots.push(root);
  const data = join(root, "plugin-data", "coordinator-board"); mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "scope.json"), JSON.stringify({ projects: ["alpha"], coordinator: "coordinator-1", judgments: {} }));
  const hooks: Array<(event: any) => any> = [];
  const old = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
  try {
    contribute({ handle() {}, registerSettings() {}, addHook: (name: string, hook: any) => { if (name === "agent.open.before") hooks.push(hook); return () => {}; } } as never);
  } finally { if (old === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = old; }
  const request = { purpose: "interactive", agentId: "coordinator-1", tools: [], metadata: {} };
  const opened = (await Promise.all(hooks.map(hook => hook({ request })))).flatMap(result => result?.tools ?? []);
  return opened as any[];
}

test("the coordinator tool contract matches its snapshot", async () => {
  const tools = await coordinatorTools();
  const surface = contractSurface(tools)!;
  const saved = existsSync(snapshotPath) ? JSON.parse(readFileSync(snapshotPath, "utf8")) : undefined;
  if (process.env.UPDATE_COORDINATOR_CONTRACT === "1") {
    const same = saved && JSON.stringify(saved.tools) === JSON.stringify(surface);
    if (saved && !same && saved.version === coordinatorContract.version) {
      throw new Error("Raise coordinatorContract.version before regenerating the contract snapshot.");
    }
    mkdirSync(join(import.meta.dir, "fixtures"), { recursive: true });
    writeFileSync(snapshotPath, JSON.stringify({ version: coordinatorContract.version, tools: surface }, null, 2) + "\n");
    return;
  }
  expect(saved, changed).toBeDefined();
  expect(saved.version, changed).toBe(coordinatorContract.version);
  expect(surface, changed).toEqual(saved.tools);
  expect(coordinatorContract.compatibleFrom).toBeLessThanOrEqual(coordinatorContract.version);
});

test("contract 1 keeps the seven board tools and adds the guide and the action tool", async () => {
  const names = (await coordinatorTools()).map(tool => tool.name);
  expect(names).toEqual([
    "read_board_conversation", "classify_board_conversation", "plan_board_assignment", "assign_board_worker", "answer_board_fact",
    "review_board_records", "judge_board_pull", boardGuideName, boardActionName,
  ]);
});

test("every board tool is an action, and the guide repeats the tool's own description", async () => {
  const tools = await coordinatorTools();
  const guide = tools.find(tool => tool.name === boardGuideName);
  const context = { agent: { id: "coordinator-1", provider: "codex" }, paseo: {} };
  const overview = JSON.parse((await guide.execute({}, context)).text);
  const named = tools.filter(tool => tool.name !== boardGuideName && tool.name !== boardActionName);
  // Actions with no tool definition of their own run through board_action only. They come after the tools.
  const onlyActions = ["judge_open_question", "list_open_questions"];
  expect(overview.actions.map((action: any) => action.name)).toEqual([...named.map(tool => tool.name), ...onlyActions]);
  expect(overview.actions.filter((action: any) => action.tool === false).map((action: any) => action.name)).toEqual(onlyActions);
  // An action only through board_action gives the guide a revision, so a running conversation is told to read it once.
  expect(overview.board).toEqual({ contract: coordinatorContract.version, guide: expect.stringMatching(/^[0-9a-f]{12}$/) });
  for (const tool of named) {
    const topic = JSON.parse((await guide.execute({ topic: tool.name }, context)).text);
    // The descriptions keep their full guidance, so a new conversation misses no rule.
    expect(tool.description.length).toBeGreaterThan(150);
    expect(topic.usage).toBe(tool.description);
    expect(topic.input.type).toBe("object");
    expect(topic.onlyThroughBoardAction).toEqual([]);
  }
});

test("the assignment route fields pass through board_action", async () => {
  const tools = await coordinatorTools();
  const action = tools.find(tool => tool.name === boardActionName);
  const job = {
    projectId: "alpha", workspaceId: "workspace-1", grade: "B", title: "Check subtitles", prompt: "Check the subtitle timing.",
    requestKey: "request-key-0001", expectedHostId: "host-a",
    expectedRoute: { provider: "provider-a", model: "model-a", effort: null }, routeSource: "coordinator",
  };
  // Another session gets the tool's own refusal, which means the input passed the installed checks.
  const outsider = { agent: { id: "worker-1", provider: "codex" }, paseo: {} };
  expect(action.execute({ action: "assign_board_worker", input: { job } }, outsider))
    .rejects.toThrow("현재 지정된 코디네이터만 작업을 배정할 수 있습니다.");
  // A value the installed board does not accept is refused before anything runs.
  const refused = await action.execute({ action: "assign_board_worker", input: { job: { ...job, routeSource: "worker" } } }, outsider);
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("job.routeSource");
  expect(refused.text).toContain("\"routeSource\"");
});
