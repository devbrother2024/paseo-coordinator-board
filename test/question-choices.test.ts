import { expect, test } from "bun:test";
import { classify, excerpt } from "../server/conversation";
import { decorateDecision } from "../server/decisions";
import {
  cardChoiceGaps, choiceExplanationRequest, contextBefore, definedLabel, missingChoicesNotice, OTHER_CHOICES, referencedLabels,
} from "../shared/question-choices";
import { coordinatorChoiceGaps, ledgerChoiceGaps } from "../shared/choice-gaps";

const row = { id: "worker", status: "idle", projectId: "p", projectTitle: "프로젝트", workspaceTitle: "w", model: null, title: "정리", lane: "idle", detail: "대기", activityAt: "1" } as const;
const page = (items: [string, string][]) => ({ epoch: "e", error: null, entries: items.map(([type, text], seqEnd) => ({ item: { type, text }, seqEnd })) });
function card(...items: [string, string][]) {
  const evidence = excerpt(page(items) as never);
  const session = { ...row, ...classify(evidence, row as never), evidenceId: evidence.id } as never as Record<string, any>;
  decorateDecision(session as never, undefined, { judgments: {}, answers: {} } as never, evidence);
  return session.decision;
}

test("질문 줄 앞 설명이 contextMarkdown 으로 실리고 version 은 그대로다", () => {
  const lead = "캐시 폴더를 비우면 첫 실행이 1분쯤 느려집니다.\n대신 오래된 미리보기가 사라집니다.";
  const decision = card(["assistant_message", `${lead}\n\n캐시를 비우도록 할까요?`]);
  expect(decision.question).toBe("캐시를 비우도록 할까요?");
  expect(decision.contextMarkdown).toBe(lead);
  const plain = card(["assistant_message", "캐시를 비우도록 할까요?"]);
  expect(plain.contextMarkdown).toBeUndefined();
});

test("맥락은 1500자 안팎에서 문단 단위로 자르고 코드 블록은 통째로 넣거나 뺀다", () => {
  const paragraph = (n: number) => `문단 ${n} ` + "가".repeat(390);
  const lines = [1, 2, 3, 4, 5].flatMap(n => [paragraph(n), ""]);
  const context = contextBefore(lines);
  expect(context.length).toBeLessThanOrEqual(1500);
  expect(context.startsWith("문단 3")).toBe(true);
  expect(context.endsWith(paragraph(5))).toBe(true);
  const code = ["```sh", ...Array.from({ length: 80 }, (_, i) => `echo line-${i} and more text`), "```"];
  const withBigCode = contextBefore(["앞 문단", "", ...code, "", "바로 앞 문단"]);
  expect(withBigCode).toBe("바로 앞 문단");
  const small = contextBefore(["앞 문단", "", "```sh", "npm test", "```", "", "바로 앞 문단"]);
  expect(small).toBe("앞 문단\n\n```sh\nnpm test\n```\n\n바로 앞 문단");
  // A single paragraph longer than the limit keeps its end.
  const long = contextBefore(["처음 문장입니다. " + "나".repeat(2000) + ". 끝 문장입니다."]);
  expect(long.startsWith("…")).toBe(true);
  expect(long.endsWith("끝 문장입니다.")).toBe(true);
  expect(long.length).toBeLessThanOrEqual(1501);
});

test("(b)로 진행할까요? 와 같은 글의 (a)·(b) 정의는 선택지 둘로 실린다", () => {
  const text = [
    "두 가지 방법이 있습니다.",
    "",
    "(a) 지금 설정 파일을 직접 고칩니다. 바로 되지만 다음 업데이트 때 덮어씁니다.",
    "(b) 설정 화면에 항목을 추가합니다. 하루 더 걸리지만 업데이트 뒤에도 남습니다.",
    "",
    "**(b)로 진행할까요?**",
  ].join("\n");
  const decision = card(["assistant_message", text]);
  expect(decision.choices.map((choice: { label: string }) => choice.label)).toEqual(["(a)", "(b)"]);
  expect(decision.choices[1].markdown).toContain("설정 화면에 항목을 추가");
  expect(decision.missingLabels).toBeUndefined();
});

test("마지막 글에 (b) 정의만 있으면 앞 턴의 (a) 정의를 찾는다", () => {
  const earlier = "방법은 둘입니다.\n\n(a) 원격 호스트를 매번 직접 고릅니다.\n\n(b) 호스트를 한 번 등록합니다.";
  const last = [
    "**(b) 보드에 호스트를 한 번 등록**",
    "",
    "등록하면 다음부터 목록에 바로 나옵니다. 등록 정보는 이 기기에만 남습니다.",
    "",
    "**(b)로 진행할까요?**",
  ].join("\n");
  const decision = card(["assistant_message", earlier], ["user_message", "장단점은?"], ["assistant_message", last]);
  expect(decision.choices.map((choice: { label: string }) => choice.label)).toEqual(["(a)", "(b)"]);
  expect(decision.choices[0].markdown).toBe("(a) 원격 호스트를 매번 직접 고릅니다.");
  expect(decision.choices[1].markdown).toContain("목록에 바로 나옵니다");
  expect(decision.missingLabels).toBeUndefined();
});

