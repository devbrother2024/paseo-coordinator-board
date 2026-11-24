import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contribute from "../index.server";
import { recordActionKey, recordRowKey } from "../client/decision-receipts";
import { nextFailureStreak, recommendedChoices, recommendedTrackedReply, trackedReplyBasis } from "../client/tracked-reply-draft";
import { boardSnapshot, boardScope } from "../shared/contract";
import { linkSession } from "../shared/session-links";
import { resolveTrackedDecision, trackedDecisionSchema, trackedReplyExample, trackedReplyRoute } from "../shared/tracked-decisions";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, {recursive: true, force: true}); });

type Agent = {project: string; status: string};
const card = (id: string, extra: Record<string, unknown>) => ({id, title: "Card " + id, kind: "answer", ...extra});

// Two selected checkouts of one repository: the ledger names "studio", one live session sits in "studio-copy".
async function fixture(items: Record<string, unknown>[], owner = "operator") {
  const root = mkdtempSync(join(tmpdir(), "reply-route-")); scratch.push(root);
  const data = join(root, "plugin-data", "coordinator-board"), ledger = join(root, "ledger");
  mkdirSync(data, {recursive: true}); mkdirSync(ledger);
  const ownerPath = join(root, "manager.json");
  const setOwner = (id: string) => writeFileSync(ownerPath, JSON.stringify({agentId: id}));
  setOwner(owner);
  writeFileSync(join(data, "tracked-sources.json"), JSON.stringify({version: 1, sources: [
    {source: "production", directory: ledger, projectId: "studio", projectTitle: "Studio", coordinatorFile: ownerPath},
  ]}));
  const ledgerItems = {items};
  const writeLedger = () => writeFileSync(join(ledger, "decisions.json"), JSON.stringify(ledgerItems));
  writeLedger();
  const agents = new Map<string, Agent>([
    ["general", {project: "studio", status: "idle"}],
    ["operator", {project: "studio", status: "idle"}],
    ["worker", {project: "studio", status: "closed"}],
    ["elsewhere", {project: "studio-copy", status: "idle"}],
  ]);
  const sent: {id: string; text: string}[] = [];
  const hidden = new Set<string>();
  const actor = (id: string) => ({id, title: id, updatedAt: "1", status: agents.get(id)!.status, pendingPermissions: []});
  const page = (entries: unknown[]) => ({entries, pageInfo: {hasMore: false, nextCursor: null}});
  const sdk = {
    workspaces: {list: async () => page([])},
    projects: {list: async () => ({projects: ["studio", "studio-copy"].map(projectId => ({projectId, projectDisplayName: projectId, projectRootPath: ""}))})},
    agents: {
      list: async () => page([...agents].filter(([id]) => !hidden.has(id)).map(([id, agent]) => ({agent: actor(id), project: {projectKey: agent.project}}))),
      ref: (id: string) => ({
        refresh: async () => agents.has(id) ? {agent: actor(id)} : null,
        timeline: {refetch: async () => ({epoch: id, entries: []})},
        send: async (text: string) => { sent.push({id, text}); },
      }),
    },
  };
  const handlers = new Map(), previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
  try { contribute({handle: (rpc, fn) => handlers.set(rpc.name, fn), registerSettings() {}, addHook: () => () => {}} as never); }
  finally { if (previous === undefined) delete process.env.PASEO_HOME; else process.env.PASEO_HOME = previous; }
  const rpc = async (def, input) => def.output.parse(await handlers.get(def.name)(def.input.parse(input), {paseo: sdk}));
  for (const projectId of ["studio", "studio-copy"]) await rpc(boardScope, {kind: "project", projectId, enabled: true});
  await rpc(boardScope, {kind: "coordinator", sessionId: "general"});
  const board = () => rpc(boardSnapshot, {fresh: true});
  const find = async (id: string) => {
    const snapshot = await board(), item = snapshot.trackedDecisions.items.find(i => i.id === id);
    return {snapshot, item, route: item && trackedReplyRoute(item, snapshot.coordinator, snapshot.sessions)};
  };
  const reply = (item, extra: Record<string, unknown> = {}) => rpc(resolveTrackedDecision, {
    id: item.id, source: item.source, projectId: item.projectId, fingerprint: item.fingerprint, answer: "Delete it", ...extra,
  });
  const link = (input) => rpc(linkSession, input);
  const context = (index = 0) => JSON.parse(sent[index].text.split("\n")[1]);
  // The board created this coordinator in its own workspace, outside the selected projects.
  const createdBy = (id: string) => {
    const scopePath = join(data, "scope.json"), scope = JSON.parse(readFileSync(scopePath, "utf8"));
    writeFileSync(scopePath, JSON.stringify({...scope, createdCoordinator: {id, previous: null, workspaceId: "board-workspace", config: {provider: "claude"}}}));
    agents.set(id, {project: "board-workspace", status: "idle"});
  };
  return {board, find, reply, link, context, agents, hidden, sent, ledgerItems, writeLedger, setOwner, createdBy};
}

