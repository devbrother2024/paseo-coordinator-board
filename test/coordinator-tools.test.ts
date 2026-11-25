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
import { compactedToolStamp, conversationProvider, guideNoteDue, nextToolStamp, providerKeepsTools, toolStaleness } from "../shared/coordinator-tools";
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

const planTool = (input: z.ZodType, description = "Plan an assignment.", accepts?: z.ZodType) =>
  coordinatorTool({ name: "plan_assignment", description, input, ...(accepts ? { accepts } : {}), execute: () => ({ text: "planned" }) });
const plain = z.object({ needsHooks: z.boolean() });
// A build that accepts a field the tool definition does not list.
const extended = (...fields: string[]) => [planTool(plain, "Plan an assignment.", plain.extend(Object.fromEntries(fields.map(name => [name, z.string().optional()]))))];
const oldBuild = [planTool(z.object({ needsHooks: z.boolean() }))];
const newBuild = [planTool(z.object({ needsHooks: z.boolean(), expectedHostId: z.string().optional() }))];
const reworded = [planTool(z.object({ needsHooks: z.boolean() }), "Plan an assignment on a host.")];
const listTool = coordinatorTool({ name: "read_board", description: "List.", input: z.object({}),
  execute: () => ({ text: JSON.stringify([{ id: "worker-1" }]) }) });

// A Paseo host where each session runs one provider conversation, which /clear replaces. `kind` is the
// provider implementation a profile runs on, which Paseo records in the conversation's persistence metadata.
// `timeline` holds what the coordinator's timeline shows; `fetches` counts how often the board read it.
function host(provider = "claude", kind?: string) {
  const conversations = new Map<string, string>([["coordinator-1", "conversation-1"], ["coordinator-2", "conversation-9"]]);
  const state = { timeline: [] as { item: Record<string, unknown>; timestamp: string }[], fetches: 0, timelineFails: false };
  const paseo = { agents: { ref: (id: string) => ({
    refresh: async () => ({ agent: { id, persistence: conversations.has(id)
      ? { provider, sessionId: conversations.get(id), ...(kind ? { metadata: { provider: kind } } : {}) } : null } }),
    timeline: { refetch: async () => { state.fetches++; if (state.timelineFails) throw new Error("offline"); return { entries: state.timeline }; } },
  }) } } as any;
  const compact = (at = new Date(Date.now() + 60_000).toISOString(), status = "completed") =>
    state.timeline.push({ item: { type: "compaction", status, trigger: "manual" }, timestamp: at });
  return { paseo, conversations, provider, state, compact };
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
  const guide = (h: { paseo: unknown; provider: string }, topic?: string) => run("read_board_guide", topic ? { topic } : {}, h);
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
  expect(first).toEqual({ session: "conversation-1", fingerprint: "new", contract: 1, guide: "" });
  const later = { ...served, fingerprint: "newer", contract: 2 };
  expect(nextToolStamp(first, later, "conversation-1")).toBe(first);
  expect(nextToolStamp(first, later, "conversation-2")).toEqual({ session: "conversation-2", fingerprint: "newer", contract: 2, guide: "" });
  expect(nextToolStamp(first, later, null)).toBe(first);
  expect(nextToolStamp(first, undefined, "conversation-2")).toBe(first);
});

test("a contract tool call shows the conversation holds the contract that introduced the tool", () => {
  // A conversation stamped before the contract can only call the guide once it holds contract 1 tools.
  expect(nextToolStamp(legacy, served, "conversation-1", { since: 1 })).toEqual({ ...legacy, contract: 1, early: true });
  const two = { ...served, contract: 2, compatibleFrom: 2 };
  const one = { ...legacy, contract: 1 };
  // Calling a tool that contract 1 already had says nothing about contract 2.
  expect(nextToolStamp(one, two, "conversation-1", { since: 1 })).toBe(one);
  expect(nextToolStamp(one, two, "conversation-1", { since: 2 })).toEqual({ ...one, contract: 2 });
  // Never beyond what the board serves, and never down.
  for (const since of [3, 0, -1, 1.5, Number.NaN]) expect(nextToolStamp(one, two, "conversation-1", { since })).toBe(one);
  expect(nextToolStamp({ ...one, contract: 2 }, two, "conversation-1", { since: 1 })).toEqual({ ...one, contract: 2 });
  // Reading the guide records the revision read.
  expect(nextToolStamp(one, served, "conversation-1", { readGuide: true })).toEqual({ ...one, guide: "g1" });
});

