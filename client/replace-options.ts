import { eligibleProvider, resolveRoute, type CatalogModel, type RouteChoice } from "../shared/dispatch";
import type { Operations } from "../shared/operations";
import type { Translate } from "./language";
import { koreanText } from "./route-options";

type Directory = Pick<Operations, "providers" | "catalog" | "routing" | "usage" | "usageRouting">;
export type ReplacementRow = {
  provider: string; model: string; label: string;
  // What the board would choose on its own, and what the next replacement uses if nothing is picked.
  recommended: boolean; current: boolean;
  disabled: string | null;
};

// The same candidates as the M grade, one provider and model per row. Models that cannot run a
// coordinator stay visible so the person sees why they cannot be picked.
export function replacementChoices(data: Directory, query: string, t: Translate = koreanText) {
  const usage = data.usageRouting ? data.usage : undefined;
  const recommended = resolveRoute("M", {}, data.catalog, false, usage);
  const current = resolveRoute("M", data.routing, data.catalog, false, usage);
  const same = (route: RouteChoice | null, model: CatalogModel) => route?.provider === model.provider && route.model === model.model;
  const labels = new Map(data.providers.map(provider => [provider.id, provider.label]));
  const search = query.trim().toLowerCase();
  const rows: (ReplacementRow & { rank: number })[] = [];
  for (const model of data.catalog) {
    if (search && ![model.provider, labels.get(model.provider) ?? "", model.model, model.label].join(" ").toLowerCase().includes(search)) continue;
    // Judged alone, a provider is eligible exactly when it has a coordinator mode. Among others it may still yield.
    const disabled = eligibleProvider("M", model.provider, false, data.catalog) ? null
      : eligibleProvider("M", model.provider, false, [model]) ? t("Claude Code나 Codex가 연결된 동안에는 운영 세션에 쓰지 않는 실행기", "Not used for the coordinator while Claude Code or Codex is connected")
        : t("코디네이터 권한 모드를 확인할 수 없는 실행기", "No verified coordinator mode for this provider");
    const row = { provider: model.provider, model: model.model, label: model.provider + " / " + model.model,
      recommended: !disabled && same(recommended, model), current: !disabled && same(current, model), disabled };
    rows.push({ ...row, rank: disabled ? 3 : row.recommended ? 0 : row.current ? 1 : 2 });
  }
  // A stable sort keeps each provider's catalog order within a rank.
  rows.sort((a, b) => a.rank - b.rank);
  const listed = new Set(data.catalog.map(model => model.provider));
  const unavailable = data.providers.filter(provider => !listed.has(provider.id)).map(provider => ({
    provider: provider.id, label: provider.label,
    reason: !provider.included ? t("배정에서 제외한 실행기", "Provider excluded from routing")
      : !provider.available || provider.status === "unavailable" ? t("연결을 확인할 실행기", "Check the provider connection")
        : provider.status === "error" ? t("모델 조회 실패", "Model lookup failed") : t("선택할 모델 없음", "No models available"),
  }));
  const hint = rows.length ? null
    : search ? t("검색 결과가 없습니다. 모델 ID로 검색하거나 검색어를 지워 주세요.", "No matches. Search by model ID or clear your search.")
      : t("고를 수 있는 모델이 없습니다. 설정에서 실행기와 모델을 새로 고쳐 주세요.", "No models to choose from. Refresh providers and models in Settings.");
  return { rows: rows.map(({ rank: _rank, ...row }) => row), unavailable, hint };
}

// The route a picked model starts with: its saved effort, else the recommended one, else the provider's default.
export function replacementRoute(data: Directory, provider: string, model: string): RouteChoice | null {
  const entry = data.catalog.find(m => m.provider === provider && m.model === model);
  if (!entry || !eligibleProvider("M", provider, false, data.catalog)) return null;
  const saved = data.routing.M?.find(route => route.provider === provider && route.model === model &&
    (route.effort === null || entry.efforts.includes(route.effort)));
  return saved ?? resolveRoute("M", {}, [entry]) ?? { provider, model, effort: null };
}

// A picked model the catalog stopped offering is dropped, so the confirmation never names a model that cannot be used.
export function offeredPick(data: Directory | null, picked: RouteChoice | null): RouteChoice | null {
  if (!data || !picked || !replacementRoute(data, picked.provider, picked.model)) return null;
  return replacementEfforts(data, picked).includes(picked.effort) ? picked : { ...picked, effort: null };
}

export function replacementEfforts(data: Directory, route: RouteChoice): (string | null)[] {
  return [null, ...(data.catalog.find(m => m.provider === route.provider && m.model === route.model)?.efforts ?? [])];
}

export function replacementMode(data: Pick<Operations, "catalog">, provider: string) {
  return data.catalog.find(m => m.provider === provider)?.coordinatorMode ?? null;
}

// A picked model is sent as the person's own choice. Otherwise the board's current route is confirmed as before.
export function replacementSelection(picked: RouteChoice | null, usual: RouteChoice | null, remember: boolean):
  { route: RouteChoice; selection?: "once" | "default" } | null {
  if (picked) return { route: picked, selection: remember ? "default" : "once" };
  return usual ? { route: usual } : null;
}
