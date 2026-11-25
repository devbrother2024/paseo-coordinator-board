import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {manageQueuedAnswer} from "../shared/busy-delivery";
import contribute from "../index.server";
import { recordActionKey, recordRowKey } from "../client/decision-receipts";
import {
  closedRevision, nextFailureStreak, recommendedTrackedReply, redirectAwaitsCheck, trackedBasisRecipient, trackedDraftLayout,
  trackedRecovery, trackedReplyBasis, trackedRetryFingerprint,
} from "../client/tracked-reply-draft";
import { trackedWorkSession } from "../client/tracked-session-targets";
import { ProjectRootReader } from "../server/project-root";
import { boardSnapshot, boardScope } from "../shared/contract";
import { projectFolderMap } from "../shared/project-folders";
import { linkSession } from "../shared/session-links";
import {
  legacyTrackedAnswer, resolveTrackedDecision, trackedAnswerLead, trackedAnswerText, trackedDecisionInputSchema, trackedDecisionSchema, trackedReplyExample, trackedReplyRoute,
  trackedRecipient,
} from "../shared/tracked-decisions";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, {recursive: true, force: true}); });

type Agent = {project: string; status: string; provider?:string; permission?:boolean; archived?: boolean};
const card = (id: string, extra: Record<string, unknown>) => ({id, title: "Card " + id, kind: "answer", ...extra});

