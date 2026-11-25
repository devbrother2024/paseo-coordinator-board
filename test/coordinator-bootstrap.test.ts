import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCoordinatorTools, notDesignatedYet } from "../server/coordinator";
import { ConversationReader } from "../server/conversation";
import {
  bootstrapFileName, cleanBootstrapText, coordinatorOwnerKey, coordinatorStartPrompt, maxBootstrapChars, readBootstrapExtra, retiredCoordinator, retiredState,
} from "../server/coordinator-bootstrap";
import { CoordinatorLifecycle } from "../server/lifecycle";
import { PreferenceStore, setCoordinator } from "../server/preferences";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "coordinator-bootstrap-"));
  paths.push(dir);
  return dir;
}

test("with no coordinator to take over from and no host instructions there is no first prompt", () => {
  expect(coordinatorStartPrompt({ language: "ko", previous: null })).toBeNull();
  expect(coordinatorStartPrompt({ language: "en", previous: null, openCards: { decisions: 2, ledger: 1 } })).toBeNull();
});

test.each(["ko", "en"] as const)("the %s handover prompt is marked as board text and names the previous coordinator and the reading tool", language => {
  const prompt = coordinatorStartPrompt({ language, previous: "old-coordinator", openCards: { decisions: 3, ledger: 2 } })!;
  const [first, second] = prompt.split("\n");
  expect(first).toBe(language === "ko" ? "[Coordinator Board · 코디네이터 시작]" : "[Coordinator Board · Coordinator start]");
  expect(second).toMatch(language === "ko" ? /사용자가 쓴 글이 아니며.*승인/ : /not the person's words.*approval/);
  expect(prompt).toContain(`read_board_conversation`);
  expect(prompt).toContain(`sessionId "old-coordinator"`);
  expect(prompt).toContain(language === "ko" ? "열린 내 결정 3건, 원장 카드 2건" : "3 open decisions and 2 ledger cards");
  expect(prompt).not.toContain(bootstrapFileName);
});

test("an unknown card count leaves the count line out instead of guessing", () => {
  const prompt = coordinatorStartPrompt({ language: "ko", previous: "old-coordinator", openCards: null })!;
  expect(prompt).toContain("old-coordinator");
  expect(prompt).not.toContain("원장 카드");
  expect(coordinatorStartPrompt({ language: "en", previous: "old", openCards: { decisions: 1, ledger: 1 } })).toContain("1 open decision and 1 ledger card.");
});

test("host instructions go last, also on a first coordinator, and a cut file says so", () => {
  const extra = { text: "Read the operating checklist first.", truncated: false };
  const first = coordinatorStartPrompt({ language: "en", previous: null, extra })!;
  expect(first.startsWith("[Coordinator Board · Coordinator start]")).toBe(true);
  expect(first).not.toContain("read_board_conversation");
  expect(first.endsWith("Read the operating checklist first.")).toBe(true);
  const handover = coordinatorStartPrompt({ language: "ko", previous: "old", openCards: { decisions: 0, ledger: 0 }, extra: { ...extra, truncated: true } })!;
  expect(handover.indexOf("old")).toBeLessThan(handover.indexOf(extra.text));
  expect(handover.endsWith(`(앞 ${maxBootstrapChars}자만 붙였습니다.)`)).toBe(true);
});

test("host instructions lose control and direction characters and are capped", () => {
  expect(cleanBootstrapText("\ufeff  line one\r\nline\u0007 two\u202e\u2066\r  ")).toEqual({ text: "line one\nline two", truncated: false });
  expect(cleanBootstrapText(" \n\t\u200f ")).toBeNull();
  const long = cleanBootstrapText("가".repeat(maxBootstrapChars + 10))!;
  expect(long).toEqual({ text: "가".repeat(maxBootstrapChars), truncated: true });
  // A character outside the basic plane is never split in half.
  expect(Array.from(cleanBootstrapText("😀".repeat(maxBootstrapChars + 1))!.text)).toHaveLength(maxBootstrapChars);
  expect(cleanBootstrapText("short", true)).toEqual({ text: "short", truncated: true });
});

test("the host instruction file is optional: missing, a folder or empty is ignored", () => {
  const dir = folder();
  expect(readBootstrapExtra(dir)).toBeNull();
  mkdirSync(join(dir, bootstrapFileName));
  expect(readBootstrapExtra(dir)).toBeNull();
  const other = folder();
  writeFileSync(join(other, bootstrapFileName), "   \n");
  expect(readBootstrapExtra(other)).toBeNull();
  writeFileSync(join(other, bootstrapFileName), "Follow the start checklist.\n");
  expect(readBootstrapExtra(other)).toEqual({ text: "Follow the start checklist.", truncated: false });
  writeFileSync(join(other, bootstrapFileName), "x".repeat(200_000));
  expect(readBootstrapExtra(other)).toEqual({ text: "x".repeat(maxBootstrapChars), truncated: true });
});

test("only the coordinator a board replacement retired is offered, while the created session is still in place", () => {
  const config = { provider: "codex/fixture-model" };
  const created = { id: "new", previous: "old", workspaceId: "ops", config };
  expect(retiredCoordinator({ coordinator: "new", createdCoordinator: created })).toBe("old");
  expect(retiredCoordinator({ coordinator: "picked-by-person", createdCoordinator: created })).toBeNull();
  expect(retiredCoordinator({ coordinator: null, createdCoordinator: created })).toBeNull();
  expect(retiredCoordinator({ coordinator: "new", createdCoordinator: { ...created, previous: null } })).toBeNull();
  expect(retiredCoordinator({ coordinator: "new", createdCoordinator: { ...created, previous: "new" } })).toBeNull();
  expect(retiredCoordinator({ coordinator: "new" })).toBeNull();
});

const mine = { metadata: { [coordinatorOwnerKey]: true } };
test("a running or waiting retired coordinator cannot be archived, and a gone or archived one is not shown", () => {
  expect(retiredState("old", { ...mine, id: "old", status: "idle", attentionReason: "permission" })).toEqual({ id: "old", archivable: false, reason: "waiting" });
  expect(retiredState("old", { ...mine, id: "old", status: "idle", attentionReason: "finished" })).toEqual({ id: "old", archivable: true });
  // A session the person picked by hand is not the board's to archive.
  expect(retiredState("old", { id: "old", status: "idle" })).toBeNull();
  expect(retiredState("old", { id: "old", status: "idle", metadata: { [coordinatorOwnerKey]: "yes" } })).toBeNull();
  expect(retiredState("old", { ...mine, id: "old", status: "idle", pendingPermissions: [] })).toEqual({ id: "old", archivable: true });
  expect(retiredState("old", { ...mine, id: "old", status: "closed" })).toEqual({ id: "old", archivable: true });
  expect(retiredState("old", { ...mine, id: "old", status: "running" })).toEqual({ id: "old", archivable: false, reason: "running" });
  expect(retiredState("old", { ...mine, id: "old", status: "initializing" })).toEqual({ id: "old", archivable: false, reason: "running" });
  expect(retiredState("old", { ...mine, id: "old", status: "idle", activeTurn: { id: "turn" } })).toEqual({ id: "old", archivable: false, reason: "running" });
  expect(retiredState("old", { ...mine, id: "old", status: "idle", pendingPermissions: [{ id: "p" }] })).toEqual({ id: "old", archivable: false, reason: "waiting" });
  expect(retiredState("old", { ...mine, id: "old", status: "idle", archivedAt: "2026-01-01T00:00:00Z" })).toBeNull();
  expect(retiredState("old", null)).toBeNull();
  expect(retiredState("old", { ...mine, id: "other", status: "idle" })).toBeNull();
  expect(retiredState(null, { ...mine, id: "old", status: "idle" })).toBeNull();
});

function lifecycleSetup(openCards?: () => Promise<{ decisions: number; ledger: number }>) {
  const dir = folder();
  const path = join(dir, "scope.json");
  writeFileSync(path, JSON.stringify({ projects: ["team"], coordinator: null, judgments: {} }));
  const prefs = new PreferenceStore(path);
  const lifecycle = new CoordinatorLifecycle(prefs, join(dir, "operate"), openCards && (async () => openCards()));
  const agents = new Map<string, any>(), creations: any[] = [], archived: string[] = [], sent: string[] = [];
  const effects = { afterCreate: async (_id: string) => {} };
  const pages = (entries: unknown[]) => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });
  const ws = {
    id: "operating-workspace", current: () => ({ id: "operating-workspace", title: "ops", pinnedAt: "pinned" }),
    refresh: async () => ({ id: "operating-workspace", title: "ops", pinnedAt: "pinned" }), setTitle: async () => {},
    setPinned: async () => ({ pinnedAt: "pinned" }),
    agents: { create: async (input: any) => {
      creations.push(input);
      agents.set(input.agentId, { id: input.agentId, workspaceId: ws.id, metadata: input.metadata, pendingPermissions: [], status: "idle" });
      await effects.afterCreate(input.agentId);
    } },
  };
  const sdk: any = {
    workspaces: { ref: () => ws, open: async () => ws, list: () => pages([{ id: ws.id }, { id: "repo" }]) },
    agents: {
      list: () => pages([...agents.values()].map(agent => ({ agent, project: { projectKey: agent.workspaceId === ws.id ? "operate" : agent.workspaceId === "elsewhere" ? "unmanaged" : "team" } }))),
      ref: (id: string) => ({
        refresh: async () => agents.has(id) ? { agent: agents.get(id) } : null,
        archive: async () => { archived.push(id); agents.get(id).archivedAt = "2026-01-01T00:00:00Z"; return { archivedAt: "2026-01-01T00:00:00Z" }; },
        send: async (text: string) => { sent.push(text); },
      }),
    },
  };
  return { dir, prefs, lifecycle, agents, creations, archived, sent, sdk, effects };
}
const start = { expectedCoordinator: null, replace: false, config: { provider: "codex/fixture-model", thinkingOptionId: "high" } };

