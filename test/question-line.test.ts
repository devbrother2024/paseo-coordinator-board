import { expect, test } from "bun:test";
import { classify, conversationQuestionDetails, excerpt } from "../server/conversation";
import { decorateDecision } from "../server/session-decisions";
import { questionFolds, questionParts } from "../client/decision-summary";
import { asksForDecision, unquoted } from "../shared/question-request";
import { lexBoardMarkdown } from "../client/board-markdown";
import type { Tokens } from "../client/vendor/marked/marked";

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

const decisionText = [
  "## 정리",
  "",
  "편집본 두 개를 비교했습니다.",
  "",
  "**결정할 것:** 세 번째 장면을 앞으로 옮길지 정해야 합니다. 답을 받고 바꾸겠습니다.",
  "- **\"옮겨\"**라고 하면 앞으로 옮깁니다.",
  "- **\"그대로\"**라고 하면 지금 순서를 둡니다.",
  "- **\"합쳐\"**라고 하면 두 장면을 하나로 합칩니다. 정해지지 않으면 **\"보류\"**라고 하면 됩니다.",
].join("\n");

test("a decision heading and a reply guide are requests", () => {
  for (const line of [
    "**결정할 것:** 세 번째 장면 위치. 답을 받고 바꾸겠습니다.",
    "결정할 것：자막 언어",
    "결정이 필요합니다. 어느 컷을 쓸지 알려 주세요.",
    "이 장면은 결정이 필요한 것입니다.",
    "답이 필요합니다.",
    "**\"옮겨\"**라고 하면, **\"그대로\"**라고 하면 됩니다.",
    "'합쳐'라고 말씀하시면 됩니다.",
    "“보류”라고 해 주시면 됩니다.",
    "답을 받고 바꾸겠습니다.",
    "답을 받고 진행하겠습니다.",
    "Decision needed: which cut to use.",
    "This now needs your decision. Please choose a cut.",
    "Note that this needs your decision.",
    "Notice: this needs your decision.",
    "Nobody else is blocked, but this needs your decision.",
    "This one needs your decision.",
    "Reply \"merge\" or \"keep\".",
    "Just reply with \"ship\" to go ahead.",
    "Reply **\"merge\"** or **\"keep\"**.",
    "Reply *\"merge\"* or _\"keep\"_.",
    "You can reply \"merge\" to go ahead.",
    "Simply reply **\"keep\"** to leave it.",
    "- Reply \"merge\" or \"keep\"",
    "Done. Please reply with \"ship\".",
    "Please reply with __\"merge\"__ to go ahead.",
    "Reply with ***\"merge\"*** or `keep`.",
  ]) expect([line, asksForDecision(line)]).toEqual([line, true]);
});

test("reports, offers, quotes and empty decisions are not requests", () => {
  for (const line of [
    "결정할 것은 없습니다.",
    "**결정할 것:** 없음",
    "결정할 것: 없습니다.",
    "결정이 필요한 것은 없습니다.",
    "답이 필요하면 알려 주세요.",
    "결정이 필요하시면 말씀해 주세요.",
    "답을 받고 반영했습니다.",
    "답을 받고 바꿨습니다.",
    "진행자가 \"결정할 것:\"이라고 적어 둔 메모는 지웠습니다.",
    "메모에 \"결정이 필요합니다\"라고 적혀 있었습니다.",
    "그렇게 하라고 하면 됩니다.",
    "No decision needed: everything merged.",
    "Nothing needs your decision right now.",
    "Nobody needs your decision today.",
    "No one needs your decision on this.",
    "No item needs your decision.",
    "None of these needs your decision.",
    "Not everything needs your decision.",
    "If anything needs your decision, I will say so.",
    "I'll reply \"done\" when the upload ends.",
    "I'll reply **\"done\"** when the upload ends.",
    "We will reply *\"done\"* once it ships.",
    "The server will reply \"OK\" when the job ends.",
    "It replies **\"OK\"** to every ping.",
    "The bot should reply with \"pong\" to a ping.",
    "Clients that reply \"no\" are skipped.",
    "The log says \"Decision needed: none\" in the header.",
  ]) expect([line, asksForDecision(line)]).toEqual([line, false]);
  expect(classify(evidence("편집본을 정리했습니다.\n\n결정할 것은 없습니다. 답을 받고 반영했습니다."), row).lane).toBe("idle");
  expect(classify(evidence(["```", "결정할 것: 예시", "Reply \"yes\"", "```", "코드 예시만 있습니다."].join("\n")), row).lane).toBe("idle");
});

test("the card shows the decision heading to the end of the message", () => {
  expect(classify(evidence(decisionText), row).lane).toBe("human");
  const details = conversationQuestionDetails(evidence(decisionText));
  expect(details?.markdown.split("\n")[0]).toStartWith("**결정할 것:**");
  expect(details?.markdown).toContain("**\"합쳐\"**라고 하면");
  expect(details?.context).toContain("편집본 두 개를 비교했습니다.");
  // The same shape on one line starts at that line too.
  const oneLine = "편집본을 올렸습니다.\n\n**결정할 것:** 장면 위치. 답을 받고 바꾸겠습니다. **\"옮겨\"**라고 하면 옮기고 **\"그대로\"**라고 하면 됩니다.";
  expect(conversationQuestionDetails(evidence(oneLine))?.markdown.startsWith("**결정할 것:**")).toBe(true);
});

