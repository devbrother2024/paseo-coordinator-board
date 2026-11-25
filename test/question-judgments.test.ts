import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConversationEvidence, applyRecordedQuestions, excerpt, questionDetails, scanOf } from "../server/conversation";
import { decorateDecision } from "../server/session-decisions";
import { PreferenceStore } from "../server/preferences";
import { recordDisplay, saveScan } from "../server/open-questions";
import { coordinatorClosures, judgeOpenQuestionTool, judgmentNotice, QuestionNotices } from "../server/question-judgments";
import { boardActions, boardActionTool } from "../server/board-guide";
import { keptQuestionNotice } from "../client/kept-question";

const NOW = Date.parse("2030-01-02T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const row = (extra: Record<string, unknown> = {}) => ({ id: "worker", status: "idle", projectId: "p", projectTitle: "Project", workspaceTitle: "w", model: null,
  title: "Release prep", lane: "idle", detail: "Waiting", activityAt: "1", ...extra }) as any;
type Step = ["assistant" | "user" | "agent", string, number?];
const entry = ([kind, text, hoursAgo]: Step, seqEnd: number) => {
  const timestamp = hoursAgo === undefined ? undefined : at(hoursAgo);
  if (kind === "agent") return { seqEnd, timestamp, item: { type: "tool_call", callId: "paseo-agent-message:m" + seqEnd, name: "message", status: "completed",
    agentMessage: { event: "message", sender: { id: "other-session" }, text } } };
  return { seqEnd, timestamp, item: { type: kind === "user" ? "user_message" : "assistant_message", text } };
};
const evidence = (...steps: Step[]) => excerpt({ epoch: "e1", entries: steps.map(entry), error: null } as any);
const older: Step = ["assistant", "Which region should I use? Please choose one.", 3];
const ask: Step = ["assistant", "Release 0.9 is ready.\nShall I publish it now?", 1];
const report: Step = ["agent", "Status from another session: tests passed.", 0.9];
const reply: Step = ["assistant", "Noted the report.", 0.8];

function store(coordinator: string | null = "coord") {
  const prefs = new PreferenceStore(join(mkdtempSync(join(tmpdir(), "question-judgments-")), "scope.json"));
  prefs.change(scope => { scope.projects = ["p"]; scope.coordinator = coordinator; });
  return prefs;
}
/** A snapshot of the worker as the board makes it, saving what it found. */
function snapshot(prefs: PreferenceStore, e: ReturnType<typeof evidence> | null, target = row()) {
  const scope = prefs.read();
  if (e) applyConversationEvidence(e, target, scope, undefined, NOW);
  else applyRecordedQuestions(target, scope, undefined, NOW);
  decorateDecision(target, undefined, scope, e ?? undefined);
  const scan = scanOf(target);
  if (scan) prefs.change(current => { saveScan(current, target, scan, item => recordDisplay(questionDetails(item)), NOW); });
  return target;
}
const records = (prefs: PreferenceStore) => prefs.read().raisedQuestions.worker?.questions ?? [];

test("judgment needed: other open questions, a question the session spoke after, and one the person wrote something else after", () => {
  const prefs = store();
  snapshot(prefs, evidence(ask));
  expect(records(prefs)[0].judge).toBeUndefined();
  snapshot(prefs, evidence(ask, report, reply));
  expect(records(prefs)[0].judge).toBe("spoke-after");
  const other = store();
  snapshot(other, evidence(ask, ["user", "Let's look at the logo first.", 0.5]));
  expect(records(other)[0].judge).toBe("person-wrote");
  const two = store();
  snapshot(two, evidence(older, ask));
  expect(records(two).map(record => record.judge)).toEqual(["others-open", undefined]);
});

test("notice: the coordinator hears once about each question to judge, and never while it waits on a permission", async () => {
  const prefs = store();
  snapshot(prefs, evidence(older, ask));
  const sent: any[] = [];
  const coordinator = { id: "coord", status: "idle", pendingPermissions: [] as unknown[], activeTurn: null };
  const sdk = { agents: { ref: (id: string) => ({
    refresh: async () => ({ agent: id === "coord" ? coordinator : null }),
    send: async (text: string, options: any) => { sent.push({ id, text, options }); },
  }) } };
  const notices = new QuestionNotices(prefs);
  coordinator.pendingPermissions = [{ id: "approval" }];
  expect(await notices.deliver(sdk as any)).toBe("waiting");
  expect(sent).toEqual([]);
  coordinator.pendingPermissions = [];
  expect(await notices.deliver(sdk as any)).toBe("sent");
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ id: "coord", options: { sourceAgentId: "plugin:coordinator-board" } });
  expect(sent[0].text).toContain("[Coordinator Board · 판단 필요 / Judgment needed]");
  expect(sent[0].text).toContain("Which region should I use?");
  expect(sent[0].text).toContain("judge_open_question");
  expect(sent[0].text).not.toContain("Shall I publish it now?");
  expect(await notices.deliver(sdk as any)).toBe("nothing");
  expect(sent).toHaveLength(1);
  // A new coordinator hears again.
  prefs.change(scope => { scope.coordinator = "coord-2"; });
  expect(await notices.deliver(sdk as any)).toBe("unavailable");
  // The coordinator's own questions are not sent to it.
  const own = store("worker");
  snapshot(own, evidence(older, ask));
  expect(await new QuestionNotices(own).deliver(sdk as any)).toBe("nothing");
});

