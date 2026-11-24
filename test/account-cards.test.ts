import { expect, test } from "bun:test";
import { accountCards } from "../client/account-cards";
import { routingOverview } from "../client/routing-overview";
import type { CatalogModel, ProviderEntry } from "../shared/dispatch";
import type { AccountUsage } from "../shared/usage-routing";

function provider(id: string, extra: Partial<ProviderEntry> = {}): ProviderEntry {
  return { id, label: id, included: true, available: true, status: "ready", modelCount: 1, ...extra };
}
function report(providerId: string, label: string, remainingPct: number | null = 50): AccountUsage {
  return { providerId, label, plan: null, fetchedAt: new Date().toISOString(), status: "available", balances: [],
    windows: [{ id: "weekly", label: "Weekly", remainingPct, resetsAt: null, summary: true }] };
}
function model(providerId: string, id: string): CatalogModel {
  return { provider: providerId, model: id, label: id, isDefault: true, efforts: ["high"], coordinatorMode: { id: "auto", label: "Auto" } };
}

test("every account card is paired with the provider it runs on, and carries that provider's switch", () => {
  const { cards, allOff } = accountCards([provider("alpha"), provider("beta", { included: false })], [report("alpha", "Alpha account"), report("beta", "Beta account")]);
  expect(cards.map(card => [card.label, card.provider?.id, card.provider?.included, card.provider?.shared])).toEqual([
    ["Alpha account", "alpha", true, false], ["Beta account", "beta", false, false]]);
  expect(allOff).toBe(false);
});

test("a provider without a usage report still gets a card, so it can be turned off", () => {
  const { cards } = accountCards([provider("alpha"), provider("quiet", { label: "Quiet CLI" })], [report("alpha", "Alpha account")]);
  expect(cards.map(card => [card.label, !!card.report, card.provider?.id])).toEqual([["Alpha account", true, "alpha"], ["Quiet CLI", false, "quiet"]]);
});

test("accounts under one provider are marked as changing together", () => {
  const { cards } = accountCards([provider("alpha")], [report("alpha", "Work login"), report("alpha", "Personal login")]);
  expect(cards.map(card => card.provider)).toEqual([
    { id: "alpha", label: "alpha", included: true, shared: true }, { id: "alpha", label: "alpha", included: true, shared: true }]);
});

test("a display-only reading gets a switch only when its provider runs on this host", () => {
  const { cards } = accountCards([provider("alpha")], [], [report("alpha", "Alpha, host reading"), report("elsewhere", "Not on this host")]);
  expect(cards.map(card => [card.label, card.supplemental, card.provider?.id])).toEqual([
    ["Alpha, host reading", true, "alpha"], ["Not on this host", true, undefined]]);
  // A host reading replaces an empty Paseo report for the same provider instead of doubling it.
  const replaced = accountCards([provider("alpha")], [report("alpha", "Empty report", null)], [report("alpha", "Host reading")]);
  expect(replaced.cards.map(card => card.label)).toEqual(["Host reading"]);
  expect(replaced.cards[0].provider?.shared).toBe(false);
});

test("with every account turned off the board says so, and an empty host is not reported as turned off", () => {
  // Providers that can also run a coordinator, so the coordinator row is explained by the switch as well.
  const off = [provider("claude", { included: false }), provider("codex", { included: false })];
  expect(accountCards(off, []).allOff).toBe(true);
  expect(accountCards([], []).allOff).toBe(false);
  expect(accountCards([], []).cards).toEqual([]);
  // The server leaves a turned-off provider's models out of the catalog, so no grade has a model and each row says why.
  const rows = routingOverview({ providers: off, catalog: [], routing: {}, usage: [], usageRouting: true });
  for (const row of rows) {
    expect(row.active).toBeNull();
    expect(row.notice).toContain("자동 배정에서 꺼져");
  }
  const english = routingOverview({ providers: off, catalog: [], routing: {}, usage: [], usageRouting: true }, (_, en) => en);
  expect(english[0].notice).toContain("Accounts and usage");
});

test("a saved candidate on a turned-off account stays in its place and says it is off", () => {
  const data = {
    providers: [provider("alpha", { included: false }), provider("beta")], catalog: [model("beta", "beta-1")],
    routing: { C: [{ provider: "alpha", model: "alpha-1", effort: null }, { provider: "beta", model: "beta-1", effort: "high" }] }, usage: [], usageRouting: true,
  };
  const row = routingOverview(data).find(entry => entry.grade === "C")!;
  expect(row.active).toEqual({ provider: "beta", model: "beta-1", effort: "high" });
  expect(row.candidates[0].issue).toBe("자동 배정에서 꺼짐");
  expect(row.notice).toContain("자동 배정에서 꺼짐");
});
