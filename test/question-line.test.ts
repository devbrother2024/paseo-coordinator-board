import { expect, test } from "bun:test";
import { classify, conversationQuestionDetails, excerpt } from "../server/conversation";
import { decorateDecision } from "../server/session-decisions";
import { questionFolds, questionParts } from "../client/decision-summary";
import { asksForDecision, unquoted } from "../shared/question-request";

const row = { id: "worker", status: "idle", projectId: "p", projectTitle: "Studio", workspaceTitle: "w", model: null, title: "Edit", lane: "idle", detail: "Waiting", activityAt: "1" } as const;
const page = (texts: string[]) => ({ epoch: "a", error: null, entries: texts.map((text, i) => ({ item: { type: "assistant_message", text }, seqEnd: i })) });
const evidence = (text: string) => excerpt(page([text]) as never);

test("a question quoted inside an explanation is not a request", () => {
  for (const quote of ["\"이대로 합쳐도 될까요?\"", "“이대로 합쳐도 될까요?”", "'이대로 합쳐도 될까요?'", "「이대로 합쳐도 될까요?」", "『이대로 합쳐도 될까요?』"]) {
    const text = ["## 기획안", "", `세 번째 장면에서 진행자가 ${quote}라고 묻습니다.`, "", "편집본을 공유 폴더에 올렸습니다."].join("\n");
    expect(asksForDecision(`진행자가 ${quote}라고 묻습니다.`)).toBe(false);
    expect(classify(evidence(text), row).lane).toBe("idle");
  }
  expect(classify(evidence("The host asks \"Shall I merge the cuts?\" in the second scene."), row).lane).toBe("idle");
});

test("a request outside the quotes is still a request, and a quote does not hide another line", () => {
  expect(asksForDecision("\"A안\"으로 할까요?")).toBe(true);
  expect(asksForDecision("진행자가 \"합칠까요?\"라고 묻는 장면을 그대로 둘지 정해 주세요.")).toBe(true);
  // Apostrophes in English words are not quotes.
  expect(asksForDecision("I've updated the cut. Shall I merge it? It's ready.")).toBe(true);
  expect(asksForDecision("Don't worry about the 'draft' label, which version would you prefer?")).toBe(true);
  const text = ["진행자가 \"이대로 합쳐도 될까요?\"라고 묻습니다.", "", "두 장면을 하나로 합쳐도 될까요?", "", "참고: 원본은 그대로 둡니다."].join("\n");
  const details = conversationQuestionDetails(evidence(text));
  expect(details?.markdown.split("\n")[0]).toBe("두 장면을 하나로 합쳐도 될까요?");
  expect(details?.context).toContain("라고 묻습니다");
});

test("an inch mark is not an opening quote", () => {
  expect(asksForDecision("24\" 모니터로 할까요? \"27\"은 비쌉니다.")).toBe(true);
  expect(unquoted("24\" 모니터로 할까요? \"27\"은 비쌉니다.")).toBe("24\" 모니터로 할까요? ____은 비쌉니다.");
  expect(asksForDecision("Shall I order the 24\" screen? The \"27\" one costs more.")).toBe(true);
});

test("quote masking keeps the length of the line", () => {
  const line = "진행자가 “합칠까요?”라고 묻고, 'yes'를 기다립니다.";
  expect(unquoted(line)).toHaveLength(line.length);
  expect(unquoted(line)).not.toContain("합칠까요");
  expect(unquoted("It's Anna's cut")).toBe("It's Anna's cut");
});

test("existing request examples keep their cards", () => {
  for (const text of [
    "확인해 주실 것\n두 번째 자막을 한 줄로 둘까요?",
    "실험용 파이썬 환경(`lab/.venv`, 1.1GB)은 지시 범위 밖이라 남겼습니다. 지울지 알려 주세요.",
    "Which version would you prefer?",
    "Please choose a project.",
    "(a)와 (b) 중 어느 쪽으로 할까요?",
  ]) expect(classify(evidence(text), row).lane).toBe("human");
});

test("the title is the request sentence; earlier sentences and the text after it are not the title", () => {
  const parts = questionParts("편집본을 올렸습니다. \"합칠까요?\"라는 대사는 그대로 둡니다. 이대로 공개해도 될까요? 공개 뒤에는 되돌리기 어렵습니다.\n\n- 원본 보관\n  - 공유 폴더");
  expect(parts).toEqual({
    lead: "편집본을 올렸습니다. \"합칠까요?\"라는 대사는 그대로 둡니다.",
    title: "이대로 공개해도 될까요?",
    body: "공개 뒤에는 되돌리기 어렵습니다.\n\n- 원본 보관\n  - 공유 폴더",
  });
  expect(questionParts("Which take should we use?")).toEqual({ lead: "", title: "Which take should we use?", body: "" });
  expect(questionParts("확인해 주실 것\n두 번째 자막을 한 줄로 둘까요?")).toEqual({ lead: "", title: "확인해 주실 것", body: "두 번째 자막을 한 줄로 둘까요?" });
  // Questions right before the request sentence ask the same thing, so they stay in the title.
  expect(questionParts("컷을 다 봤습니다. 두 번째 컷을 쓸까요, 세 번째 컷을 쓸까요? 어느 쪽으로 할까요?")).toEqual({
    lead: "컷을 다 봤습니다.", title: "두 번째 컷을 쓸까요, 세 번째 컷을 쓸까요? 어느 쪽으로 할까요?", body: "" });
  // Splitting inside bold or code would break the Markdown, so the whole line stays the title.
  expect(questionParts("**정리했습니다. 이대로 할까요?**\n- 근거")).toEqual({ lead: "", title: "**정리했습니다. 이대로 할까요?**", body: "- 근거" });
});

test("the split stays out of the decision identity", () => {
  const text = ["완료한 일입니다.", "편집본을 올렸습니다. 이대로 공개해도 될까요?", "", "- 원본 보관"].join("\n");
  const seen = evidence(text);
  const session: any = { ...row, ...classify(seen, row), evidenceId: seen.id };
  const legacy: any = { ...session };
  const scope: any = { judgments: {}, answers: {} };
  decorateDecision(legacy, undefined, scope);
  decorateDecision(session, undefined, scope, seen);
  expect(session.decision.version).toBe(legacy.decision.version);
  expect(session.decision.question).toBe("편집본을 올렸습니다. 이대로 공개해도 될까요? - 원본 보관");
  expect(session.decision.questionMarkdown).toBe("편집본을 올렸습니다. 이대로 공개해도 될까요?\n\n- 원본 보관");
});

test("More appears when the two-line title is cut off, whatever its length", () => {
  // A short title that wraps past two lines on a narrow screen or with a large font is cut off.
  expect(questionFolds({ bodyFolds: false, fullHeight: 63, shownHeight: 42 })).toBe(true);
  // A long title that fits two lines on a wide screen is not.
  expect(questionFolds({ bodyFolds: false, fullHeight: 42, shownHeight: 42 })).toBe(false);
  // Sub-pixel rounding is not a cut-off line.
  expect(questionFolds({ bodyFolds: false, fullHeight: 42.4, shownHeight: 42 })).toBe(false);
  // Before the first layout nothing is known to be cut off; a long body still folds.
  expect(questionFolds({ bodyFolds: false })).toBe(false);
  expect(questionFolds({ bodyFolds: true })).toBe(true);
});
