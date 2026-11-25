import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAgentTool } from "@getpaseo/plugin/server";
import { z } from "zod";
import { attachCoordinatorTools } from "../server/coordinator";
import { ConversationReader } from "../server/conversation";
import { PreferenceStore, setCoordinator } from "../server/preferences";
import { coordinatorTool } from "../server/board-guide";
import {
  CoordinatorToolStamps, coordinatorToolsView, guideNote, readCoordinatorTools, toolsFingerprint, withGuideNote,
} from "../server/coordinator-tools";
import { guideNoteDue, nextToolStamp, toolStaleness } from "../shared/coordinator-tools";
import { staleToolsNotice } from "../client/coordinator-tools";

const ko = (korean: string) => korean;
const en = (_: string, english: string) => english;
const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

function store(stamp?: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "coordinator-tools-"));
  paths.push(dir);
  const path = join(dir, "scope.json");
  writeFileSync(path, JSON.stringify({ projects: ["alpha"], coordinator: null, judgments: {} }));
  const prefs = new PreferenceStore(path);
  prefs.change(scope => setCoordinator(scope, "coordinator-1"));
  if (stamp) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.toolStamps = { "coordinator-1": { at: "2026-01-01T00:00:00.000Z", ...stamp } };
    writeFileSync(path, JSON.stringify(raw));
  }
  return prefs;
}

const planTool = (input: z.ZodType, description = "Plan an assignment.", usage = "Pass needsHooks for native hooks.") =>
  coordinatorTool({ name: "plan_assignment", description, usage, input, execute: () => ({ text: "planned" }) });
const oldBuild = [planTool(z.object({ needsHooks: z.boolean() }))];
const newBuild = [planTool(z.object({ needsHooks: z.boolean(), expectedHostId: z.string().optional() }))];
const reworded = [planTool(z.object({ needsHooks: z.boolean() }), "Plan an assignment on a host.")];
const listTool = coordinatorTool({ name: "read_board", description: "List.", usage: "Lists managed sessions.", input: z.object({}),
  execute: () => ({ text: JSON.stringify([{ id: "worker-1" }]) }) });

// A Paseo host where each session runs one provider conversation, which /clear replaces.
function host(provider = "claude") {
  const conversations = new Map<string, string>([["coordinator-1", "conversation-1"], ["coordinator-2", "conversation-9"]]);
  const paseo = { agents: { ref: (id: string) => ({
    refresh: async () => ({ agent: { id, persistence: conversations.has(id) ? { provider, sessionId: conversations.get(id) } : null } }),
  }) } } as any;
  return { paseo, conversations, provider };
}

// One board build: the real coordinator hook, with the tools it hands out wrapped for stamping.
async function board(prefs: PreferenceStore, extra: any[] = oldBuild, contract?: { version: number; compatibleFrom: number }) {
  const stamps = new CoordinatorToolStamps(prefs, contract);
  let hook: any;
  attachCoordinatorTools({ addHook: (_: string, h: any) => { hook = h; return () => {}; } } as any, prefs, new ConversationReader(), extra, stamps);
  const opened = await hook({ request: { purpose: "interactive", agentId: "coordinator-1", tools: [], metadata: {} } });
  const run = (name: string, input: unknown, h: { paseo: unknown; provider: string }, agentId = "coordinator-1") =>
    opened.tools.find((tool: any) => tool.name === name).execute(input, { paseo: h.paseo, agent: { id: agentId, provider: h.provider } });
  const call = (h: { paseo: unknown; provider: string }, agentId = "coordinator-1") => run("plan_assignment", { needsHooks: false }, h, agentId);
  const guide = (h: { paseo: unknown; provider: string }, held = 1) => run("read_board_guide", { contract: held }, h);
  return { stamps, call, run, guide, names: opened.tools.map((tool: any) => tool.name) as string[] };
}

const served = { fingerprint: "new", contract: 1, compatibleFrom: 1, guide: "g1" };
const legacy = { session: "conversation-1", fingerprint: "old" };