test("a replacement creates the new coordinator with the handover in its creation request and sends nothing else", async () => {
  const f = lifecycleSetup(async () => ({ decisions: 4, ledger: 1 }));
  f.agents.set("old-coordinator", { id: "old-coordinator", workspaceId: "repo", status: "idle", pendingPermissions: [] });
  f.prefs.change(s => setCoordinator(s, "old-coordinator"));
  const result = await f.lifecycle.ensure(f.sdk, { ...start, expectedCoordinator: "old-coordinator", replace: true, language: "en" });
  expect(f.creations).toHaveLength(1);
  expect(f.creations[0].prompt).toStartWith("[Coordinator Board · Coordinator start]");
  expect(f.creations[0].prompt).toContain(`sessionId "old-coordinator"`);
  expect(f.creations[0].prompt).toContain("4 open decisions and 1 ledger card.");
  expect(f.creations[0].config.systemPrompt).toContain("read_board_conversation");
  expect(f.sent).toEqual([]);
  // The old coordinator stays until the person archives it.
  expect(f.archived).toEqual([]);
  expect(f.prefs.read().createdCoordinator).toMatchObject({ id: result.sessionId, previous: "old-coordinator" });
});

test("a failing card count still replaces, without the count line; host instructions are appended", async () => {
  const f = lifecycleSetup(async () => { throw new Error("snapshot unavailable"); });
  writeFileSync(join(f.dir, bootstrapFileName), "Read the start checklist.");
  f.prefs.change(s => setCoordinator(s, "old-coordinator"));
  await f.lifecycle.ensure(f.sdk, { ...start, expectedCoordinator: "old-coordinator", replace: true, language: "ko" });
  expect(f.creations[0].prompt).toContain("old-coordinator");
  expect(f.creations[0].prompt).not.toContain("원장 카드");
  expect(f.creations[0].prompt.endsWith("Read the start checklist.")).toBe(true);
});

