import { expect, test } from "bun:test";
import { modelChoices, pickedRoute, providerHeadroom, routeEfforts } from "../client/model-choices";
import {
  addCandidate, boardCandidates, canAdd, canRemove, dismissFailure, editAnnouncement, editableCandidates, expireEdits, lostToAnotherChange, maxCandidates, moveFirst, moveUp, nextExpiry, removeCandidate,
  saveConflicted, saveFailed, saveStarted, saveSucceeded, sameList, setEffort, undoIssue, undoTarget, undoWindowMs, type RoutingEdits,
} from "../client/routing-edit";
import { gradeLabel, gradePurpose, modeLabel, routeLabel, routingGrades, routingOverview, routingRow } from "../client/routing-overview";
import type { CatalogModel, ProviderEntry, RouteChoice } from "../shared/dispatch";
import type { AccountUsage } from "../shared/usage-routing";

const now = Date.parse("2026-11-24T08:00:00Z");
const mode = (id: string) => ({ id, label: id + " mode" });
function provider(id: string, extra: Partial<ProviderEntry> = {}): ProviderEntry {
  return { id, label: id, included: true, available: true, status: "ready", modelCount: 1, ...extra };
}
function model(providerId: string, id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { provider: providerId, model: id, label: id, isDefault: false, efforts: ["medium", "high"], coordinatorMode: mode("auto"), ...extra };
}
function usage(providerId: string, remainingPct: number, extra: Partial<AccountUsage> = {}): AccountUsage {
  return { providerId, label: providerId, plan: null, fetchedAt: new Date().toISOString(), status: "available", balances: [],
    windows: [{ id: "weekly", label: "Weekly", remainingPct, resetsAt: null, summary: true }], ...extra };
}
const opus: RouteChoice = { provider: "claude", model: "claude-opus-5-5", effort: "high" };
const sol: RouteChoice = { provider: "codex", model: "gpt-6.2-sol", effort: "high" };
const sonnet: RouteChoice = { provider: "claude", model: "claude-sonnet-5-5", effort: "high" };
const gemini: RouteChoice = { provider: "cursor", model: "gemini-4-neon-high", effort: null };
function directory(extra: Partial<Parameters<typeof routingOverview>[0]> = {}) {
  return {
    providers: [provider("claude", { label: "Claude Code" }), provider("codex"), provider("cursor", { label: "Cursor" })],
    catalog: [
      model("claude", "claude-sonnet-5-5"), model("claude", "claude-opus-5-5", { efforts: ["high", "xhigh"] }),
      model("codex", "gpt-6.2-sol", { coordinatorMode: mode("auto-review") }), model("codex", "gpt-6-luna", { efforts: [], coordinatorMode: mode("auto-review") }),
      model("cursor", "gemini-4-neon-high", { efforts: [], coordinatorMode: null }),
    ],
    routing: {}, usage: [] as AccountUsage[], usageRouting: false,
    ...extra,
  };
}
const ko = (korean: string) => korean, en = (_: string, english: string) => english;

test("the overview has one row per grade, each with what the grade is for, in both languages", () => {
  const rows = routingOverview(directory());
  expect(rows.map(row => row.grade)).toEqual(["A", "B", "C", "D", "M"]);
  for (const grade of routingGrades) {
    for (const t of [ko, en]) {
      expect(gradeLabel(grade, t).length).toBeGreaterThan(3);
      expect(gradePurpose(grade, t).length).toBeGreaterThan(8);
      expect(gradeLabel(grade, t) + gradePurpose(grade, t)).not.toContain("—");
    }
    expect(gradePurpose(grade, ko)).not.toBe(gradePurpose(grade, en));
  }
  expect(gradeLabel("M", ko)).toBe("코디네이터");
  expect(gradeLabel("A", en)).toBe("A · Highest");
});

