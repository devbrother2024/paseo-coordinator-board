import { expect, test } from "bun:test";
import { offeredPick, replacementChoices, replacementEfforts, replacementMode, replacementRoute, replacementSelection } from "../client/replace-options";
import type { CatalogModel, ProviderEntry, RouteChoice } from "../shared/dispatch";

const mode = (id: string) => ({ id, label: id + " mode" });
function provider(id: string, extra: Partial<ProviderEntry> = {}): ProviderEntry {
  return { id, label: id, included: true, available: true, status: "ready", modelCount: 1, ...extra };
}
function model(providerId: string, id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { provider: providerId, model: id, label: id, isDefault: false, efforts: ["medium", "high"], coordinatorMode: mode("auto"), ...extra };
}
function directory(extra: Partial<Parameters<typeof replacementChoices>[0]> = {}) {
  return {
    providers: [provider("claude", { label: "Claude Code" }), provider("codex"), provider("cursor", { label: "Cursor" })],
    catalog: [
      model("claude", "claude-sonnet-5-5"), model("claude", "claude-opus-5-5", { efforts: ["high", "xhigh"] }),
      model("codex", "gpt-6.2-sol", { coordinatorMode: mode("auto-review") }), model("codex", "gpt-6-luna", { efforts: [], coordinatorMode: mode("auto-review") }),
      model("cursor", "gemini-4-neon-high", { efforts: [], coordinatorMode: null }),
    ],
    routing: {}, usage: [], usageRouting: false,
    ...extra,
  };
}
const names = (rows: { provider: string; model: string }[]) => rows.map(row => row.provider + "/" + row.model);

test("the list shows one provider and model per row with the recommendation first", () => {
  const view = replacementChoices(directory(), "");
  expect(view.rows[0]).toMatchObject({ provider: "claude", model: "claude-opus-5-5", label: "claude / claude-opus-5-5", recommended: true, current: true, disabled: null });
  expect(names(view.rows.filter(row => !row.disabled))).toEqual([
    "claude/claude-opus-5-5", "claude/claude-sonnet-5-5", "codex/gpt-6.2-sol", "codex/gpt-6-luna",
  ]);
  expect(view.rows.filter(row => row.recommended)).toHaveLength(1);
});

test("a saved default is marked and follows the recommendation", () => {
  const saved: RouteChoice = { provider: "codex", model: "gpt-6-luna", effort: null };
  const view = replacementChoices(directory({ routing: { M: [saved] } }), "");
  expect(names(view.rows).slice(0, 2)).toEqual(["claude/claude-opus-5-5", "codex/gpt-6-luna"]);
  expect(view.rows[0]).toMatchObject({ recommended: true, current: false });
  expect(view.rows[1]).toMatchObject({ recommended: false, current: true });
});

test("models that cannot run a coordinator are listed last, dimmed with the reason", () => {
  const view = replacementChoices(directory(), "");
  const cursor = view.rows.at(-1)!;
  expect(cursor).toMatchObject({ provider: "cursor", model: "gemini-4-neon-high" });
  expect(cursor.disabled).toContain("권한 모드");
  // A provider with a coordinator mode still yields to Claude Code and Codex while they are connected.
  const yielded = replacementChoices(directory({ catalog: [model("claude", "claude-opus-5-5"), model("opencode", "open-1", { coordinatorMode: mode("build") })],
    providers: [provider("claude"), provider("opencode")] }), "");
  expect(yielded.rows.at(-1)!.disabled).toContain("Claude Code");
  expect(replacementChoices(directory(), "", (_, english) => english).rows.at(-1)!.disabled).toContain("coordinator mode");
});

test("providers with no usable models explain why instead of disappearing", () => {
  const view = replacementChoices(directory({
    providers: [provider("claude"), provider("codex", { included: false }), provider("grok", { available: false, status: "unavailable" }),
      provider("broken", { status: "error" }), provider("empty", { status: "empty", modelCount: 0 })],
    catalog: [model("claude", "claude-opus-5-5")],
  }), "");
  expect(view.unavailable.map(item => item.provider)).toEqual(["codex", "grok", "broken", "empty"]);
  expect(view.unavailable[0].reason).toContain("제외");
  expect(view.unavailable[1].reason).toContain("연결");
  expect(view.unavailable[2].reason).toContain("실패");
  expect(view.unavailable[3].reason).toContain("없음");
});

