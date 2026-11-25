import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { attachCoordinatorTools } from "../server/coordinator";
import { ConversationReader } from "../server/conversation";
import { PreferenceStore, setCoordinator } from "../server/preferences";
import {
  CoordinatorToolStamps, coordinatorToolsView, readCoordinatorTools, staleToolNote, toolsFingerprint, withStaleNote,
} from "../server/coordinator-tools";
import { nextToolStamp, toolStaleness } from "../shared/coordinator-tools";
import { staleToolsNotice } from "../client/coordinator-tools";

const ko = (korean: string) => korean;
const en = (_: string, english: string) => english;
const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

function store() {
  const dir = mkdtempSync(join(tmpdir(), "coordinator-tools-"));
  paths.push(dir);
  const path = join(dir, "scope.json");
  writeFileSync(path, JSON.stringify({ projects: ["alpha"], coordinator: null, judgments: {} }));
  const prefs = new PreferenceStore(path);
  prefs.change(scope => setCoordinator(scope, "coordinator-1"));
  return prefs;
}

const planTool = (input: z.ZodType) => defineAgentTool({ name: "plan_assignment", description: "Plan an assignment.", input, execute: () => ({ text: "planned" }) });
const oldBuild = [planTool(z.object({ needsHooks: z.boolean() }))];
const newBuild = [planTool(z.object({ needsHooks: z.boolean(), expectedHostId: z.string().optional() }))];

// A Paseo host where each session runs one provider conversation, which /clear replaces.
function host(provider = "claude") {
  const conversations = new Map<string, string>([["coordinator-1", "conversation-1"], ["coordinator-2", "conversation-9"]]);
  const paseo = { agents: { ref: (id: string) => ({
    refresh: async () => ({ agent: { id, persistence: conversations.has(id) ? { provider, sessionId: conversations.get(id) } : null } }),
  }) } } as any;
  return { paseo, conversations, provider };
}

// One board build: the real coordinator hook, with the tools it hands out wrapped for stamping.
async function board(prefs: PreferenceStore, extra: any[] = oldBuild) {
  const stamps = new CoordinatorToolStamps(prefs);
  let hook: any;
  attachCoordinatorTools({ addHook: (_: string, h: any) => { hook = h; return () => {}; } } as any, prefs, new ConversationReader(), extra, stamps);
  const opened = await hook({ request: { purpose: "interactive", agentId: "coordinator-1", tools: [], metadata: {} } });
  const plan = opened.tools.find((tool: any) => tool.name === "plan_assignment");
  const call = (h: { paseo: unknown; provider: string }, agentId = "coordinator-1") =>
    plan.execute({ needsHooks: false }, { paseo: h.paseo, agent: { id: agentId, provider: h.provider } });
  return { stamps, call };
}

test("staleness: same definitions are current, a new conversation is current, unknown stays silent", () => {
  const stamp = { session: "conversation-1", fingerprint: "old" };
  expect(toolStaleness(stamp, "old", "conversation-1")).toBe("current");
  expect(toolStaleness(stamp, "new", "conversation-1")).toBe("stale");
  expect(toolStaleness(stamp, "new", "conversation-2")).toBe("current");
  expect(toolStaleness(stamp, "new", null)).toBe("unknown");
  expect(toolStaleness(undefined, "new", "conversation-1")).toBe("unknown");
  expect(toolStaleness(stamp, undefined, "conversation-1")).toBe("unknown");
});

test("a conversation keeps its first stamp, and a new conversation starts over", () => {
  const first = nextToolStamp(undefined, "old", "conversation-1")!;
  expect(first).toEqual({ session: "conversation-1", fingerprint: "old" });
  expect(nextToolStamp(first, "new", "conversation-1")).toBe(first);
  expect(nextToolStamp(first, "new", "conversation-2")).toEqual({ session: "conversation-2", fingerprint: "new" });
  expect(nextToolStamp(first, "new", null)).toBe(first);
  expect(nextToolStamp(first, undefined, "conversation-2")).toBe(first);
});