test("staleness: a compatible contract is current, a new conversation is current, unknown stays silent", () => {
  expect(toolStaleness({ ...legacy, fingerprint: "new" }, served, "conversation-1")).toBe("current");
  // A stamp from before the contract carries no contract number.
  expect(toolStaleness(legacy, served, "conversation-1")).toBe("stale");
  expect(toolStaleness(legacy, served, "conversation-2")).toBe("current");
  expect(toolStaleness(legacy, served, null)).toBe("unknown");
  expect(toolStaleness(undefined, served, "conversation-1")).toBe("unknown");
  expect(toolStaleness(legacy, undefined, "conversation-1")).toBe("unknown");
  // The surface grew, yet the conversation's contract still works with this board.
  expect(toolStaleness({ ...legacy, contract: 1 }, served, "conversation-1")).toBe("current");
  expect(toolStaleness({ ...legacy, contract: 1 }, { ...served, contract: 2, compatibleFrom: 1 }, "conversation-1")).toBe("current");
  expect(toolStaleness({ ...legacy, contract: 1 }, { ...served, contract: 2, compatibleFrom: 2 }, "conversation-1")).toBe("stale");
});

test("a conversation keeps its first stamp, and a new conversation starts over with the served contract", () => {
  const first = nextToolStamp(undefined, served, "conversation-1")!;
  expect(first).toEqual({ session: "conversation-1", fingerprint: "new", contract: 1 });
  const later = { ...served, fingerprint: "newer", contract: 2 };
  expect(nextToolStamp(first, later, "conversation-1")).toBe(first);
  expect(nextToolStamp(first, later, "conversation-2")).toEqual({ session: "conversation-2", fingerprint: "newer", contract: 2 });
  expect(nextToolStamp(first, later, null)).toBe(first);
  expect(nextToolStamp(first, undefined, "conversation-2")).toBe(first);
});

test("a contract tool call tells which contract the conversation holds", () => {
  // A conversation stamped before the contract learns it on its first contract tool call.
  expect(nextToolStamp(legacy, served, "conversation-1", { held: 1 })).toEqual({ ...legacy, contract: 1, early: true });
  const two = { ...served, contract: 2, compatibleFrom: 2 };
  const one = { ...legacy, contract: 1 };
  expect(nextToolStamp(one, two, "conversation-1", { held: 1 })).toBe(one);
  expect(nextToolStamp(one, two, "conversation-1", { held: 2 })).toEqual({ ...one, contract: 2 });
  // A number the board does not serve, or not a whole number, is ignored. The held contract never goes down.
  for (const held of [3, 0, -1, 1.5, Number.NaN]) expect(nextToolStamp(one, two, "conversation-1", { held })).toBe(one);
  expect(nextToolStamp({ ...one, contract: 2 }, two, "conversation-1", { held: 1 })).toEqual({ ...one, contract: 2 });
  // Reading the guide records the revision read.
  expect(nextToolStamp(one, served, "conversation-1", { readGuide: true })).toEqual({ ...one, guide: "g1" });
});

test("the guide note is due until the conversation read or was told about this guide revision", () => {
  const stamp = { session: "conversation-1", fingerprint: "new", contract: 1 };
  expect(guideNoteDue(stamp, served)).toBe(true);
  expect(guideNoteDue({ ...stamp, noted: "g1" }, served)).toBe(false);
  expect(guideNoteDue({ ...stamp, guide: "g1" }, served)).toBe(false);
  expect(guideNoteDue({ ...stamp, guide: "g0", noted: "g0" }, served)).toBe(true);
  expect(guideNoteDue(undefined, served)).toBe(false);
  expect(guideNoteDue(stamp, undefined)).toBe(false);
});

