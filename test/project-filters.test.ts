import { expect, test } from "bun:test";
import { groupProjects, visibleProjectFilters, selectedProjectIds, toggleProjectFilter } from "../client/project-filters";

const project = (id: string, title = id, path = "/work/" + id, rootKey?: string) => ({
  id, title, path, rootKey, selected: true,
});

test("projects on the same folder share one filter and a combined selection", () => {
  const groups = groupProjects([
    project("one", "Studio", "/work/Studio", "root-1"),
    project("alias", "Studio", "/work/studio", "root-1"),
    project("other", "Studio", "/backup/Studio", "root-2"),
    project("solo", "Library"),
    { ...project("deleted"), missing: true },
    { ...project("unmanaged"), selected: false },
  ]);
  expect(groups.map(({ ids, label }) => [ids, label])).toEqual([
    [["one", "alias"], "Studio · work/Studio"],
    [["other"], "Studio · backup/Studio"],
    [["solo"], "Library"],
  ]);
  expect([...selectedProjectIds(groups, ["alias", "deleted"])]).toEqual(["one", "alias"]);
  expect(toggleProjectFilter(groups, ["alias", "other"], groups[0])).toEqual(["other"]);
  expect(toggleProjectFilter(groups, ["other"], groups[0])).toEqual(["other", "one", "alias"]);
});

test("unverified or distinct roots remain separate and unique project names stay short", () => {
  const groups = groupProjects([
    project("one", "Studio", "/work/Studio"),
    project("alias", "Alias", "/work/studio"),
    project("case", "Case", "/work/STUDIO", "root-2"),
  ]);
  expect(groups.map(group => group.label)).toEqual(["Studio", "Alias", "Case"]);
  expect(groups.map(group => group.ids)).toEqual([["one"], ["alias"], ["case"]]);
});

const filters = [
  { ids: ["idle"], label: "Idle", count: 0 },
  { ids: ["active", "alias"], label: "Active", count: 2 },
  { ids: ["largest"], label: "Largest", count: 9 },
  { ids: ["second"], label: "Second", count: 3 },
];
const metrics = { allWidth: 64, toggleWidth: 92, gap: 6, chipWidth: () => 74 };
const layout = (rowWidth: number, selected: ReadonlySet<string | null> = new Set()) =>
  visibleProjectFilters(filters, selected, { ...metrics, rowWidth });

test("collapsed fitting reserves the toggle width and both gaps", () => {
  // All + two chips + toggle takes 64 + 2 * (74 + 6) + 92 + 6 = 322 pixels.
  const justFits = layout(322);
  expect(justFits.collapsed).toEqual([filters[2], filters[3]]);
  expect(justFits.hiddenCount).toBe(2);
  expect(justFits.showToggle).toBe(true);
  expect(layout(321).collapsed).toEqual([filters[2]]);
  expect(justFits.ordered).toEqual([filters[2], filters[3], filters[1], filters[0]]);
});

test("all eligible chips fit without a toggle at the exact full-row width", () => {
  const selected = new Set(["idle"]);
  expect(layout(384, selected)).toEqual({
    ordered: [filters[2], filters[3], filters[1], filters[0]],
    collapsed: [filters[2], filters[3], filters[1], filters[0]],
    hiddenCount: 0,
    showToggle: false,
  });
  expect(layout(383, selected).showToggle).toBe(true);
  expect(visibleProjectFilters([], new Set(), { ...metrics, rowWidth: 0 }).showToggle).toBe(false);
});

test("selected chips get space first and remain reachable on an overflowing row", () => {
  const chosen = selectedProjectIds(filters, ["idle"]);
  expect(layout(322, chosen).collapsed).toEqual([filters[2], filters[0]]);
  const allSelected = new Set(filters.flatMap(filter => filter.ids));
  const narrow = layout(200, allSelected);
  expect(narrow.collapsed).toEqual(narrow.ordered);
  expect(narrow.hiddenCount).toBe(0);
  expect(narrow.showToggle).toBe(true);
});

test("collapsed filters hide idle projects even with room, and stop before a lower-ranked chip can pass", () => {
  const wide = layout(1500);
  expect(wide.collapsed).toEqual([filters[2], filters[3], filters[1]]);
  expect(wide.hiddenCount).toBe(1);
  expect(wide.showToggle).toBe(true);
  const narrow = visibleProjectFilters(filters, new Set(), {
    ...metrics, rowWidth: 322, chipWidth: group => group === filters[3] ? 140 : 74,
  });
  expect(narrow.collapsed).toEqual([filters[2]]);
});