test("the fingerprint follows tool definitions, not their order", () => {
  const other = defineAgentTool({ name: "read_board", description: "Read.", input: z.object({}), execute: () => ({ text: "" }) });
  expect(toolsFingerprint([...oldBuild, other])).toBe(toolsFingerprint([other, ...oldBuild]));
  expect(toolsFingerprint(oldBuild)).not.toBe(toolsFingerprint(newBuild));
  const reworded = [defineAgentTool({ ...oldBuild[0], description: "Plan an assignment on a host." })];
  expect(toolsFingerprint(reworded)).not.toBe(toolsFingerprint(oldBuild));
  // Key order, required-name order and description spacing are not changes a conversation can see.
  const two = (shape: Record<string, z.ZodType>, description = "Plan an assignment.") =>
    [defineAgentTool({ name: "plan_assignment", description, input: z.strictObject(shape), execute: () => ({ text: "" }) })];
  const a = two({ needsHooks: z.boolean().describe("Hooks  needed."), projectId: z.string() });
  const b = two({ projectId: z.string(), needsHooks: z.boolean().describe("Hooks needed. ") }, "  Plan an\n assignment. ");
  expect(toolsFingerprint(b)).toBe(toolsFingerprint(a));
  expect(toolsFingerprint(two({ needsHooks: z.boolean(), projectId: z.string().max(40) }))).not.toBe(toolsFingerprint(two({ needsHooks: z.boolean(), projectId: z.string() })));
  // A schema that cannot be described leaves the board unable to judge.
  expect(toolsFingerprint([{ name: "x", description: "x", input: { toJSONSchema: null } as any }])).toBeUndefined();
});

test("a board update leaves the coordinator's conversation stale, and a reload does not change that", async () => {
  const prefs = store();
  const h = host();
  expect((await (await board(prefs, oldBuild)).call(h)).text).toBe("planned");

  // The board updates. The conversation still holds the old definitions, even after a reload reruns the hook.
  const after = await board(prefs, newBuild);
  expect(after.stamps.staleness("coordinator-1", "conversation-1")).toBe("stale");
  const result = await after.call(h);
  expect(result.text).toStartWith("planned\n\n");
  expect(result.text).toContain("/clear");
  expect(after.stamps.staleness("coordinator-1", "conversation-1")).toBe("stale");

  // /clear starts a new conversation. It gets the current tools, and its first call stamps them.
  h.conversations.set("coordinator-1", "conversation-2");
  expect(after.stamps.staleness("coordinator-1", "conversation-2")).toBe("current");
  expect((await after.call(h)).text).toBe("planned");
  expect(prefs.read().toolStamps["coordinator-1"]).toMatchObject({ session: "conversation-2", fingerprint: after.stamps.fingerprint });
});