// Two selected checkouts of one repository: the ledger names "studio", one live session sits in "studio-copy".
// `roots` gives the projects folders on disk. Without them, each project is only itself.
async function fixture(items: Record<string, unknown>[], owner = "operator", roots: Record<string, string> = {}) {
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
  const sent: {id: string; text: string; messageId?: string}[] = [];
  const optionsLog: {activeTurnBehavior?:string;sourceAgentId?:string}[]=[];
  const hidden = new Set<string>();
  // `lost`: the SDK call delivers the message and then fails. `history`: the recipient's timeline shows what arrived.
  const lost = new Set<string>();
  const history = {visible: false};
  const actor = (id: string) => ({id, title: id, updatedAt: "1", status: agents.get(id)!.status, pendingPermissions: agents.get(id)!.permission ? [{id:"request"}] : [],
    provider:agents.get(id)!.provider, activeTurn:agents.get(id)!.status==="running" ? {id:"turn"} : null,
    ...(agents.get(id)!.archived ? {archivedAt: "2026-01-02T00:00:00.000Z"} : {})});
  const page = (entries: unknown[]) => ({entries, pageInfo: {hasMore: false, nextCursor: null}});
  const sdk = {
    workspaces: {list: async () => page([])},
    projects: {list: async () => ({projects: ["studio", "studio-copy"].map(projectId => ({projectId, projectDisplayName: projectId, projectRootPath: roots[projectId] ?? ""}))})},
    agents: {
      list: async () => page([...agents].filter(([id]) => !hidden.has(id)).map(([id, agent]) => ({agent: actor(id), project: {projectKey: agent.project}}))),
      ref: (id: string) => ({
        refresh: async () => agents.has(id) ? {agent: actor(id)} : null,
        timeline: {refetch: async () => ({epoch: id, entries: history.visible
          ? sent.filter(m => m.id === id).map(m => ({item: {type: "user_message", messageId: m.messageId, text: m.text}})) : []})},
        send: async (text: string, options?: {messageId?: string;activeTurnBehavior?:string;sourceAgentId?:string}) => {
          optionsLog.push(options ?? {});
          sent.push({id, text, messageId: options?.messageId});
          if (lost.has(id)) throw new Error("connection lost");
        },
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
    return {snapshot, item, route: item && trackedReplyRoute(item, snapshot.coordinator, snapshot.sessions, projectFolderMap(snapshot.projects))};
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
  return {scopePath:join(data,"scope.json"),rpc,optionsLog,board, find, reply, link, context, agents, hidden, sent, lost, history, ledgerItems, writeLedger, setOwner, createdBy};
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

const sizes = {questions: [{id: "Q1", text: "Which size?", options: [{key: "A", text: "Small", recommended: true}, {key: "B", text: "Large"}]}]};

test("a reply to a card's questions starts with the card's answer lead, unless the person leaves it out or writes freely", async () => {
  const f = await fixture([card("lead", {where: "manager", answerLead: "Approve the image spec", ...sizes}), card("plain", {where: "manager", ...sizes})], "general");
  f.createdBy("general");
  const {item: led} = await f.find("lead"), {item: plain} = await f.find("plain");
  const compose = (item, replies: string[], free = "", photos = false, removed = false) =>
    trackedAnswerText(item, replies, free, removed ? "" : trackedAnswerLead(item, replies, free, photos));
  expect(compose(led, ["A · Small"])).toBe("Approve the image spec\nQ1 · Which size?: A · Small");
  expect(compose(plain, ["A · Small"])).toBe("Q1 · Which size?: A · Small");
  expect(compose(led, [""], "Hold it until Friday")).toBe("Hold it until Friday");
  expect(compose(led, ["B · Large"], "", false, true)).toBe("Q1 · Which size?: B · Large");
  expect(compose(led, ["A · Small"], "Ship it today")).toBe("Approve the image spec\nQ1 · Which size?: A · Small\nShip it today");
  // A photo sent with nothing typed still says what it answers.
  expect(compose(led, [""], "", true)).toBe("Approve the image spec");
  expect(compose(led, [""])).toBe("");
  expect(trackedAnswerLead({answerLead: " Approve\n  the spec "}, ["A · Small"], "")).toBe("Approve the spec");
  for (const item of [led, plain]) {
    expect(await f.reply(item, {recipientId: "general", answer: compose(item, ["A · Small"]), questionIndexes: [0]})).toEqual({status: "sent"});
  }
  expect(f.sent.map(m => m.text.split("\n\n").slice(1).join("\n\n"))).toEqual([
    "Approve the image spec\nQ1 · Which size?: A · Small", "Q1 · Which size?: A · Small",
  ]);
  expect(f.sent.some(m => m.text.includes("\u2014"))).toBe(false);
});

test("a reply recorded in the older form is still confirmed by the same answers, and is never sent again", async () => {
  const f = await fixture([card("lead", {where: "manager", answerLead: "Approve the image spec", ...sizes})], "general");
  f.createdBy("general");
  const {item} = await f.find("lead");
  const older = "Q1 · Which size? \u2014 A · Small";
  f.lost.add("general");
  expect(await f.reply(item, {recipientId: "general", answer: older, questionIndexes: [0]})).toEqual({status: "unconfirmed"});
  const current = trackedAnswerText(item, ["A · Small"], "", trackedAnswerLead(item, ["A · Small"], ""));
  expect(legacyTrackedAnswer(item, current)).toBe(older);
  expect(legacyTrackedAnswer(item, "Q1 · Which size?: A · Small")).toBe(older);
  const other = trackedAnswerText(item, ["B · Large"], "", trackedAnswerLead(item, ["B · Large"], ""));
  expect(await f.reply(item, {recipientId: "general", answer: other, questionIndexes: [0]})).toEqual({status: "changed", reason: "conflict"});
  expect(await f.reply(item, {recipientId: "general", answer: current, questionIndexes: [0]})).toEqual({status: "unconfirmed"});
  f.history.visible = true;
  expect(await f.reply(item, {recipientId: "general", answer: current, questionIndexes: [0]})).toEqual({status: "sent"});
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].text.endsWith("\n\n" + older)).toBe(true);
});

test("a reply left unconfirmed is checked with the session that took it after the card moves to another session", async () => {
  const ids = ["same", "stale", "other"];
  const f = await fixture(ids.map(id => card(id, {where: "session", agentId: "worker-a"})));
  for (const id of ["worker-a", "worker-b"]) f.agents.set(id, {project: "studio", status: "idle"});
  const before = {};
  for (const id of ids) before[id] = (await f.find(id)).item;
  f.lost.add("worker-a");
  for (const id of ids) expect(await f.reply(before[id], {recipientId: "worker-a"})).toEqual({status: "unconfirmed"});
  // The ledger hands the cards to another session, and the first one leaves the board.
  for (const item of f.ledgerItems.items) item.agentId = "worker-b";
  f.writeLedger();
  f.hidden.add("worker-a");
  const after = {};
  for (const id of ids) after[id] = await f.find(id);
  expect(after["same"].route.recipientId).toBe("worker-b");
  expect(after["same"].item.fingerprint).not.toBe(before["same"].fingerprint);
  // Until the first reply is found, nothing new goes out to either session.
  expect(await f.reply(after["same"].item, {recipientId: "worker-b"})).toEqual({status: "changed", reason: "earlier-unconfirmed"});
  expect(await f.reply(before["stale"], {recipientId: "worker-a"})).toEqual({status: "unconfirmed"});
  expect(f.sent).toHaveLength(3);
  f.history.visible = true;
  // The same reply closes only the revision it answered, and the card stays open for the new session.
  expect(await f.reply(after["same"].item, {recipientId: "worker-b"})).toEqual({status: "sent", revision: before["same"].fingerprint, recipientId: "worker-a"});
  expect((await f.find("same")).item?.fingerprint).toBe(after["same"].item.fingerprint);
  // A screen that still shows the first session confirms it the same way.
  expect(await f.reply(before["stale"], {recipientId: "worker-a"})).toEqual({status: "sent", revision: before["stale"].fingerprint});
  expect(f.sent).toHaveLength(3);
  // Once the first reply is found, a different reply answers the card as it is now.
  expect(await f.reply(after["other"].item, {recipientId: "worker-b", answer: "Keep it"})).toEqual({status: "sent"});
  expect(f.sent.slice(3).map(m => [m.id, m.text.endsWith("\n\nKeep it")])).toEqual([["worker-b", true]]);
});

test("an unconfirmed reply holds its card for ten minutes, or until the session that took it is deleted or archived", async () => {
  const firsts = {held: "worker-a", deleted: "worker-c", archived: "worker-d"};
  const f = await fixture(Object.entries(firsts).map(([id, agentId]) => card(id, {where: "session", agentId})));
  for (const id of [...Object.values(firsts), "worker-b"]) f.agents.set(id, {project: "studio", status: "idle"});
  const before = {};
  for (const [id, agentId] of Object.entries(firsts)) {
    before[id] = (await f.find(id)).item;
    f.lost.add(agentId);
    expect(await f.reply(before[id], {recipientId: agentId})).toEqual({status: "unconfirmed"});
  }
  // The cards move to another session before any first reply is found, and two of the first sessions go away.
  for (const item of f.ledgerItems.items) item.agentId = "worker-b";
  f.writeLedger();
  f.agents.delete("worker-c");
  f.agents.set("worker-d", {project: "studio", status: "idle", archived: true});
  const after = {};
  for (const id of Object.keys(firsts)) after[id] = (await f.find(id)).item;
  expect(await f.reply(after["held"], {recipientId: "worker-b", answer: "Keep it"})).toEqual({status: "changed", reason: "earlier-unconfirmed"});
  for (const id of ["deleted", "archived"]) expect(await f.reply(after[id], {recipientId: "worker-b", answer: "Keep it"})).toEqual({status: "sent"});
  setSystemTime(new Date(Date.now() + 10 * 60_000 + 1000));
  try {
    expect(await f.reply(after["held"], {recipientId: "worker-b", answer: "Keep it"})).toEqual({status: "sent"});
  } finally {
    setSystemTime();
  }
  // Every first reply is still unconfirmed, so retrying it only checks again.
  for (const [id, agentId] of Object.entries(firsts)) expect(await f.reply(before[id], {recipientId: agentId})).toEqual({status: "unconfirmed"});
  expect(f.sent.map(m => m.id)).toEqual(["worker-a", "worker-c", "worker-d", "worker-b", "worker-b", "worker-b"]);
});

test("an edit between listing and sending says revised, and the same draft sends once the board refreshes", async () => {
  const f = await fixture([card("icon", {where: "manager", recommend: ["Red"], why: ["First check"]})], "general");
  f.createdBy("general");
  const {item} = await f.find("icon");
  Object.assign(f.ledgerItems.items[0], {why: ["First check", "Checked again"], urgency: "today"});
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
  expect(trackedRecovery({...second, fingerprint: item.fingerprint}, item.fingerprint, streak)).toEqual({needsRefresh: false, awaitingRevision: false, stuck: true});
  f.hidden.delete("general");
  expect(await f.reply(item, {recipientId: "general"})).toEqual({status: "sent"});
});

test("a ledger owner that has only left the session list is reported missing, not changed", async () => {
  const f = await fixture([card("icon", {where: "manager"}), card("cleanup", {where: "session", agentId: "worker"})]);
  const icon = await f.find("icon"), cleanup = await f.find("cleanup");
  expect(icon.route?.recipientId).toBe("operator");
  expect(cleanup.route?.fallbackId).toBe("operator");
  f.hidden.add("operator");
  expect(await f.reply(icon.item, {recipientId: "operator"})).toEqual({status: "changed", reason: "recipient-missing"});
  expect(await f.reply(cleanup.item, {recipientId: "operator", route: "coordinator"})).toEqual({status: "changed", reason: "recipient-missing"});
  expect(f.sent).toBeEmpty();
  f.hidden.delete("operator");
  expect(await f.reply(icon.item, {recipientId: "operator"})).toEqual({status: "sent"});
});

test("a rejected reply keeps the form, waits for the newer revision, or asks for a refresh", () => {
  const twice = {key: "same", count: 2};
  const rejected = (status: string, reason?: string) => ({status, ...(reason ? {reason} : {}), requested: "rev-1", fingerprint: "rev-1"});
  // The typed reply stays editable when the owner or recipient changed. The same rejection twice points to the session.
  for (const reason of ["earlier-unconfirmed", "owner-changed", "recipient-changed", "recipient-closed", "recipient-error", "recipient-missing", "recipient-unchecked"]) {
    expect(trackedRecovery(rejected("changed", reason), "rev-1", null)).toEqual({needsRefresh: false, awaitingRevision: false, stuck: false});
    expect(trackedRecovery(rejected("changed", reason), "rev-1", twice).stuck).toBe(true);
  }
  // A changed card holds the send button until its newer revision is on screen. Then the reply can be reviewed and sent.
  expect(trackedRecovery(rejected("changed", "revised"), "rev-1", twice)).toEqual({needsRefresh: false, awaitingRevision: true, stuck: true});
  expect(trackedRecovery(rejected("changed", "revised"), "rev-2", twice)).toEqual({needsRefresh: false, awaitingRevision: false, stuck: false});
  for (const outcome of [rejected("changed", "removed"), rejected("changed", "conflict"), rejected("changed", "queue-stopped"), rejected("changed"),
    rejected("out-of-scope"), rejected("unavailable")]) {
    expect(trackedRecovery(outcome, "rev-1", null)).toEqual({needsRefresh: true, awaitingRevision: false, stuck: false});
  }
  expect(trackedRecovery(rejected("changed", "removed"), "rev-1", twice).stuck).toBe(true);
  for (const outcome of [null, rejected("sent"), rejected("busy"), rejected("unconfirmed")]) {
    expect(trackedRecovery(outcome, "rev-1", twice)).toEqual({needsRefresh: false, awaitingRevision: false, stuck: false});
  }
});

test("a closed work session is never offered; the reply can go to the verified ledger owner once", async () => {
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

test("a work session in a project on the same folder gets the chip and the reply; another folder gets neither", async () => {
  const disk = mkdtempSync(join(tmpdir(), "reply-folders-")); scratch.push(disk);
  const checkout = join(disk, "Work", "app"), named = join(disk, "other", "app"), alias = join(disk, "alias");
  mkdirSync(checkout, {recursive: true}); mkdirSync(named, {recursive: true}); symlinkSync(checkout, alias, "junction");
  const cased = join(disk, "work", "app"), insensitive = existsSync(cased);
  const open = async (copyRoot: string, status = "idle") => {
    const f = await fixture([card("palette", {where: "session", agentId: "elsewhere"})], "operator", {studio: checkout, "studio-copy": copyRoot});
    f.agents.set("elsewhere", {project: "studio-copy", status});
    const found = await f.find("palette");
    // The card's session chip and its send button read the same check.
    const target = trackedWorkSession(found.item!, {hostLabel: "This host", sessions: found.snapshot.sessions, hosts: [],
      folders: projectFolderMap(found.snapshot.projects)});
    const chip = target?.kind === "local" ? target.id : null;
    return {f, ...found, chip};
  };
  const linked = await open(alias);
  expect(linked.chip).toBe("elsewhere");
  expect(linked.route).toEqual({targetId: "elsewhere", recipientId: "elsewhere", fallbackId: "operator"});
  expect(await linked.f.reply(linked.item, {recipientId: "operator", route: "coordinator"})).toEqual({status: "changed", reason: "recipient-changed"});
  expect(await linked.f.reply(linked.item, {recipientId: "elsewhere"})).toEqual({status: "sent"});
  expect(linked.f.sent.map(m => m.id)).toEqual(["elsewhere"]);
  // Two spellings of one path are one folder only where the disk ignores letter case.
  const spelled = await open(cased);
  expect(spelled.chip).toBe(insensitive ? "elsewhere" : null);
  expect(spelled.route?.recipientId ?? null).toBe(insensitive ? "elsewhere" : null);
  const other = await open(named);
  expect(other.chip).toBeNull();
  expect(other.route).toEqual({targetId: null, recipientId: null, fallbackId: "operator", blocked: "other-project"});
  expect(await other.f.reply(other.item, {recipientId: "elsewhere"})).toEqual({status: "changed", reason: "recipient-missing"});
  expect(other.f.sent).toBeEmpty();
  const ended = await open(alias, "closed");
  expect(ended.route).toEqual({targetId: "elsewhere", recipientId: null, fallbackId: "operator", blocked: "closed"});
  expect(await ended.f.reply(ended.item, {recipientId: "elsewhere"})).toEqual({status: "changed", reason: "recipient-closed"});
  expect(ended.f.sent).toBeEmpty();
});

test("a same-folder session the board cannot check just now asks for another try instead of calling it missing", async () => {
  const disk = mkdtempSync(join(tmpdir(), "reply-folders-")); scratch.push(disk);
  const checkout = join(disk, "app"), alias = join(disk, "alias");
  mkdirSync(checkout); symlinkSync(checkout, alias, "junction");
  const f = await fixture([card("palette", {where: "session", agentId: "elsewhere"})], "operator", {studio: checkout, "studio-copy": alias});
  const {item, route} = await f.find("palette");
  expect(route?.recipientId).toBe("elsewhere");
  // Neither folder is read in time when the reply goes out.
  const late = spyOn(ProjectRootReader.prototype, "describe").mockResolvedValue([{temporary: false, unread: true}, {temporary: false, unread: true}]);
  try {
    expect(await f.reply(item, {recipientId: "elsewhere"})).toEqual({status: "changed", reason: "recipient-unchecked"});
  } finally {
    late.mockRestore();
  }
  expect(f.sent).toBeEmpty();
  expect(await f.reply(item, {recipientId: "elsewhere"})).toEqual({status: "sent"});
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
  // The owner is unchanged but has no session on this host. Any other session is not the owner.
  expect(await f.reply(item, {recipientId: "remote-owner", route: "coordinator"})).toEqual({status: "changed", reason: "recipient-missing"});
  expect(await f.reply(item, {recipientId: "general", route: "coordinator"})).toEqual({status: "changed", reason: "owner-changed"});
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

test("a redirected reply left unconfirmed is still checked after the work session is back, and nothing new is redirected", async () => {
  const f = await fixture([card("cleanup", {where: "session", agentId: "worker"}), card("archive", {where: "session", agentId: "worker"})]);
  const {item} = await f.find("cleanup");
  f.lost.add("operator");
  const redirected = await f.reply(item, {recipientId: "operator", route: "coordinator"});
  expect(redirected).toEqual({status: "unconfirmed"});
  f.agents.set("worker", {project: "studio", status: "idle"});
  const back = await f.find("cleanup");
  expect(back.route).toEqual({targetId: "worker", recipientId: "worker", fallbackId: "operator"});
  // The card keeps offering the check, and the reply is never sent to the work session as well.
  const outcome = {...redirected, mode: "fallback", recipientId: "operator"};
  expect(redirectAwaitsCheck(outcome, back.route!.fallbackId)).toBe(true);
  expect(redirectAwaitsCheck({...outcome, mode: "send"}, "operator")).toBe(false);
  expect(redirectAwaitsCheck({...outcome, status: "changed"}, "operator")).toBe(false);
  expect(redirectAwaitsCheck(outcome, "general")).toBe(false);
  expect(trackedBasisRecipient({sourceCoordinatorId: undefined}, back.route, true)).toBe("operator");
  expect(trackedBasisRecipient({sourceCoordinatorId: undefined}, back.route)).toBe("worker");
  expect(trackedBasisRecipient(back.item!, back.route, true)).toBeNull();
  expect(await f.reply(back.item, {recipientId: "worker"})).toEqual({status: "changed", reason: "conflict"});
  expect(await f.reply(back.item, {recipientId: "operator", route: "coordinator"})).toEqual({status: "unconfirmed"});
  f.history.visible = true;
  expect(await f.reply(back.item, {recipientId: "operator", route: "coordinator"})).toEqual({status: "sent"});
  expect(f.sent.map(m => m.id)).toEqual(["operator"]);
  // A card with nothing sent yet goes to its own session again.
  const other = await f.find("archive");
  expect(await f.reply(other.item, {recipientId: "operator", route: "coordinator"})).toEqual({status: "changed", reason: "recipient-changed"});
  expect(f.sent).toHaveLength(1);
});

test("a redirected reply left unconfirmed is checked with the owner that took it after the ledger owner rotates", async () => {
  const f = await fixture([card("cleanup", {where: "session", agentId: "worker"}), card("archive", {where: "session", agentId: "worker"})]);
  const {item: cleanup} = await f.find("cleanup"), {item: archive} = await f.find("archive");
  f.lost.add("operator");
  for (const item of [cleanup, archive]) expect(await f.reply(item, {recipientId: "operator", route: "coordinator"})).toEqual({status: "unconfirmed"});
  // A new owner is not a new revision, and the old owner has left the managed sessions.
  f.setOwner("general");
  f.hidden.add("operator");
  const rotated = await f.find("cleanup");
  expect(rotated.item!.fingerprint).toBe(cleanup.fingerprint);
  expect(rotated.route?.fallbackId).toBe("general");
  expect(await f.reply(cleanup, {recipientId: "operator", route: "coordinator"})).toEqual({status: "changed", reason: "owner-changed"});
  expect(await f.reply(cleanup, {recipientId: "general", route: "coordinator"})).toEqual({status: "changed", reason: "conflict"});
  f.history.visible = true;
  // The answer names the owner that took the reply, so the board's receipt does not point at the one the retry went to.
  expect(await f.reply(cleanup, {recipientId: "general", route: "coordinator"})).toEqual({status: "sent", recipientId: "operator"});
  expect(await f.reply(archive, {recipientId: "operator", route: "coordinator"})).toEqual({status: "sent"});
  expect(f.sent.map(m => m.id)).toEqual(["operator", "operator"]);
  expect((await f.board()).trackedDecisions.items).toBeEmpty();
});

test("a display-only edit keeps the draft's basis; anything the reply answers needs a new look", async () => {
  const f = await fixture([card("notes", {where: "manager", ask: ["Build 12 to staging?"], recommend: ["Delete"], questions: [
    {id: "Q1", text: "Which branch?", options: [{key: "A", text: "Delete", recommended: true, does: "Removes it from staging"}, {key: "B", text: "Keep"}]},
  ]})]);
  const {item} = await f.find("notes");
  Object.assign(f.ledgerItems.items[0], {why: ["Added later"], risk: ["Slow rebuild"], urgency: "now", howToAnswer: "A or B",
    recommendedReply: "Delete it", qa: [{q: "Is it merged?", a: "Yes"}], replyHistory: [{text: "Asked once", at: null}]});
  f.writeLedger();
  const {item: revised} = await f.find("notes");
  expect(revised.fingerprint).not.toBe(item.fingerprint);
  expect(revised.recommendedReply).toBe("Delete it");
  expect(await f.reply(item, {recipientId: "operator", questionIndexes: [0]})).toEqual({status: "changed", reason: "revised"});
  expect(trackedReplyBasis(revised, null)).toBe(trackedReplyBasis(item, null));
  expect(trackedReplyBasis({...revised, pullRepository: "studio/app", pullTarget: {repo: "studio/app", number: 7}}, null)).toBe(trackedReplyBasis(item, null));
  expect(recordRowKey(revised)).toBe(recordRowKey(item));
  expect(recordActionKey(revised)).not.toBe(recordActionKey(item));
  const [delete_, keep] = item.questions[0].options;
  const option = (change: Record<string, unknown>) => ({questions: [{...item.questions[0], options: [{...delete_, ...change}, keep]}]});
  for (const change of [
    {questions: [{id: "Q1", text: "Which branch now?", options: item.questions[0].options}]},
    {questions: [{id: "Q1", text: "Which branch?", options: [{key: "A", text: "Archive"}, {key: "B", text: "Keep"}]}]},
    {title: "Release build"}, {ask: ["Build 13 to production?"]}, {recommend: ["Keep"]},
    option({does: "Removes it from production"}), option({note: "Only after the release"}), option({pros: "Less noise"}), option({cons: "No rollback"}),
    option({recommended: false}),
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
  // A board coordinator replaced while the reply is being written asks for a new look; a ledger owner has its own check.
  const replaced = [sessions[0], {id: "operator", projectId: "studio", status: "idle"}] as never[];
  const basis = (coordinator: string, list: never[], card = item) => trackedReplyBasis(card, trackedBasisRecipient(card, trackedReplyRoute(card, coordinator, list)));
  expect(trackedBasisRecipient(item, trackedReplyRoute(item, "general", sessions))).toBe("general");
  expect(basis("operator", replaced)).not.toBe(basis("general", sessions));
  const owned = {...item, sourceCoordinatorId: "general"};
  expect(trackedBasisRecipient(owned, trackedReplyRoute(owned, "general", sessions))).toBeNull();
});

test("a tracked reply matches a same-folder session only on the board host", () => {
  const item = trackedDecisionSchema.parse({source: "production", projectId: "studio", id: "feed", title: "Feed card", key: "f",
    fingerprint: "b".repeat(64), matchedSessionId: null, matchedPull: null, kind: "answer", where: "session", sessionId: "worker"});
  const folders = {studio: "shared-folder", "studio-copy": "shared-folder"};
  const local = {id: "worker", projectId: "studio-copy", status: "idle"};
  const remote = {...local, serverId: "win-host"};
  expect(trackedRecipient(item, null, [local] as never[], folders)).toBe("worker");
  expect(trackedReplyRoute(item, null, [local] as never[], folders).recipientId).toBe("worker");
  expect(trackedRecipient(item, null, [remote] as never[], folders)).toBeNull();
  expect(trackedReplyRoute(item, null, [remote] as never[], folders)).toMatchObject({recipientId: null, blocked: "other-host"});
});

test("a redirected reply is refused once the card's own session can take it", async () => {
  const f = await fixture([card("cleanup", {where: "session", agentId: "worker"}), card("palette", {where: "session", agentId: "elsewhere"})]);
  const {item: cleanup, route} = await f.find("cleanup");
  const {item: palette} = await f.find("palette");
  expect(route).toMatchObject({recipientId: null, fallbackId: "operator", blocked: "closed"});
  f.agents.set("worker", {project: "studio", status: "idle"});
  expect(await f.reply(cleanup, {recipientId: "operator", route: "coordinator"})).toEqual({status: "changed", reason: "recipient-changed"});
  await f.link({sessionId: "elsewhere", sourceProjectId: "studio-copy", targetProjectId: "studio", expectedTargetProjectId: null});
  expect(await f.reply(palette, {recipientId: "operator", route: "coordinator"})).toEqual({status: "changed", reason: "recipient-changed"});
  expect(f.sent).toBeEmpty();
  expect(await f.reply(cleanup, {recipientId: "worker"})).toEqual({status: "sent"});
  expect(f.sent.map(m => m.id)).toEqual(["worker"]);
});

test("an unconfirmed reply is only checked, never sent again, after its card changes", async () => {
  const f = await fixture([card("icon", {where: "manager", why: ["First check"]}), card("logo", {where: "manager", why: ["First check"]})]);
  const first = (await f.find("icon")).item, other = (await f.find("logo")).item;
  f.lost.add("operator");
  expect(await f.reply(first, {recipientId: "operator"})).toEqual({status: "unconfirmed"});
  expect(await f.reply(other, {recipientId: "operator"})).toEqual({status: "unconfirmed"});
  f.lost.clear();
  for (const entry of f.ledgerItems.items) Object.assign(entry, {why: ["First check", "Checked again"]});
  f.writeLedger();
  const revised = (await f.find("icon")).item, otherRevised = (await f.find("logo")).item;
  expect(revised.fingerprint).not.toBe(first.fingerprint);
  // The card keeps the attempt, so its retry names the revision that was sent.
  const retry = trackedRetryFingerprint({status: "unconfirmed", requested: first.fingerprint, answer: "Delete it", recipientId: "operator"},
    revised.fingerprint, "Delete it", "operator");
  expect(retry).toBe(first.fingerprint);
  expect(trackedRetryFingerprint({status: "unconfirmed", requested: first.fingerprint, answer: "Delete it", recipientId: "operator"},
    revised.fingerprint, "Keep it", "operator")).toBe(revised.fingerprint);
  expect(trackedRetryFingerprint({status: "changed", requested: first.fingerprint}, revised.fingerprint, "", null)).toBe(revised.fingerprint);
  expect(await f.reply({...revised, fingerprint: retry}, {recipientId: "operator"})).toEqual({status: "unconfirmed"});
  // A reloaded board asks with the new revision, and still nothing goes out.
  expect(await f.reply(revised, {recipientId: "operator"})).toEqual({status: "unconfirmed"});
  expect(await f.reply(revised, {recipientId: "operator", answer: "Keep it"})).toEqual({status: "changed", reason: "earlier-unconfirmed"});
  f.history.visible = true;
  expect(await f.reply({...revised, fingerprint: retry}, {recipientId: "operator"})).toEqual({status: "sent", revision: first.fingerprint});
  expect(await f.reply({...revised, fingerprint: retry}, {recipientId: "operator"})).toEqual({status: "sent", revision: first.fingerprint});
  const reloaded = await f.reply(otherRevised, {recipientId: "operator"});
  expect(reloaded).toEqual({status: "sent", revision: other.fingerprint});
  expect(f.sent).toHaveLength(2);
  // Each confirmed reply closes the revision it answered. The board still lists both cards as they are now.
  const after = await f.board();
  expect(new Set(after.trackedDecisions.items.map(item => item.fingerprint))).toEqual(new Set([revised.fingerprint, otherRevised.fingerprint]));
  for (const [item, outcome] of [[revised, {status: "sent", requested: retry}], [otherRevised, {...reloaded, requested: otherRevised.fingerprint}]] as const) {
    const closed = closedRevision(outcome);
    expect(closed).not.toBeNull();
    expect(recordActionKey({key: item.key, fingerprint: closed!})).not.toBe(recordActionKey(item));
  }
  expect(closedRevision({status: "sent", requested: revised.fingerprint})).toBe(revised.fingerprint);
  expect(closedRevision({status: "unconfirmed", requested: retry})).toBeNull();
  expect(after.replyHistory.map(entry => entry.status)).toEqual(["sent", "sent"]);
});

test("a reply or photo kept from before the card had questions stays on screen until it is removed", () => {
  const item = trackedDecisionSchema.parse({source: "production", projectId: "studio", id: "theme", title: "Theme", key: "t",
    fingerprint: "c".repeat(64), matchedSessionId: null, matchedPull: null, kind: "answer", where: "manager"});
  expect(trackedDraftLayout(item, "Use the dark theme", [])).toEqual({freeEditor: true, carried: false, orphaned: []});
  const asked = {...item, questions: [{id: "Q1", text: "Which theme?", multi: false, options: []}]};
  expect(trackedDraftLayout(asked, "Use the dark theme", [])).toEqual({freeEditor: false, carried: true, orphaned: []});
  expect(trackedAnswerText(asked, ["Dark"], "Use the dark theme").split("\n")).toEqual([trackedAnswerText(asked, ["Dark"], ""), "Use the dark theme"]);
  expect(trackedDraftLayout(asked, "", [{questionIndex: undefined}]).carried).toBe(true);
  expect(trackedDraftLayout(asked, " ", [{questionIndex: 0}])).toEqual({freeEditor: false, carried: false, orphaned: []});
  const stray = {questionIndex: 1};
  expect(trackedDraftLayout(asked, "", [stray, {questionIndex: 0}]).orphaned).toEqual([stray]);
  expect(trackedDraftLayout(item, "", [{questionIndex: 0}]).orphaned).toHaveLength(1);
  expect(trackedDraftLayout({...item, matchedSessionId: "worker"}, "Use the dark theme", [])).toEqual({freeEditor: false, carried: false, orphaned: []});
});

test("a card has one input: its own, its single question's, or the merge card's", () => {
  const item = trackedDecisionSchema.parse({source: "production", projectId: "studio", id: "theme", title: "Theme", key: "t",
    fingerprint: "c".repeat(64), matchedSessionId: null, matchedPull: null, kind: "answer", where: "manager"});
  const question = (id: string) => ({id, text: "Which " + id + "?", multi: false, options: []});
  // No questions: the card's own input.
  expect(trackedDraftLayout(item, "", []).freeEditor).toBe(true);
  // One question: that question's input is the card's input, so no second one is added.
  expect(trackedDraftLayout({...item, questions: [question("Q1")]}, "", []).freeEditor).toBe(false);
  // Several questions: the card's input stays under them for a question, a change request or a note, and what is
  // written there is not something left over from before the questions.
  const several = {...item, questions: [question("Q1"), question("Q2")]};
  expect(trackedDraftLayout(several, "Why not both?", [{questionIndex: undefined}])).toEqual({freeEditor: true, carried: false, orphaned: []});
  // A card tied to a session question with questions of its own keeps its input; without them the session card has it.
  expect(trackedDraftLayout({...several, matchedSessionId: "worker"}, "", []).freeEditor).toBe(true);
  expect(trackedDraftLayout({...item, matchedSessionId: "worker"}, "", []).freeEditor).toBe(false);
  // While the merge card takes the change request, the ledger side adds no input of its own.
  expect(trackedDraftLayout(item, "", [], true).freeEditor).toBe(false);
  expect(trackedDraftLayout(several, "", [], true).freeEditor).toBe(false);
  // A draft or photo already on the ledger side stays reachable when the merge input appears after a refresh.
  expect(trackedDraftLayout(item, "Hold this until Friday", [], true).freeEditor).toBe(true);
  expect(trackedDraftLayout(item, "", [{questionIndex: undefined}], true).freeEditor).toBe(true);
  expect(trackedDraftLayout(several, "Why not both?", [], true).freeEditor).toBe(true);
  expect(trackedDraftLayout(item, "  ", [{questionIndex: 0}], true).freeEditor).toBe(false);
});

test("the example answer is only a placeholder; the recommendation is inserted on request", () => {
  const item = trackedDecisionSchema.parse({source: "ledger", projectId: "studio", id: "cleanup", title: "Remove branch", key: "k",
    fingerprint: "a".repeat(64), matchedSessionId: null, matchedPull: null, kind: "answer",
    recommend: ["Delete", "Its work is already merged."], howToAnswer: "Tell the worker: delete / keep"});
  expect(trackedReplyExample(item)).toBe("Tell the worker: delete / keep");
  expect(recommendedTrackedReply(item)).toBe("Delete");
  for (const change of [{kind: "merge"}, {matchedSessionId: "worker"}, {recommend: ["x".repeat(121)]}, {recommend: ["Delete\nor keep"]}, {recommend: []},
    {recommendedReply: "Keep", kind: "merge"}, {recommendedReply: "x".repeat(121), recommend: ["Delete\nor keep"]}, {recommendedReply: "  ", recommend: []}]) {
    expect(recommendedTrackedReply({...item, ...change} as typeof item)).toBe("");
  }
  // The ledger's short reply comes first; a long one falls back to the first recommendation line.
  expect(recommendedTrackedReply({...item, recommendedReply: " Keep the branch "})).toBe("Keep the branch");
  expect(recommendedTrackedReply({...item, recommendedReply: "Keep", recommend: []})).toBe("Keep");
  expect(recommendedTrackedReply({...item, recommendedReply: "Keep\nfor now"})).toBe("Delete");
  expect(recommendedTrackedReply({...item, recommendedReply: "x".repeat(121)})).toBe("Delete");
  // The example reply is the sentence to send after following the recommendation, so it comes before the
  // recommendation itself, which may be an instruction ("Disconnect the remote desktop") rather than a reply.
  const done = {...item, recommend: ["Disconnect the remote desktop"], howToAnswer: "Disconnected the remote desktop"};
  expect(recommendedTrackedReply({...done, recommendedReply: "Done"})).toBe("Done");
  expect(recommendedTrackedReply(done)).toBe("Disconnected the remote desktop");
  expect(recommendedTrackedReply({...done, howToAnswer: undefined})).toBe("Disconnect the remote desktop");
  expect(recommendedTrackedReply({...done, recommendedReply: "x".repeat(121)})).toBe("Disconnected the remote desktop");
  expect(recommendedTrackedReply({...done, howToAnswer: "Disconnected\nand checked"})).toBe("Disconnect the remote desktop");
  expect(recommendedTrackedReply({...done, howToAnswer: "y".repeat(121)})).toBe("Disconnect the remote desktop");
  // A reply format that lists choices or blanks to fill is a guide, not a sentence to send.
  expect(recommendedTrackedReply({...done, howToAnswer: "Disconnected / Still connected"})).toBe("Disconnect the remote desktop");
  expect(recommendedTrackedReply({...done, howToAnswer: "Disconnected at <time>"})).toBe("Disconnect the remote desktop");
  const choices = {...item, questions: [
    {id: "Q1", text: "Pick", multi: false, options: [{key: "A", text: "One", recommended: true}, {key: "B", text: "Two", recommended: false}]},
    {id: "Q2", text: "Pick any", multi: true, options: [{key: "1", text: "Logs", recommended: true}, {key: "2", text: "Docs", recommended: true}]},
    {id: "Q3", text: "Unclear", multi: false, options: [{key: "A", text: "One", recommended: true}, {key: "B", text: "Two", recommended: true}]},
    {id: "Q4", text: "Answered", multi: false, options: [{key: "A", text: "One", recommended: true}]},
  ]} as typeof item;
  expect(recommendedTrackedReply(choices)).toBe("");
});

test("a running worker steers only a person's reply, and an idle-only ledger card queues it", async()=>{
  const f=await fixture([card("one",{where:"session",agentId:"worker"}),card("two",{where:"session",agentId:"worker",deliverWhenIdle:true})]);
  f.agents.set("worker",{project:"studio",status:"running",provider:"codex"});
  const first=(await f.find("one")).item;
  expect(await f.reply(first,{recipientId:"worker",answer:"Keep two columns."})).toEqual({status:"sent"});
  expect(f.sent[0].text).toBe("Keep two columns.");
  expect(f.optionsLog[0]).toMatchObject({activeTurnBehavior:"steer"});
  expect(f.optionsLog[0].sourceAgentId).toBeUndefined();
  const second=(await f.find("two")).item;
  expect(second.deliverWhenIdle).toBe(true);
  expect(await f.reply(second,{recipientId:"worker"})).toEqual({status:"queued"});
  expect(f.sent).toHaveLength(1);
});

test("parallel review holds the original reply across refresh and ambiguous delivery, and requires a human to resume",async()=>{
  const f=await fixture([card("one",{where:"session",agentId:"worker"})]);
  f.agents.set("worker",{project:"studio",status:"running",provider:"custom"});
  const first=(await f.find("one")).item;
  expect(await f.reply(first,{recipientId:"worker",answer:"Use blue."})).toEqual({status:"queued"});
  const q=(await f.find("one")).item.queuedReply;
  expect(q.offer).toBe(true);
  const ref={card:{kind:"ledger",source:first.source,id:first.id,projectId:first.projectId,fingerprint:first.fingerprint},
    messageId:q.messageId,coordinatorId:q.coordinatorId};
  const act=action=>f.rpc(manageQueuedAnswer,{...ref,action});
  f.agents.get("operator")!.permission=true;
  expect(await act("parallel")).toEqual({status:"unavailable"});
  expect(f.sent).toBeEmpty();
  f.agents.get("operator")!.permission=false;
  f.lost.add("operator");
  const pair=await Promise.all([act("parallel"),act("parallel")]);
  expect(pair.map(p=>p.status).sort()).toEqual(["changed","unconfirmed"]);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({id:"operator"});
  expect(f.sent[0].text).toContain("Use blue.");
  const preamble=f.sent[0].text.split("\n{")[0];
  expect(preamble).toContain("이 요청 자체는 승인이 아닙니다");
  expect(preamble).toContain("Check the original session transcript");
  expect(f.optionsLog[0]).toMatchObject({sourceAgentId:"plugin:coordinator-board",activeTurnBehavior:"steer"});
  f.agents.get("worker")!.status="idle";
  expect((await f.find("one")).item.queuedReply.parallel).toBe("held");
  expect(f.sent).toHaveLength(1);
  expect(await act("resume")).toEqual({status:"updated"});
  for(let i=0;i<5 && f.sent.length===1;i++) { await f.board(); await Bun.sleep(5); }
  expect(f.sent.map(m=>m.id)).toEqual(["operator","worker"]);
});

test("invalid idle flags preserve both direct and imported ledger cards and allow mid-turn replies", async () => {
  for (const value of ["true", 1, null, {enabled:true}]) {
    const input = {source:"ledger", projectId:"studio", id:"one", title:"Pick a layout", deliverWhenIdle:value};
    expect(trackedDecisionInputSchema.parse(input).deliverWhenIdle).toBeFalsy();
  }
  const f = await fixture([card("one",{where:"session",agentId:"worker",deliverWhenIdle:"true"})]);
  f.agents.set("worker",{project:"studio",status:"running",provider:"codex"});
  const item = (await f.find("one")).item;
  expect(item).toBeDefined();
  expect(item.deliverWhenIdle).toBeFalsy();
  expect(await f.reply(item,{recipientId:"worker",answer:"Two columns."})).toEqual({status:"sent"});
  expect(f.sent.map(message=>message.text)).toEqual(["Two columns."]);
});

for (const ended of ["closed","archived"]) {
  test(`a held reply can only be canceled once the worker is ${ended}`, async () => {
    const f = await fixture([card("one",{where:"session",agentId:"worker"})]);
    f.agents.set("worker",{project:"studio",status:"running",provider:"custom"});
    const item = (await f.find("one")).item;
    await f.reply(item,{recipientId:"worker"});
    const queue = (await f.find("one")).item.queuedReply;
    const ref = {card:{kind:"ledger",source:item.source,id:item.id,projectId:item.projectId,fingerprint:item.fingerprint},
      messageId:queue.messageId,coordinatorId:queue.coordinatorId};
    const act = action => f.rpc(manageQueuedAnswer,{...ref,action});
    expect(await act("parallel")).toEqual({status:"updated"});
    expect((await f.find("one")).item.queuedReply.originState).toBe("live");
    if (ended==="closed") f.agents.get("worker")!.status="closed";
    else { f.agents.get("worker")!.archived=true; f.hidden.add("worker"); }
    // A click from the older live snapshot must also preserve the hold.
    expect(await act("resume")).toEqual({status:"changed"});
    expect((await f.find("one")).item.queuedReply).toMatchObject({parallel:"held",originState:"ended"});
    expect(await act("cancel")).toEqual({status:"updated"});
    expect((await f.find("one")).item.queuedReply).toBeUndefined();
    expect(f.sent.map(m=>m.id)).toEqual(["operator"]);
  });
}

test("a persisted conversation hold distinguishes an archived origin from an unreachable host", async () => {
  const f = await fixture([]);
  const scope = JSON.parse(readFileSync(f.scopePath,"utf8"));
  const card = {kind:"session",projectId:"studio",sessionId:"worker",version:"question-one"};
  const input = {projectId:card.projectId,sessionId:card.sessionId,version:card.version,recipientId:"worker",
    action:"reply",text:"Two columns.",requestKey:"queued-answer-1"};
  const held = {input,at:new Date().toISOString(),title:"Which layout?",fingerprint:"saved-answer",
    stopped:false,parallel:"held",photos:[]};
  const local = crypto.randomUUID(), remote = crypto.randomUUID();
  writeFileSync(f.scopePath,JSON.stringify({...scope,queuedDecisions:{
    [local]:{...held,serverId:null}, [remote]:{...held,serverId:"offline-host"},
  }}));
  f.agents.get("worker")!.archived = true;
  const snapshot = await f.board();
  for (const [messageId,originState] of [[local,"ended"],[remote,"unknown"]]) {
    expect(snapshot.queuedConversations.find(q => q.messageId===messageId)).toMatchObject({parallel:"held",originState});
    expect(await f.rpc(manageQueuedAnswer,{card,messageId,action:"resume"})).toEqual({status:"changed"});
    expect(await f.rpc(manageQueuedAnswer,{card,messageId,action:"cancel"})).toEqual({status:"updated"});
  }
  expect(f.sent).toBeEmpty();
});
