import { expect, test } from "bun:test";
import { ProjectRootReader } from "../server/project-root";

const directory = { dev: 1n, ino: 5n, isDirectory: () => true };
const project = (id: string, path: string) => ({ id, path });
const stat = async () => directory;
const realpath = async (path: string) => path;

test("the host classifies configured, canonical and known Linux temporary roots", async () => {
  const roots = new ProjectRootReader({
    host: { platform: "linux", temp: "/scratch/current" },
    disk: { stat, realpath: async path => path === "/scratch/current" ? "/mnt/scratch" : path },
  });
  const paths = ["/tmp", "/var/tmp/jobs", "/dev/shm/boards", "/scratch/current/jobs", "/mnt/scratch/demo", "/tmp/../work", "/tmp-notes", "/var/tmp-old", "/mnt/scratch2"];
  expect((await roots.describe(paths.map(path => project(path, path)), new Set())).map(item => item.temporary))
    .toEqual([true, true, true, true, true, false, false, false, false]);
});

test("Darwin aliases and Windows temporary paths use native boundaries and verified case", async () => {
  const mac = new ProjectRootReader({ host: { platform: "darwin", temp: "/private/tmp" }, disk: { stat, realpath } });
  const paths = ["/private/tmp/example", "/var/folders/ab/example", "/private/var/folders/ab/example", "/var/folders-old/example"];
  expect((await mac.describe(paths.map(path => project(path, path)), new Set())).map(item => item.temporary)).toEqual([true, true, true, false]);

  const temp = "C:\\Users\\sample\\AppData\\Local\\Temp";
  const mismatch = "C:\\Users\\sample\\AppData\\Local\\temp";
  const win = new ProjectRootReader({
    host: { platform: "win32", temp: "D:\\scratch", localAppData: "C:\\Users\\sample\\AppData\\Local", windowsDir: "C:\\Windows" },
    disk: { stat, realpath: async path => path === mismatch + "\\alias" ? temp + "\\alias" : path },
  });
  const winPaths = [temp + "\\board", "d:\\scratch\\jobs", "C:\\Windows\\Temp\\job", mismatch + "\\alias", mismatch + "\\separate", temp + "-backup", "C:\\work\\Temp"];
  expect((await win.describe(winPaths.map(path => project(path, path)), new Set())).map(item => item.temporary)).toEqual([true, true, true, true, false, false, false]);
});

test("only selected roots are statted and successful reads are cached by path", async () => {
  let now = 0;
  const reads: string[] = [];
  const roots = new ProjectRootReader({
    host: { platform: "linux", temp: "/tmp" }, now: () => now,
    disk: { stat: async path => { reads.push(path); return directory; }, realpath },
  });
  const paths = [project("a", "/work/app"), project("alias", "/work/app"), project("other", "/mount/offline")];
  const selected = new Set(["a", "alias"]);
  expect((await roots.describe(paths, selected)).map(item => item.rootKey)).toEqual(["1:5", "1:5", undefined]);
  await roots.describe(paths, selected);
  expect(reads).toEqual(["/work/app"]);
  now = 240_000;
  await roots.describe(paths, selected);
  expect(reads).toEqual(["/work/app", "/work/app"]);
});

test("a blocked filesystem does not block snapshots or start another probe for that path", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const roots = new ProjectRootReader({
    host: { platform: "linux", temp: "/tmp" }, timeoutMs: 15,
    disk: { stat: async path => {
      calls.push(path);
      if (path === "/mount/offline") await blocked;
      return directory;
    }, realpath },
  });
  const values = [project("slow", "/mount/offline"), project("fast", "/work/fast")];
  try {
    for (let i = 0; i < 2; i++) {
      expect((await roots.describe(values, new Set(["slow", "fast"]))).map(item => item.rootKey)).toEqual([undefined, "1:5"]);
    }
    expect(calls).toEqual(["/mount/offline", "/work/fast"]);
  } finally {
    release();
  }
});
