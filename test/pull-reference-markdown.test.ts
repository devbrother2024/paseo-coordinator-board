import { expect, test } from "bun:test";
import { lexBoardMarkdown } from "../client/board-markdown";
import { fallbackRepository, pullLinksIn, pullReferenceTokens } from "../client/pull-reference-markdown";
import { knownPullRepositories, repositoryIndex } from "../client/pull-repositories";

const card = "studio/card";
const known = repositoryIndex([
  { repo: "studio/alpha-web", names: ["Alpha"] },
  { repo: "studio/beta" },
  { repo: "labs/gamma-api", names: ["GammaApi"] },
  { repo: "studio/shared" },
  { repo: "labs/shared" },
  { repo: "studio/beta-api" },
  { repo: "studio/site", names: ["web"] },
  { repo: "studio/_alpha-web" },
]);
const links = (markdown: string, repository?: string, index = known) => pullLinksIn(markdown, { repository, known: index });
const one = (repo: string, number: number) => [{ repo, number }];

test("without a card repository or known repositories nothing is rewritten", () => {
  const tokens = lexBoardMarkdown("승인 #42");
  expect(pullReferenceTokens(tokens)).toBe(tokens);
});

test("a number with no name beside it uses the card repository when the text names no other", () => {
  expect(links("# 승인 #42\n\n**#43** 과 (#44번).", card)).toEqual([...one(card, 42), ...one(card, 43), ...one(card, 44)]);
  expect(links("승인 #42")).toEqual([]);
  // 코드, 링크 글자, 이스케이프, 잘못된 번호는 건드리지 않는다.
  expect(links("`#1`, [#2](https://example.com), \\#5.\n\n```text\n#6\n```\n\n#0 그리고 #2147483648, #42.", card)).toEqual(one(card, 42));
});

test("owner/repository#N links only to a repository the board knows", () => {
  expect(links("studio/beta#3 와 studio/beta #4 그리고 other/repo#5", card)).toEqual([...one("studio/beta", 3), ...one("studio/beta", 4)]);
  // owner/repository 가 하나라도 있으면 이름 없는 번호는 카드 저장소로 가지 않는다.
  expect(links("other/repo#5 정리 뒤 #6", card)).toEqual([]);
  expect(links("alpha-web #1, other/repo #2 and #3", card)).toEqual(one("studio/alpha-web", 1));
});

test("the name right beside a number picks its repository; an unknown name leaves it unlinked", () => {
  expect(links("alpha-web #12 와 beta #3")).toEqual([...one("studio/alpha-web", 12), ...one("studio/beta", 3)]);
  expect(links("**Alpha** PR #12, 그리고 beta의 #3")).toEqual([...one("studio/alpha-web", 12), ...one("studio/beta", 3)]);
  expect(links("[alpha-web](https://example.com/a) #12", card)).toEqual(one("studio/alpha-web", 12));
  expect(links("#14 (beta)", card)).toEqual(one("studio/beta", 14));
  expect(links("Merged #12 (alpha-web) and #13 (beta-api)", card)).toEqual([...one("studio/alpha-web", 12), ...one("studio/beta-api", 13)]);
  expect(links("#18 ([beta](https://example.com/b))", card)).toEqual(one("studio/beta", 18));
  // 링크로 쓴 저장소 이름도 이름이다(Codex 리뷰 재현 문장, 카드 저장소 alpha-web).
  expect(links("[beta](https://github.com/studio/beta) #12", "studio/alpha-web")).toEqual(one("studio/beta", 12));
  expect(links("alpha-web #1, [beta](https://github.com/studio/beta) #2 and #3", "studio/alpha-web")).toEqual([...one("studio/alpha-web", 1), ...one("studio/beta", 2)]);
  // 조사를 떼고, 띄어 쓴 조사도 본다.
  expect(links("GammaApi의 #166", card)).toEqual(one("labs/gamma-api", 166));
  expect(links("beta-api에서 #20", card)).toEqual(one("studio/beta-api", 20));
  expect(links("beta-api 에서 #21", card)).toEqual(one("studio/beta-api", 21));
  expect(links("Alpha에서는 #12", card)).toEqual(one("studio/alpha-web", 12));
  expect(links("Alpha랑 #12", card)).toEqual(one("studio/alpha-web", 12));
  expect(links("web #31", card)).toEqual(one("studio/site", 31));
  // 이름은 통째로 맞춘다.
  expect(links("_alpha-web #12", card)).toEqual(one("studio/_alpha-web", 12));
  for (const text of ["x_alpha-web #13", ".alpha-web #14", "x".repeat(200) + "_alpha-web #16"]) expect({ text, found: links(text, card) }).toEqual({ text, found: [] });
  // 모르는 이름, 여럿 맞는 이름, 서로 다른 두 이름은 링크 없음.
  for (const text of ["unknown-repo #5", "shared #4", "zeta-api의 #26", "zetaapp 의 #12", "ZetaApp #166", "ZetaApp의 #166", "zetaapp #166",
    "#12 (zeta-api)", "alpha-web #12 (beta)"]) {
    expect({ text, found: links(text, card) }).toEqual({ text, found: [] });
  }
  expect(links("beta #2, delta #5", card)).toEqual(one("studio/beta", 2));
});

