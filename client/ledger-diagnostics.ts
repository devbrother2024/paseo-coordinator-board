import type { LedgerField, LedgerIssue } from "../shared/ledger-diagnostics";

type Translate = (korean: string, english: string) => string;

export function ledgerFallbackText(t: Translate) {
  return t("일부 결정 기록을 읽지 못했습니다. 현재 건수에는 확인한 항목만 포함됩니다.", "Some decision records could not be loaded. The count includes the available items.");
}

function fieldText(field: LedgerField, t: Translate) {
  const name = field.path || t("카드", "record");
  if (field.hint === "option-text") {
    return t(`${name} 없음 (label 대신 text 사용)`, `${name} is missing (use text instead of label)`);
  }
  if (field.reason === "missing") return t(`${name} 없음`, `${name} is missing`);
  if (field.reason === "duplicate") return t(`${name} 중복`, `${name} is duplicated`);
  return t(`${name} 값이 올바르지 않음`, `${name} has an invalid value`);
}

export function ledgerHistoryUnavailableText(t: Translate) {
  return t("이 원장의 답 기록을 읽지 못해 지금은 답할 수 없습니다.",
    "Replies are unavailable while this ledger’s reply history cannot be read.");
}

export function ledgerIssueText(issue: LedgerIssue, t: Translate) {
  const location = `${issue.projectTitle} · ${issue.source}`;
  if (issue.kind === "source") {
    return {
      summary: `${ledgerFallbackText(t)} ${location}`,
      detail: t("원장의 decisions.json 파일을 열 수 없거나, JSON 또는 items 배열 형식이 올바르지 않습니다.",
        "The ledger’s decisions.json file could not be opened, or its JSON or items array is invalid."),
    };
  }
  if (issue.kind === "history") {
    const filename = `board-${issue.part}.tsv`;
    return {
      summary: t(`${location} 원장의 이력을 읽지 못했습니다.`, `History from the ${location} ledger could not be loaded.`),
      detail: t(`${filename} 파일을 확인해 주세요.`, `Check the ${filename} file.`),
    };
  }
  const card = issue.id || t(`#${issue.row}`, `#${issue.row}`);
  const first = fieldText(issue.fields[0], t);
  const fields = issue.fields.map(field => fieldText(field, t));
  return {
    summary: t(`${issue.projectTitle} 원장의 카드 ${card} 형식 오류: ${first}`, `${issue.projectTitle} ledger card ${card} has a format error: ${first}`),
    detail: [[location, issue.title, t(`items의 ${issue.row}번째 카드`, `Item ${issue.row} in the items array`)].filter(Boolean).join(" · "), ...fields].join("\n"),
  };
}

export function ledgerMoreText(count: number, t: Translate) {
  return t(`외 ${count}건`, `${count} more ${count === 1 ? "issue" : "issues"}`);
}
