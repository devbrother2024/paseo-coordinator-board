import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferenceStore } from "../server/preferences";
import { judgeOpenQuestionTool, listOpenQuestionsTool } from "../server/question-judgments";
import { boardActions, boardActionTool, boardGuideTool } from "../server/board-guide";

const at = "2030-01-02T10:00:00.000Z";
function store() {
  const prefs = new PreferenceStore(join(mkdtempSync(join(tmpdir(), "list-open-questions-")), "scope.json"));
  const question = (key: string, text: string, extra: Record<string, unknown> = {}) => ({ key, epoch: "e1", seq: 3, question: text, raisedAt: at, askedAt: at, later: 1, ...extra });
  prefs.change(scope => {
    scope.projects = ["p"];
    scope.coordinator = "coord";
    scope.raisedQuestions.worker = { projectId: "p", title: "Worker", projectTitle: "P", workspaceTitle: "w", questions: [
      question("k1", "Which region\u0007 should I use?‮", { judge: "spoke-after" }),
      question("k2", "Shall I publish " + "x".repeat(400), { verdict: { kind: "needed", todo: "Pick a release day", at, by: "coord" } }),
      question("k3", "Held by a ledger card?", { moved: true, heldByLedger: true }),
    ] };
    scope.raisedQuestions.other = { projectId: "p", title: "Other", projectTitle: "P", workspaceTitle: "w", questions: [question("k4", "Which font?")] };
    scope.raisedQuestions.outside = { projectId: "q", title: "Outside", projectTitle: "Q", workspaceTitle: "w", questions: [question("k5", "Out of scope?")] };
  });
  return prefs;
}
const run = (prefs: PreferenceStore, input: Record<string, unknown> = {}, caller = "coord") =>
  boardActionTool(boardActions([listOpenQuestionsTool(prefs)])).execute({ action: "list_open_questions", input } as any, { agent: { id: caller } } as any);

test("the coordinator lists the open questions of managed sessions, with keys to judge them", async () => {
  const prefs = store();
  const result = await run(prefs);
  expect(result.isError).toBeFalsy();
  const { questions } = JSON.parse(result.text);
  expect(questions.map((q: any) => q.questionKey)).toEqual(["k1", "k2", "k4"]);
  expect(questions[0]).toMatchObject({ sessionId: "worker", questionKey: "k1", status: "open", askedAt: at, why: "spoke-after" });
  // The session's words are cleaned of control and direction characters and kept short.
  expect(questions[0].question).toBe("Which region should I use?");
  expect(questions[1]).toMatchObject({ status: "needed", verdict: { todo: "Pick a release day", by: "coord", at } });
  expect(questions[1].question.length).toBeLessThanOrEqual(200);
  // One session.
  expect(JSON.parse((await run(prefs, { sessionId: "other" })).text).questions.map((q: any) => q.questionKey)).toEqual(["k4"]);
});

test("only the coordinator can list, and the keys it lists are the ones judge_open_question takes", async () => {
  const prefs = store();
  expect((await run(prefs, {}, "worker")).isError).toBe(true);
  const [first] = JSON.parse((await run(prefs)).text).questions;
  const judged = await boardActionTool(boardActions([judgeOpenQuestionTool(prefs, () => {})]))
    .execute({ action: "judge_open_question", input: { sessionId: first.sessionId, questionKey: first.questionKey, verdict: "needed" } } as any, { agent: { id: "coord" } } as any);
  expect(judged.isError).toBeFalsy();
  expect(JSON.parse((await run(prefs)).text).questions[0]).toMatchObject({ questionKey: "k1", status: "needed" });
});

test("the guide says to find the key with list_open_questions before judging", async () => {
  const prefs = store();
  const guide = boardGuideTool(boardActions([judgeOpenQuestionTool(prefs, () => {}), listOpenQuestionsTool(prefs)]), "rev");
  const judge = JSON.parse((await guide.execute({ topic: "judge_open_question" } as any, { agent: { id: "coord" } } as any)).text);
  expect(judge.usage).toContain("list_open_questions");
  const list = JSON.parse((await guide.execute({ topic: "list_open_questions" } as any, { agent: { id: "coord" } } as any)).text);
  expect(list.usage).toContain("questionKey");
});
