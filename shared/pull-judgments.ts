import { z } from "zod";
import { commitSha, pullVerdict, repositorySlug, type PullDetail, type PullGate, type PullRequestItem } from "./prs";

export const MAX_PULL_JUDGMENTS = 500;
export const pullJudgmentSchema = z.object({
  repo: repositorySlug, number: z.number().int().positive(), headSha: commitSha, verdict: pullVerdict,
  reason: z.string().trim().min(1).max(300), ownerSessionId: z.string().min(1).max(256).optional(),
  // The host where the board verified a remote owner (its serverId). Absent for a session on this host.
  ownerSessionHost: z.string().min(1).max(256).optional(),
  at: z.iso.datetime(), coordinator: z.string(),
});
export type PullJudgment = z.output<typeof pullJudgmentSchema>;
export const pullJudgmentKey = (repo: string, number: number) => repo + "#" + number;

type Options = {
  // false only when the person turned the setting off.
  enabled: boolean;
  // Whether a coordinator is designated to judge new heads.
  coordinator: boolean;
  judgments: Record<string, PullJudgment>;
  // PRs that a coordinator ledger merge card already raised for the person.
  ledgerPulls: ReadonlySet<string>;
};

// Decide which GitHub-ready PRs become merge cards. Everything else stays in project progress.
export function applyPullJudgments<T extends PullRequestItem>(items: readonly T[], options: Options): T[] {
  return items.map(item => {
    const { gate: _gate, judgment: _judgment, ...pr } = item;
    const key = pullJudgmentKey(pr.repo, pr.number);
    const saved = Object.hasOwn(options.judgments, key) ? options.judgments[key] : undefined;
    const current = saved && pr.headSha && saved.headSha === pr.headSha ? saved : undefined;
    const judgment = current && {
      verdict: current.verdict, reason: current.reason, at: current.at,
      ...(current.ownerSessionId ? { ownerSessionId: current.ownerSessionId } : {}),
      ...(current.ownerSessionHost ? { ownerSessionHost: current.ownerSessionHost } : {}),
    };
    if (pr.reason !== "ready") return { ...pr, lane: "progress", ...(judgment ? { judgment } : {}) } as T;
    let gate: PullGate;
    if (!options.enabled) gate = "github";
    // A verdict bound to this exact head is the most specific evidence, even over a ledger card.
    // It still holds while no coordinator is designated.
    else if (current) gate = current.verdict === "ready" ? "judged" : current.verdict;
    // With nobody to judge a new head, GitHub decides.
    else if (!options.coordinator) gate = "github";
    // A verdict on an earlier head means the ledger card predates new commits too.
    else if (saved) gate = "stale";
    else gate = options.ledgerPulls.has(key) ? "ledger" : "awaiting";
    const lane = gate === "github" || gate === "ledger" || gate === "judged" ? "review" : "progress";
    return { ...pr, lane, gate, ...(judgment ? { judgment } : {}) } as T;
  });
}

// Keep the newest judgments when the store grows past its limit.
export function prunePullJudgments(judgments: Record<string, PullJudgment>, limit = MAX_PULL_JUDGMENTS) {
  const entries = Object.entries(judgments);
  if (entries.length <= limit) return judgments;
  entries.sort((a, b) => b[1].at.localeCompare(a[1].at));
  return Object.fromEntries(entries.slice(0, limit));
}

export type PullColumn = "human" | "review" | "running";
// Project kanban column for a PR that is not covered by a ledger card.
export function pullColumn(pr: Pick<PullRequestItem, "lane" | "reason" | "gate" | "judgment">): PullColumn {
  if (pr.lane === "review") return "human";
  if (pr.gate === "needs-changes" || pr.gate === "blocked" || pr.gate === "stale") return "review";
  if (["conflict", "checks-failed", "changes-requested", "review-required", "blocked", "unknown"].includes(pr.reason)) return "review";
  return "running";
}

