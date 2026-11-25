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
  { repo: "studio/beta-api" },
  { repo: "studio/site", names: ["web"] },
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
  // 머리를 못 알아보는 표라도 같은 행에 모르는 저장소 이름이 있으면 카드 저장소로 가지 않는다.
  expect(tableReferences("| 메모 | 대상 | 번호 |\n|---|---|---|\n| 고침 | zeta-api | #8 |\n| 고침 | ZetaApp | #9 |\n| 고침 | checks-failed | #10 |\n| 고침 | beta-api | #11 |", "studio/card")).toEqual([
    [], [], [{ repo: "studio/card", number: 10 }], [{ repo: "studio/beta-api", number: 11 }],
  ]);
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
  // 한 줄에 저장소 단서가 여럿이면 바로 앞(또는 바로 뒤 괄호) 이름이 없는 번호는 잇지 않는다.
  expect(link("Merged #12 (alpha-web) and #13 (beta-api)", "studio/card")).toEqual([{ repo: "studio/alpha-web", number: 12 }, { repo: "studio/beta-api", number: 13 }]);
  expect(link("#12 alpha-web 수정, #13 beta-api 수정", "studio/card")).toEqual([]);
  // 줄에 모르는 저장소 이름이 있으면 카드 저장소로 가지 않는다. 바로 앞 이름은 조사를 떼고 본다.
  expect(link("zeta-api 병합 완료 #26", "studio/card")).toEqual([]);
  expect(link("#26 zeta-api 병합", "studio/card")).toEqual([]);
  expect(link("zeta-api의 #26", "studio/card")).toEqual([]);
  expect(link("GammaApi의 #166", "studio/card")).toEqual([{ repo: "labs/gamma-api", number: 166 }]);
  expect(link("beta-api에서 #20", "studio/card")).toEqual([{ repo: "studio/beta-api", number: 20 }]);
  // 프로젝트 이름은 번호 바로 앞에서만 단서다. 줄 다른 곳의 흔한 단어는 저장소로 보지 않는다.
  // 줄에 프로젝트 이름이 있으면 링크 대상으로 쓰지 않더라도 카드 저장소로 가지 않는다.
  expect(link("web 화면 고친 뒤 #30", "studio/card")).toEqual([]);
  expect(link("Alpha 프로젝트 #12", "studio/card")).toEqual([]);
  expect(link("Alpha에서는 #12", "studio/card")).toEqual([{ repo: "studio/alpha-web", number: 12 }]);
  expect(link("Alpha랑 #12", "studio/card")).toEqual([{ repo: "studio/alpha-web", number: 12 }]);
  // 모르는 CamelCase 이름, 번호 바로 앞의 모르는 한 단어도 저장소 단서다.
  for (const text of ["ZetaApp #166", "ZetaApp의 #166", "ZetaApp 수정 (#26)", "zetaapp #166"]) expect(link(text, "studio/card")).toEqual([]);
  expect(link("web #31", "studio/card")).toEqual([{ repo: "studio/site", number: 31 }]);
  // 저장소 이름처럼 보이지 않는 일반어 앞 번호는 예전처럼 카드 저장소.
  for (const text of ["GitHub PR #12", "follow-up #12", "v1.2 #12", "macOS #12", "README.md 수정 #12", "iOS #12", "JavaScript #12", "TypeScript #12",
    "PowerShell #12", "YouTube #12", "iPhone #12", "feat/x 브랜치 #12", "e.g. 예시 #12", "i.e. 같은 #12", "UTF-8 고침 #12", "GPT-5 비교 #12",
    "0.5.24-beta 배포 #12", "macos-latest 실패 #12", "Approve #12", "fixes #12", "checks-failed 상태 #12"]) {
    expect(link(text, "studio/card")).toEqual([{ repo: "studio/card", number: 12 }]);
  }
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
