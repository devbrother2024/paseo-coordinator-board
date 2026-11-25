import { expect, test } from "bun:test";
import { cleanSessionText, lastMessageSummary, needsCoordinator, waitedFor, waitedLabel } from "../shared/review-wait";
import { coveredSessionIds, decorateReviewWait } from "../server/review-wait";
import { excerpt } from "../server/conversation";
import { discoverSessions } from "../server/discovery";

const ko = (korean: string) => korean;
const en = (_: string, english: string) => english;
const hour = 3_600_000;

test("요약은 멈춤·대기 문장을 마지막 문단보다 먼저 고른다", () => {
  const text = "구현을 마쳤습니다.\n\n자기 PR 세 개 상한으로 다음 구현을 정지합니다. 병합되면 이어갑니다.\n\n다른 메모입니다.";
  expect(lastMessageSummary(text)).toBe("자기 PR 세 개 상한으로 다음 구현을 정지합니다.");
  expect(lastMessageSummary("Done.\n\nWaiting for review on the open PR before the next step.\n\nNotes follow.")).toBe("Waiting for review on the open PR before the next step.");
  expect(lastMessageSummary("리뷰를 기다린다")).toBe("리뷰를 기다린다");
  expect(lastMessageSummary("Work stopped until the API key arrives.")).toBe("Work stopped until the API key arrives.");
});

test("멈춤 문장이 없으면 마지막 문단을 쓰고, 코드 블록 속 낱말은 고르지 않는다", () => {
  expect(lastMessageSummary("첫 문단입니다.\n\n둘째 줄\n셋째 줄")).toBe("둘째 줄 셋째 줄");
  expect(lastMessageSummary("검증을 마쳤습니다.\n\n```\nwaiting = true\n```")).toBe("검증을 마쳤습니다.");
});

test("요약은 마크다운 기호를 걷어 내고 길이를 자른다", () => {
  expect(lastMessageSummary("## 결과\n\n- **PR [#12](https://example.com/pr/12)** 병합 `대기` 중")).toBe("PR #12 병합 대기 중");
  expect(lastMessageSummary("> 인용\n> 마지막")).toBe("인용 마지막");
  expect(lastMessageSummary("| 열 | 값 |\n|---|---|\n| 상태 | 정지 |")).toBe("상태 정지");
  const long = "가".repeat(400);
  const cut = lastMessageSummary(long);
  expect(cut.length).toBe(160);
  expect(cut.endsWith("…")).toBe(true);
  expect(lastMessageSummary("   \n\n")).toBe("");
});

test("세션 글의 제어 문자와 양방향 제어 문자를 지우고 줄바꿈은 남긴다", () => {
  const raw = "정지‮합니다\u0007⁦.\n다음\tstep​";
  expect(cleanSessionText(raw)).toBe("정지합니다.\n다음\tstep");
  expect(lastMessageSummary("정지‮합니다\u0000.")).toBe("정지합니다.");
});

test("기다린 시간은 분·시간·일로 두 언어 문구를 만든다", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();
  expect(waitedFor(at(30_000), now)).toEqual({ unit: "minute", value: 1 });
  expect(waitedFor(at(59 * 60_000), now)).toEqual({ unit: "minute", value: 59 });
  expect(waitedFor(at(hour), now)).toEqual({ unit: "hour", value: 1 });
  expect(waitedFor(at(23 * hour + 59 * 60_000), now)).toEqual({ unit: "hour", value: 23 });
  expect(waitedFor(at(24 * hour), now)).toEqual({ unit: "day", value: 1 });
  expect(waitedFor(at(49 * hour), now)).toEqual({ unit: "day", value: 2 });
  expect(waitedFor("not a date", now)).toBeNull();
  expect(waitedFor(undefined, now)).toBeNull();
  // A clock skew must not produce a negative duration.
  expect(waitedFor(new Date(now + hour).toISOString(), now)).toEqual({ unit: "minute", value: 1 });
  expect(waitedLabel(at(3 * hour), now, ko)).toBe("3시간째");
  expect(waitedLabel(at(3 * hour), now, en)).toBe("Waiting 3 h");
  expect(waitedLabel(at(2 * 24 * hour), now, ko)).toBe("2일째");
  expect(waitedLabel(at(2 * 24 * hour), now, en)).toBe("Waiting 2 days");
  expect(waitedLabel(at(24 * hour), now, en)).toBe("Waiting 1 day");
  expect(waitedLabel(at(5 * 60_000), now, ko)).toBe("5분째");
  expect(waitedLabel(at(5 * 60_000), now, en)).toBe("Waiting 5 min");
  expect(waitedLabel(undefined, now, ko)).toBe("");
});