test("a compacted conversation starts over with the served definitions", () => {
  const early = { ...legacy, contract: 1, early: true, guide: "g0", noted: "g0" };
  expect(compactedToolStamp(early, served)).toEqual({ session: "conversation-1", fingerprint: "new", contract: 1, guide: "" });
  expect(compactedToolStamp(early, undefined)).toBe(early);
});

test("the guide note is due until the conversation read or was told about this guide revision", () => {
  // A new conversation starts at the empty revision: nothing beyond its tool definitions to learn.
  const stamp = { session: "conversation-1", fingerprint: "new", contract: 1, guide: "" };
  expect(guideNoteDue(stamp, { ...served, guide: "" })).toBe(false);
  expect(guideNoteDue(stamp, served)).toBe(true);
  // A conversation stamped before the contract has never heard of the guide.
  expect(guideNoteDue(legacy, { ...served, guide: "" })).toBe(true);
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
  expect(same.stamps.served!.guide).toBe(first.stamps.served!.guide);
  expect(same.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
  // No screen notice and no note in a tool result.
  expect((await same.call(h)).text).toBe("planned");
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
  // `at` stays the time the conversation was first stamped: later evidence is compared against it.
  expect(prefs.read().toolStamps["coordinator-1"].at).toBe("2026-01-01T00:00:00.000Z");
  // It keeps saying so in later guide reads: some of its definitions predate the contract.
  expect(JSON.parse((await b.guide(h)).text).conversation.definitions).toBe("older");
  expect((await b.call(h)).text).toBe("planned");
});

test("board_action is a contract tool call too", async () => {
  const prefs = store({ session: "conversation-1", fingerprint: "f".repeat(64) });
  const h = host();
  const b = await board(prefs, oldBuild);
  const result = await b.run("board_action", { action: "plan_assignment", input: { needsHooks: true } }, h);
  expect(result.text).toStartWith("planned");
  expect(b.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
});

test("a broken contract stays stale until the conversation is compacted", async () => {
  const prefs = store();
  const h = host();
  const row = { id: "coordinator-1", status: "idle", provider: "claude" };
  await (await board(prefs, oldBuild)).call(h);
  expect(prefs.read().toolStamps["coordinator-1"]).toMatchObject({ contract: 1 });

  const two = await board(prefs, newBuild, { version: 2, compatibleFrom: 2 });
  expect(two.stamps.staleness("coordinator-1", "conversation-1")).toBe("stale");
  // Calling a tool it already had shows nothing new, whatever the call says.
  await two.guide(h);
  await two.run("board_action", { action: "plan_assignment", input: { needsHooks: false } }, h);
  expect(two.stamps.staleness("coordinator-1", "conversation-1")).toBe("stale");
  // A compaction from before the stamp, and one still running, are not evidence.
  h.compact("2020-01-01T00:00:00.000Z");
  h.compact(undefined, "loading");
  expect(await readCoordinatorTools(h.paseo, two.stamps, row)).toEqual({ stale: true });

  // The person compacts the conversation. Its ID stays, and it loads the board tools again.
  h.compact();
  expect(await readCoordinatorTools(h.paseo, two.stamps, row)).toBeUndefined();
  expect(two.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
  expect(prefs.read().toolStamps["coordinator-1"]).toMatchObject({ session: "conversation-1", contract: 2, fingerprint: two.stamps.fingerprint });

  // A contract that only grew keeps older conversations current.
  const prefsB = store();
  await (await board(prefsB, oldBuild)).call(h);
  const grown = await board(prefsB, newBuild, { version: 2, compatibleFrom: 1 });
  expect(grown.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
});

test("a compaction clears what the board held against an older conversation", async () => {
  const prefs = store({ session: "conversation-1", fingerprint: "f".repeat(64) });
  const h = host();
  const b = await board(prefs, oldBuild);
  expect(JSON.parse((await b.guide(h)).text).conversation.definitions).toBe("older");
  expect(prefs.read().toolStamps["coordinator-1"].early).toBe(true);
  // The next board tool call sees the compaction in the coordinator's timeline.
  h.compact();
  await b.call(h);
  expect(prefs.read().toolStamps["coordinator-1"].early).toBeUndefined();
  expect(prefs.read().toolStamps["coordinator-1"]).toMatchObject({ contract: 1, fingerprint: b.stamps.fingerprint });
  expect(JSON.parse((await b.guide(h)).text).conversation.definitions).toBe("current");

  // The turn hook does the same without waiting for a tool call, and only reads a timeline when it could matter.
  const prefsB = store({ session: "conversation-1", fingerprint: "f".repeat(64) });
  const hb = host();
  const c = await board(prefsB, oldBuild);
  await c.stamps.refresh(hb.paseo, "coordinator-1");
  expect(hb.state.fetches).toBe(1);
  expect(c.stamps.staleness("coordinator-1", "conversation-1")).toBe("stale");
  hb.compact();
  await c.stamps.refresh(hb.paseo, "coordinator-1");
  expect(c.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
  const before = hb.state.fetches;
  await c.stamps.refresh(hb.paseo, "coordinator-1");
  await c.call(hb);
  await c.stamps.refresh(hb.paseo, "worker-1");
  expect(hb.state.fetches).toBe(before);

  // A timeline the board cannot read changes nothing, and never the tool's own result.
  const prefsC = store({ session: "conversation-1", fingerprint: "f".repeat(64) });
  const hc = host();
  hc.state.timelineFails = true;
  hc.compact();
  const d = await board(prefsC, oldBuild);
  expect((await d.call(hc)).text).toStartWith("planned");
  await d.stamps.refresh(hc.paseo, "coordinator-1");
  expect(d.stamps.staleness("coordinator-1", "conversation-1")).toBe("stale");
});

test("a compaction from before this board build is not evidence", async () => {
  // Stamped long ago, compacted since, and only then updated: that compaction loaded the older definitions.
  const prefs = store({ session: "conversation-1", fingerprint: "f".repeat(64) });
  const h = host();
  const row = { id: "coordinator-1", status: "idle", provider: "claude" };
  h.compact("2026-03-01T00:00:00.000Z");
  const b = await board(prefs, oldBuild);
  expect(await readCoordinatorTools(h.paseo, b.stamps, row)).toEqual({ stale: true });
  await b.call(h);
  expect(b.stamps.staleness("coordinator-1", "conversation-1")).toBe("stale");

  // The board remembers when it began serving these definitions, so a plugin restart of the same
  // build does not move that line past a compaction that came after it.
  const served = prefs.read().toolsServed!;
  expect(served.fingerprint).toBe(b.stamps.fingerprint!);
  await new Promise(resolve => setTimeout(resolve, 15));
  h.compact(new Date(Date.parse(served.at) + 1).toISOString());
  const restarted = await board(prefs, oldBuild);
  expect(prefs.read().toolsServed).toEqual(served);
  expect(await readCoordinatorTools(h.paseo, restarted.stamps, row)).toBeUndefined();

  // An update serves other definitions and draws the line anew.
  const prefsB = store();
  await (await board(prefsB, oldBuild)).call(h);
  const stampedAt = Date.parse(prefsB.read().toolStamps["coordinator-1"].at);
  await new Promise(resolve => setTimeout(resolve, 15));
  const updated = await board(prefsB, newBuild, { version: 2, compatibleFrom: 2 });
  expect(prefsB.read().toolsServed!.fingerprint).toBe(updated.stamps.fingerprint!);
  expect(Date.parse(prefsB.read().toolsServed!.at)).toBeGreaterThan(stampedAt);
  const hb = host();
  hb.compact(new Date(Date.parse(prefsB.read().toolsServed!.at) - 1).toISOString());
  expect(await readCoordinatorTools(hb.paseo, updated.stamps, row)).toEqual({ stale: true });

  // A board with nothing to compare writes nothing when it starts.
  const dir = mkdtempSync(join(tmpdir(), "coordinator-tools-")); paths.push(dir);
  const empty = new PreferenceStore(join(dir, "scope.json"));
  new CoordinatorToolStamps(empty).serve(oldBuild);
  expect(readdirSync(dir)).toEqual([]);
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
  // Nothing beyond the tool definitions: a new conversation is told nothing.
  expect(b.stamps.served!.guide).toBe("");
  expect((await b.call(h)).text).toBe("planned");

  // An update adds a field that only board_action can carry. The running conversation is told once.
  const updated = await board(prefs, extended("host"));
  expect(updated.stamps.served!.guide).toMatch(/^[a-f0-9]{12}$/);
  expect(updated.stamps.fingerprint).toBe(b.stamps.fingerprint);
  expect(updated.stamps.staleness("coordinator-1", "conversation-1")).toBe("current");
  expect((await updated.call(h)).text).toBe(`planned\n\n${guideNote}`);
  expect((await updated.call(h)).text).toBe("planned");
  // Told, but not read yet: a reload of the same build stays quiet.
  expect((await (await board(prefs, extended("host"))).call(h)).text).toBe("planned");
  await updated.guide(h);
  expect(prefs.read().toolStamps["coordinator-1"].guide).toBe(updated.stamps.served!.guide);

  // The next field is news again, once.
  const again = await board(prefs, extended("host", "route"));
  expect(again.stamps.served!.guide).not.toBe(updated.stamps.served!.guide);
  expect((await again.call(h)).text).toBe(`planned\n\n${guideNote}`);
  expect((await again.call(h)).text).toBe("planned");

  // A conversation that starts on a build with such fields is told once as well.
  const fresh = store();
  const c = await board(fresh, extended("host"));
  expect((await c.call(h)).text).toBe(`planned\n\n${guideNote}`);
  expect((await c.call(h)).text).toBe("planned");
  // The guide's own result never carries the note, and reading it first leaves nothing to tell.
  const first = store();
  const d = await board(first, extended("host"));
  expect((await d.guide(h)).text).not.toContain(guideNote);
  expect((await d.call(h)).text).toBe("planned");
});

test("a JSON result is left alone, and the note waits for a text result", async () => {
  const prefs = store({ session: "conversation-1", fingerprint: "f".repeat(64) });
  const h = host();
  const b = await board(prefs, [...oldBuild, listTool]);
  // However often a JSON tool is called, its result keeps its shape.
  for (let i = 0; i < 3; i++) {
    const listing = await b.run("read_board", {}, h);
    expect(listing).toEqual({ text: JSON.stringify([{ id: "worker-1" }]) });
  }
  expect(prefs.read().toolStamps["coordinator-1"].noted).toBeUndefined();
  expect((await b.call(h)).text).toBe(`planned\n\n${guideNote}`);
  expect((await b.call(h)).text).toBe("planned");
  expect(await b.run("read_board", {}, h)).toEqual({ text: JSON.stringify([{ id: "worker-1" }]) });
});

test("reading one topic is not reading the guide", async () => {
  const prefs = store();
  const h = host();
  const b = await board(prefs, extended("host"));
  expect(JSON.parse((await b.guide(h, "plan_assignment")).text).action).toBe("plan_assignment");
  expect(prefs.read().toolStamps["coordinator-1"].guide).toBe("");
  expect((await b.call(h)).text).toBe(`planned\n\n${guideNote}`);
  // The list is what says what was added.
  const other = store();
  const c = await board(other, extended("host"));
  await c.guide(h);
  expect(other.read().toolStamps["coordinator-1"].guide).toBe(c.stamps.served!.guide);
  expect((await c.call(h)).text).toBe("planned");
});

test("the note keeps a result intact", () => {
  // A JSON result is returned as it came.
  const listing = { text: JSON.stringify([{ id: "worker-1" }]) };
  expect(withGuideNote(listing)).toEqual({ told: false, result: listing });
  const object = { text: "{\"sessionId\":\"worker-1\"}", structuredContent: { kept: true } };
  expect(withGuideNote(object)).toEqual({ told: false, result: object });
  // Plain text, and text that only looks like JSON, carry the note at the end. Structured content is never touched.
  expect(withGuideNote({ text: "Recorded." })).toEqual({ told: true, result: { text: `Recorded.\n\n${guideNote}` } });
  expect(withGuideNote({ text: "[draft] saved" }).result.text).toEndWith(guideNote);
  expect(withGuideNote({}).result.text).toBe(guideNote);
  expect(withGuideNote({ text: "x", structuredContent: [1], isError: true }).result).toEqual({ text: `x\n\n${guideNote}`, structuredContent: [1], isError: true });
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
  expect((await (await board(prefs, extended("host"))).call(codex)).text).toBe("planned");
  expect(prefs.read().toolStamps).toEqual({});
  // Even with a stamp left from a Claude conversation, another provider gets no note.
  await (await board(prefs, oldBuild)).call(host());
  expect((await (await board(prefs, extended("host"), { version: 2, compatibleFrom: 2 })).call(codex)).text).toBe("planned");
});

test("a coordinator on a Claude Code profile is judged by what the profile runs on", async () => {
  // A second Claude Code account is a provider with its own ID. Paseo records the implementation it runs on.
  expect(conversationProvider({ provider: "claude-work", metadata: { provider: "claude" } })).toBe("claude");
  expect(conversationProvider({ provider: "claude" })).toBe("claude");
  expect(conversationProvider({ provider: "codex-work", metadata: { provider: "codex" } })).toBe("codex");
  // Without that record the ID is all there is. A name that merely looks like Claude is not taken for it.
  expect(conversationProvider({ provider: "claude-work" })).toBe("claude-work");
  expect(providerKeepsTools(conversationProvider({ provider: "claude-work" }))).toBe(false);
  // Missing or malformed records are unknown, never a guess.
  for (const odd of [null, undefined, {}, { provider: 3 }]) expect(conversationProvider(odd as never)).toBeNull();
  expect(conversationProvider({ provider: "claude", metadata: { provider: "" } })).toBe("claude");
  expect(conversationProvider({ provider: "codex", metadata: "claude" } as never)).toBe("codex");

  const prefs = store({ session: "conversation-1", fingerprint: "f".repeat(64) });
  const profile = host("claude-work", "claude");
  const b = await board(prefs, oldBuild);
  const row = { id: "coordinator-1", status: "idle", provider: "claude-work" };
  expect(await readCoordinatorTools(profile.paseo, b.stamps, row)).toEqual({ stale: true });
  expect((await b.call(profile)).text).toBe(`planned\n\n${guideNote}`);
  expect(JSON.parse((await b.guide(profile)).text).conversation.definitions).toBe("older");
  expect(await readCoordinatorTools(profile.paseo, b.stamps, row)).toBeUndefined();
  // A new conversation on the profile is stamped like any Claude Code conversation.
  const fresh = store();
  await (await board(fresh, oldBuild)).call(profile);
  expect(fresh.read().toolStamps["coordinator-1"]).toMatchObject({ session: "conversation-1", contract: 1 });

  // A profile of another provider, and a look-alike ID with no record, stay out.
  for (const other of [host("codex-work", "codex"), host("claude-like")]) {
    const quiet = store();
    expect((await (await board(quiet, extended("host"))).call(other)).text).toBe("planned");
    expect(quiet.read().toolStamps).toEqual({});
  }
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
  const row = { status: "idle" };
  expect(coordinatorToolsView("stale", row, true)).toEqual({ stale: true });
  expect(coordinatorToolsView("stale", { ...row, status: "running" }, true)).toEqual({ stale: true });
  // A conversation on a provider that is not known to keep its definitions.
  expect(coordinatorToolsView("stale", row, false)).toBeUndefined();
  expect(coordinatorToolsView("current", row, true)).toBeUndefined();
  expect(coordinatorToolsView("unknown", row, true)).toBeUndefined();
  // No coordinator, or one on another host.
  expect(coordinatorToolsView("stale", undefined, true)).toBeUndefined();
  expect(coordinatorToolsView("stale", { ...row, serverId: "host-b" }, true)).toBeUndefined();
  // A closed or failed coordinator already has the reach notice.
  expect(coordinatorToolsView("stale", { ...row, status: "closed" }, true)).toBeUndefined();
  expect(coordinatorToolsView("stale", { ...row, status: "error" }, true)).toBeUndefined();
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
  expect(await readCoordinatorTools(counted, broken.stamps, { ...row, serverId: "host-b" })).toBeUndefined();
  expect(reads).toBe(1);
  // The same stamp under a conversation that another provider runs shows nothing.
  expect(await readCoordinatorTools(host("codex").paseo, broken.stamps, row)).toBeUndefined();
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
  // The step says what it rests on, and when the notice goes away.
  expect(notice.steps[1]).toContain("Claude Code 2.1.330");
  expect(notice.steps[1]).toContain("새로 고치면");
  expect(notice.steps[2]).toContain("/clear");
  for (const step of notice.steps.slice(1)) expect(step).toContain("직접 입력");
  const english = staleToolsNotice({ stale: true }, en)!;
  expect(english.title).toContain("from before the update");
  expect(english.steps[0]).toContain("read_board_guide");
  expect(english.steps[1]).toContain("/compact");
  expect(english.steps[1]).toContain("Claude Code 2.1.330");
  expect(english.steps[1]).toContain("refresh the board");
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