test("notice text carries values in both languages and says it grants nothing", () => {
  const text = judgmentNotice([{ sessionId: "worker", questionKey: "k1", question: "Which region?", why: "others-open", askedAt: at(3) }]);
  expect(text.split("\n")[0]).toBe("[Coordinator Board · 판단 필요 / Judgment needed]");
  expect(JSON.parse(text.split("\n")[1])).toEqual({ sessionId: "worker", questionKey: "k1", question: "Which region?", why: "others-open", askedAt: at(3) });
  expect(text).toContain("승인이 아닙니다");
  expect(text).toContain("not an approval");
});

test("judge action: only the coordinator, only an open recorded question, and handled needs evidence", async () => {
  const prefs = store();
  snapshot(prefs, evidence(older, ask));
  const [first] = records(prefs);
  let invalidated = 0;
  const actions = boardActions([judgeOpenQuestionTool(prefs, () => { invalidated++; })]);
  expect(actions.get("judge_open_question")?.tool).toBe(false);
  const run = (input: unknown, caller = "coord") => boardActionTool(actions).execute({ action: "judge_open_question", input } as any, { agent: { id: caller } } as any);
  const rejected = await run({ sessionId: "worker", questionKey: first.key, verdict: "handled" });
  expect(rejected.isError).toBe(true);
  expect((await run({ sessionId: "worker", questionKey: first.key, verdict: "handled", evidence: "   " })).isError).toBe(true);
  expect((await run({ sessionId: "worker", questionKey: first.key, verdict: "needed" }, "someone-else")).isError).toBe(true);
  expect((await run({ sessionId: "worker", questionKey: "unknown", verdict: "needed" })).isError).toBe(true);
  expect(records(prefs)).toHaveLength(2);
  const done = await run({ sessionId: "worker", questionKey: first.key, verdict: "handled", evidence: "The person chose eu-west in the session at 10:02." });
  expect(done.isError).toBeFalsy();
  expect(invalidated).toBe(1);
  expect(records(prefs).map(record => record.key)).not.toContain(first.key);
  expect(prefs.read().closedQuestions[first.key]).toMatchObject({ reason: "coordinator", evidence: "The person chose eu-west in the session at 10:02.",
    question: expect.stringContaining("Which region"), projectId: "p", by: "coord" });
});

test("verdicts: needed keeps the card and says so, handled closes it and shows in recent decisions", async () => {
  const prefs = store();
  snapshot(prefs, evidence(older, ask, report, reply));
  const [first, second] = records(prefs);
  const run = (input: unknown) => judgeOpenQuestionTool(prefs, () => {}).execute(input as any, { agent: { id: "coord" } } as any);
  // Before a verdict, the other question does not ride on the card.
  expect(snapshot(prefs, evidence(older, ask, report, reply)).keptQuestion.older).toBeUndefined();
  await run({ sessionId: "worker", questionKey: first.key, verdict: "needed", evidence: "No answer in the session yet." });
  await run({ sessionId: "worker", questionKey: second.key, verdict: "needed" });
  const card = snapshot(prefs, evidence(older, ask, report, reply));
  expect(card.keptQuestion).toMatchObject({ verdict: "needed", older: [{ question: expect.stringContaining("Which region") }] });
  expect(card.decision?.source).toBe("conversation");
  await run({ sessionId: "worker", questionKey: second.key, verdict: "handled", evidence: "Published by the release session, see its report." });
  const after = snapshot(prefs, evidence(older, ask, report, reply));
  expect(after.detail).toContain("Which region");
  const history = coordinatorClosures(prefs.read(), new Set(["p"]));
  expect(history).toEqual([expect.objectContaining({ status: "closed", title: expect.stringContaining("Shall I publish"), reviewedBy: "coord",
    reviewReason: "Published by the release session, see its report.", projectId: "p" })]);
  expect(coordinatorClosures(prefs.read(), new Set(["q"]))).toEqual([]);
});

test("asked again after a verdict: the same words in a new message open a new question", async () => {
  const prefs = store();
  snapshot(prefs, evidence(ask, report, reply));
  const [first] = records(prefs);
  await judgeOpenQuestionTool(prefs, () => {}).execute({ sessionId: "worker", questionKey: first.key, verdict: "handled", evidence: "Answered in the session." } as any,
    { agent: { id: "coord" } } as any);
  expect(snapshot(prefs, evidence(ask, report, reply)).lane).toBe("idle");
  const again = snapshot(prefs, evidence(ask, report, reply, ["assistant", "Shall I publish it now?", 0.2]));
  expect(again).toMatchObject({ lane: "human", detail: expect.stringContaining("Shall I publish") });
  expect(again.keptQuestion.key).not.toBe(first.key);
});

test("without a coordinator, other open questions still ride on the card", () => {
  const prefs = store(null);
  expect(snapshot(prefs, evidence(older, ask)).keptQuestion.older).toHaveLength(1);
});

test("card line: no 'may have answered', no per-question close, and the coordinator's verdict is plain", () => {
  const decision = { source: "conversation" } as any;
  const maybe = keptQuestionNotice({ keptQuestion: { key: "k", later: 2, maybeAnswered: true }, decision })!;
  expect(maybe.line).toEqual(["이 뒤로 세션이 2번 더 말함", "The session spoke 2 more times since"]);
  expect(JSON.stringify(maybe)).not.toMatch(/답했을 수 있음|may have answered/);
  expect(keptQuestionNotice({ keptQuestion: { key: "k", later: 0, verdict: "needed" }, decision })!.line).toEqual(
    ["코디네이터 판단: 처리 필요", "Coordinator: needs your decision"]);
  expect(keptQuestionNotice({ keptQuestion: { key: "k", later: 0, ended: true, stale: true }, decision })!.line).toEqual(
    ["오래된 질문 · 세션 끝남 · 미처리", "Old question · Session ended · Not handled"]);
  expect(keptQuestionNotice({ keptQuestion: { key: "k", later: 0 }, decision })!.line).toBeNull();
});