const githubWords = {
  ready: ["병합 검토 가능", "Ready for merge review"], draft: ["초안", "Draft"],
  conflict: ["충돌 해결 필요", "Conflicts to resolve"], "checks-failed": ["검사 실패", "Checks failed"],
  "checks-pending": ["검사 중", "Checks pending"], "changes-requested": ["수정 요청", "Changes requested"],
  "review-required": ["리뷰 필요", "Review required"],
  blocked: ["병합 조건 대기", "Merge requirements pending"],
  computing: ["GitHub이 병합 가능 여부를 계산 중", "GitHub is still checking whether it can merge"],
  // Only when the board could not read the PR from GitHub.
  unknown: ["상태 미확인", "Status unknown"],
  "auto-merge": ["자동 병합 대기", "Auto-merge enabled"],
} as const satisfies Record<PullRequestItem["reason"], readonly [string, string]>;
export const githubStatusWords: Record<PullRequestItem["reason"], readonly [string, string]> = githubWords;

// Why a PR reads as status unknown, or why its lifecycle could not be read.
export const pullDetailWords: Record<PullDetail | "scope" | "unmapped" | "off", readonly [string, string]> = {
  "gh-missing": ["호스트에서 gh를 찾지 못함", "gh was not found on the host"],
  "gh-auth": ["호스트의 gh 로그인 필요", "gh on the host needs to sign in"],
  timeout: ["GitHub 응답 시간 초과", "GitHub took too long to answer"],
  network: ["GitHub에 연결하지 못함", "Could not reach GitHub"],
  "lookup-failed": ["GitHub 조회 실패", "GitHub lookup failed"],
  closed: ["조회하는 사이 PR이 닫힘", "The PR closed while the board was reading it"],
  "still-computing": ["GitHub이 병합 가능 여부를 계산하지 못함, 잠시 뒤 다시 확인", "GitHub has not worked out mergeability yet. The board checks again shortly"],
  "check-result": ["결과가 없는 검사가 있음", "A check finished without a result"],
  "review-state": ["알 수 없는 리뷰 상태", "Unrecognized review state"],
  "merge-state": ["알 수 없는 병합 상태", "Unrecognized merge state"],
  scope: ["관리 프로젝트의 저장소 연결과 다름", "Not the repository linked to this managed project"],
  unmapped: ["저장소 연결 없음", "No repository linked"],
  off: ["PR 조회 꺼짐", "PR lookup is off"],
};

// "Status unknown" always comes with its reason when the board knows it.
export function unknownStatusWords(detail: keyof typeof pullDetailWords | undefined): readonly [string, string] {
  const [ko, en] = githubWords.unknown;
  if (!detail) return [ko, en];
  const [why, whyEn] = pullDetailWords[detail];
  return [`${ko}: ${why}`, `${en}: ${whyEn}`];
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);

// Korean and English status for a PR card. GitHub reasons come first unless GitHub says ready.
export function pullStatusWords(pr: Pick<PullRequestItem, "reason" | "gate" | "judgment" | "detail">): readonly [string, string] {
  if (pr.reason === "unknown") return unknownStatusWords(pr.detail);
  if (pr.reason !== "ready") return githubWords[pr.reason];
  const reason = pr.judgment ? oneLine(pr.judgment.reason) : "";
  switch (pr.gate) {
    case "awaiting": return ["GitHub 준비됨 · 코디네이터 판단 대기", "GitHub ready · Awaiting coordinator review"];
    case "stale": return ["새 커밋, 다시 확인 필요", "New commits · Needs another review"];
    case "needs-changes": return reason ? [`수정 필요: ${reason}`, `Needs changes: ${reason}`] : ["수정 필요", "Needs changes"];
    case "in-progress": return ["작업 중", "Work in progress"];
    case "blocked": return reason ? [`막힘: ${reason}`, `Blocked: ${reason}`] : ["막힘", "Blocked"];
    case "judged": return ["코디네이터 확인 · 병합 검토 가능", "Coordinator checked · Ready for merge review"];
    case "ledger": return ["코디네이터 병합 안건", "Coordinator merge request"];
    default: return githubWords.ready;
  }
}

export type WorkSessionState = { running: boolean };
// A work session still running on this PR, or the owner the coordinator named, needs one more confirmation.
export function needsRunningConfirmation(sessions: readonly WorkSessionState[]) {
  return sessions.some(session => session.running);
}

type SessionLike = { id: string; lane: string };
// Whether the session the coordinator named as the PR owner is running now.
export function ownerRunning(pr: Pick<PullRequestItem, "judgment">, sessions: readonly SessionLike[]) {
  const owner = pr.judgment?.ownerSessionId;
  return !!owner && sessions.some(session => session.id === owner && session.lane === "running");
}