test("a list with no request line above it keeps its own start", () => {
  const details = conversationQuestionDetails(evidence(["정리했습니다.", "- 원본 보관", "- **\"옮겨\"**라고 하면 됩니다."].join("\n")));
  expect(details?.markdown.split("\n")[0]).toBe("- **\"옮겨\"**라고 하면 됩니다.");
});

test("a negation or an offer only cancels the sentence it is in", () => {
  for (const line of [
    "No decision needed for the tests. Please choose a deployment region.",
    "결정할 것은 없습니다. 배포 지역을 골라 주세요.",
    "**결정할 것:** 없음. 다음 줄은 별개입니다. 배포 지역을 골라 주세요.",
    "If you like, I can add tests. Shall I merge it?",
    "A안으로 할까요? 궁금하시면 알려 주세요. 결정이 필요합니다.",
    "Nothing needs your decision. **Decision needed:** which cut to use.",
    "Which of e.g. A or B would you prefer?",
  ]) expect([line, asksForDecision(line)]).toEqual([line, true]);
  for (const line of [
    "배포 지역은 정해 두었습니다. 결정할 것은 없습니다.",
    "Please choose a region if you like. No decision needed.",
    "결정이 필요하시면 말씀해 주세요. 답을 받고 반영했습니다.",
    "All done. Nothing needs your decision. Let me know if you want more.",
  ]) expect([line, asksForDecision(line)]).toEqual([line, false]);
  // A version number or size is not a sentence end.
  expect(asksForDecision("v1.2 용량은 3.5GB입니다. 결정할 것은 없습니다.")).toBe(false);
  expect(asksForDecision("용량은 3.5GB입니다. 이대로 확인해 주세요.")).toBe(true);
});

test("a request phrase inside inline code is not a request", () => {
  for (const line of [
    "예시 입력 `... please choose a region ...`은 잘립니다.",
    "한계 예시: ``골라 주세요`` 같은 문구는 요청이 아닙니다.",
    "문구 `이대로 할까요?`는 그대로 둡니다.",
    "The sample `Shall I merge it?` is only an example.",
  ]) expect([line, asksForDecision(line)]).toEqual([line, false]);
  expect(classify(evidence(["- 남은 한계", "  1. 긴 입력은 잘립니다 (예: `foo ... please choose bar`, 상한 10개)", "  2. 빈 목록은 `none` 으로 표시됩니다"].join("\n")), row).lane).toBe("idle");
});

test("a request outside the inline code still counts, and an unpaired backtick masks nothing", () => {
  expect(asksForDecision("예시 `please choose`는 잘립니다. 지울지 알려 주세요.")).toBe(true);
  expect(asksForDecision("`A안`으로 할까요?")).toBe(true);
  expect(asksForDecision("한 줄에 ` 하나만 있고 이대로 할까요?")).toBe(true);
  expect(asksForDecision("`a` 와 ` 이대로 확인해 주세요.")).toBe(true);
  expect(asksForDecision("``a`b`` 다음 이대로 확인해 주세요.")).toBe(true);
});

test("inline code masking keeps the length of the line", () => {
  const line = "예시 `please choose` 와 ``a`b`` 는 코드, `짝 없음";
  expect(unquoted(line)).toHaveLength(line.length);
  expect(unquoted(line)).toBe("예시 " + "_".repeat(15) + " 와 _______ 는 코드, `짝 없음");
});

test("a numbered list item keeps its number and the list stays whole in the card", () => {
  const markdown = ["  1. 긴 입력은 잘립니다 (예: `foo bar`, 상한 10개) 이대로 둘지 알려 주세요.", "  2. 빈 목록은 `none` 으로 표시됩니다", "  3. 나머지는 평문입니다"].join("\n");
  const parts = questionParts(markdown);
  expect(parts.lead).toBe("");
  expect(parts.title).toBe("1. 긴 입력은 잘립니다 (예: `foo bar`, 상한 10개) 이대로 둘지 알려 주세요.");
  expect(parts.body).toBe("  2. 빈 목록은 `none` 으로 표시됩니다\n  3. 나머지는 평문입니다");
  // No part is an empty list item.
  for (const part of [parts.lead, parts.title, parts.body].filter(Boolean)) {
    for (const token of lexBoardMarkdown(part)) if (token.type === "list") for (const item of (token as Tokens.List).items) expect(item.text.trim()).not.toBe("");
  }
  expect(questionParts("- 입력이 길면 잘립니다. 어떻게 할지 알려 주세요.\n- 둘째").lead).toBe("");
  // A sentence split still applies to a line that is not a list item.
  expect(questionParts("편집본을 올렸습니다. 이대로 공개해도 될까요?").title).toBe("이대로 공개해도 될까요?");
});
