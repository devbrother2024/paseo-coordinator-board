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
  expect(references(pullReferenceTokens(tokens, { repository: "studio/app" }))).toEqual([
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
  expect(references(pullReferenceTokens(tokens, { repository: "studio/app" }))).toEqual([{repo:"studio/app", number:42}]);
});

const { repositoryIndex, knownPullRepositories } = await import("../client/pull-repositories");
const { tableRowClues } = await import("../client/pull-reference-markdown");
import type { Tokens } from "../client/vendor/marked/marked";

const known = repositoryIndex([
  { repo: "studio/alpha-web", names: ["Alpha"] },
  { repo: "studio/beta" },
  { repo: "labs/gamma-api", names: ["GammaApi"] },
  { repo: "studio/shared" },
  { repo: "labs/shared" },
]);

function tableReferences(markdown: string, repository?: string) {
  const table = lexBoardMarkdown(markdown).find(token => token.type === "table") as Tokens.Table;
  const clues = tableRowClues(table, known);
  return table.rows.map((row, r) => row.flatMap(cell => references(pullReferenceTokens(cell.tokens, { repository, known, row: clues[r] }))));
}

test("each table row links its PR to the repository named in that row", () => {
  expect(tableReferences([
    "| 저장소 | PR | 상태 |",
    "|---|---|---|",
    "| alpha-web | #12 | 병합됨 |",
    "| **BETA** | #3 | 병합됨 |",
    "| GammaApi | #7 | 열림 |",
    "| unknown-repo | #9 | 병합됨 |",
    "| shared | #4 | 병합됨 |",
    "| | #5 | 병합됨 |",
    "| studio/beta | #6 | 병합됨 |",
  ].join("\n"), "studio/card")).toEqual([
    [{ repo: "studio/alpha-web", number: 12 }],
    [{ repo: "studio/beta", number: 3 }],
    [{ repo: "labs/gamma-api", number: 7 }],
    [],
    [],
    [{ repo: "studio/card", number: 5 }],
    [{ repo: "studio/beta", number: 6 }],
  ]);
});

test("a table without a repository header still finds the column that names known repositories", () => {
  expect(tableReferences([
    "| 이름 | 번호 |",
    "|---|---|",
    "| alpha-web | #12 |",
    "| delta | #2 |",
  ].join("\n"), "studio/card")).toEqual([[{ repo: "studio/alpha-web", number: 12 }], []]);
  expect(tableReferences("| 메모 | 번호 |\n|---|---|\n| 고침 | #8 |", "studio/card")).toEqual([[{ repo: "studio/card", number: 8 }]]);
});

test("a sentence links each PR number to the repository written before it", () => {
  const link = (markdown: string, repository?: string) => references(pullReferenceTokens((lexBoardMarkdown(markdown)[0] as Tokens.Paragraph).tokens, { repository, known }));
  expect(link("alpha-web #12 와 beta #3")).toEqual([{ repo: "studio/alpha-web", number: 12 }, { repo: "studio/beta", number: 3 }]);
  expect(link("**Alpha** PR #12, 그리고 beta의 #3")).toEqual([{ repo: "studio/alpha-web", number: 12 }, { repo: "studio/beta", number: 3 }]);
  // 같은 줄에서만 단서를 찾는다. 다음 줄의 단서 없는 번호는 카드 저장소.
  expect(link("alpha-web #12\n그 다음 #13", "studio/card")).toEqual([{ repo: "studio/alpha-web", number: 12 }, { repo: "studio/card", number: 13 }]);
  // 번호 뒤에만 이름이 있으면 그 줄의 이름 하나를 따른다.
  expect(link("#14 (beta)", "studio/card")).toEqual([{ repo: "studio/beta", number: 14 }]);
  // 모르는 저장소 이름, 둘 이상 맞는 이름은 잇지 않는다. 틀린 링크보다 링크 없음.
  expect(link("unknown-repo #5", "studio/card")).toEqual([]);
  expect(link("shared #4", "studio/card")).toEqual([]);
  expect(link("#15 alpha-web beta", "studio/card")).toEqual([]);
  expect(link("beta #2, delta #5", "studio/card")).toEqual([{ repo: "studio/beta", number: 2 }]);
  expect(link("alpha-web fixed in PR #18", "studio/card")).toEqual([{ repo: "studio/alpha-web", number: 18 }]);
  // 단서가 없으면 지금처럼 카드 저장소, 카드 저장소도 없으면 잇지 않는다.
  expect(link("Approve #42", "studio/card")).toEqual([{ repo: "studio/card", number: 42 }]);
  expect(link("Approve #42")).toEqual([]);
  // owner/repo#N 꼴은 건드리지 않는다.
  expect(link("other/thing#16 와 alpha-web #17")).toEqual([{ repo: "studio/alpha-web", number: 17 }]);
});

test("the board knows repositories only from settings, ledger cards, PR lists and merge history", () => {
  const index = knownPullRepositories({
    projects: [{ id: "p1", title: "Alpha" }, { id: "p2", title: "Unmapped" }],
    pullRequests: {
      projects: [{ projectId: "p1", repo: "studio/alpha-web", mode: "auto" }, { projectId: "p2", repo: "studio/off", mode: "off" }],
      items: [{ repo: "labs/gamma-api" }],
    },
    trackedDecisions: { items: [{ projectId: "p3", projectTitle: "Beta", pullRepository: "studio/beta", mergeTarget: null, pullTarget: undefined, matchedPull: null }] },
    replyHistory: [{ pullMerge: { repo: "labs/delta" } }],
  });
  const link = (markdown: string) => references(pullReferenceTokens((lexBoardMarkdown(markdown)[0] as Tokens.Paragraph).tokens, { known: index }));
  expect(link("Alpha #1, alpha-web #2, gamma-api #3, Beta #4, delta #5, off #6, unmapped #7")).toEqual([
    { repo: "studio/alpha-web", number: 1 }, { repo: "studio/alpha-web", number: 2 }, { repo: "labs/gamma-api", number: 3 },
    { repo: "studio/beta", number: 4 }, { repo: "labs/delta", number: 5 },
  ]);
});