test("project titles with spaces or Korean are matched whole beside a number", () => {
  const titled = repositoryIndex([
    { repo: "studio/alpha", names: ["Alpha Web"] },
    { repo: "studio/alpha-tools", names: ["Alpha Web Tools"] },
    { repo: "studio/web" },
    { repo: "studio/kr", names: ["알파 웹"] },
    { repo: "studio/one", names: ["알파"] },
  ]);
  const link = (text: string, repository?: string) => links(text, repository, titled);
  expect(link("Alpha Web #12")).toEqual(one("studio/alpha", 12));
  expect(link("alpha web의 #13")).toEqual(one("studio/alpha", 13));
  expect(link("alpha web 에서 #13")).toEqual(one("studio/alpha", 13));
  // 겹치는 이름은 가장 긴 것 먼저.
  expect(link("Alpha Web Tools #14")).toEqual(one("studio/alpha-tools", 14));
  expect(link("알파 웹 #15")).toEqual(one("studio/kr", 15));
  expect(link("알파 웹에서 #16")).toEqual(one("studio/kr", 16));
  expect(link("알파 #17", card)).toEqual(one("studio/one", 17));
  expect(link("#18 (Alpha Web)")).toEqual(one("studio/alpha", 18));
  expect(link("Web #19")).toEqual(one("studio/web", 19));
  // 이름이 번호 옆에 없으면 링크 대상이 아니고, 카드 저장소도 막는다.
  expect(link("Alpha Web 정리 후 #20", card)).toEqual([]);
  expect(link("알파 웹 정리 후 #21", card)).toEqual([]);
  expect(link("Alpha Webby #22", card)).toEqual([]);
});

test("a table's repository column, found by its header, links each row", () => {
  expect(links([
    "| 저장소 | PR | 상태 |",
    "|---|---|---|",
    "| alpha-web | #12 | 병합됨 |",
    "| **BETA** | #3 | 병합됨 |",
    "| GammaApi | #7 | 열림 |",
    "| unknown-repo | #9 | 병합됨 |",
    "| shared | #4 | 병합됨 |",
    "| | #5 | 병합됨 |",
    "| studio/beta | #6 | 병합됨 |",
  ].join("\n"), card)).toEqual([...one("studio/alpha-web", 12), ...one("studio/beta", 3), ...one("labs/gamma-api", 7), ...one("studio/beta", 6)]);
  expect(links("| Repository | PR |\n|---|---|\n| beta | #3 |", card)).toEqual(one("studio/beta", 3));
  // 머리가 없는 표는 칸을 추측하지 않는다. 다른 저장소 이름이 보이면 카드 저장소도 쓰지 않는다.
  expect(links("| 이름 | 번호 |\n|---|---|\n| alpha-web | #12 |\n| delta | #2 |", card)).toEqual([]);
  expect(links("| 메모 | 번호 |\n|---|---|\n| 고침 | #8 |", card)).toEqual(one(card, 8));
  // 저장소 칸이 카드 저장소만 가리키면 빈 칸도 카드 저장소.
  // (원장 카드의 저장소는 보드 색인에 들어 있다.)
  const withCard = repositoryIndex([{ repo: card }, { repo: "studio/beta" }]);
  expect(links("| 저장소 | PR |\n|---|---|\n| card | #1 |\n| | #2 |", card, withCard)).toEqual([...one(card, 1), ...one(card, 2)]);
});

test("every kind of other-repository clue in the text keeps the card repository away", () => {
  const ambiguous = repositoryIndex([{ repo: "studio/shared-name" }, { repo: "labs/shared-name" }, { repo: "studio/alpha-web", names: ["Alpha Studio"] }]);
  const kinds: [string, string][] = [
    ["아는 다른 저장소", "alpha-web"],
    ["프로젝트 이름 전체", "Alpha Studio"],
    ["owner/repo 꼴", "other/tool"],
    ["owner/repo#N 꼴", "other/tool#3"],
    ["GitHub 주소", "https://github.com/other/tool/pull/3"],
    ["여럿 맞는 이름", "shared-name"],
  ];
  for (const [kind, clue] of kinds) {
    for (const form of [`${clue} 정리 후 #12`, `#12 ${clue} 정리`, `${clue}\n\n다음 문단 #12`, `- ${clue}\n- 목록 #12`, `| 메모 | 번호 |\n|---|---|\n| ${clue} | #12 |`]) {
      const found = links(form, card, ambiguous);
      expect({ kind, form, linksCard: found.some(link => link.repo === card) }).toEqual({ kind, form, linksCard: false });
    }
  }
  // 저장소 칸의 모르는 값도 다른 저장소 단서다.
  expect(links("| 저장소 | 번호 |\n|---|---|\n| zeta-api | #8 |\n\n그 밖에 #9", card)).toEqual([]);
  // 다른 저장소 단서가 하나도 없으면 카드 저장소.
  for (const form of ["정리 후 #12", "README.md 수정 #12", "feat 브랜치 정리 #12", "UTF-8 고침 #12"]) {
    expect({ form, found: links(form, card) }).toEqual({ form, found: one(card, 12) });
  }
});