test("a board build that does not change tool definitions is not reported", async () => {
  const prefs = store();
  const h = host();
  await (await board(prefs, oldBuild)).call(h);
  const same = await board(prefs, oldBuild);
  expect(same.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
  expect((await same.call(h)).text).toBe("planned");
});

test("a coordinator that never called a board tool, or whose conversation cannot be read, is unknown", async () => {
  const prefs = store();
  const b = await board(prefs, newBuild);
  expect(b.stamps.staleness("coordinator-1", "conversation-1")).toBe("unknown");
  const unreadable = host();
  unreadable.conversations.delete("coordinator-1");
  expect((await b.call(unreadable)).text).toBe("planned");
  expect(prefs.read().toolStamps).toEqual({});
});

test("only the board's coordinator is stamped, and stamps of former coordinators are pruned", async () => {
  const prefs = store();
  const h = host();
  const b = await board(prefs);
  await b.call(h, "worker-1");
  expect(prefs.read().toolStamps).toEqual({});
  await b.call(h);
  prefs.change(scope => setCoordinator(scope, "coordinator-2"));
  await b.call(h, "coordinator-2");
  expect(Object.keys(prefs.read().toolStamps)).toEqual(["coordinator-2"]);
});

test("a failed conversation lookup never changes the tool's own result", async () => {
  const prefs = store();
  const b = await board(prefs);
  const broken = { paseo: { agents: { ref: () => ({ refresh: async () => { throw new Error("offline"); } }) } }, provider: "claude" };
  const warn = console.warn;
  console.warn = () => {};
  try { expect((await b.call(broken)).text).toBe("planned"); } finally { console.warn = warn; }
});

test("the note in a stale tool result names both fixes in both languages", () => {
  for (const text of ["replace the coordinator", "/clear", "코디네이터를 교체"]) expect(staleToolNote).toContain(text);
  expect(staleToolNote).not.toContain("\u2014");
});

test("a JSON tool result keeps its JSON, and the note goes to structured content", () => {
  const listing = JSON.stringify([{ id: "worker-1" }]);
  const json = withStaleNote({ text: listing });
  expect(json.text).toBe(listing);
  expect((json.structuredContent as any).boardToolsNotice).toBe(staleToolNote);
  const object = withStaleNote({ text: "{\"sessionId\":\"worker-1\"}", structuredContent: { kept: true } });
  expect(JSON.parse(object.text!)).toEqual({ sessionId: "worker-1" });
  expect(object.structuredContent).toEqual({ kept: true, boardToolsNotice: staleToolNote });
  // Plain text, and text that only looks like JSON, carry the note at the end.
  expect(withStaleNote({ text: "Recorded." }).text).toBe(`Recorded.\n\n${staleToolNote}`);
  expect(withStaleNote({ text: "[draft] saved" }).text).toEndWith(staleToolNote);
  expect(withStaleNote({}).text).toBe(staleToolNote);
  expect(withStaleNote({ text: "x", structuredContent: [1] }).structuredContent).toEqual([1]);
});

test("a JSON-returning board tool stays parseable in a stale conversation", async () => {
  const prefs = store();
  const h = host();
  const listing = (description: string) => [defineAgentTool({ name: "read_board", description, input: z.object({}), execute: () => ({ text: JSON.stringify([{ id: "worker-1" }]) }) })];
  const callList = async (tools: any[]) => {
    let hook: any;
    attachCoordinatorTools({ addHook: (_: string, f: any) => { hook = f; return () => {}; } } as any, prefs, new ConversationReader(), tools, new CoordinatorToolStamps(prefs));
    const opened = await hook({ request: { purpose: "interactive", agentId: "coordinator-1", tools: [], metadata: {} } });
    return opened.tools.find((t: any) => t.name === "read_board").execute({}, { paseo: h.paseo, agent: { id: "coordinator-1", provider: "claude" } });
  };
  expect((await callList(listing("List."))).structuredContent).toBeUndefined();
  const result = await callList(listing("List managed sessions."));
  expect(JSON.parse(result.text)).toEqual([{ id: "worker-1" }]);
  expect(result.structuredContent.boardToolsNotice).toBe(staleToolNote);
});

test("a coordinator on another provider is neither stamped nor told anything", async () => {
  const prefs = store();
  const codex = host("codex");
  await (await board(prefs, oldBuild)).call(codex);
  expect(prefs.read().toolStamps).toEqual({});
  // Even with a stamp left from a Claude conversation, another provider gets no note.
  await (await board(prefs, oldBuild)).call(host());
  expect((await (await board(prefs, newBuild)).call(codex)).text).toBe("planned");
});

test("a conversation ID that is too long or oddly shaped is never stored, and a bad stored stamp does not stop the board", async () => {
  const prefs = store();
  const b = await board(prefs, oldBuild);
  for (const id of ["x".repeat(300), "two words", "../escape", ""]) {
    const h = host();
    h.conversations.set("coordinator-1", id);
    expect((await b.call(h)).text).toBe("planned");
    expect(prefs.read().toolStamps).toEqual({});
    expect(b.stamps.staleness("coordinator-1", id)).toBe("unknown");
  }
  const h = host();
  h.conversations.set("coordinator-1", "y".repeat(256));
  await b.call(h);
  expect(prefs.read().toolStamps["coordinator-1"]?.session).toBe("y".repeat(256));
  // A stamp the schema rejects, written by hand or by another build, is dropped rather than fatal.
  const path = (prefs as any).path as string;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  raw.toolStamps = { "coordinator-1": { session: "z".repeat(300), fingerprint: "f", at: new Date().toISOString() } };
  writeFileSync(path, JSON.stringify(raw));
  expect(prefs.read().toolStamps).toEqual({});
  expect(prefs.read().coordinator).toBe("coordinator-1");
});

test("the board shows the notice only for its own listed coordinator", () => {
  const row = { status: "idle", provider: "claude" };
  expect(coordinatorToolsView("stale", row)).toEqual({ stale: true });
  expect(coordinatorToolsView("stale", { ...row, status: "running" })).toEqual({ stale: true });
  expect(coordinatorToolsView("stale", { ...row, provider: "codex" })).toBeUndefined();
  expect(coordinatorToolsView("stale", { ...row, provider: null })).toBeUndefined();
  expect(coordinatorToolsView("current", row)).toBeUndefined();
  expect(coordinatorToolsView("unknown", row)).toBeUndefined();
  // No coordinator, or one on another host.
  expect(coordinatorToolsView("stale", undefined)).toBeUndefined();
  expect(coordinatorToolsView("stale", { ...row, serverId: "host-b" })).toBeUndefined();
  // A closed or failed coordinator already has the reach notice.
  expect(coordinatorToolsView("stale", { ...row, status: "closed" })).toBeUndefined();
  expect(coordinatorToolsView("stale", { ...row, status: "error" })).toBeUndefined();
});

test("the snapshot reads the coordinator's conversation only when its stamp differs", async () => {
  const prefs = store();
  const h = host();
  await (await board(prefs, oldBuild)).call(h);
  const row = { id: "coordinator-1", status: "idle", provider: "claude" };
  let reads = 0;
  const counted = { agents: { ref: (id: string) => ({ refresh: async () => { reads++; return h.paseo.agents.ref(id).refresh(); } }) } } as any;
  const same = await board(prefs, oldBuild);
  expect(await readCoordinatorTools(counted, same.stamps, row)).toBeUndefined();
  expect(reads).toBe(0);
  const updated = await board(prefs, newBuild);
  expect(await readCoordinatorTools(counted, updated.stamps, row)).toEqual({ stale: true });
  expect(reads).toBe(1);
  expect(await readCoordinatorTools(counted, updated.stamps, { ...row, provider: "codex" })).toBeUndefined();
  expect(reads).toBe(1);
  expect(await readCoordinatorTools(counted, updated.stamps, { ...row, serverId: "host-b" })).toBeUndefined();
  h.conversations.set("coordinator-1", "conversation-2");
  expect(await readCoordinatorTools(counted, updated.stamps, row)).toBeUndefined();
  const offline = { agents: { ref: () => ({ refresh: async () => { throw new Error("offline"); } }) } } as any;
  h.conversations.set("coordinator-1", "conversation-1");
  expect(await readCoordinatorTools(offline, updated.stamps, row)).toBeUndefined();
});

test("notice wording in both languages names the replacement and /clear", () => {
  expect(staleToolsNotice(undefined, ko)).toBeNull();
  const notice = staleToolsNotice({ stale: true }, ko)!;
  expect(notice.title).toBe("코디네이터가 보드 업데이트 전의 도구 정의를 기억하고 있어 새 기능을 쓰지 못합니다.");
  expect(notice.steps).toHaveLength(2);
  expect(notice.steps[1]).toContain("/clear");
  expect(staleToolsNotice({ stale: true }, en)!.title).toContain("cannot use new features");
  for (const t of [ko, en]) {
    const view = staleToolsNotice({ stale: true }, t)!;
    for (const text of [view.title, view.effect, ...view.steps]) { expect(text.length).toBeGreaterThan(0); expect(text).not.toContain("\u2014"); }
  }
});

test("the board never reloads a session, nor types /clear or /compact into one", () => {
  const root = join(import.meta.dir, "..");
  const sources = (folder: string): string[] => readdirSync(join(root, folder), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? (entry.name === "vendor" ? [] : sources(join(folder, entry.name))) : /\.tsx?$/.test(entry.name) ? [join(folder, entry.name)] : []);
  const files = [...sources("server"), ...sources("shared"), ...sources("client"), "index.server.ts", "index.client.tsx"];
  const read = (file: string) => readFileSync(join(root, file), "utf8");
  expect(files.filter(file => /\.agents\.ref\([^)]*\)\.reload\(|\bhandle\.reload\(|refreshAgent\(/.test(read(file)))).toEqual([]);
  expect(files.filter(file => /\.(send|run)\(\s*["'`]\/(clear|compact)\b/.test(read(file)))).toEqual([]);
});