const tenQuestions = Array.from({length: 10}, (_, index) => ({id: "Q" + (index + 1), text: "Question " + (index + 1),
  options: [{key: "A", text: "Yes", recommended: true}, {key: "B", text: "No"}]}));

test("coordinator cards owned by the board's own coordinator send with no or ten questions", async () => {
  const f = await fixture([card("icon", {where: "manager", recommend: ["Red"]}), card("plan", {where: "manager", questions: tenQuestions})], "general");
  f.createdBy("general");
  const {snapshot} = await f.find("icon");
  const [icon, plan] = snapshot.trackedDecisions.items;
  for (const item of [icon, plan]) {
    expect(trackedReplyRoute(item, snapshot.coordinator, snapshot.sessions)).toEqual({targetId: "general", recipientId: "general", fallbackId: null});
  }
  expect(await f.reply(icon, {recipientId: "general"})).toEqual({status: "sent"});
  expect(await f.reply(plan, {recipientId: "general", questionIndexes: plan.questions.map((_, index) => index)})).toEqual({status: "sent"});
  expect(f.sent.map(m => m.id)).toEqual(["general", "general"]);
  expect(f.context(1).questions).toHaveLength(10);
});

test("an edit between listing and sending says revised, and the same draft sends once the board refreshes", async () => {
  const f = await fixture([card("icon", {where: "manager", recommend: ["Red"], why: ["First check"]})], "general");
  f.createdBy("general");
  const {item} = await f.find("icon");
  Object.assign(f.ledgerItems.items[0], {why: ["First check", "Checked again"], recommend: ["Red", "It matches the logo"]});
  f.writeLedger();
  expect(await f.reply(item, {recipientId: "general"})).toEqual({status: "changed", reason: "revised"});
  const {item: latest} = await f.find("icon");
  expect(trackedReplyBasis(latest, null)).toBe(trackedReplyBasis(item, null));
  expect(await f.reply(latest, {recipientId: "general"})).toEqual({status: "sent"});
  expect(f.sent).toHaveLength(1);
});

test("an owner the board cannot find on this host is reported missing, and a repeat asks for another step", async () => {
  const f = await fixture([card("icon", {where: "manager"})], "general");
  f.createdBy("general");
  f.hidden.add("general");
  const {item, route} = await f.find("icon");
  expect(route?.recipientId).toBe("general");
  const first = await f.reply(item, {recipientId: "general"});
  expect(first).toEqual({status: "changed", reason: "recipient-missing"});
  const second = await f.reply(item, {recipientId: "general"});
  expect(f.sent).toBeEmpty();
  const streak = nextFailureStreak(nextFailureStreak(null, first, "general"), second, "general");
  expect(streak?.count).toBe(2);
  expect(nextFailureStreak(streak, {status: "changed", reason: "recipient-missing"}, "operator")?.count).toBe(1);
  expect(nextFailureStreak(streak, {status: "changed", reason: "revised"}, "general")?.count).toBe(1);
  expect(nextFailureStreak(streak, {status: "busy"}, "general")).toBeNull();
  f.hidden.delete("general");
  expect(await f.reply(item, {recipientId: "general"})).toEqual({status: "sent"});
});

test("a closed assigned session is never offered; the reply can go to the verified ledger owner once", async () => {
  const f = await fixture([card("cleanup", {where: "session", agentId: "worker", recommend: ["Delete"], howToAnswer: "Tell the worker: delete / keep"})]);
  const {item, route} = await f.find("cleanup");
  expect(route).toEqual({targetId: "worker", recipientId: null, fallbackId: "operator", blocked: "closed"});
  expect(await f.reply(item, {recipientId: "worker"})).toEqual({status: "changed", reason: "recipient-closed"});
  expect(await f.reply(item, {recipientId: "operator", route: "coordinator"})).toEqual({status: "sent"});
  expect(await f.reply(item, {recipientId: "operator", route: "coordinator"})).toEqual({status: "sent"});
  expect(f.sent.map(m => m.id)).toEqual(["operator"]);
  expect(f.context()).toMatchObject({route: "coordinator", sourceSessionId: "worker", recipientSessionId: "operator", cardId: "cleanup"});
  expect(f.sent[0].text.endsWith("\n\nDelete it")).toBe(true);
  const after = await f.board();
  expect(after.trackedDecisions.items).toBeEmpty();
  expect(after.replyHistory[0]).toMatchObject({status: "sent", recipientId: "operator", coordinator: true, answer: "Delete it"});
  f.agents.set("worker", {project: "studio", status: "idle"});
  expect(await f.reply(item, {recipientId: "worker"})).toEqual({status: "changed", reason: "conflict"});
  expect(f.sent).toHaveLength(1);
});