test("미처리 판정: 코디네이터 없음, 문턱 전후, 열린 카드, 코디네이터 손길", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const base = { coordinator: "coord", waitingSince: new Date(now - 13 * hour).toISOString(), now, thresholdHours: 12,
    covered: false, coordinatorTouched: false };
  expect(needsCoordinator(base)).toBe(true);
  expect(needsCoordinator({ ...base, coordinator: null })).toBe(false);
  expect(needsCoordinator({ ...base, waitingSince: new Date(now - 11 * hour).toISOString() })).toBe(false);
  expect(needsCoordinator({ ...base, waitingSince: new Date(now - 12 * hour).toISOString() })).toBe(true);
  expect(needsCoordinator({ ...base, covered: true })).toBe(false);
  expect(needsCoordinator({ ...base, coordinatorTouched: true })).toBe(false);
  expect(needsCoordinator({ ...base, waitingSince: undefined })).toBe(false);
  expect(needsCoordinator({ ...base, thresholdHours: 24 })).toBe(false);
});

test("원장 카드가 가리키는 세션을 모은다", () => {
  const ids = coveredSessionIds([
    { sessionId: "a", sessionMatch: null, matchedSessionId: null },
    { sessionId: null, sessionMatch: { projectId: "p", sessionId: "b", question: "q" }, matchedSessionId: null },
    { sessionId: null, sessionMatch: null, matchedSessionId: "c" },
    { sessionId: null, sessionMatch: null, matchedSessionId: null },
  ]);
  expect([...ids].sort()).toEqual(["a", "b", "c"]);
});

function page(items: unknown[]) {
  return { epoch: "e", entries: items.map((item, i) => ({ item, seqEnd: i })), error: null } as never;
}
const said = (text: string) => ({ type: "assistant_message", text });
const fromAgent = (sender: string, text = "상태를 알려 주세요") => ({ type: "tool_call", name: "agent_message", callId: "paseo-agent-message:" + sender + text.length,
  status: "completed", agentMessage: { event: "message", sender: { id: sender }, text } });

test("발췌는 마지막으로 들어온 입력의 보낸 세션을 기억한다", () => {
  expect(excerpt(page([{ type: "user_message", text: "시작" }, said("정지합니다.")])).lastInputSender).toBeUndefined();
  expect(excerpt(page([fromAgent("coord"), said("아직 정지 상태입니다.")])).lastInputSender).toBe("coord");
  expect(excerpt(page([fromAgent("coord"), said("정지"), { type: "user_message", text: "사람 입력" }, said("확인")])).lastInputSender).toBeUndefined();
  expect(excerpt(page([said("정지"), fromAgent("other")])).lastInputSender).toBe("other");
});

test("스냅숏 꾸미기: 확인 대기 카드에 요약·전체 글·미처리 표시를 단다", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const since = new Date(now - 20 * hour).toISOString();
  const row = (id: string, lane: "review" | "idle" | "running" = "review") => ({ id, title: id, projectId: "p", projectTitle: "P", workspaceTitle: "w",
    model: null, status: "idle", lane, detail: "세션 결과 확인 필요", waitingSince: since });
  const rows = [row("stuck"), row("carded"), row("judged"), row("nudged"), row("quiet", "idle"), row("busy", "running")];
  const evidence = new Map([
    ["stuck", excerpt(page([said("구현을 마쳤습니다.\n\nPR 상한으로 다음 구현을 **정지**합니다.")]))],
    ["carded", excerpt(page([said("리뷰를 기다립니다.")]))],
    ["judged", excerpt(page([said("리뷰를 기다립니다.")]))],
    ["nudged", excerpt(page([fromAgent("coord"), said("아직 기다립니다.")]))],
    ["quiet", excerpt(page([said("끝났습니다.")]))],
  ]);
  const judged = evidence.get("judged")!;
  decorateReviewWait(rows, evidence, { coordinator: "coord", now, thresholdHours: 12, covered: new Set(["carded"]),
    judgments: { judged: { evidenceId: judged.id, projectId: "p" }, stuck: { evidenceId: "older", projectId: "p" } } });
  const by = new Map(rows.map(r => [r.id, r]));
  expect(by.get("stuck")).toMatchObject({ lastSummary: "PR 상한으로 다음 구현을 정지합니다.", needsCoordinator: true });
  expect(by.get("stuck")!.lastMessage).toContain("**정지**");
  expect(by.get("carded")!.needsCoordinator).toBeUndefined();
  expect(by.get("judged")!.needsCoordinator).toBeUndefined();
  expect(by.get("nudged")!.needsCoordinator).toBeUndefined();
  // Idle cards show the same summary, but only the review lane is flagged.
  expect(by.get("quiet")).toMatchObject({ lastSummary: "끝났습니다." });
  expect(by.get("quiet")!.needsCoordinator).toBeUndefined();
  expect(by.get("busy")!.lastSummary).toBeUndefined();
  expect(by.get("busy")!.waitingSince).toBeUndefined();

  const without = [row("stuck")];
  decorateReviewWait(without, evidence, { coordinator: null, now, thresholdHours: 12, covered: new Set(), judgments: {} });
  expect(without[0].needsCoordinator).toBeUndefined();
  expect(without[0].lastSummary).toBeTruthy();
});