test("앞 턴이 (a)를 언급만 하고 정의하지 않으면 missingLabels 에 (a)", () => {
  const decision = card(["assistant_message", "(a)는 위험하다고 봅니다."], ["user_message", "그럼?"],
    ["assistant_message", "(b) 호스트를 한 번 등록합니다.\n\n(b)로 진행할까요?"]);
  expect(decision.choices.map((choice: { label: string }) => choice.label)).toEqual(["(b)"]);
  expect(decision.missingLabels).toEqual(["(a)"]);
});

test("다른 이름표가 어디에도 없으면 다른 선택지 없음으로 본다", () => {
  const decision = card(["assistant_message", "(b) 호스트를 한 번 등록합니다.\n\n(b)로 진행할까요?"]);
  expect(decision.missingLabels).toEqual([OTHER_CHOICES]);
  const nothing = card(["assistant_message", "B로 진행할까요?"]);
  expect(nothing.choices).toBeUndefined();
  expect(nothing.missingLabels).toEqual(["B", OTHER_CHOICES]);
});

test("앞 턴 2000자 밖의 정의도 찾는다", () => {
  const long = ["(a) 오늘 배포합니다.", "(b) 내일 배포합니다.", "", "x".repeat(3000)].join("\n");
  const decision = card(["assistant_message", long], ["user_message", "음"], ["assistant_message", "(b)로 진행할까요?"]);
  expect(decision.choices.map((choice: { markdown: string }) => choice.markdown)).toEqual(["(a) 오늘 배포합니다.", "(b) 내일 배포합니다."]);
  // The last message itself can be cut too.
  const self = card(["assistant_message", long + "\n\n(b)로 진행할까요?"]);
  expect(self.choices).toHaveLength(2);
});

test("한국어·영어 이름표를 모두 알아본다", () => {
  expect(referencedLabels("A안으로 갈까요?").map(item => item.key)).toEqual(["a"]);
  expect(referencedLabels("옵션 B로 할까요?").map(item => item.key)).toEqual(["b"]);
  expect(referencedLabels("(나)로 진행할까요?").map(item => item.key)).toEqual(["나"]);
  expect(referencedLabels("2번으로 진행할까요?").map(item => item.key)).toEqual(["2"]);
  expect(referencedLabels("1안과 2안 중 어느 쪽이 좋을까요?").map(item => item.key)).toEqual(["1", "2"]);
  expect(referencedLabels("Shall I go with Option C?").map(item => item.key)).toEqual(["c"]);
  expect(referencedLabels("Would you like me to pick B?").map(item => item.key)).toEqual(["b"]);
  // Ordinary words, code and numbering are not labels.
  expect(referencedLabels("Should I plan a release? API로 보낼까요? `(a)` 1번 이상 (1) 단계")).toEqual([]);
  expect(definedLabel("- **Option A**: keep it")).toBe("a");
  expect(definedLabel("B안: 새로 만든다")).toBe("b");
  expect(definedLabel("(가) 지금 고친다")).toBe("가");
  expect(definedLabel("(b)로 진행할까요?")).toBeNull();
  expect(definedLabel("A안으로 갈까요?")).toBeNull();
  const english = card(["assistant_message", "Option A: ship today.\nOption B: wait for the review.\n\nShall I go with Option B?"]);
  expect(english.choices.map((choice: { label: string }) => choice.label)).toEqual(["A", "B"]);
});

test("화면용 필드가 바뀌어도 version 은 같다", () => {
  const a = card(["assistant_message", "(a) 빠르게.\n(b) 안전하게.\n\n(b)로 진행할까요?"]);
  const b = card(["assistant_message", "(b) 안전하게.\n\n(b)로 진행할까요?"]);
  const c = card(["assistant_message", "(b)로 진행할까요?"]);
  expect(a.question).toBe(b.question);
  expect(new Set([a.version, b.version, c.version]).size).toBe(3);
  // The same evidence id and question give one version whatever the display fields carry.
  const evidence = excerpt(page([["assistant_message", "(a) 빠르게.\n(b) 안전하게.\n\n(b)로 진행할까요?"]]) as never);
  const session = { ...row, ...classify(evidence, row as never), evidenceId: evidence.id } as Record<string, any>;
  const legacy = { ...session };
  decorateDecision(legacy as never, undefined, { judgments: {}, answers: {} } as never);
  decorateDecision(session as never, undefined, { judgments: {}, answers: {} } as never, evidence);
  expect(legacy.decision.choices).toBeUndefined();
  expect(session.decision.choices).toHaveLength(2);
  expect(session.decision.version).toBe(legacy.decision.version);
});