test("a session in another project explains the session link and still offers the owner", async () => {
  const f = await fixture([card("palette", {where: "session", agentId: "elsewhere", recommend: ["Dark"]})]);
  const {item, route} = await f.find("palette");
  expect(route).toEqual({targetId: null, recipientId: null, fallbackId: "operator", blocked: "other-project"});
  expect(await f.reply(item, {recipientId: "elsewhere"})).toEqual({status: "changed", reason: "recipient-missing"});
  await f.link({sessionId: "elsewhere", sourceProjectId: "studio-copy", targetProjectId: "studio", expectedTargetProjectId: null});
  const linked = await f.find("palette");
  expect(linked.route).toEqual({targetId: "elsewhere", recipientId: "elsewhere", fallbackId: "operator"});
  expect(await f.reply(linked.item, {recipientId: "elsewhere"})).toEqual({status: "sent"});
  expect(f.sent.map(m => m.id)).toEqual(["elsewhere"]);
});

test("a closed coordinator never redirects a coordinator card", async () => {
  const f = await fixture([card("owner-card", {where: "manager", recommend: ["Delete"]})]);
  f.agents.set("operator", {project: "studio", status: "closed"});
  const {item, route} = await f.find("owner-card");
  expect(route).toEqual({targetId: "operator", recipientId: null, fallbackId: null, blocked: "closed"});
  expect(await f.reply(item, {recipientId: "operator"})).toEqual({status: "changed", reason: "recipient-closed"});
  expect(await f.reply(item, {recipientId: "general", route: "coordinator"})).toEqual({status: "changed", reason: "recipient-changed"});
  expect(f.sent).toBeEmpty();
});

test("a rotated or unverified ledger owner never receives a redirected reply", async () => {
  const f = await fixture([card("cleanup", {where: "session", agentId: "worker"})]);
  const {item} = await f.find("cleanup");
  f.setOwner("general");
  expect(await f.reply(item, {recipientId: "operator", route: "coordinator"})).toEqual({status: "changed", reason: "owner-changed"});
  expect((await f.find("cleanup")).route?.fallbackId).toBe("general");
  f.setOwner("remote-owner");
  const unverified = await f.find("cleanup");
  expect(unverified.route).toMatchObject({blocked: "closed", fallbackId: null});
  for (const recipientId of ["remote-owner", "general"]) {
    expect(await f.reply(item, {recipientId, route: "coordinator"})).toEqual({status: "changed", reason: "owner-changed"});
  }
  expect(f.sent).toBeEmpty();
});

test("a busy coordinator does not queue a redirected reply", async () => {
  const f = await fixture([card("cleanup", {where: "session", agentId: "worker"})]);
  f.agents.set("operator", {project: "studio", status: "running"});
  const {item, route} = await f.find("cleanup");
  expect(route?.fallbackId).toBe("operator");
  expect(await f.reply(item, {recipientId: "operator", route: "coordinator"})).toEqual({status: "busy"});
  const after = await f.find("cleanup");
  expect(after.item?.queuedReply).toBeUndefined();
  expect(f.sent).toBeEmpty();
});

test("a display-only edit keeps the draft's basis; changed questions or recipients need a new look", async () => {
  const f = await fixture([card("notes", {where: "manager", recommend: ["Delete"], questions: [
    {id: "Q1", text: "Which branch?", options: [{key: "A", text: "Delete", recommended: true}, {key: "B", text: "Keep"}]},
  ]})]);
  const {item} = await f.find("notes");
  Object.assign(f.ledgerItems.items[0], {why: ["Added later"], urgency: "now", recommend: ["Delete, it is merged"]});
  f.writeLedger();
  const {item: revised} = await f.find("notes");
  expect(revised.fingerprint).not.toBe(item.fingerprint);
  expect(await f.reply(item, {recipientId: "operator", questionIndexes: [0]})).toEqual({status: "changed", reason: "revised"});
  expect(trackedReplyBasis(revised, null)).toBe(trackedReplyBasis(item, null));
  expect(recordRowKey(revised)).toBe(recordRowKey(item));
  expect(recordActionKey(revised)).not.toBe(recordActionKey(item));
  for (const change of [
    {questions: [{id: "Q1", text: "Which branch now?", options: item.questions[0].options}]},
    {questions: [{id: "Q1", text: "Which branch?", options: [{key: "A", text: "Archive"}, {key: "B", text: "Keep"}]}]},
    {where: "session", sessionId: "worker"},
  ]) expect(trackedReplyBasis({...revised, ...change} as typeof item, null)).not.toBe(trackedReplyBasis(item, null));
  expect(trackedReplyBasis(item, "general")).not.toBe(trackedReplyBasis(item, "operator"));
  expect(await f.reply(revised, {recipientId: "operator", questionIndexes: [0]})).toEqual({status: "sent"});
});