test("a first coordinator starts empty unless the host left start instructions", async () => {
  const empty = lifecycleSetup();
  await empty.lifecycle.ensure(empty.sdk, start);
  expect(empty.creations[0].prompt).toBeUndefined();
  const withFile = lifecycleSetup(async () => ({ decisions: 9, ledger: 9 }));
  writeFileSync(join(withFile.dir, bootstrapFileName), "Read the start checklist.");
  await withFile.lifecycle.ensure(withFile.sdk, { ...start, language: "en" });
  expect(withFile.creations[0].prompt).toStartWith("[Coordinator Board · Coordinator start]");
  expect(withFile.creations[0].prompt).not.toContain("read_board_conversation");
  expect(withFile.creations[0].prompt).not.toContain("ledger");
});

async function replaced() {
  const f = lifecycleSetup(async () => ({ decisions: 0, ledger: 0 }));
  // Outside the managed projects, like a coordinator in its operations folder.
  f.agents.set("old-coordinator", { id: "old-coordinator", workspaceId: "elsewhere", status: "idle", pendingPermissions: [], ...mine });
  f.prefs.change(s => setCoordinator(s, "old-coordinator"));
  const result = await f.lifecycle.ensure(f.sdk, { ...start, expectedCoordinator: "old-coordinator", replace: true });
  return { ...f, current: result.sessionId };
}