test("the fingerprint follows names and input shapes, not wording", () => {
  const other = defineAgentTool({ name: "read_board", description: "Read.", input: z.object({}), execute: () => ({ text: "" }) });
  expect(toolsFingerprint([...oldBuild, other])).toBe(toolsFingerprint([other, ...oldBuild]));
  expect(toolsFingerprint(oldBuild)).not.toBe(toolsFingerprint(newBuild));
  expect(toolsFingerprint([...oldBuild, other])).not.toBe(toolsFingerprint(oldBuild));
  // Tool descriptions, titles and field descriptions are wording.
  expect(toolsFingerprint(reworded)).toBe(toolsFingerprint(oldBuild));
  const two = (shape: Record<string, z.ZodType>, description = "Plan an assignment.", title?: string) =>
    [defineAgentTool({ name: "plan_assignment", description, ...(title ? { title } : {}), input: z.strictObject(shape), execute: () => ({ text: "" }) })];
  const a = two({ needsHooks: z.boolean().describe("Hooks needed."), projectId: z.string() });
  const b = two({ projectId: z.string(), needsHooks: z.boolean().describe("Set for native hooks.") }, "Plan where a worker runs.", "Plan");
  expect(toolsFingerprint(b)).toBe(toolsFingerprint(a));
  // A field named like an annotation is still a field.
  expect(toolsFingerprint(two({ title: z.string() }))).not.toBe(toolsFingerprint(two({ description: z.string() })));
  expect(toolsFingerprint(two({ title: z.string() }))).not.toBe(toolsFingerprint(two({})));
  // Narrowing, a new field, a renamed tool and strictness are shape.
  expect(toolsFingerprint(two({ needsHooks: z.boolean(), projectId: z.string().max(40) }))).not.toBe(toolsFingerprint(two({ needsHooks: z.boolean(), projectId: z.string() })));
  expect(toolsFingerprint([defineAgentTool({ ...a[0], name: "plan_work" })])).not.toBe(toolsFingerprint(a));
  expect(toolsFingerprint([defineAgentTool({ ...a[0], input: z.object({ needsHooks: z.boolean(), projectId: z.string() }) })])).not.toBe(toolsFingerprint(a));
  // A schema that cannot be described leaves the board unable to judge.
  expect(toolsFingerprint([{ name: "x", description: "x", input: { toJSONSchema: null } as any }])).toBeUndefined();
});

