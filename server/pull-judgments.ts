import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { commitSha, mergeJudgmentSettings, pullVerdict, repositorySlug, setMergeJudgment, type PullRequestItem } from "../shared/prs";
import { pullJudgmentKey, prunePullJudgments } from "../shared/pull-judgments";
import { matchesWorkspace } from "../shared/workspace-pull";
import { managedRowsForCoordinator } from "./coordinator";
import type { PreferenceStore, Preferences } from "./preferences";
import type { ProjectPullRequests } from "./prs";

type Reader = Pick<ProjectPullRequests, "read">;

// Options for applyPullJudgments. Only the setting turns verdicts off; without a coordinator,
// GitHub decides new heads but a current non-ready verdict still holds.
export function judgedMergeCardOptions(scope: Pick<Preferences, "judgedMergeCards" | "coordinator">) {
  return { enabled: scope.judgedMergeCards, coordinator: scope.coordinator !== null };
}

export function registerMergeJudgmentSettings(server: PluginServerContext, prefs: PreferenceStore, invalidate: () => void) {
  server.handle(mergeJudgmentSettings, async () => ({ enabled: prefs.read().judgedMergeCards }));
  server.handle(setMergeJudgment, async ({ enabled }) => {
    prefs.change(scope => { scope.judgedMergeCards = enabled; });
    invalidate();
    return { ok: true as const };
  });
}

const input = z.strictObject({
  repo: repositorySlug.optional(), number: z.number().int().positive().max(2147483647).optional(),
  headSha: commitSha.optional(), verdict: pullVerdict.optional(),
  reason: z.string().trim().min(1).max(300).optional(), ownerSessionId: z.string().min(1).max(256).optional(),
});

const fail = (ko: string, en: string) => new Error(ko + " / " + en);

export function judgePullTool(prefs: PreferenceStore, prs: Reader, invalidate: () => void, now = () => new Date()) {
  return defineAgentTool({
    name: "judge_board_pull",
    description: "Without input, list open PRs in managed projects with their head commit, GitHub status, your current verdict and matching work sessions. "
      + "To record a verdict, give repo, number, headSha (the exact 40-character head commit you checked), verdict and a one-line reason. "
      + "Use ready only when the work is finished, review comments are addressed and checks pass on that head. Use needs-changes when something must be fixed, "
      + "in-progress while a work session is still changing the PR, and blocked when it waits on something outside the PR. "
      + "Optionally name the ownerSessionId of the work session. The board shows a merge card only for a ready verdict on the current head; "
      + "a new commit expires the verdict. This records a board judgment only. It never merges, approves or sends messages.",
    input,
    async execute(args, { paseo, agent }) {
      const rows = await managedRowsForCoordinator(paseo, prefs, agent.id);
      const recording = args.repo !== undefined || args.number !== undefined || args.headSha !== undefined || args.verdict !== undefined || args.reason !== undefined;
      if (!recording) {
        const view = await prs.read(paseo);
        const saved = prefs.read().pullJudgments;
        const list = view.items.map(pr => {
          const judgment = saved[pullJudgmentKey(pr.repo, pr.number)];
          const sessions = rows.filter(row => pr.projectIds.includes(row.projectId) && matchesWorkspace(pr, row.workspacePull))
            .map(row => ({ id: row.id, title: row.title, status: row.status, running: row.lane === "running" }));
          return {
            repo: pr.repo, number: pr.number, title: pr.title, headSha: pr.headSha ?? null, github: pr.reason,
            verdict: judgment ? { verdict: judgment.verdict, reason: judgment.reason, current: !!pr.headSha && judgment.headSha === pr.headSha } : null,
            workSessions: sessions,
          };
        });
        return { text: JSON.stringify(list) };
      }
      const { repo, number, headSha, verdict, reason, ownerSessionId } = args;
      if (!repo || !number || !headSha || !verdict || !reason) {
        throw fail("repo, number, headSha, verdict, reason을 모두 보내세요.", "Send repo, number, headSha, verdict and reason together.");
      }
      if (ownerSessionId && !rows.some(row => row.id === ownerSessionId)) {
        throw fail("ownerSessionId가 관리 세션이 아닙니다.", "ownerSessionId is not a managed session.");
      }
      const find = (items: PullRequestItem[]) => items.find(pr => pr.repo === repo && pr.number === number);
      let pull = find((await prs.read(paseo)).items);
      // The cached list can lag a fresh push. Check GitHub again before rejecting the head.
      if (!pull || pull.headSha !== headSha) pull = find((await prs.read(paseo, { refresh: true })).items);
      if (!pull) throw fail("관리 프로젝트의 열린 PR이 아닙니다.", "This is not an open PR in a managed project.");
      if (pull.headSha !== headSha) {
        throw fail(`PR 머리 커밋이 ${pull.headSha ?? "확인 불가"}입니다. 그 커밋을 다시 확인하세요.`,
          `The PR head is ${pull.headSha ?? "unavailable"}. Review that commit again.`);
      }
      prefs.change(scope => {
        if (scope.coordinator !== agent.id) throw fail("코디네이터 지정이 바뀌었습니다.", "The coordinator changed.");
        scope.pullJudgments[pullJudgmentKey(repo, number)] = {
          repo, number, headSha, verdict, reason: reason.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim() || "-",
          ...(ownerSessionId ? { ownerSessionId } : {}), at: now().toISOString(), coordinator: agent.id,
        };
        scope.pullJudgments = prunePullJudgments(scope.pullJudgments);
      });
      invalidate();
      return { text: verdict === "ready"
        ? "Recorded. The board shows a merge card for this head. A new commit expires the verdict."
        : "Recorded. The PR stays in project progress with this reason." };
    },
  });
}
