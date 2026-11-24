import { expect, test } from "bun:test";
import { lexBoardMarkdown } from "../client/board-markdown";
import { pullReferenceTokens } from "../client/pull-reference-markdown";
import type { Token } from "../client/vendor/marked/marked";

function references(tokens: Token[]): {repo: string; number: number}[] {
  return tokens.flatMap(token => token.type === "pullReference" ? [{ repo: token.repo, number: token.number }]
    : "tokens" in token && Array.isArray(token.tokens) ? references(token.tokens) : []);
}

test("bare PR numbers in a heading or formatted paragraph link to the card repository", () => {
  const tokens = lexBoardMarkdown("# Approve #42\n\nSee **#43** and (#44번).");
  expect(pullReferenceTokens(tokens)).toBe(tokens);
  expect(references(pullReferenceTokens(tokens, "studio/app"))).toEqual([
    { repo: "studio/app", number: 42 },
    { repo: "studio/app", number: 43 },
    { repo: "studio/app", number: 44 },
  ]);
});

test("code, explicit links, qualified references, escapes and invalid PR numbers are left alone", () => {
  const tokens = lexBoardMarkdown([
    "See `#1`, [#2](https://example.com), other/repo#3, other/repo #4, \\#5.",
    "",
    "```text",
    "#6",
    "```",
    "",
    "#0 and #2147483648 but #42.",
  ].join("\n"));
  expect(references(pullReferenceTokens(tokens, "studio/app"))).toEqual([{repo:"studio/app", number:42}]);
});