test("a build that only rewords descriptions is not reported", async () => {
  const prefs = store();
  const h = host();
  const first = await board(prefs, oldBuild);
  await first.call(h);
  await first.guide(h);
  const same = await board(prefs, reworded);
  expect(same.stamps.fingerprint).toBe(first.stamps.fingerprint);
  expect(same.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
  expect(await readCoordinatorTools(h.paseo, same.stamps, { id: "coordinator-1", status: "idle", provider: "claude" })).toBeUndefined();
});

test("the coordinator receives the guide and the action tool with the board's tools", async () => {
  const b = await board(store());
  expect(b.names).toEqual(["read_board_conversation", "classify_board_conversation", "plan_assignment", "read_board_guide", "board_action"]);
});

test("a conversation from before the contract catches up by reading the guide", async () => {
  const prefs = store({ session: "conversation-1", fingerprint: "f".repeat(64) });
  const h = host();
  const b = await board(prefs, oldBuild);
  const row = { id: "coordinator-1", status: "idle", provider: "claude" };
  expect(b.stamps.staleness("coordinator-1", "conversation-1")).toBe("stale");
  expect(await readCoordinatorTools(h.paseo, b.stamps, row)).toEqual({ stale: true });

  // Its own tools keep working. The first text result says once to read the guide.
  const told = await b.call(h);
  expect(told.text).toStartWith("planned\n\n");
  expect(told.text).toContain("read_board_guide");
  expect((await b.call(h)).text).toBe("planned");
  expect(b.stamps.staleness("coordinator-1", "conversation-1")).toBe("stale");

  // Reading the guide is a contract tool call: no replacement, /clear or /compact.
  const overview = JSON.parse((await b.guide(h)).text);
  expect(overview.conversation.definitions).toBe("older");
  expect(b.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
  expect(await readCoordinatorTools(h.paseo, b.stamps, row)).toBeUndefined();
  expect(prefs.read().toolStamps["coordinator-1"]).toMatchObject({ session: "conversation-1", fingerprint: "f".repeat(64), contract: 1, early: true });
  // It keeps saying so in later guide reads: some of its definitions predate the contract.
  expect(JSON.parse((await b.guide(h)).text).conversation.definitions).toBe("older");
  expect((await b.call(h)).text).toBe("planned");
});

test("board_action is a contract tool call too", async () => {
  const prefs = store({ session: "conversation-1", fingerprint: "f".repeat(64) });
  const h = host();
  const b = await board(prefs, oldBuild);
  const result = await b.run("board_action", { contract: 1, action: "plan_assignment", input: { needsHooks: true } }, h);
  expect(result.text).toStartWith("planned");
  expect(b.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
});

test("a broken contract stays stale until the conversation holds the new one", async () => {
  const prefs = store();
  const h = host();
  const one = await board(prefs, oldBuild);
  await one.call(h);
  expect(prefs.read().toolStamps["coordinator-1"]).toMatchObject({ contract: 1 });

  const two = await board(prefs, newBuild, { version: 2, compatibleFrom: 2 });
  expect(two.stamps.staleness("coordinator-1", "conversation-1")).toBe("stale");
  // The conversation still holds contract 1 definitions and says so.
  await two.guide(h, 1);
  expect(two.stamps.staleness("coordinator-1", "conversation-1")).toBe("stale");
  // After the person compacts it, the conversation loads the tools again under the same conversation ID.
  await two.guide(h, 2);
  expect(two.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
  expect(prefs.read().toolStamps["coordinator-1"]).toMatchObject({ session: "conversation-1", contract: 2 });

  // A contract that only grew keeps older conversations current.
  const prefsB = store();
  await (await board(prefsB, oldBuild)).call(h);
  const grown = await board(prefsB, newBuild, { version: 2, compatibleFrom: 1 });
  expect(grown.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
});

test("/clear starts a new conversation, which gets the served contract on its first call", async () => {
  const prefs = store({ session: "conversation-1", fingerprint: "f".repeat(64) });
  const h = host();
  const b = await board(prefs, oldBuild);
  h.conversations.set("coordinator-1", "conversation-2");
  expect(b.stamps.staleness("coordinator-1", "conversation-2")).toBe("current");
  await b.call(h);
  expect(prefs.read().toolStamps["coordinator-1"]).toMatchObject({ session: "conversation-2", fingerprint: b.stamps.fingerprint, contract: 1 });
  expect(prefs.read().toolStamps["coordinator-1"].early).toBeUndefined();
  expect(JSON.parse((await b.guide(h)).text).conversation.definitions).toBe("current");
});

test("the guide note is attached once per guide revision", async () => {
  const prefs = store();
  const h = host();
  const b = await board(prefs, oldBuild);
  // A new conversation is told once, then left alone.
  expect((await b.call(h)).text).toBe(`planned\n\n${guideNote}`);
  expect((await b.call(h)).text).toBe("planned");
  await b.guide(h);
  expect((await b.call(h)).text).toBe("planned");
  expect(prefs.read().toolStamps["coordinator-1"].guide).toBe(b.stamps.served!.guide);

  // An update that changes usage text or accepted input changes the guide revision.
  const updated = await board(prefs, [planTool(z.object({ needsHooks: z.boolean() }), "Plan an assignment.", "Pass needsHooks. Pass host when the human names one.")]);
  expect(updated.stamps.served!.guide).not.toBe(b.stamps.served!.guide);
  expect(updated.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
  expect((await updated.call(h)).text).toBe(`planned\n\n${guideNote}`);
  expect((await updated.call(h)).text).toBe("planned");
  // The guide's own result never carries the note.
  const fresh = store();
  const c = await board(fresh, oldBuild);
  expect((await c.guide(h)).text).not.toContain(guideNote);
  expect((await c.call(h)).text).toBe("planned");
});

test("a JSON result does not count as told", async () => {
  const prefs = store();
  const h = host();
  const b = await board(prefs, [...oldBuild, listTool]);
  const listing = await b.run("read_board", {}, h);
  expect(JSON.parse(listing.text)).toEqual([{ id: "worker-1" }]);
  expect(listing.structuredContent.boardToolsNotice).toBe(guideNote);
  // The conversation may not have seen it, so the next text result still carries it.
  expect((await b.call(h)).text).toBe(`planned\n\n${guideNote}`);
  expect((await b.run("read_board", {}, h)).structuredContent).toBeUndefined();
});

test("the note keeps a result intact", () => {
  const listing = JSON.stringify([{ id: "worker-1" }]);
  const json = withGuideNote({ text: listing });
  expect(json.told).toBe(false);
  expect(json.result.text).toBe(listing);
  expect((json.result.structuredContent as any).boardToolsNotice).toBe(guideNote);
  const object = withGuideNote({ text: "{\"sessionId\":\"worker-1\"}", structuredContent: { kept: true } });
  expect(JSON.parse(object.result.text!)).toEqual({ sessionId: "worker-1" });
  expect(object.result.structuredContent).toEqual({ kept: true, boardToolsNotice: guideNote });
  // Plain text, and text that only looks like JSON, carry the note at the end.
  expect(withGuideNote({ text: "Recorded." })).toEqual({ told: true, result: { text: `Recorded.\n\n${guideNote}`, structuredContent: { boardToolsNotice: guideNote } } });
  expect(withGuideNote({ text: "[draft] saved" }).result.text).toEndWith(guideNote);
  expect(withGuideNote({}).result.text).toBe(guideNote);
  expect(withGuideNote({ text: "x", structuredContent: [1] }).result.structuredContent).toEqual([1]);
});

test("the note names the guide in both languages and asks for nothing drastic", () => {
  for (const text of ["read_board_guide", "board_action", "보드 알림", "Board note"]) expect(guideNote).toContain(text);
  expect(guideNote).toContain("needs no replacement, /clear or /compact");
  expect(guideNote).not.toContain("—");
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
  expect((await b.call(h, "worker-1")).text).toBe("planned");
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

test("a coordinator on another provider is neither stamped nor told anything", async () => {
  const prefs = store();
  const codex = host("codex");
  expect((await (await board(prefs, oldBuild)).call(codex)).text).toBe("planned");
  expect(prefs.read().toolStamps).toEqual({});
  // Even with a stamp left from a Claude conversation, another provider gets no note.
  await (await board(prefs, oldBuild)).call(host());
  expect((await (await board(prefs, newBuild, { version: 2, compatibleFrom: 2 })).call(codex)).text).toBe("planned");
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

test("the snapshot reads the coordinator's conversation only when its stamp may be stale", async () => {
  const h = host();
  const row = { id: "coordinator-1", status: "idle", provider: "claude" };
  let reads = 0;
  const counted = { agents: { ref: (id: string) => ({ refresh: async () => { reads++; return h.paseo.agents.ref(id).refresh(); } }) } } as any;
  // A current stamp, and an older one whose contract still works, cost no lookup.
  const prefs = store();
  await (await board(prefs, oldBuild)).call(h);
  expect(await readCoordinatorTools(counted, (await board(prefs, oldBuild)).stamps, row)).toBeUndefined();
  expect(await readCoordinatorTools(counted, (await board(prefs, newBuild, { version: 2, compatibleFrom: 1 })).stamps, row)).toBeUndefined();
  expect(reads).toBe(0);
  const broken = await board(prefs, newBuild, { version: 2, compatibleFrom: 2 });
  expect(await readCoordinatorTools(counted, broken.stamps, row)).toEqual({ stale: true });
  expect(reads).toBe(1);
  expect(await readCoordinatorTools(counted, broken.stamps, { ...row, provider: "codex" })).toBeUndefined();
  expect(await readCoordinatorTools(counted, broken.stamps, { ...row, serverId: "host-b" })).toBeUndefined();
  expect(reads).toBe(1);
  h.conversations.set("coordinator-1", "conversation-2");
  expect(await readCoordinatorTools(counted, broken.stamps, row)).toBeUndefined();
  const offline = { agents: { ref: () => ({ refresh: async () => { throw new Error("offline"); } }) } } as any;
  h.conversations.set("coordinator-1", "conversation-1");
  expect(await readCoordinatorTools(offline, broken.stamps, row)).toBeUndefined();
});

test("notice wording orders the fixes from least to most context lost", () => {
  expect(staleToolsNotice(undefined, ko)).toBeNull();
  const notice = staleToolsNotice({ stale: true }, ko)!;
  expect(notice.title).toBe("코디네이터 대화가 보드 업데이트 전의 도구 정의를 쓰고 있습니다.");
  expect(notice.steps).toHaveLength(3);
  expect(notice.steps[0]).toContain("read_board_guide");
  expect(notice.steps[1]).toContain("/compact");
  expect(notice.steps[1]).not.toContain("/clear");
  expect(notice.steps[2]).toContain("/clear");
  for (const step of notice.steps.slice(1)) expect(step).toContain("직접 입력");
  const english = staleToolsNotice({ stale: true }, en)!;
  expect(english.title).toContain("from before the update");
  expect(english.steps[0]).toContain("read_board_guide");
  expect(english.steps[1]).toContain("/compact");
  expect(english.steps[2]).toContain("/clear");
  for (const t of [ko, en]) {
    const view = staleToolsNotice({ stale: true }, t)!;
    for (const text of [view.title, view.effect, ...view.steps]) { expect(text.length).toBeGreaterThan(0); expect(text).not.toContain("—"); }
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