test("dropped links: plain words right before a number and lines that name repositories elsewhere", () => {
  // 범위를 좁혀 생긴 링크 빠짐. 틀린 링크 대신 링크 없음.
  for (const text of ["Approve #42", "GitHub PR #12", "follow-up #12", "v1.2 #12", "Closes #12", "alpha-web fixed in PR #18"]) {
    expect({ text, found: links(text, card) }).toEqual({ text, found: [] });
  }
  expect(links("alpha-web #12\n그 다음 #13", card)).toEqual(one("studio/alpha-web", 12));
  expect(links("alpha-web. 다음은 #15", card)).toEqual([]);
  expect(links("#12 alpha-web 수정, #13 beta-api 수정", card)).toEqual([]);
  expect(links("#15 alpha-web beta", card)).toEqual([]);
  expect(links("Alpha 프로젝트 #12", card)).toEqual([]);
  expect(links("web 화면 고친 뒤 #30", card)).toEqual([]);
  expect(links("beta #1<br>#2", card)).toEqual(one("studio/beta", 1));
  expect(links("other/thing#16 와 alpha-web #17")).toEqual(one("studio/alpha-web", 17));
});

test("known limitation: an unknown repository name away from the number does not stop the card repository", () => {
  // 알려진 한계. 보드가 모르는 저장소 이름이 번호 옆이 아닌 곳에만 있으면 카드 저장소로 간다.
  // 실제 글의 저장소 이름은 대부분 보드 목록(관리 프로젝트, 원장, 열린 PR, 병합 기록)에 있어 다른 저장소 단서로 걸린다.
  // 하이픈 든 모르는 단어로 막으면 re-review, follow-up 같은 흔한 말 때문에 링크가 넓게 빠지므로 막지 않는다.
  for (const text of ["zeta-api 병합 완료 #26", "#26 zeta-api 병합", "ZetaApp 수정 (#26)"]) {
    expect({ text, found: links(text, card) }).toEqual({ text, found: one(card, 26) });
  }
  expect(links("| 메모 | 대상 | 번호 |\n|---|---|---|\n| 고침 | zeta-api | #8 |", card)).toEqual(one(card, 8));
});

test("the fallback is decided once for the whole text", () => {
  const tokens = lexBoardMarkdown("정리했습니다.\n\n## 결과\n\n- 첫째 #1\n- 둘째는 alpha-web 쪽");
  expect(fallbackRepository(tokens, card, known)).toBeUndefined();
  expect(fallbackRepository(lexBoardMarkdown("정리했습니다. #1"), card, known)).toBe(card);
  expect(fallbackRepository(lexBoardMarkdown("card 정리 #1, studio/card#2"), card, known)).toBe(card);
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
  expect(links("Alpha #1, alpha-web #2, gamma-api #3, Beta #4, delta #5, off #6, unmapped #7", undefined, index)).toEqual([
    ...one("studio/alpha-web", 1), ...one("studio/alpha-web", 2), ...one("labs/gamma-api", 3), ...one("studio/beta", 4), ...one("labs/delta", 5),
  ]);
});

test("the fallback reads the whole visible text: below a collapsed preview and across formatting", () => {
  const beta = repositoryIndex([{ repo: "studio/beta" }]);
  const context = "#12\n첫째\n둘째\n셋째\n\nbeta 정리";
  // 접힌 미리보기에는 beta 가 안 보여도 전체 글에 있으므로 카드 저장소로 잇지 않는다.
  expect(pullLinksIn("#12\n첫째\n둘째\n셋째", { repository: card, known: beta, fallbackSource: context })).toEqual([]);
  expect(pullLinksIn("#12\n첫째\n둘째\n셋째", { repository: card, known: beta })).toEqual(one(card, 12));
  // 서식에 걸친 프로젝트 이름도 보이는 글 그대로 읽는다.
  const titled = repositoryIndex([{ repo: "studio/frontend", names: ["Alpha Web"] }]);
  expect(links("**Alpha** Web 정리\n\n#12", card, titled)).toEqual([]);
  expect(links("Alpha *Web* 정리\n\n#12", card, titled)).toEqual([]);
  expect(links("[Alpha](https://example.com) Web 정리\n\n#12", card, titled)).toEqual([]);
  expect(links("Alpha\n\nWeb 정리 #12", card, titled)).toEqual(one(card, 12));
});

test("escaped punctuation reads as the character it shows", () => {
  const index = repositoryIndex([{ repo: "studio/alpha-web" }, { repo: "studio/web" }]);
  // 화면에는 alpha-web #12 로 보이므로 alpha-web 이다(web 으로 가면 틀린 링크).
  expect(links("alpha\\-web #12", card, index)).toEqual(one("studio/alpha-web", 12));
  expect(links("zeta\\-web #13", card, index)).toEqual([]);
  // 이스케이프한 # 는 번호가 아니다.
  expect(links("\\#5 와 alpha\\-web #6", card, index)).toEqual(one("studio/alpha-web", 6));
});