test("removed cards and a different earlier answer report their own reasons", async () => {
  const f = await fixture([card("gone", {where: "manager"}), card("saved", {where: "manager"})]);
  const {snapshot} = await f.find("gone");
  const [gone, saved] = snapshot.trackedDecisions.items;
  expect(await f.reply(saved, {answer: "Keep it"})).toEqual({status: "closed"});
  expect(await f.reply(saved, {answer: "Delete it"})).toEqual({status: "changed", reason: "conflict"});
  expect(await f.reply(saved, {recipientId: "operator"})).toEqual({status: "changed", reason: "conflict"});
  f.ledgerItems.items.splice(0, 1);
  f.writeLedger();
  expect(await f.reply(gone, {recipientId: "operator"})).toEqual({status: "changed", reason: "removed"});
  expect(await f.reply(gone)).toEqual({status: "changed", reason: "removed"});
  expect(f.sent).toBeEmpty();
});

test("a feed card without a ledger owner falls back to the live board coordinator only", () => {
  const item = trackedDecisionSchema.parse({source: "production", projectId: "studio", id: "feed", title: "Feed card", key: "f",
    fingerprint: "b".repeat(64), matchedSessionId: null, matchedPull: null, kind: "answer", where: "session", sessionId: "worker"});
  const sessions = [{id: "worker", projectId: "studio", status: "closed"}, {id: "general", projectId: "studio", status: "idle"}] as never[];
  expect(trackedReplyRoute(item, "general", sessions)).toEqual({targetId: "worker", recipientId: null, fallbackId: "general", blocked: "closed"});
  expect(trackedReplyRoute({...item, sessionHost: "remote"}, "general", sessions)).toEqual({targetId: null, recipientId: null, fallbackId: "general", blocked: "other-host"});
  expect(trackedReplyRoute({...item, sessionId: null}, "general", sessions)).toMatchObject({blocked: "no-session", fallbackId: "general"});
  expect(trackedReplyRoute(item, "general", [sessions[0], {id: "general", projectId: "studio", status: "error"}] as never[])).toMatchObject({fallbackId: null});
  expect(trackedReplyRoute(item, null, sessions)).toMatchObject({fallbackId: null});
  expect(trackedReplyRoute({...item, sourceCoordinatorId: null}, "general", sessions)).toMatchObject({fallbackId: null});
  expect(trackedReplyRoute({...item, where: "manager"}, null, sessions)).toEqual({targetId: null, recipientId: null, fallbackId: null, blocked: "no-coordinator"});
});

test("the example answer is only a placeholder; the recommendation is inserted on request", () => {
  const item = trackedDecisionSchema.parse({source: "ledger", projectId: "studio", id: "cleanup", title: "Remove branch", key: "k",
    fingerprint: "a".repeat(64), matchedSessionId: null, matchedPull: null, kind: "answer",
    recommend: ["Delete", "Its work is already merged."], howToAnswer: "Tell the worker: delete / keep"});
  expect(trackedReplyExample(item)).toBe("Tell the worker: delete / keep");
  expect(recommendedTrackedReply(item)).toBe("Delete");
  for (const change of [{kind: "merge"}, {matchedSessionId: "worker"}, {recommend: ["x".repeat(121)]}, {recommend: ["Delete\nor keep"]}, {recommend: []}]) {
    expect(recommendedTrackedReply({...item, ...change} as typeof item)).toBe("");
  }
  const choices = {...item, questions: [
    {id: "Q1", text: "Pick", multi: false, options: [{key: "A", text: "One", recommended: true}, {key: "B", text: "Two", recommended: false}]},
    {id: "Q2", text: "Pick any", multi: true, options: [{key: "1", text: "Logs", recommended: true}, {key: "2", text: "Docs", recommended: true}]},
    {id: "Q3", text: "Unclear", multi: false, options: [{key: "A", text: "One", recommended: true}, {key: "B", text: "Two", recommended: true}]},
    {id: "Q4", text: "Answered", multi: false, options: [{key: "A", text: "One", recommended: true}]},
  ]} as typeof item;
  expect(recommendedTrackedReply(choices)).toBe("");
  expect(recommendedChoices(choices, index => index === 3)).toEqual({
    0: [JSON.stringify(["A", "One"])], 1: [JSON.stringify(["1", "Logs"]), JSON.stringify(["2", "Docs"])],
  });
});
