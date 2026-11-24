import { expect, test } from "bun:test";
import { lexBoardMarkdown } from "../client/board-markdown";
import { plainDecisionTitle } from "../client/decision-summary";

const dates = "04-08~04-14 집계에서 04-08~04-10에 변동이 있었습니다.";

test("date ranges, estimates, and single-tilde text keep their original characters", () => {
  const body = dates + " ~3분 뒤 ~보류~를 다시 확인합니다.";
  expect(lexBoardMarkdown(body)[0]).toMatchObject({ tokens: [{ type: "text", text: body }] });
  expect(plainDecisionTitle(dates)).toBe(dates);
});

test("double tildes strike text while literal tildes leave nested Markdown available", () => {
  expect(lexBoardMarkdown("~**보류**~ ~검토~ ~~삭제~~")[0]).toMatchObject({ tokens: [
    { type: "text", text: "~" },
    { type: "strong", text: "보류" },
    { type: "text", text: "~ ~검토~ " },
    { type: "del", text: "삭제" },
  ] });
});

test("inline and fenced code and links preserve tildes", () => {
  const tokens = lexBoardMarkdown([
    'Inline: `~sample~ ~~value~~` [~Guide~](https://example.com/~guide~)',
    "",
    '~~~text',
    '~sample~ ~~value~~',
    '~~~',
  ].join("\n"));
  expect(tokens[0]).toMatchObject({ tokens: [
    { type: "text" },
    { type: "codespan", text: "~sample~ ~~value~~" },
    { type: "text" },
    { type: "link", href: "https://example.com/~guide~", tokens: [{ type: "text", text: "~Guide~" }] },
  ] });
  expect(tokens.find(token => token.type === "code")).toMatchObject({ text: "~sample~ ~~value~~" });
});