test("settings offer the retired coordinator and archive it only when the person asks and it is settled", async () => {
  const f = await replaced();
  expect(await f.lifecycle.retired(f.sdk)).toEqual({ id: "old-coordinator", archivable: true });
  f.agents.get("old-coordinator").status = "running";
  expect(await f.lifecycle.retired(f.sdk)).toEqual({ id: "old-coordinator", archivable: false, reason: "running" });
  await expect(f.lifecycle.archiveRetired(f.sdk, "old-coordinator")).rejects.toThrow(/진행 중.*in progress/);
  f.agents.get("old-coordinator").status = "idle";
  await expect(f.lifecycle.archiveRetired(f.sdk, f.current)).rejects.toThrow(/바뀌었습니다/);
  await expect(f.lifecycle.archiveRetired(f.sdk, "someone-else")).rejects.toThrow(/바뀌었습니다/);
  expect(f.archived).toEqual([]);
  await f.lifecycle.archiveRetired(f.sdk, "old-coordinator");
  expect(f.archived).toEqual(["old-coordinator"]);
  expect(await f.lifecycle.retired(f.sdk)).toBeNull();
  expect(f.sent).toEqual([]);
});

test("after the person picks another coordinator, the board no longer offers to archive the earlier one", async () => {
  const f = await replaced();
  f.prefs.change(s => setCoordinator(s, "old-coordinator"));
  expect(await f.lifecycle.retired(f.sdk)).toBeNull();
  await expect(f.lifecycle.archiveRetired(f.sdk, "old-coordinator")).rejects.toThrow(/바뀌었습니다/);
  expect(f.archived).toEqual([]);
});

test("the new coordinator can read the coordinator it replaced; nobody else can read it through the board", async () => {
  const f = await replaced();
  f.agents.set("unmanaged", { id: "unmanaged", workspaceId: "elsewhere", status: "idle", pendingPermissions: [] });
  f.sdk.agents.ref = ((ref) => (id: string) => ({ ...ref(id), timeline: { refetch: async () => ({ epoch: id, entries: [
    { item: { type: "user_message", text: "Please watch PR 12." }, seqEnd: 1 },
    { item: { type: "assistant_message", text: "I will report when checks finish." }, seqEnd: 2 },
  ] }) } }))(f.sdk.agents.ref);
  let hook: any;
  attachCoordinatorTools({ addHook: (_: unknown, h: any) => { hook = h; return () => {}; } } as any, f.prefs, new ConversationReader());
  const tool = async (id: string) => (await hook({ request: { purpose: "interactive", agentId: id, tools: [] } })).tools[0];
  const read = async (caller: string, sessionId: string) => JSON.parse((await (await tool(caller)).execute({ sessionId }, { paseo: f.sdk, agent: { id: caller } })).text);
  const record = await read(f.current, "old-coordinator");
  expect(record).toMatchObject({ sessionId: "old-coordinator", previousCoordinator: true });
  expect(record.turns.map((turn: { text: string }) => turn.text).join(" ")).toContain("PR 12");
  await expect(read(f.current, "unmanaged")).rejects.toThrow("관리 대상");
  // Once the person picks another coordinator, the earlier handover no longer opens the record.
  f.prefs.change(s => setCoordinator(s, "old-coordinator"));
  await expect(read("old-coordinator", "old-coordinator")).rejects.toThrow();
});