test("an unsaved grade shows the board's own choice and the fallbacks behind it", () => {
  const row = routingRow(directory(), "C");
  expect(row.mode).toBe("recommended");
  expect(row.active).toEqual(opus);
  expect(row.candidates.map(candidate => candidate.route)).toEqual([opus, sol, sonnet, gemini]);
  expect(row.candidates.map(candidate => candidate.active)).toEqual([true, false, false, false]);
  expect(row.fallbacks).toBe(3);
  expect(row.notice).toBeNull();
  // Grades that do not accept every provider list only what they can use.
  expect(routingRow(directory(), "A").candidates.map(candidate => candidate.route.provider)).toEqual(["claude", "codex"]);
  expect(routingRow(directory(), "M").candidates.map(candidate => candidate.route.provider)).toEqual(["claude", "codex"]);
});

test("a saved list is shown as saved, with the first usable candidate in use", () => {
  const row = routingRow(directory({ routing: { C: [gemini, sol] } }), "C");
  expect(row.mode).toBe("custom");
  expect(row.active).toEqual(gemini);
  expect(row.fallbacks).toBe(1);
  expect(row.notice).toBeNull();
  expect(row.candidates.map(candidate => candidate.efforts)).toEqual([[null], [null, "medium", "high"]]);
});

test("when the first saved candidate cannot be used, the row says why and names the fallback in use", () => {
  const gone: RouteChoice = { provider: "codex", model: "retired-model", effort: null };
  const row = routingRow(directory({ routing: { C: [gone, sol] } }), "C");
  expect(row.active).toEqual(sol);
  expect(row.candidates[0]).toMatchObject({ active: false, efforts: [] });
  expect(row.candidates[0].issue).toContain("현재 목록에 없는 모델");
  expect(row.notice).toContain("1순위");
  expect(row.notice).toContain("retired-model");
  expect(row.fallbacks).toBe(0);
  expect(routingRow(directory({ routing: { C: [gone, sol] } }), "C", en).notice).toContain("fallback");
  // Nothing usable at all is explained as well.
  const empty = routingRow(directory({ routing: { C: [gone] } }), "C");
  expect(empty.active).toBeNull();
  expect(empty.notice).toContain("저장된 후보");
  expect(empty.fallbacks).toBe(0);
});

test("a grade decided by remaining usage says so, and a saved list is never overridden by usage", () => {
  const reports = [usage("claude", 5), usage("codex", 90)];
  const row = routingRow(directory({ usageRouting: true, usage: reports }), "C");
  expect(row.mode).toBe("usage");
  expect(row.active).toEqual(sol);
  // The candidate in use is listed first: that is the order a first change would save.
  expect(row.candidates.map(candidate => candidate.route)).toEqual([sol, opus, sonnet, gemini]);
  expect(row.candidates.map(candidate => candidate.active)).toEqual([true, false, false, false]);
  expect(row.fallbacks).toBe(3);
  expect(routingRow(directory({ usageRouting: false, usage: reports }), "C").mode).toBe("recommended");
  expect(routingRow(directory({ usageRouting: true, usage: [usage("claude", 90), usage("codex", 5)] }), "C").mode).toBe("recommended");
  const saved = routingRow(directory({ usageRouting: true, usage: reports, routing: { C: [opus, sol] } }), "C");
  expect(saved).toMatchObject({ mode: "custom", active: opus });
  for (const t of [ko, en]) expect(new Set((["recommended", "custom", "usage"] as const).map(m => modeLabel(m, t))).size).toBe(3);
});

test("a host with one provider, or none, still fills every row", () => {
  const single = directory({ providers: [provider("codex")], catalog: [model("codex", "gpt-6.2-sol", { coordinatorMode: mode("auto-review") })] });
  for (const row of routingOverview(single)) {
    expect(row.active).toEqual(sol);
    expect(row.fallbacks).toBe(0);
    expect(row.mode).toBe("recommended");
  }
  for (const row of routingOverview(directory({ providers: [], catalog: [] }))) {
    expect(row.active).toBeNull();
    expect(row.notice).toContain("실행기");
    expect(row.candidates).toEqual([]);
  }
  expect(routeLabel(null, en)).toContain("No available");
  expect(routeLabel(gemini, ko)).toBe("cursor / gemini-4-neon-high · 기본 강도");
});

