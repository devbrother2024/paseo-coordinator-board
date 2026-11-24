import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFolders, type Disk } from "../server/project-folders";
import { projectFolderMap, sameProject } from "../shared/project-folders";

const scratch: string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, {recursive: true, force: true}); });

test("the disk decides whether two project roots are one folder", () => {
  const disk = mkdtempSync(join(tmpdir(), "project-folders-")); scratch.push(disk);
  const checkout = join(disk, "Work", "app"), named = join(disk, "other", "app"), alias = join(disk, "alias");
  mkdirSync(checkout, {recursive: true}); mkdirSync(named, {recursive: true}); symlinkSync(checkout, alias, "junction");
  const cased = join(disk, "work", "app"), insensitive = existsSync(cased);
  const folders = projectFolders([
    {projectId: "alpha", projectRootPath: checkout}, {projectId: "alpha-cased", projectRootPath: cased},
    {projectId: "alpha-link", projectRootPath: alias}, {projectId: "beta", projectRootPath: named},
    {projectId: "gone", projectRootPath: join(disk, "gone")}, {projectId: "unknown", projectRootPath: ""},
  ]);
  expect(sameProject("alpha", "alpha-link", folders)).toBe(true);
  expect(sameProject("alpha", "alpha-cased", folders)).toBe(insensitive);
  expect(sameProject("alpha", "beta", folders)).toBe(false);
  expect([folders.gone, folders.unknown]).toEqual([undefined, undefined]);
  expect(sameProject("gone", "unknown", folders)).toBe(false);
  expect(sameProject("gone", "gone", folders)).toBe(true);
  expect(sameProject("alpha", null, folders)).toBe(false);
  if (!insensitive) {
    // A case-sensitive disk can hold both spellings as two folders.
    mkdirSync(cased, {recursive: true});
    const both = projectFolders([{projectId: "alpha", projectRootPath: checkout}, {projectId: "alpha-cased", projectRootPath: cased}]);
    expect(sameProject("alpha", "alpha-cased", both)).toBe(false);
  }
});

test("letter case joins two roots only where the disk says they are one folder", () => {
  const entry = (ino: bigint) => ({dev: 1n, ino, isDirectory: () => true});
  const missing = () => Object.assign(new Error("missing"), {code: "ENOENT"});
  const disk = (inodes: Record<string, bigint>, realpath: (path: string) => string): Disk => ({
    stat: path => { const inode = inodes[path]; if (inode) return entry(inode); throw missing(); }, realpath,
  });
  const roots = [{projectId: "alpha", projectRootPath: "/Users/you/Projects/app"}, {projectId: "alpha-cased", projectRootPath: "/Users/you/projects/app"}];
  const insensitive = disk({"/Users/you/Projects/app": 7n, "/Users/you/projects/app": 7n}, () => "/Users/you/Projects/app");
  const sensitive = disk({"/Users/you/Projects/app": 7n, "/Users/you/projects/app": 8n}, path => path);
  expect(sameProject("alpha", "alpha-cased", projectFolders(roots, insensitive))).toBe(true);
  expect(sameProject("alpha", "alpha-cased", projectFolders(roots, sensitive))).toBe(false);
  const windows = [{projectId: "alpha", projectRootPath: "C:\\Users\\you\\Projects\\app"}, {projectId: "alpha-cased", projectRootPath: "c:\\users\\you\\projects\\app"},
    {projectId: "beta", projectRootPath: "C:\\Users\\you\\Projects\\api"}];
  // Some volumes, such as Windows ReFS, can give two folders the same file number.
  const reused = disk({[windows[0].projectRootPath]: 9n, [windows[1].projectRootPath]: 9n, [windows[2].projectRootPath]: 9n},
    path => path.toLowerCase().endsWith("api") ? windows[2].projectRootPath : windows[0].projectRootPath);
  const onWindows = projectFolders(windows, reused);
  expect([sameProject("alpha", "alpha-cased", onWindows), sameProject("alpha", "beta", onWindows)]).toEqual([true, false]);
  expect(projectFolders(roots, {stat: () => ({dev: 1n, ino: 9n, isDirectory: () => false}), realpath: path => path})).toEqual({});
  expect(projectFolderMap([{id: "alpha", folder: "1:7"}, {id: "beta"}])).toEqual({alpha: "1:7"});
});
