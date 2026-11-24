import { expect, test } from "bun:test";
import { offeredPick, replacementMode, replacementSelection } from "../client/replace-options";
import type { CatalogModel, ProviderEntry, RouteChoice } from "../shared/dispatch";

const mode = (id: string) => ({ id, label: id + " mode" });
function provider(id: string, extra: Partial<ProviderEntry> = {}): ProviderEntry {
  return { id, label: id, included: true, available: true, status: "ready", modelCount: 1, ...extra };
}
function model(providerId: string, id: string, extra: Partial<CatalogModel> = {}): CatalogModel {
  return { provider: providerId, model: id, label: id, isDefault: false, efforts: ["medium", "high"], coordinatorMode: mode("auto"), ...extra };
}
function directory(extra: Record<string, unknown> = {}) {
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
test("the permission mode comes from the picked model's provider", () => {
  const data = directory();
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