test("the first change to an unsaved grade starts from the candidates the person was looking at", () => {
  expect(editableCandidates(directory(), "C")).toEqual([opus, sol, sonnet, gemini]);
  expect(editableCandidates(directory({ routing: { C: [gemini] } }), "C")).toEqual([gemini]);
});

test("a first change on a grade decided by usage keeps the model in use instead of returning to the board's first", () => {
  const byUsage = directory({ usageRouting: true, usage: [usage("claude", 3), usage("codex", 90)] });
  expect(boardCandidates(byUsage, "C")).toEqual([sol, opus, sonnet, gemini]);
  // Changing only the second candidate's effort saves a list that still starts with the model in use.
  const next = setEffort(editableCandidates(byUsage, "C"), 1, "xhigh");
  expect(next).toEqual([sol, { ...opus, effort: "xhigh" }, sonnet, gemini]);
  expect(routingRow({ ...byUsage, routing: { C: next } }, "C")).toMatchObject({ mode: "custom", active: sol });
  // Without usage in play the board's own order stands.
  expect(boardCandidates(directory({ usageRouting: false, usage: byUsage.usage }), "C")).toEqual([opus, sol, sonnet, gemini]);
  expect(boardCandidates(directory({ providers: [], catalog: [] }), "C")).toEqual([]);
  // The row remembers that the change left usage-based selection, so it can say so.
  const edits = saveSucceeded({}, "C", [], now, true);
  expect(edits.C).toMatchObject({ note: "saved", leftUsage: true });
  expect(saveSucceeded({}, "C", [], now).C?.leftUsage).toBeUndefined();
  expect(saveSucceeded({}, "C", null, now, true).C?.leftUsage).toBeUndefined();
});

test("undo is not offered when the earlier list holds a candidate the server would now refuse", () => {
  const gone: RouteChoice = { provider: "codex", model: "retired-model", effort: null };
  // The dead candidate was just removed: the saved list no longer keeps it, so it cannot come back.
  const cleaned = directory({ routing: { C: [sol] } });
  expect(undoIssue(cleaned, "C", [gone, sol])).toContain("retired-model");
  expect(undoIssue(cleaned, "C", [gone, sol], en)).toContain("Cannot undo");
  // Still saved, it is accepted as before. Usable candidates and the recommendation always can be restored.
  expect(undoIssue(directory({ routing: { C: [sol, gone] } }), "C", [gone, sol])).toBeNull();
  expect(undoIssue(cleaned, "C", [opus, sol])).toBeNull();
  expect(undoIssue(cleaned, "C", [])).toBeNull();
  const excluded = directory({ routing: { C: [sol] }, providers: [provider("claude", { included: false }), provider("codex"), provider("cursor")],
    catalog: directory().catalog.filter(m => m.provider !== "claude") });
  expect(undoIssue(excluded, "C", [opus, sol])).toContain("claude-opus-5-5");
});

test("each change of a row's state has words for a screen reader, in both languages", () => {
  const label = "C · 중간";
  expect(editAnnouncement(undefined, label)).toBeNull();
  expect(editAnnouncement({ saving: true }, label)).toBeNull();
  expect(editAnnouncement(saveSucceeded({}, "C", [opus], now).C, label)).toBe("C · 중간 저장됨.");
  expect(editAnnouncement(saveSucceeded({}, "C", null, now).C, label)).toContain("되돌렸습니다");
  expect(editAnnouncement(saveConflicted({}, "C", now).C, label)).toContain("다른 화면");
  expect(editAnnouncement(saveFailed({}, "C", [opus], "synthetic refusal").C, label)).toContain("synthetic refusal");
  expect(editAnnouncement(saveSucceeded({}, "C", [opus], now).C, "C · Medium", en)).toBe("C · Medium: saved.");
});

