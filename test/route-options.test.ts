import { expect, test } from "bun:test";
import { explainEmptyRoute, savedCandidateIssue } from "../client/route-options";
import type { CatalogModel, Grade, ProviderEntry, RouteChoice } from "../shared/dispatch";

function provider(id: string, extra: Partial<ProviderEntry> = {}): ProviderEntry {
  return { id, label: id, included: true, available: true, status: "ready", modelCount: 1, ...extra };
}

function model(provider: string, id: string): CatalogModel {
  return { provider, model: id, label: id, isDefault: false, efforts: ["high"] };
}

test("실행기 포함 여부·등급·연결 상태를 기준으로 빈 추천의 복구 방법을 표시한다", () => {
  function message(providers: ProviderEntry[], grade: Grade = "C") {
    return explainEmptyRoute({ providers, catalog: [], routing: {} }, grade);
  }
  expect(message([])).toMatch(/연결/);
  for (const grade of ["A", "B"] as const) {
    expect(message([provider("cursor", { status: "empty" })], grade)).toMatch(/모델.*없/);
  }
  expect(message([provider("cursor")], "M")).toMatch(/기존|지정/);
  // The switch that brings a provider back now lives with the accounts.
  expect(message([provider("codex", { included: false })], "M")).toMatch(/꺼져.*계정과 사용량/);
  expect(message([provider("codex", { available: false, status: "unavailable" })], "D")).toMatch(/연결/);
  expect(message([provider("codex", { status: "error" })])).toMatch(/조회.*실패/);
  expect(message([provider("codex", { status: "empty", modelCount: 0 })])).toMatch(/모델.*없/);
});

test("저장 후보를 제외하거나 모델·강도 목록이 바뀌어도 원래 순위와 이유를 보여 준다", () => {
  const first: RouteChoice = { provider: "codex", model: "first", effort: "high" };
  const second: RouteChoice = { provider: "cursor", model: "gemini", effort: null };
  const data = {
    providers: [provider("codex", { included: false }), provider("cursor", { included: false })],
    catalog: [] as CatalogModel[],
    routing: { C: [first, second] },
  };

  expect(explainEmptyRoute(data, "C")).toMatch(/저장.*후보/);
  expect(savedCandidateIssue(data, "C", first)).toContain("꺼짐");
  data.providers[0].included = true;
  expect(savedCandidateIssue(data, "C", first)).toContain("모델");
  data.catalog.push({ ...model("codex", "first"), efforts: [] });
  expect(savedCandidateIssue(data, "C", first)).toContain("강도");
  data.catalog[0].efforts = ["high"];
  expect(savedCandidateIssue(data, "C", first)).toBeNull();
  expect(data.routing.C).toEqual([first, second]);
});

test("영어 경고를 표시하면서 실행기 이름과 모델 ID를 보존한다", () => {
  const en = (_ko: string, english: string) => english;
  const a = model("codex", "팀-모델");
  const b = model("cursor", "model-B");
  const row = { provider: b.provider, model: b.model, effort: "xhigh" };
  const data = {
    providers: [provider("codex", { label: "팀 실행기" }), provider("cursor")],
    catalog: [a, b], routing: { C: [row] },
  };
  expect(savedCandidateIssue(data, "C", row, en)).toMatch(/effort/);
  expect(explainEmptyRoute(data, "C", en)).toContain("Back to recommended");
  expect(data.routing.C).toEqual([row]);
});
