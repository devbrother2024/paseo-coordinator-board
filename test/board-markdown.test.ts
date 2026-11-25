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

const after = ["", "**처리**", "", "- 시험을 추가했습니다", "- 문서를 고쳤습니다", "", "**PR 상태**", "", "- 초안으로 열었습니다"];
const kinds = (lines: string[]) => lexBoardMarkdown(lines.join("\n")).filter(token => token.type !== "space").map(token => token.type);

test("a triple backtick inside a sentence does not open a code block", () => {
  const tokens = lexBoardMarkdown(["- 코드 블록(```)은 무시하지만 인라인 코드(`…`)는 아닙니다.", "- 둘째 항목입니다.", ...after].join("\n"));
  expect(tokens.map(token => token.type)).not.toContain("code");
  expect(tokens[0]).toMatchObject({ type: "list", items: [{ text: expect.stringContaining("(```)") }, { text: "둘째 항목입니다." }] });
});

test("an opening fence with no closing fence stays text and does not swallow what follows", () => {
  for (const opener of ["```)은 무시하지만 인라인 코드는 아닙니다.", "~~~ 은 무시합니다.", "```"]) {
    const types = kinds(["- 가나다 코드 블록", opener, "- 둘째 항목입니다.", ...after]);
    expect(types).not.toContain("code");
    expect(types).toEqual(expect.arrayContaining(["list", "paragraph"]));
    expect(lexBoardMarkdown(["- 가나다", opener, "- 둘째", ...after].join("\n")).at(-1)).toMatchObject({ type: "list" });
  }
  // The same inside an indented list item.
  expect(kinds(["- 가나다 코드 블록", "  ```)은 무시합니다.", "  - 둘째 항목입니다.", ...after])).not.toContain("code");
});

test("a closed fence is still a code block, in a list item too", () => {
  const closed = lexBoardMarkdown(["문장입니다.", "", "```js", "const a = 1;", "```", "", "뒤 문장입니다."].join("\n"));
  expect(closed.filter(token => token.type === "code")).toMatchObject([{ text: "const a = 1;", lang: "js" }]);
  const nested = lexBoardMarkdown(["- 가나다", "", "  ```", "  const a = 1;", "  ```", "- 둘째", ...after].join("\n"));
  expect(nested[0]).toMatchObject({ type: "list", items: [{ tokens: expect.arrayContaining([expect.objectContaining({ type: "code", text: "const a = 1;" })]) }, {}] });
  expect(lexBoardMarkdown("````\n```\n안쪽\n```\n````").map(token => token.type)).toEqual(["code"]);
});