test("candidates are added first or last, moved up, removed and given another effort without duplicates", () => {
  const list = [opus, sol];
  expect(addCandidate(list, gemini, "first")).toEqual([gemini, opus, sol]);
  expect(addCandidate(list, gemini, "last")).toEqual([opus, sol, gemini]);
  // Adding a model that is already listed moves it and takes the new effort.
  expect(addCandidate(list, { ...sol, effort: "medium" }, "first")).toEqual([{ ...sol, effort: "medium" }, opus]);
  expect(moveUp(list, 1)).toEqual([sol, opus]);
  expect(moveUp(list, 0)).toEqual(list);
  expect(moveUp(list, 5)).toEqual(list);
  expect(moveFirst([opus, sol, gemini], 2)).toEqual([gemini, opus, sol]);
  expect(moveFirst(list, 0)).toEqual(list);
  expect(moveFirst(list, 9)).toEqual(list);
  expect(removeCandidate(list, 0)).toEqual([sol]);
  expect(removeCandidate([opus], 0)).toEqual([]);
  // Removing the last saved candidate returns the grade to the recommendation. The recommendation's only candidate stays.
  expect(canRemove([opus], true)).toBe(true);
  expect(canRemove([opus], false)).toBe(false);
  expect(canRemove([opus, sol], false)).toBe(true);
  expect(setEffort(list, 0, "xhigh")).toEqual([{ ...opus, effort: "xhigh" }, sol]);
  expect(setEffort(list, 1, null)[1].effort).toBeNull();
  expect(list).toEqual([opus, sol]);
  expect(sameList(list, [opus, sol])).toBe(true);
  expect(sameList(list, [sol, opus])).toBe(false);
});

test("a full list takes no new model but can still reorder one it holds", () => {
  const full = Array.from({ length: maxCandidates }, (_, index) => ({ provider: "codex", model: "fixture-" + index, effort: null }));
  expect(canAdd(full, gemini)).toBe(false);
  expect(canAdd(full, full[3])).toBe(true);
  expect(canAdd(full.slice(1), gemini)).toBe(true);
  expect(addCandidate(full, full[3], "first")).toHaveLength(maxCandidates);
});

test("a saved change can be undone once, for a few seconds", () => {
  let edits: RoutingEdits = saveStarted({}, "C");
  expect(edits.C).toEqual({ saving: true });
  expect(undoTarget(edits, "C", now)).toBeNull();
  edits = saveSucceeded(edits, "C", [opus], now);
  expect(edits.C?.note).toBe("saved");
  expect(undoTarget(edits, "C", now + undoWindowMs - 1)).toEqual([opus]);
  expect(undoTarget(edits, "C", now + undoWindowMs)).toBeNull();
  // Undoing saves the earlier list. That save offers no further undo.
  edits = saveSucceeded(saveStarted(edits, "C"), "C", null, now + 1000);
  expect(edits.C?.note).toBe("undone");
  expect(undoTarget(edits, "C", now + 1001)).toBeNull();
  // The list before a grade's first saved change is empty: undo goes back to the recommendation.
  expect(undoTarget(saveSucceeded({}, "D", [], now), "D", now)).toEqual([]);
});

test("notes expire on their own, and the next expiry tells the screen when to look again", () => {
  let edits = saveSucceeded({}, "C", [opus], now);
  edits = saveConflicted(edits, "A", now + 2000);
  expect(nextExpiry(edits)).toBe(now + undoWindowMs);
  expect(expireEdits(edits, now + undoWindowMs - 1)).toBe(edits);
  edits = expireEdits(edits, now + undoWindowMs);
  expect(edits.C).toBeUndefined();
  expect(edits.A?.note).toBe("conflict");
  expect(nextExpiry(edits)).toBe(now + 2000 + undoWindowMs);
  expect(expireEdits(edits, now + 2000 + undoWindowMs)).toEqual({});
  expect(nextExpiry({})).toBeNull();
});

test("a change that failed to save stays with its grade while other grades are opened and changed", () => {
  let edits = saveFailed(saveStarted({}, "C"), "C", [gemini, opus], "synthetic refusal");
  edits = saveSucceeded(saveStarted(edits, "A"), "A", [], now);
  edits = expireEdits(edits, now + undoWindowMs * 10);
  expect(edits.A).toBeUndefined();
  expect(edits.C?.failed).toEqual({ candidates: [gemini, opus], message: "synthetic refusal" });
  expect(nextExpiry(edits)).toBeNull();
  // Retrying replaces the failure, and dismissing drops it.
  expect(saveStarted(edits, "C").C).toEqual({ saving: true });
  expect(dismissFailure(edits, "C")).toEqual({});
});

