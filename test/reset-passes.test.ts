import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { mergeHostUsage, readDisplayUsage } from "../server/display-usage";
import { nearestExpiry, resetPassClockTimes, resetPassFreshness, resetPassRows } from "../client/reset-passes";
import { countdownClock } from "../client/countdown-clock";
import type { AccountUsage, ResetPass } from "../shared/usage-routing";

const now = Date.parse("2026-11-25T07:00:00Z");
function report(providerId: string, extra: Partial<AccountUsage> = {}): AccountUsage {
  return { providerId, label: providerId, plan: null, fetchedAt: "2026-11-25T06:55:00Z", status: "available", balances: [],
    windows: [{ id: "weekly", label: "Weekly", remainingPct: 40, resetsAt: null, summary: true }], ...extra };
}
const weekly: ResetPass = { id: "weekly", label: "Weekly reset", left: 2, expiresAt: ["2026-12-11T07:00:00Z"], note: "Restores the weekly limit" };

async function withFile<T>(rows: unknown[], run: (folder: string) => Promise<T>) {
  const folder = mkdtempSync(join(tmpdir(), "board-passes-"));
  try {
    writeFileSync(join(folder, "account-usage.json"), JSON.stringify({ version: 1, reports: rows }));
    return await run(folder);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test("a malformed reset pass is dropped and the rest of the report is kept", async () => {
  const passes = [
    weekly,
    { id: "model", label: "Model reset", left: 0, expiresAt: [] },
    { id: "", label: "No id", left: 1, expiresAt: [] },
    { id: "long", label: "x".repeat(65), left: 1, expiresAt: [] },
    { id: "negative", label: "Negative", left: -1, expiresAt: [] },
    { id: "fraction", label: "Fraction", left: 1.5, expiresAt: [] },
    { id: "date", label: "Bad date", left: 1, expiresAt: ["next week"] },
    { id: "dates", label: "Too many", left: 1, expiresAt: Array(17).fill("2026-12-11T07:00:00Z") },
    { id: "note", label: "Long note", left: 1, expiresAt: [], note: "x".repeat(201) },
    { id: "blank", label: "Blank note", left: 1, expiresAt: [], note: "" },
    { id: "spaces", label: "Spaces note", left: 3, expiresAt: [], note: "   " },
    "not a pass",
  ];
  const host = report("studio", { resetPasses: passes as ResetPass[] });
  const { display } = await withFile([host], folder => readDisplayUsage(folder, [{ id: "studio" }], []));
  expect(display).toHaveLength(1);
  expect(display[0].windows).toEqual(host.windows);
  expect(display[0].resetPasses).toEqual([weekly, { id: "model", label: "Model reset", left: 0, expiresAt: [] },
    { id: "blank", label: "Blank note", left: 1, expiresAt: [] }, { id: "spaces", label: "Spaces note", left: 3, expiresAt: [] }]);
  // A blank note is left out rather than costing the pass.
  expect(display[0].resetPasses?.slice(2).map(pass => "note" in pass && pass.note !== undefined)).toEqual([false, false]);
  // Passes that are not a list, or a list with nothing valid, leave the report without passes rather than dropping it.
  for (const resetPasses of ["two", [{ id: "x" }]]) {
    const { display: kept } = await withFile([{ ...host, resetPasses }], folder => readDisplayUsage(folder, [{ id: "studio" }], []));
    expect(kept).toHaveLength(1);
    expect(kept[0].resetPasses).toBeUndefined();
  }
});

test("passes reach a provider Paseo measures without the file replacing its measurements", async () => {
  const native = report("runner", { label: "Runner account" });
  const file = report("runner", { label: "Runner account", fetchedAt: "2026-11-20T03:00:00Z", windows: [{ id: "weekly", label: "Weekly", remainingPct: 99, resetsAt: null, summary: true }],
    balances: [{ id: "credits", label: "Credits", remaining: 5, limit: null, unit: "credits", resetsAt: null }], resetPasses: [weekly] });
  const { display, usage } = await withFile([file], folder => readDisplayUsage(folder, [{ id: "runner" }], [native]));
  expect(display).toEqual([]);
  // The passes carry the host report's own time, not Paseo's newer one.
  expect(usage).toEqual([{ ...native, resetPasses: [weekly], resetPassesFetchedAt: "2026-11-20T03:00:00Z" }]);
});

test("passes are attached only when the account they belong to is clear", () => {
  const passes = (label: string, left: number) => report("runner", { label, resetPasses: [{ ...weekly, left }] });
  const installed = [{ id: "runner" }, { id: "other" }];
  // One account on each side pairs even when the labels differ.
  expect(mergeHostUsage([passes("Renamed", 3)], installed, [report("runner", { label: "Work" })]).usage[0].resetPasses?.[0].left).toBe(3);
  // Several accounts under one provider pair by label, and an unmatched account gets nothing.
  const accounts = [report("runner", { label: "Work" }), report("runner", { label: "Personal" }), report("runner", { label: "Spare" })];
  const merged = mergeHostUsage([passes("Work", 1), passes("Personal", 4)], installed, accounts).usage;
  expect(merged.map(entry => entry.resetPasses?.[0].left)).toEqual([1, 4, undefined]);
  // Two file reports for a single account are ambiguous unless one shares its label.
  expect(mergeHostUsage([passes("A", 1), passes("B", 2)], installed, [report("runner", { label: "Work" })]).usage[0].resetPasses).toBeUndefined();
  // Providers that do not run on this host, and file reports without passes, add nothing.
  expect(mergeHostUsage([passes("Work", 1)], [{ id: "other" }], [report("runner", { label: "Work" })]).usage[0].resetPasses).toBeUndefined();
  expect(mergeHostUsage([report("runner")], installed, [report("runner")]).usage[0]).toEqual(report("runner"));
});

test("the card shows the count and the nearest expiry still ahead", () => {
  const date = (stamp: string) => stamp.slice(0, 10);
  const ko = (k: string) => k, en = (_: string, e: string) => e;
  const passes: ResetPass[] = [
    { ...weekly, expiresAt: ["2026-11-20T07:00:00Z", "2026-12-20T07:00:00Z", "2026-12-11T09:00:00Z"] },
    { id: "model", label: "Model reset", left: 0, expiresAt: [] },
    { id: "stale", label: "Stale", left: 1, expiresAt: ["2026-11-01T00:00:00Z"] },
    { id: "soon", label: "Soon", left: 1, expiresAt: ["2026-11-25T07:00:30Z"] },
  ];
  expect(resetPassRows(passes, now, "ko", ko, date)).toEqual([
    { key: "weekly:0", name: "Weekly reset", value: "2장 남음", empty: false, expiry: "가장 가까운 만료 2026-12-11 · 16일 2시간 남음", note: "Restores the weekly limit" },
    { key: "model:1", name: "Model reset", value: "없음", empty: true, expiry: null, note: undefined },
    { key: "stale:2", name: "Stale", value: "1장 남음", empty: false, expiry: null, note: undefined },
    { key: "soon:3", name: "Soon", value: "1장 남음", empty: false, expiry: "가장 가까운 만료 2026-11-25 · 곧 만료", note: undefined },
  ]);
  expect(resetPassRows(passes, now, "en", en, date).map(row => [row.value, row.expiry])).toEqual([
    ["2 left", "Next expiry 2026-12-11 · 16d 2h left"], ["None", null], ["1 left", null], ["1 left", "Next expiry 2026-11-25 · expires soon"],
  ]);
  expect(nearestExpiry(passes[0], now)).toBe("2026-12-11T09:00:00Z");
  expect(nearestExpiry(passes[2], now)).toBeNull();
  expect(resetPassRows(undefined, now, "ko", ko, date)).toEqual([]);
});

test("passes on a measured account show their own report time and turn old with it", () => {
  const measured = report("runner", { fetchedAt: "2026-11-25T06:59:00Z", resetPasses: [weekly] });
  expect(resetPassFreshness({ ...measured, resetPassesFetchedAt: "2026-11-25T06:50:00Z" }, now))
    .toEqual({ fetchedAt: "2026-11-25T06:50:00Z", separate: true, stale: false });
  // Older than the card's own "last known reading" limit, even though Paseo's reading is a minute old.
  expect(resetPassFreshness({ ...measured, resetPassesFetchedAt: "2026-11-20T03:00:00Z" }, now))
    .toEqual({ fetchedAt: "2026-11-20T03:00:00Z", separate: true, stale: true });
  // Passes on a host report card share the card's time and its footer.
  expect(resetPassFreshness(measured, now)).toEqual({ fetchedAt: "2026-11-25T06:59:00Z", separate: false, stale: false });
  expect(resetPassFreshness(report("runner", { fetchedAt: "2026-11-25T06:40:00Z" }), now).stale).toBe(true);
});

test("the settings clock wakes when passes turn old even with nothing counting down", () => {
  const measured = report("runner", { resetPasses: [{ ...weekly, expiresAt: [] }, { id: "model", label: "Model reset", left: 0, expiresAt: ["2026-12-01T00:00:00Z"] }],
    resetPassesFetchedAt: "2026-11-25T06:50:00Z", windows: [{ id: "weekly", label: "Weekly", remainingPct: 40, resetsAt: null, summary: true }] });
  // No reset or expiry ahead, so only the moment the passes turn old keeps the clock going. A pass with none left adds no expiry.
  const times = resetPassClockTimes(measured, now);
  expect(times).toEqual(["2026-11-25T07:05:00.001Z"]);
  let time = now, timer: { due: number; run: () => void } | null = null;
  const ticks: number[] = [];
  const clock = countdownClock({ now: () => time, appState: () => "active", onAppState: () => () => {},
    setTimer: (run, wait) => (timer = { due: time + wait, run }), clearTimer: () => { timer = null; } }, tick => ticks.push(tick));
  clock.setResets(times);
  expect(resetPassFreshness(measured, ticks.at(-1)!).stale).toBe(false);
  // Follow the timers past the boundary: the last tick lands on it and the passes read as old.
  while (timer && timer.due <= Date.parse(times[0])) { const due: { due: number; run: () => void } = timer; timer = null; time = due.due; due.run(); }
  expect(ticks.at(-1)).toBe(Date.parse(times[0]));
  expect(resetPassFreshness(measured, ticks.at(-1)!).stale).toBe(true);
  clock.stop();
  // Expiries ahead are watched too, and a card without passes asks for nothing.
  expect(resetPassClockTimes(report("runner", { fetchedAt: "2026-11-25T06:59:00Z", resetPasses: [weekly] }), now))
    .toEqual(["2026-12-11T07:00:00Z", "2026-11-25T07:14:00.001Z"]);
  expect(resetPassClockTimes(report("runner"), now)).toEqual([]);
  expect(resetPassClockTimes(undefined, now)).toEqual([]);
});
