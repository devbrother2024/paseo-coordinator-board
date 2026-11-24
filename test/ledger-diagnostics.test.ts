import { expect, test } from "bun:test";
import { ledgerHistoryUnavailableText, ledgerIssueText, ledgerMoreText } from "../client/ledger-diagnostics";
import type { LedgerIssue } from "../shared/ledger-diagnostics";

const ko = (ko: string) => ko;
const en = (_: string, en: string) => en;
const card = {
  kind: "entry", source: "releases", projectTitle: "Studio", id: "choice", title: "Choose take", row: 2,
  fields: [{path: "questions.0.options.0.text", reason: "missing"}, {path: "questions.0.options.0.label", reason: "invalid"}],
} satisfies LedgerIssue;

test("each language names the affected card, missing field, and extra issue count", () => {
  expect(ledgerIssueText(card, ko).summary).toBe("Studio 원장의 카드 choice 형식 오류: questions.0.options.0.text 없음");
  expect(ledgerIssueText(card, en).summary).toBe("Studio ledger card choice has a format error: questions.0.options.0.text is missing");
  expect(ledgerIssueText(card, ko).detail).toContain("releases");
  expect(ledgerIssueText(card, en).detail).toContain("Choose take");
  expect(ledgerIssueText(card, en).detail).toContain("questions.0.options.0.label has an invalid value");
  expect(ledgerMoreText(2, ko)).toBe("외 2건");
  expect(ledgerMoreText(1, en)).toBe("1 more issue");
});

test("a failed source keeps the generic wording and includes the project and source", () => {
  const issue = { kind: "source", source: "releases", projectTitle: "Studio" } satisfies LedgerIssue;
  expect(ledgerIssueText(issue, ko).summary).toContain("일부 결정 기록을 읽지 못했습니다.");
  expect(ledgerIssueText(issue, en).summary).toContain("Some decision records could not be loaded.");
  expect(ledgerIssueText(issue, en).summary).toContain("Studio · releases");
});

test("option text hints and read-only ledger notices are localized", () => {
  const issue = { ...card, fields: [{ ...card.fields[0], hint: "option-text" as const }] };
  expect(ledgerIssueText(issue, ko).summary).toContain("label 대신 text 사용");
  expect(ledgerIssueText(issue, en).summary).toContain("use text instead of label");
  expect(ledgerHistoryUnavailableText(ko)).toContain("지금은 답할 수 없습니다");
  expect(ledgerHistoryUnavailableText(en)).toContain("Replies are unavailable");
});