test("a refused save is a conflict only when the stored routing moved on", () => {
  expect(lostToAnotherChange(3, 4)).toBe(true);
  expect(lostToAnotherChange(3, 3)).toBe(false);
  // The latest revision could not be read: treat it as a failure the person can retry.
  expect(lostToAnotherChange(3, null)).toBe(false);
});

const names = (groups: { provider: string; rows: { model: string }[] }[]) => groups.map(group => [group.provider, ...group.rows.map(row => row.model)]);

test("models are grouped under their provider, with the recommendation first", () => {
  const view = modelChoices(directory(), "C", "");
  expect(view.titled).toBe(true);
  expect(names(view.groups)).toEqual([
    ["claude", "claude-opus-5-5", "claude-sonnet-5-5"], ["codex", "gpt-6.2-sol", "gpt-6-luna"], ["cursor", "gemini-4-neon-high"],
  ]);
  expect(view.groups[0]).toMatchObject({ label: "Claude Code" });
  expect(view.groups[0].rows[0]).toMatchObject({ recommended: true, current: true, disabled: null });
  expect(view.groups.flatMap(group => group.rows).filter(row => row.recommended)).toHaveLength(1);
  // The provider holding the model in use comes first.
  const saved = modelChoices(directory({ routing: { C: [gemini] } }), "C", "");
  expect(saved.groups.map(group => group.provider)).toEqual(["claude", "cursor", "codex"]);
  expect(saved.groups[1].rows[0]).toMatchObject({ current: true, recommended: false });
});

test("a host with one provider shows its models without a group title", () => {
  const single = directory({ providers: [provider("codex")], catalog: [model("codex", "gpt-6.2-sol"), model("codex", "gpt-6-luna")] });
  const view = modelChoices(single, "D", "");
  expect(view.titled).toBe(false);
  // The grade's recommended model leads, then the catalog order.
  expect(names(view.groups)).toEqual([["codex", "gpt-6-luna", "gpt-6.2-sol"]]);
  expect(names(modelChoices(single, "C", "").groups)).toEqual([["codex", "gpt-6.2-sol", "gpt-6-luna"]]);
});

test("models a grade cannot use, and models already listed, are dimmed with the reason", () => {
  const high = modelChoices(directory(), "A", "");
  expect(high.groups.at(-1)!.rows[0].disabled).toContain("다른 실행기");
  const coordinator = modelChoices(directory(), "M", "");
  expect(coordinator.groups.at(-1)!.rows[0].disabled).toContain("권한 모드");
  // Saved lists made by an earlier screen may hold one model at two efforts. Both rows are told apart.
  const twice = routingRow(directory({ routing: { C: [opus, { ...opus, effort: "xhigh" }] } }), "C");
  expect(new Set(twice.candidates.map(candidate => JSON.stringify(candidate.route))).size).toBe(2);
  expect(modelChoices(directory(), "M", "", en).groups.at(-1)!.rows[0].disabled).toContain("coordinator mode");
  const yielded = modelChoices(directory({ catalog: [model("claude", "claude-opus-5-5"), model("opencode", "open-1", { coordinatorMode: mode("build") })],
    providers: [provider("claude"), provider("opencode")] }), "M", "");
  expect(yielded.groups.at(-1)!.rows[0].disabled).toContain("다른 실행기");
  const taken = modelChoices(directory(), "C", "", ko, [sol]);
  expect(taken.groups.find(group => group.provider === "codex")!.rows.map(row => [row.model, row.disabled])).toEqual([["gpt-6-luna", null], ["gpt-6.2-sol", "이미 후보에 있음"]]);
});

