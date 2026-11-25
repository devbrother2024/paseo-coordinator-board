import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConversationEvidence, applyRecordedQuestions, excerpt, questionDetails, scanOf } from "../server/conversation";
import { decorateDecision } from "../server/session-decisions";
import { PreferenceStore } from "../server/preferences";
import { ledgerQuestionsBySession, recordDisplay, saveScan, type LedgerView } from "../server/open-questions";
import { questionsToJudge } from "../server/question-judgments";
import { TrackedDecisionStore } from "../server/tracked-decisions";

const NOW = Date.parse("2030-01-02T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const row = (extra: Record<string, unknown> = {}) => ({ id: "worker", status: "idle", projectId: "book", projectTitle: "Book", workspaceTitle: "w", model: null,
  title: "Proxy build", lane: "idle", detail: "Waiting", activityAt: "1", ...extra }) as any;
type Step = ["assistant" | "user", string, number] | ["agent", string, number, string];
const entry = (step: Step, seqEnd: number) => {
  const [kind, text, hoursAgo] = step;
  if (kind === "agent") return { seqEnd, timestamp: at(hoursAgo), item: { type: "tool_call", callId: "paseo-agent-message:relay-" + seqEnd, name: "message",
    status: "completed", agentMessage: { event: "message", sender: { id: step[3] }, text } } };
  return { seqEnd, timestamp: at(hoursAgo), item: { type: kind === "user" ? "user_message" : "assistant_message", text } };
};
const evidence = (...steps: Step[]) => excerpt({ epoch: "e1", entries: steps.map(entry), error: null } as any);
const block = (questions: { id: string; text: string }[]) => "Two choices for the proxy build.\n\n```board-question\n" + JSON.stringify({ questions: questions.map(q => ({ ...q,
  options: [{ key: "A", text: "720p", recommended: true }, { key: "B", text: "1080p" }] })) }) + "\n```";
const asked: Step = ["assistant", block([{ id: "Q1", text: "Screen proxy resolution?" }]), 2];
// What a coordinator relays after the person answered the ledger card: card information and the person's words.
const relay = (sender: string): Step => ["agent", "[Coordinator Board · ledger reply] card m5-resolution\n\nQ1 · Screen proxy resolution?: A · 720p", 1, sender];

function store() {
  const prefs = new PreferenceStore(join(mkdtempSync(join(tmpdir(), "relayed-answer-")), "scope.json"));
  prefs.change(scope => { scope.projects = ["book"]; scope.coordinator = "coord"; });
  return prefs;
}
function snapshot(prefs: PreferenceStore, e: ReturnType<typeof evidence> | null, ledger?: LedgerView, target = row()) {
  const scope = prefs.read();
  if (e) applyConversationEvidence(e, target, scope, ledger, NOW);
  else applyRecordedQuestions(target, scope, ledger, NOW);
  decorateDecision(target, undefined, scope, e ?? undefined);
  const scan = scanOf(target);
  if (scan) prefs.change(current => { saveScan(current, target, scan, item => recordDisplay(questionDetails(item)), NOW); });
  return target;
}

test("an answer the coordinator relays from the person closes the question, with who relayed it and which message", () => {
  const prefs = store();
  const shown = snapshot(prefs, evidence(asked));
  const key = shown.keptQuestion.key;
  const after = snapshot(prefs, evidence(asked, relay("coord"), ["assistant", "Building the 720p proxy now.", 0.5]));
  expect(after.lane).toBe("idle");
  expect(prefs.read().closedQuestions[key]).toMatchObject({ reason: "relayed", by: "coord", messageId: expect.stringContaining("relay-") });
});

test("the same words relayed by another session are not evidence", () => {
  const prefs = store();
  const after = snapshot(prefs, evidence(asked, relay("some-worker"), ["assistant", "Noted.", 0.5]));
  expect(after).toMatchObject({ lane: "human", detail: expect.stringContaining("Screen proxy resolution") });
  expect(Object.keys(prefs.read().closedQuestions)).toEqual([]);
});

test("a relayed answer that fits two open questions closes neither", () => {
  const prefs = store();
  const second: Step = ["assistant", block([{ id: "Q1", text: "Screen proxy resolution?" }]), 1.5];
  const after = snapshot(prefs, evidence(asked, second, relay("coord")));
  expect(after.lane).toBe("human");
  expect(Object.keys(prefs.read().closedQuestions)).toEqual([]);
});

test("a relayed message that only mentions an option in its prose is not an answer", () => {
  const prefs = store();
  const chatter: Step = ["agent", "The ledger card asks the person to pick between A and B. Waiting for the answer.", 1, "coord"];
  expect(snapshot(prefs, evidence(asked, chatter)).lane).toBe("human");
});