test("search matches provider names, provider labels and model names, and says when nothing matches", () => {
  expect(names(replacementChoices(directory(), "luna").rows)).toEqual(["codex/gpt-6-luna"]);
  expect(names(replacementChoices(directory(), "claude code").rows)).toEqual(["claude/claude-opus-5-5", "claude/claude-sonnet-5-5"]);
  expect(names(replacementChoices(directory(), "  CURSOR ").rows)).toEqual(["cursor/gemini-4-neon-high"]);
  const none = replacementChoices(directory(), "no such model");
  expect(none.rows).toEqual([]);
  expect(none.hint).toContain("검색");
  expect(replacementChoices(directory(), "").hint).toBeNull();
  expect(replacementChoices(directory({ catalog: [], providers: [] }), "").hint).toContain("실행기");
});

test("picking a model preselects the reasoning effort without another step", () => {
  const data = directory();
  expect(replacementRoute(data, "claude", "claude-opus-5-5")).toEqual({ provider: "claude", model: "claude-opus-5-5", effort: "high" });
  // Outside the recommendation table the provider's own default applies.
  expect(replacementRoute(data, "claude", "claude-sonnet-5-5")).toEqual({ provider: "claude", model: "claude-sonnet-5-5", effort: null });
  expect(replacementRoute(data, "codex", "gpt-6-luna")).toEqual({ provider: "codex", model: "gpt-6-luna", effort: null });
  const saved = directory({ routing: { M: [{ provider: "claude", model: "claude-sonnet-5-5", effort: "medium" }] } });
  expect(replacementRoute(saved, "claude", "claude-sonnet-5-5")?.effort).toBe("medium");
  const stale = directory({ routing: { M: [{ provider: "claude", model: "claude-sonnet-5-5", effort: "retired" }] } });
  expect(replacementRoute(stale, "claude", "claude-sonnet-5-5")?.effort).toBeNull();
  expect(replacementRoute(data, "cursor", "gemini-4-neon-high")).toBeNull();
  expect(replacementRoute(data, "claude", "not-in-catalog")).toBeNull();
});

test("the effort choices and the permission mode come from the picked model's provider", () => {
  const data = directory();
  expect(replacementEfforts(data, { provider: "claude", model: "claude-opus-5-5", effort: "high" })).toEqual([null, "high", "xhigh"]);
  expect(replacementEfforts(data, { provider: "codex", model: "gpt-6-luna", effort: null })).toEqual([null]);
  expect(replacementMode(data, "codex")).toEqual(mode("auto-review"));
  expect(replacementMode(data, "cursor")).toBeNull();
  expect(replacementMode(data, "unknown")).toBeNull();
});

test("what is sent says whether the person picked the model and whether to remember it", () => {
  const picked: RouteChoice = { provider: "codex", model: "gpt-6.2-sol", effort: "high" };
  const usual: RouteChoice = { provider: "claude", model: "claude-opus-5-5", effort: "high" };
  expect(replacementSelection(null, usual, true)).toEqual({ route: usual });
  expect(replacementSelection(picked, usual, true)).toEqual({ route: picked, selection: "default" });
  expect(replacementSelection(picked, usual, false)).toEqual({ route: picked, selection: "once" });
  // With no usable default, a picked model is still enough to replace.
  expect(replacementSelection(picked, null, false)).toEqual({ route: picked, selection: "once" });
  expect(replacementSelection(null, null, true)).toBeNull();
});

test("a pick survives a catalog refresh only while the model is still offered", () => {
  const picked: RouteChoice = { provider: "claude", model: "claude-opus-5-5", effort: "xhigh" };
  expect(offeredPick(directory(), picked)).toEqual(picked);
  expect(offeredPick(directory(), { ...picked, effort: "retired" })).toEqual({ ...picked, effort: null });
  expect(offeredPick(directory({ catalog: [model("codex", "gpt-6.2-sol")] }), picked)).toBeNull();
  expect(offeredPick(null, picked)).toBeNull();
  expect(offeredPick(directory(), null)).toBeNull();
});

test("a host with a single provider lists that provider's models without assuming any other", () => {
  const only = directory({ providers: [provider("opencode")], catalog: [model("opencode", "open-1", { coordinatorMode: mode("build"), efforts: [] }), model("opencode", "open-2", { coordinatorMode: mode("build"), efforts: [] })] });
  const view = replacementChoices(only, "");
  expect(view.rows.map(row => [row.model, row.disabled, row.recommended])).toEqual([["open-1", null, true], ["open-2", null, false]]);
  expect(replacementRoute(only, "opencode", "open-2")).toEqual({ provider: "opencode", model: "open-2", effort: null });
  const none = directory({ providers: [provider("custom")], catalog: [model("custom", "c-1", { coordinatorMode: null })] });
  expect(replacementChoices(none, "").rows[0].disabled).toContain("권한 모드");
});
