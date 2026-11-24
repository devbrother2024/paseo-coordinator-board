import { eligibleProvider, resolveRoute, type CatalogModel, type Grade, type RouteChoice } from "../shared/dispatch";
import type { Operations } from "../shared/operations";
import { recentUsage, type AccountUsage } from "../shared/usage-routing";
import type { Translate } from "./language";
import { koreanText } from "./route-options";

export type ModelDirectory = Pick<Operations, "providers" | "catalog" | "routing" | "usage" | "usageRouting">;
export type ChoiceRow = {
  provider: string; model: string; label: string;
  // What the board would choose on its own, and what this grade uses now.
  recommended: boolean; current: boolean;
  disabled: string | null;
};
export type ChoiceGroup = { provider: string; label: string; headroom: number | null; rows: ChoiceRow[] };

const sameModel = (route: Pick<RouteChoice, "provider" | "model"> | null, model: CatalogModel) =>
  route?.provider === model.provider && route.model === model.model;

// One reading for a provider's group title. Several accounts under one provider give no single answer,
// because nothing says which account the next session will use.
export function providerHeadroom(reports: readonly AccountUsage[] | undefined, provider: string, now = Date.now()): number | null {
  const own = (reports ?? []).filter(report => report.providerId === provider);
  if (own.length !== 1 || own[0].status !== "available" || !recentUsage(own[0], now)) return null;
  const live = own[0].windows.filter(w => w.remainingPct !== null && (!w.resetsAt || Date.parse(w.resetsAt) > now));
  if (!live.length) return null;
  return Math.min(...live.map(w => w.remainingPct!));
}

// The models a grade may use, grouped by provider. Models the grade cannot use stay visible with the reason.
export function modelChoices(data: ModelDirectory, grade: Grade, query: string, t: Translate = koreanText, taken: readonly RouteChoice[] = [], now = Date.now()) {
  const usage = data.usageRouting ? data.usage : undefined;
  const recommended = resolveRoute(grade, {}, data.catalog, false, usage);
  const current = resolveRoute(grade, data.routing, data.catalog, false, usage);
  const providers = new Map(data.providers.map(provider => [provider.id, provider.label]));
  const search = query.trim().toLowerCase();
  const groups = new Map<string, ChoiceGroup>();
  let count = 0;
  for (const model of data.catalog) {
    const title = providers.get(model.provider) ?? model.provider;
    if (search && ![model.provider, title, model.model, model.label].join(" ").toLowerCase().includes(search)) continue;
    // Judged alone, a provider lacks only a coordinator mode. Among others it may yield the grade to them.
    const disabled = taken.some(route => sameModel(route, model)) ? t("이미 후보에 있음", "Already a candidate")
      : eligibleProvider(grade, model.provider, false, data.catalog) ? null
        : grade === "M" && !eligibleProvider("M", model.provider, false, [model]) ? t("코디네이터 권한 모드를 확인할 수 없는 실행기", "No verified coordinator mode for this provider")
          : t("연결된 다른 실행기가 이 등급을 맡는 동안에는 쓰지 않는 실행기", "Not used for this grade while another connected provider covers it");
    const group = groups.get(model.provider) ?? { provider: model.provider, label: title, headroom: providerHeadroom(data.usage, model.provider, now), rows: [] };
    group.rows.push({ provider: model.provider, model: model.model, label: model.model,
      recommended: !disabled && sameModel(recommended, model), current: !disabled && sameModel(current, model), disabled });
    groups.set(model.provider, group);
    count++;
  }
  const rank = (row: ChoiceRow) => row.disabled ? 3 : row.recommended ? 0 : row.current ? 1 : 2;
  // Stable sorts keep the provider order and each provider's catalog order within a rank.
  const ordered = [...groups.values()].map(group => ({ ...group, rows: [...group.rows].sort((a, b) => rank(a) - rank(b)) }))
    .sort((a, b) => Math.min(...a.rows.map(rank)) - Math.min(...b.rows.map(rank)));
  const listed = new Set(data.catalog.map(model => model.provider));
  const unavailable = data.providers.filter(provider => !listed.has(provider.id)).map(provider => ({
    provider: provider.id, label: provider.label,
    reason: !provider.included ? t("자동 배정에서 꺼짐", "Turned off for automatic assignment")
      : !provider.available || provider.status === "unavailable" ? t("연결을 확인할 실행기", "Check the provider connection")
        : provider.status === "error" ? t("모델 조회 실패", "Model lookup failed") : t("선택할 모델 없음", "No models available"),
  }));
  const hint = count ? null
    : search ? t("검색 결과가 없습니다. 모델 ID로 검색하거나 검색어를 지워 주세요.", "No matches. Search by model ID or clear your search.")
      : t("고를 수 있는 모델이 없습니다. 설정에서 실행기와 모델을 새로 고쳐 주세요.", "No models to choose from. Refresh providers and models in Settings.");
  // A host with one provider needs no group title: every row belongs to it.
  return { groups: ordered, titled: listed.size > 1, count, unavailable, hint };
}

// The efforts a model supports, with the provider's own default first. A model outside the catalog offers none.
export function routeEfforts(data: Pick<Operations, "catalog">, route: Pick<RouteChoice, "provider" | "model">): (string | null)[] {
  const entry = data.catalog.find(m => m.provider === route.provider && m.model === route.model);
  return entry ? [null, ...entry.efforts] : [];
}

// The route a picked model starts with: the effort saved for this grade, else the recommended one, else the provider's default.
export function pickedRoute(data: ModelDirectory, grade: Grade, provider: string, model: string): RouteChoice | null {
  const entry = data.catalog.find(m => m.provider === provider && m.model === model);
  if (!entry || !eligibleProvider(grade, provider, false, data.catalog)) return null;
  const saved = data.routing[grade]?.find(route => route.provider === provider && route.model === model &&
    (route.effort === null || entry.efforts.includes(route.effort)));
  // Judged on its own: the effort does not depend on what else is connected.
  return saved ?? resolveRoute(grade, {}, [entry]) ?? { provider, model, effort: null };
}