test("providers with no usable models explain why, and search covers names and labels", () => {
  const view = modelChoices(directory({
    providers: [provider("claude"), provider("codex", { included: false }), provider("grok", { available: false, status: "unavailable" }),
      provider("broken", { status: "error" }), provider("empty", { status: "empty", modelCount: 0 })],
    catalog: [model("claude", "claude-opus-5-5")],
  }), "C", "");
  expect(view.unavailable.map(item => [item.provider, item.reason])).toEqual([
    ["codex", "자동 배정에서 꺼짐"], ["grok", "연결을 확인할 실행기"], ["broken", "모델 조회 실패"], ["empty", "선택할 모델 없음"]]);
  expect(names(modelChoices(directory(), "C", "luna").groups)).toEqual([["codex", "gpt-6-luna"]]);
  expect(names(modelChoices(directory(), "C", " CLAUDE code ").groups)).toEqual([["claude", "claude-opus-5-5", "claude-sonnet-5-5"]]);
  const none = modelChoices(directory(), "C", "no such model");
  expect(none).toMatchObject({ groups: [], count: 0 });
  expect(none.hint).toContain("검색");
  expect(modelChoices(directory(), "C", "").hint).toBeNull();
  expect(modelChoices(directory({ providers: [], catalog: [] }), "C", "").hint).toContain("실행기");
});

test("only the efforts a model supports are offered, and a picked model starts with a sensible one", () => {
  const data = directory();
  expect(routeEfforts(data, opus)).toEqual([null, "high", "xhigh"]);
  expect(routeEfforts(data, gemini)).toEqual([null]);
  expect(routeEfforts(data, { provider: "codex", model: "retired-model" })).toEqual([]);
  expect(pickedRoute(data, "B", "claude", "claude-opus-5-5")).toEqual({ ...opus, effort: "xhigh" });
  // The recommended effort for this grade is one the model does not offer here, so the provider's default applies.
  expect(pickedRoute(data, "A", "claude", "claude-opus-5-5")).toEqual({ ...opus, effort: null });
  expect(pickedRoute(data, "C", "claude", "claude-sonnet-5-5")).toEqual(sonnet);
  expect(pickedRoute(data, "M", "claude", "claude-sonnet-5-5")?.effort).toBeNull();
  expect(pickedRoute(data, "C", "cursor", "gemini-4-neon-high")).toEqual(gemini);
  expect(pickedRoute(data, "C", "codex", "gpt-6-luna")?.effort).toBeNull();
  const saved = directory({ routing: { C: [{ ...sonnet, effort: "medium" }], D: [{ ...sonnet, effort: "retired" }] } });
  expect(pickedRoute(saved, "C", "claude", "claude-sonnet-5-5")?.effort).toBe("medium");
  expect(pickedRoute(saved, "D", "claude", "claude-sonnet-5-5")?.effort).toBe("medium");
  expect(pickedRoute(data, "A", "cursor", "gemini-4-neon-high")).toBeNull();
  expect(pickedRoute(data, "C", "claude", "not-in-catalog")).toBeNull();
});

test("a provider's remaining usage is shown only when one fresh account report can answer", () => {
  expect(providerHeadroom([usage("claude", 40)], "claude")).toBe(40);
  const two = usage("claude", 80, { windows: [
    { id: "session", label: "Session", remainingPct: 25, resetsAt: null, summary: false },
    { id: "weekly", label: "Weekly", remainingPct: 80, resetsAt: null, summary: true }] });
  expect(providerHeadroom([two], "claude")).toBe(25);
  // Two accounts under one provider, a stale or failed report, an expired window, or no report at all.
  expect(providerHeadroom([usage("claude", 40), usage("claude", 90)], "claude")).toBeNull();
  expect(providerHeadroom([usage("claude", 40, { fetchedAt: "2026-11-01T00:00:00Z" })], "claude")).toBeNull();
  expect(providerHeadroom([usage("claude", 40, { status: "error" })], "claude")).toBeNull();
  expect(providerHeadroom([usage("claude", 40, { windows: [{ id: "weekly", label: "Weekly", remainingPct: 40, resetsAt: "2020-01-01T00:00:00Z", summary: true }] })], "claude")).toBeNull();
  expect(providerHeadroom([usage("codex", 40)], "claude")).toBeNull();
  expect(providerHeadroom(undefined, "claude")).toBeNull();
  expect(modelChoices(directory({ usage: [usage("codex", 61)] }), "C", "").groups.map(group => group.headroom)).toEqual([null, 61, null]);
});
