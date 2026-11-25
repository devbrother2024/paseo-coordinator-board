import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConversationEvidence, excerpt, questionDetails, scanOf } from "../server/conversation";
import { decorateDecision } from "../server/session-decisions";
import { PreferenceStore } from "../server/preferences";
import { recordDisplay, saveScan } from "../server/open-questions";
import { boardActions, boardActionTool, boardGuideTool } from "../server/board-guide";
import { judgeOpenQuestionTool } from "../server/question-judgments";
import { keptQuestionNotice } from "../client/kept-question";

const NOW = Date.parse("2030-01-02T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const row = () => ({ id: "worker", status: "idle", projectId: "p", projectTitle: "Project", workspaceTitle: "w", model: null,
  title: "Release prep", lane: "idle", detail: "Waiting", activityAt: "1" }) as any;
type Step = ["assistant" | "agent", string, number];
const entry = ([kind, text, hoursAgo]: Step, seqEnd: number) => kind === "agent"
  ? { seqEnd, timestamp: at(hoursAgo), item: { type: "tool_call", callId: "paseo-agent-message:m" + seqEnd, name: "message", status: "completed",
    agentMessage: { event: "message", sender: { id: "other-session" }, text } } }
  : { seqEnd, timestamp: at(hoursAgo), item: { type: "assistant_message", text } };
const evidence = (...steps: Step[]) => excerpt({ epoch: "e1", entries: steps.map(entry), error: null } as any);
// Asked two days ago, then the session kept answering other sessions' reports.
const old: Step[] = [["assistant", "Release 0.9 is ready.\nShall I publish it to the eu-west region now?", 48],
  ...Array.from({ length: 20 }, (_, i): Step[] => [["agent", `Report ${i}`, 40 - i], ["assistant", `Noted report ${i}.`, 40 - i]]).flat()];

function store() {
  const prefs = new PreferenceStore(join(mkdtempSync(join(tmpdir(), "no-stale-fade-")), "scope.json"));
  prefs.change(scope => { scope.projects = ["p"]; scope.coordinator = "coord"; });
  return prefs;
}
function card(prefs: PreferenceStore) {
  const target = row();
  const e = evidence(...old);
  applyConversationEvidence(e, target, prefs.read(), undefined, NOW);
  decorateDecision(target, undefined, prefs.read(), e);
  prefs.change(scope => { saveScan(scope, target, scanOf(target)!, item => recordDisplay(questionDetails(item)), NOW); });
  return target;
}
const judge = (prefs: PreferenceStore, input: Record<string, unknown>) => boardActionTool(boardActions([judgeOpenQuestionTool(prefs, () => {})]))
  .execute({ action: "judge_open_question", input } as any, { agent: { id: "coord" } } as any);

test("an old question before the coordinator judges is a plain decision card: no fade, no 'old question', no extra line", () => {
  const shown = card(store());
  expect(shown.lane).toBe("human");
  expect(shown.decision?.source).toBe("conversation");
  expect(shown.keptQuestion).not.toHaveProperty("stale");
  const notice = keptQuestionNotice(shown)!;
  expect(notice).not.toHaveProperty("stale");
  expect(notice.line).toBeNull();
  expect(JSON.stringify(notice)).not.toMatch(/오래된 질문|Old question/);
});

test("an old question the coordinator judged as needed says what to do, from its todo", async () => {
  const prefs = store();
  const first = card(prefs);
  expect((await judge(prefs, { sessionId: "worker", questionKey: first.keptQuestion.key, verdict: "needed", todo: "Choose whether 0.9 goes to eu-west today" })).isError).toBeFalsy();
  const shown = card(prefs);
  expect(shown.keptQuestion).toMatchObject({ verdict: "needed", verdictTodo: "Choose whether 0.9 goes to eu-west today" });
  expect(keptQuestionNotice(shown)!.line).toEqual(["처리 필요 · Choose whether 0.9 goes to eu-west today", "Needs your decision · Choose whether 0.9 goes to eu-west today"]);
  // A todo is short: at most 80 characters.
  expect((await judge(prefs, { sessionId: "worker", questionKey: first.keptQuestion.key, verdict: "needed", todo: "x".repeat(81) })).isError).toBe(true);
});

test("without a todo, the needed line shows the question's first line", async () => {
  const prefs = store();
  const first = card(prefs);
  await judge(prefs, { sessionId: "worker", questionKey: first.keptQuestion.key, verdict: "needed" });
  const shown = card(prefs);
  expect(shown.keptQuestion.verdictTodo).toBe("Shall I publish it to the eu-west region now?");
  expect(keptQuestionNotice(shown)!.line?.[0]).toBe("처리 필요 · Shall I publish it to the eu-west region now?");
});

test("the guide tells the coordinator: reports and guidance are handled, and age decides nothing", async () => {
  const guide = boardGuideTool(boardActions([judgeOpenQuestionTool(store(), () => {})]), "rev");
  const topic = JSON.parse((await guide.execute({ topic: "judge_open_question" } as any, { agent: { id: "coord" } } as any)).text);
  expect(topic.usage).toContain("보고·안내·다른 카드 안내");
  expect(topic.usage).toContain("오래됐다는 이유");
  expect(topic.usage).toContain("not a reason");
  expect(topic.usage).toContain("todo");
});