test("원장 카드: 이름표만 가리키고 questions 가 없으면 안내, key 가 있으면 안내 없음, 세션 화면 문구도 안내", () => {
  const base = { title: "원격 호스트 연결 방식", ask: [], recommend: ["(b)로 진행"], howToAnswer: undefined, why: [], steps: [], questions: [] };
  expect(ledgerChoiceGaps(base as never)).toEqual({ missingLabels: ["(b)"], deferred: false });
  const withKeys = { ...base, questions: [{ text: "방식", options: [{ key: "a", text: "직접 고름" }, { key: "B", text: "한 번 등록" }] }] };
  expect(ledgerChoiceGaps(withKeys as never)).toEqual({ missingLabels: [], deferred: false });
  const deferred = { ...base, recommend: ["자세한 건 세션 화면 참고"] };
  expect(ledgerChoiceGaps(deferred as never)).toEqual({ missingLabels: [], deferred: true });
  const defined = { ...base, why: ["(a) 직접 고름", "(b) 한 번 등록"] };
  expect(ledgerChoiceGaps(defined as never).missingLabels).toEqual([]);
});

test("코디네이터 판단도 같은 검사를 한다", () => {
  expect(coordinatorChoiceGaps({ question: "B안으로 진행할까요?", recommendation: "B안으로 진행해 주세요." })).toEqual({ missingLabels: ["B"], deferred: false });
  expect(coordinatorChoiceGaps({ question: "B안으로 진행할까요?", options: [{ label: "A안 · 직접 고름", reply: "A" }, { label: "B안 · 등록", reply: "B" }] }).missingLabels).toEqual([]);
  expect(coordinatorChoiceGaps({ question: "배포할까요?", needsInput: "직전 글에 있음" }).deferred).toBe(true);
  expect(coordinatorChoiceGaps({ question: "배포할까요?", recommendation: "배포해 주세요.", recommendationReason: "자세한 건 세션 화면 참고" }).deferred).toBe(true);
  expect(cardChoiceGaps(["Proceed with B?"], [])).toEqual({ missingLabels: ["B"], deferred: false });
});

test("안내와 요청 문장은 실제 이름표로 두 언어를 만든다", () => {
  expect(missingChoicesNotice(["(a)"], "session")).toEqual([
    "이 질문의 (a)가 무엇인지 세션 기록에서 찾지 못했습니다.", "Could not find what (a) is in the session history.",
  ]);
  expect(missingChoicesNotice([OTHER_CHOICES], "session")[0]).toBe("이 질문에서 고를 수 있는 다른 선택지를 세션 기록에서 찾지 못했습니다.");
  expect(choiceExplanationRequest(["(a)", "(b)"])[0]).toBe("선택지 (a), (b)가 각각 무엇이고, 고르면 무엇이 달라지는지, 장단점과 추천 이유를 한 메시지로 정리해 주세요.");
  expect(choiceExplanationRequest(["1", "3"])[0]).toContain("선택지 1, 3이 각각");
  expect(choiceExplanationRequest(["B", OTHER_CHOICES])[1]).toContain("options B, the other options each");
});

test("앞 내용은 처음 4줄만 보이고 열린 코드 블록은 닫는다", async () => {
  const { previewMarkdown } = await import("../client/choice-display");
  expect(previewMarkdown("한 줄")).toEqual({ preview: "한 줄", more: false });
  expect(previewMarkdown("1\n2\n\n3\n4\n5")).toEqual({ preview: "1\n2\n\n3\n4", more: true });
  expect(previewMarkdown("앞\n```sh\nnpm ci\nnpm test\nnpm run typecheck\n```")).toEqual({ preview: "앞\n```sh\nnpm ci\nnpm test\n```", more: true });
});

test("버튼은 받는 곳에 맞는 문장을 채운다", async () => {
  const { choiceRequest, decisionChoiceNotice } = await import("../client/choice-display");
  const conversation = { source: "conversation", question: "(b)로 진행할까요?", version: "v", choices: [{ label: "(b)", markdown: "(b) 등록" }], missingLabels: ["(a)"] } as const;
  const notice = decisionChoiceNotice(conversation);
  expect(notice?.notice[0]).toBe("이 질문의 (a)가 무엇인지 세션 기록에서 찾지 못했습니다.");
  const toSession = choiceRequest(notice, false);
  expect(toSession?.label[0]).toBe("작업 세션에 선택지 설명 요청");
  expect(toSession?.text[0]).toBe("선택지 (a), (b)가 각각 무엇이고, 고르면 무엇이 달라지는지, 장단점과 추천 이유를 한 메시지로 정리해 주세요.");
  expect(choiceRequest(notice, true)?.label[0]).toBe("코디네이터에 카드 보완 요청");
  expect(decisionChoiceNotice({ ...conversation, missingLabels: undefined })).toBeNull();
  const coordinator = decisionChoiceNotice({ source: "coordinator", question: "B안으로 갈까요?", version: "v" });
  expect(coordinator?.where).toBe("card");
  expect(choiceRequest(coordinator, true)?.text[0]).toContain("questions[].options");
  expect(decisionChoiceNotice({ source: "permission", question: "Bash", version: "v" })).toBeNull();
});
