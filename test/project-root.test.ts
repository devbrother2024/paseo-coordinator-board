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
  expect((await roots.describe(paths, selected)).map(item => item.rootKey)).toEqual(["1:5:/work/app", "1:5:/work/app", undefined]);
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
      expect((await roots.describe(values, new Set(["slow", "fast"]))).map(item => item.rootKey)).toEqual([undefined, "1:5:/work/fast"]);
    }
    expect(calls).toEqual(["/mount/offline", "/work/fast"]);
  } finally {
    release();
  }
});

test("a selected folder is unread while its read is late or two blocked reads hold every slot", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const roots = new ProjectRootReader({
    host: { platform: "linux", temp: "/tmp" }, timeoutMs: 15,
    disk: { stat: async path => {
      if (path.startsWith("/mount/")) await blocked;
      return directory;
    }, realpath },
  });
  const three = [project("three", "/work/three")];
  try {
    const late = [project("one", "/mount/one"), project("two", "/mount/two"), project("other", "/mount/other")];
    expect(await roots.describe(late, new Set(["one", "two"]))).toEqual([{ temporary: false, unread: true }, { temporary: false, unread: true }, { temporary: false }]);
    // Both reads are still blocked, so a third folder is not read at all.
    expect(await roots.describe(three, new Set(["three"]))).toEqual([{ temporary: false, unread: true }]);
  } finally {
    release();
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(await roots.describe(three, new Set(["three"]))).toEqual([{ rootKey: "1:5:/work/three", temporary: false }]);
});

test("one folder needs the same file numbers and the same resolved path", async () => {
  const keys = async (platform: NodeJS.Platform, inodes: Record<string, bigint>, resolve: (path: string) => string) => {
    const roots = new ProjectRootReader({
      host: { platform, temp: platform === "win32" ? "C:\\Temp" : "/tmp" },
      disk: { stat: async path => ({ ...directory, ino: inodes[path] }), realpath: async path => resolve(path) },
    });
    const paths = Object.keys(inodes);
    return (await roots.describe(paths.map(path => project(path, path)), new Set(paths))).map(item => item.rootKey);
  };
  // A disk that ignores letter case resolves both spellings to one path.
  const [upper, lower] = await keys("darwin", { "/Users/you/Projects/app": 7n, "/Users/you/projects/app": 7n }, () => "/Users/you/Projects/app");
  expect(upper).toBe(lower);
  // A case-sensitive disk can hold both spellings as two folders.
  const [first, second] = await keys("linux", { "/home/you/App": 7n, "/home/you/app": 8n }, path => path);
  expect(first).not.toBe(second);
  // Windows ReFS can give two folders the same file number.
  const [app, alias, api] = await keys("win32", { "C:\\work\\app": 9n, "c:\\WORK\\app": 9n, "C:\\work\\api": 9n },
    path => path.toLowerCase().endsWith("api") ? "C:\\work\\api" : "C:\\work\\app");
  expect(app).toBe(alias);
  expect(api).not.toBe(app);
});
