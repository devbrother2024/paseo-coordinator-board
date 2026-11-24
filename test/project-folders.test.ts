import { expect, test } from "bun:test";
import { projectFolderMap, sameProject } from "../shared/project-folders";

test("two projects are one folder only when the server gave both the same root key", () => {
  const folders = projectFolderMap([
    {id: "alpha", rootKey: "1:7"}, {id: "alpha-link", rootKey: "1:7"}, {id: "beta", rootKey: "1:8"}, {id: "gone"}, {id: "unknown"},
  ]);
  expect(folders).toEqual({alpha: "1:7", "alpha-link": "1:7", beta: "1:8"});
  expect(sameProject("alpha", "alpha-link", folders)).toBe(true);
  expect(sameProject("alpha", "beta", folders)).toBe(false);
  expect(sameProject("gone", "unknown", folders)).toBe(false);
  expect(sameProject("gone", "gone", folders)).toBe(true);
  expect(sameProject("alpha", null, folders)).toBe(false);
});