test("마지막 글이 잘렸으면 전체 글에 앞부분 생략을 알린다", () => {
  const long = "앞".repeat(2500) + "\n\n정지합니다.";
  const rows = [{ id: "s", title: "s", projectId: "p", projectTitle: "P", workspaceTitle: "w", model: null, status: "idle", lane: "review" as const, detail: "", waitingSince: "2026-11-24T00:00:00Z" }];
  decorateReviewWait(rows, new Map([["s", excerpt(page([said(long)]))]]), { coordinator: null, now: Date.parse("2026-11-24T01:00:00Z"), thresholdHours: 12, covered: new Set(), judgments: {} });
  expect(rows[0]).toMatchObject({ lastSummary: "정지합니다.", lastMessageTruncated: true });
  expect(rows[0].lastMessage!.length).toBeLessThanOrEqual(2000);
});

test("발견 단계는 확인 대기·대기 중 세션에 기다리기 시작한 시각을 단다", async () => {
  const pageOf = (entries: unknown[]) => ({ entries, pageInfo: { nextCursor: null, hasMore: false } });
  const agent = (id: string, extra: object) => ({ agent: { id, status: "idle", updatedAt: "2026-11-24T05:00:00Z", pendingPermissions: [], ...extra }, project: { projectKey: "p" } });
  const sdk = { workspaces: { list: async () => pageOf([]) }, agents: { list: async () => pageOf([
    agent("review", { requiresAttention: true, attentionReason: "finished", attentionTimestamp: "2026-11-24T03:00:00Z" }),
    agent("idle", {}),
    agent("running", { status: "running", activeTurn: {} }),
  ]) } };
  const rows = await discoverSessions(sdk as never);
  const by = new Map(rows.map(r => [r.id, r]));
  expect(by.get("review")).toMatchObject({ lane: "review", waitingSince: "2026-11-24T03:00:00Z" });
  expect(by.get("idle")).toMatchObject({ lane: "idle", waitingSince: "2026-11-24T05:00:00Z" });
  expect(by.get("running")!.waitingSince).toBeUndefined();
});

test("코디네이터 목록 도구는 기다린 시간과 미처리 여부를 함께 준다", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { PreferenceStore } = await import("../server/preferences");
  const { ConversationReader } = await import("../server/conversation");
  const { attachCoordinatorTools } = await import("../server/coordinator");
  const store = new PreferenceStore(join(mkdtempSync(join(tmpdir(), "review-wait-")), "scope.json"));
  store.change(s => { s.projects = ["p"]; s.coordinator = "coord"; });
  const old = new Date(Date.now() - 30 * hour).toISOString();
  const recent = new Date(Date.now() - 2 * hour).toISOString();
  const finished = (id: string, at: string) => ({ agent: { id, status: "idle", updatedAt: at, attentionTimestamp: at, requiresAttention: true,
    attentionReason: "finished", pendingPermissions: [] }, project: { projectKey: "p" } });
  const pageOf = (entries: unknown[]) => ({ entries, pageInfo: { nextCursor: null, hasMore: false } });
  const timelines: Record<string, unknown[]> = {
    stuck: [said("PR 상한으로 정지합니다.")], nudged: [fromAgent("coord"), said("아직 정지 상태입니다.")],
    carded: [said("리뷰를 기다립니다.")], fresh: [said("리뷰를 기다립니다.")],
  };
  const sdk = { workspaces: { list: async () => pageOf([]) }, agents: {
    list: async () => pageOf([{ agent: { id: "coord", status: "running", activeTurn: {}, updatedAt: old, pendingPermissions: [] }, project: { projectKey: "p" } },
      finished("stuck", old), finished("nudged", old), finished("carded", old), finished("fresh", recent)]),
    ref: (id: string) => ({ timeline: { refetch: async () => page(timelines[id] ?? []) } }),
  } };
  let hook: (event: unknown) => Promise<{ tools: { execute: (input: object, ctx: object) => Promise<{ text: string }> }[] } | undefined> = async () => undefined;
  attachCoordinatorTools({ addHook: (_: string, h: typeof hook) => { hook = h; return () => {}; } } as never, store, new ConversationReader(), [], undefined,
    async () => ({ thresholdHours: 12, covered: new Set(["carded"]) }));
  const [read] = (await hook({ request: { purpose: "interactive", agentId: "coord", tools: [] } }))!.tools;
  const listing: { id: string; lane?: string; waitedHours?: number; needsCoordinator?: boolean }[] =
    JSON.parse((await read.execute({}, { paseo: sdk, agent: { id: "coord" } })).text);
  const by = new Map(listing.map(r => [r.id, r]));
  expect(by.get("stuck")).toMatchObject({ lane: "review", waitedHours: 30, needsCoordinator: true });
  expect(by.get("nudged")!.needsCoordinator).toBeUndefined();
  expect(by.get("carded")!.needsCoordinator).toBeUndefined();
  expect(by.get("fresh")).toMatchObject({ lane: "review", waitedHours: 2 });
  expect(by.get("fresh")!.needsCoordinator).toBeUndefined();
  expect(by.get("coord")!.lane).toBeUndefined();
});