test("a ledger card for the same session and the same question takes the card's place and closes it when resolved", () => {
  const dir = mkdtempSync(join(tmpdir(), "relayed-answer-ledger-"));
  const feed = join(dir, "tracked.json");
  writeFileSync(feed, JSON.stringify({ version: 1, items: [{ source: "fixture", projectId: "book", id: "m5-resolution", title: "Proxy resolution",
    sessionId: "worker", where: "human", kind: "answer", questions: [{ id: "Q1", text: "Screen proxy resolution?",
      options: [{ key: "A", text: "720p" }, { key: "B", text: "1080p" }] }] }] }));
  const tracked = new TrackedDecisionStore(feed);
  const items = () => tracked.read(new Set(["book"]), [], { items: [], projects: [] }).items;
  const ledger = (): LedgerView => ({ questions: ledgerQuestionsBySession(items()), resolved: tracked.resolvedKeys() ?? undefined });
  const prefs = store();
  // While the ledger card is open, only the ledger card shows the question.
  const shown = snapshot(prefs, evidence(asked, ["assistant", "Waiting for the resolution.", 1.5]), ledger());
  expect(shown.decision).toBeUndefined();
  expect(shown.lane).not.toBe("human");
  expect(prefs.read().raisedQuestions.worker.questions[0]).toMatchObject({ moved: true });
  // It is not a question for the coordinator to judge either: the ledger card holds it.
  expect(questionsToJudge(prefs.read(), NOW)).toEqual([]);
  // The person answers on the ledger card and it is resolved: the conversation question closes with it.
  const card = items()[0];
  expect(tracked.resolve({ source: "fixture", projectId: "book", id: "m5-resolution", fingerprint: card.fingerprint }, () => new Set(["book"])).status).toBe("closed");
  const after = snapshot(prefs, evidence(asked, ["assistant", "Waiting for the resolution.", 1.5]), ledger());
  expect(after.decision).toBeUndefined();
  expect(Object.values(prefs.read().closedQuestions).map((entry: any) => entry.reason)).toEqual(["ledger"]);
});

test("a ledger card for another session with the same words does not touch the question", () => {
  const prefs = store();
  const other: LedgerView = { questions: ledgerQuestionsBySession([{ key: "k", fingerprint: "f", sessionId: "someone-else",
    questions: [{ id: "Q1", text: "Screen proxy resolution?" }] } as any]), resolved: new Set() };
  expect(snapshot(prefs, evidence(asked), other).decision?.source).toBe("conversation");
});

test("an example inside a code block of the coordinator's message is not a relayed answer", () => {
  const prefs = store();
  const example: Step = ["agent", "To answer, the person can write a line like this:\n```\nQ1 · Screen proxy resolution?: A · 720p\n```\n> Q1 A\nWaiting for the answer.", 1, "coord"];
  expect(snapshot(prefs, evidence(asked, example)).lane).toBe("human");
  expect(Object.keys(prefs.read().closedQuestions)).toEqual([]);
});

test("a ledger card with only some of a block's questions does not take the block, and its resolution closes nothing", () => {
  const two: Step = ["assistant", block([{ id: "Q1", text: "Screen proxy resolution?" }, { id: "Q2", text: "Keep the source files?" }]), 2];
  const card = (questions: { id: string; text: string }[], resolved: string[] = []): LedgerView => ({
    questions: ledgerQuestionsBySession([{ key: "m5", fingerprint: "f1", sessionId: "worker", questions } as any]), resolved: new Set(resolved) });
  const partial = store();
  const shown = snapshot(partial, evidence(two), card([{ id: "Q1", text: "Screen proxy resolution?" }]));
  expect(shown.decision?.source).toBe("conversation");
  expect(partial.read().raisedQuestions.worker.questions[0].heldByLedger).toBeUndefined();
  // The partial card goes away resolved: the block's question stays open.
  const after = snapshot(partial, evidence(two), { questions: new Map(), resolved: new Set([JSON.stringify(["m5", "f1"])]) });
  expect(after.decision?.source).toBe("conversation");
  expect(Object.keys(partial.read().closedQuestions)).toEqual([]);
  // A card with every question of the block takes it.
  const whole = store();
  const held = snapshot(whole, evidence(two), card([{ id: "Q1", text: "Screen proxy resolution?" }, { id: "Q2", text: "Keep the source files?" }]));
  expect(held.decision).toBeUndefined();
  expect(whole.read().raisedQuestions.worker.questions[0].heldByLedger).toBe(true);
});

test("a question a ledger card held shows again on its session card while the ledger cannot be read", () => {
  const prefs = store();
  const ledger: LedgerView = { questions: ledgerQuestionsBySession([{ key: "m5", fingerprint: "f1", sessionId: "worker",
    questions: [{ id: "Q1", text: "Screen proxy resolution?" }] } as any]), resolved: new Set() };
  expect(snapshot(prefs, evidence(asked), ledger).decision).toBeUndefined();
  // The ledger file is missing or unreadable: the board cannot confirm the ledger card holds it, so the session card shows it.
  const unreadable = snapshot(prefs, evidence(asked), { questions: new Map(), unreadable: true });
  expect(unreadable.decision?.source).toBe("conversation");
  // Nothing closed meanwhile, and the ledger card takes it again once the ledger reads.
  expect(Object.keys(prefs.read().closedQuestions)).toEqual([]);
  expect(snapshot(prefs, evidence(asked), ledger).decision).toBeUndefined();
  // A session the board does not read (working, ended) follows the same rule from the record.
  const working = snapshot(prefs, null, { questions: new Map(), unreadable: true }, row({ status: "running", lane: "running", detail: "Working" }));
  expect(working.decision?.source).toBe("conversation");
});
