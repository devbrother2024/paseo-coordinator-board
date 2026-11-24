import { resolveRoute, sameRoute, type Grade, type RouteChoice } from "../shared/dispatch";
import type { Operations } from "../shared/operations";
import type { Translate } from "./language";
import { routeEfforts } from "./model-choices";
import { explainEmptyRoute, koreanText, savedCandidateIssue } from "./route-options";
import { boardCandidates } from "./routing-edit";

type Directory = Pick<Operations, "providers" | "catalog" | "routing" | "usage" | "usageRouting">;
export const routingGrades: readonly Grade[] = ["A", "B", "C", "D", "M"];

export function gradeLabel(grade: Grade, t: Translate = koreanText) {
  const names = { A: t("A · 최상", "A · Highest"), B: t("B · 높음", "B · High"), C: t("C · 중간", "C · Medium"), D: t("D · 기본", "D · Basic"), M: t("코디네이터", "Coordinator") };
  return names[grade];
}

// What kind of work a grade stands for. The coordinator picks the grade for each task.
export function gradePurpose(grade: Grade, t: Translate = koreanText) {
  const purposes = {
    A: t("가장 어려운 일. 설계, 까다로운 버그, 여러 부분에 걸친 변경", "The hardest work: design, difficult bugs, changes across many parts"),
    B: t("어려운 구현과 꼼꼼한 검토", "Demanding implementation and careful review"),
    C: t("보통 난이도의 구현과 수정", "Everyday implementation and fixes"),
    D: t("단순하고 반복적인 일. 조사, 정리, 작은 수정", "Simple, routine work: lookups, cleanup, small edits"),
    M: t("코디네이터 세션을 만들거나 교체할 때", "Creating or replacing the coordinator session"),
  };
  return purposes[grade];
}

export function routeLabel(route: RouteChoice | null, t: Translate = koreanText) {
  if (!route) return t("사용 가능한 후보 없음", "No available candidate");
  return route.provider + " / " + route.model + " · " + (route.effort ?? t("기본 강도", "default effort"));
}

// How the model in use was decided: by the board's own order, by a saved list, or by remaining account usage.
export type RoutingMode = "recommended" | "custom" | "usage";
export type RoutingCandidate = { route: RouteChoice; issue: string | null; active: boolean; efforts: (string | null)[] };
export type RoutingRow = {
  grade: Grade; label: string; purpose: string; mode: RoutingMode;
  active: RouteChoice | null; candidates: RoutingCandidate[];
  // Usable candidates behind the one in use.
  fallbacks: number;
  // Why the first candidate is not the one in use, or why nothing can be used.
  notice: string | null;
};

export function routingRow(data: Directory, grade: Grade, t: Translate = koreanText): RoutingRow {
  const usage = data.usageRouting ? data.usage : undefined;
  const saved = data.routing[grade];
  const active = resolveRoute(grade, data.routing, data.catalog, false, usage);
  // An unsaved grade lists the candidate in use first: that is the order a first change would save.
  const listed = saved ?? boardCandidates(data, grade);
  const preferred = saved ? null : resolveRoute(grade, {}, data.catalog);
  const candidates = listed.map(route => {
    const issue = saved ? savedCandidateIssue(data, grade, route, t) : null;
    return { route, issue, active: !!active && sameRoute(active, route), efforts: issue ? [] : routeEfforts(data, route) };
  });
  const first = candidates[0];
  const mode: RoutingMode = saved ? "custom" : active && preferred && !sameRoute(active, preferred) ? "usage" : "recommended";
  const notice = !active ? explainEmptyRoute(data, grade, t)
    : saved && first?.issue ? t(`1순위 ${first.route.provider} / ${first.route.model}을 쓸 수 없어 예비 후보를 씁니다 · ${first.issue}`,
      `Priority 1 (${first.route.provider} / ${first.route.model}) is unavailable, so a fallback is in use · ${first.issue}`)
      : null;
  return { grade, label: gradeLabel(grade, t), purpose: gradePurpose(grade, t), mode, active, candidates,
    fallbacks: candidates.filter(candidate => !candidate.issue && !candidate.active).length, notice };
}

export function routingOverview(data: Directory, t: Translate = koreanText): RoutingRow[] {
  return routingGrades.map(grade => routingRow(data, grade, t));
}

export function modeLabel(mode: RoutingMode, t: Translate = koreanText) {
  return { recommended: t("추천", "Recommended"), custom: t("직접 지정", "Custom"), usage: t("사용량 기준", "By usage") }[mode];
}