test("a coordinator the person picked by hand is not offered for archiving after a replacement", async () => {
  const f = await replaced();
  delete f.agents.get("old-coordinator").metadata;
  expect(await f.lifecycle.retired(f.sdk)).toBeNull();
  await expect(f.lifecycle.archiveRetired(f.sdk, "old-coordinator")).rejects.toThrow(/바뀌었습니다/);
  expect(f.archived).toEqual([]);
});

test("a board tool called from the first prompt before the switch says it is not designated yet, then works", async () => {
  const f = lifecycleSetup(async () => ({ decisions: 0, ledger: 0 }));
  f.agents.set("old-coordinator", { id: "old-coordinator", workspaceId: "elsewhere", status: "idle", pendingPermissions: [], ...mine });
  f.prefs.change(s => setCoordinator(s, "old-coordinator"));
  let hook: any;
  attachCoordinatorTools({ addHook: (_: unknown, h: any) => { hook = h; return () => {}; } } as any, f.prefs, new ConversationReader());
  const list = async (caller: string) => (await (await hook({ request: { purpose: "interactive", agentId: caller, tools: [] } })).tools[0])
    .execute({}, { paseo: f.sdk, agent: { id: caller } });
  const oldTool = (await hook({ request: { purpose: "interactive", agentId: "old-coordinator", tools: [] } })).tools[0];
  let early: unknown;
  f.effects.afterCreate = async id => { early = await list(id).then(() => null, error => error); };
  const result = await f.lifecycle.ensure(f.sdk, { ...start, expectedCoordinator: "old-coordinator", replace: true, language: "en" });
  expect((early as Error).message).toBe(notDesignatedYet);
  expect(notDesignatedYet).toMatch(/지정하기 전.*not designated/);
  expect(f.creations[0].prompt).toContain("Call it again shortly.");
  expect(JSON.parse((await list(result.sessionId)).text)).toEqual([]);
  // A session that is no longer the coordinator keeps the earlier answer.
  await expect(oldTool.execute({}, { paseo: f.sdk, agent: { id: "old-coordinator" } })).rejects.toThrow("해제");
});

async function handoverReader(timeline: (id: string) => Promise<unknown>) {
  const f = await replaced();
  let fetches = 0;
  f.sdk.agents.ref = ((ref) => (id: string) => ({ ...ref(id), timeline: { refetch: async () => { fetches++; return timeline(id); } } }))(f.sdk.agents.ref);
  let hook: any;
  // A fresh reader, as after a plugin restart: nothing cached for the old coordinator.
  attachCoordinatorTools({ addHook: (_: unknown, h: any) => { hook = h; return () => {}; } } as any, f.prefs, new ConversationReader());
  const read = async () => JSON.parse((await (await hook({ request: { purpose: "interactive", agentId: f.current, tools: [] } })).tools[0]
    .execute({ sessionId: "old-coordinator" }, { paseo: f.sdk, agent: { id: f.current } })).text);
  return { ...f, read, fetches: () => fetches };
}
const oldRecord = async (id: string) => ({ epoch: id, entries: [
  { item: { type: "user_message", text: "Please watch PR 12." }, seqEnd: 1 },
  { item: { type: "assistant_message", text: "I will report when checks finish." }, seqEnd: 2 },
] });

test("a closed previous coordinator's record is fetched from Paseo even with nothing cached", async () => {
  const f = await handoverReader(oldRecord);
  f.agents.get("old-coordinator").status = "closed";
  const record = await f.read();
  expect(f.fetches()).toBe(1);
  expect(record).toMatchObject({ sessionId: "old-coordinator", previousCoordinator: true, status: "closed" });
  expect(record.turns.map((turn: { text: string }) => turn.text).join(" ")).toContain("PR 12");
});

test("an unreadable previous record is reported in both languages instead of an empty record", async () => {
  const f = await handoverReader(async () => { throw new Error("timeline unavailable"); });
  f.agents.get("old-coordinator").status = "closed";
  await expect(f.read()).rejects.toThrow(/읽지 못했습니다.*Could not read/);
  f.agents.get("old-coordinator").status = "running";
  const running = await f.read();
  expect(running).toMatchObject({ previousCoordinator: true, status: "running", turns: [] });
  expect(running.note).toMatch(/진행 중.*still running/);
});
