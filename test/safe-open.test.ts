import { expect, test } from "bun:test";
import { closeSync, fstatSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNoFollow, openNoFollowSync, sameFileIdentity } from "../server/safe-open";

const fallback = { noFollow: 0 };

test("Windows accepts the short and extended volume serial for the same file", () => {
  const pathStat = { dev: 0x1234567887654321n, ino: 42n };
  const handleStat = { dev: 0x87654321n, ino: 42n };
  expect(sameFileIdentity(pathStat, handleStat, "win32")).toBe(true);
  expect(sameFileIdentity(handleStat, pathStat, "win32")).toBe(true);
  expect(sameFileIdentity(pathStat, handleStat, "linux")).toBe(false);
  expect(sameFileIdentity(pathStat, handleStat, "darwin")).toBe(false);
  expect(sameFileIdentity(pathStat, { ...handleStat, dev: 0x87654322n }, "win32")).toBe(false);
  expect(sameFileIdentity(pathStat, { ...handleStat, ino: 43n }, "win32")).toBe(false);
  expect(sameFileIdentity(pathStat, { ...pathStat, dev: 0x1234567987654321n }, "win32")).toBe(false);
  expect(sameFileIdentity({ ...pathStat, ino: 0n }, { ...handleStat, ino: 0n }, "win32")).toBe(false);
});

test("the fallback reads, overwrites, and creates regular files", async () => {
  const directory = mkdtempSync(join(tmpdir(), "board-safe-open-"));
  try {
    const existing = join(directory, "existing");
    writeFileSync(existing, "original");
    const handle = await openNoFollow(existing, fallback);
    try { expect(await handle.readFile("utf8")).toBe("original"); }
    finally { await handle.close(); }
    const reader = openNoFollowSync(existing, "read", fallback);
    try { expect(readFileSync(reader, "utf8")).toBe("original"); }
    finally { closeSync(reader); }

    for (const path of [existing, join(directory, "new")]) {
      const writer = openNoFollowSync(path, "overwrite", fallback);
      try { writeFileSync(writer, "new"); }
      finally { closeSync(writer); }
      expect(readFileSync(path, "utf8")).toBe("new");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the fallback rejects symbolic links before opening them", async () => {
  const directory = mkdtempSync(join(tmpdir(), "board-safe-open-"));
  try {
    const target = join(directory, "target");
    const path = join(directory, "link");
    writeFileSync(target, "keep me");
    symlinkSync(target, path, "file");

    const unexpectedOpen = () => { throw new Error("link reached open"); };
    const options = { ...fallback, openFile: unexpectedOpen };
    await expect(openNoFollow(path, options)).rejects.toMatchObject({ code: "ELOOP" });
    expect(() => openNoFollowSync(path, "read", options)).toThrow(/symbolic link or replaced file/);
    expect(() => openNoFollowSync(path, "overwrite", options)).toThrow(/symbolic link or replaced file/);
    expect(readFileSync(target, "utf8")).toBe("keep me");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the fallback closes a replaced file without reading or truncating it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "board-safe-open-"));
  try {
    const path = join(directory, "expected");
    const replacement = join(directory, "replacement");
    writeFileSync(path, "expected contents");
    writeFileSync(replacement, "keep me");

    let asyncFd: number | undefined;
    await expect(openNoFollow(path, {
      ...fallback,
      openFile: async (_path, flags) => {
        const handle = await open(replacement, flags);
        asyncFd = handle.fd;
        return handle;
      },
    })).rejects.toMatchObject({ code: "ELOOP" });
    expect(() => fstatSync(asyncFd!)).toThrow(/EBADF/);

    for (const access of ["read", "overwrite"] as const) {
      let syncFd: number | undefined;
      expect(() => openNoFollowSync(path, access, {
        ...fallback,
        openFile: (_path, flags, mode) => {
          syncFd = openSync(replacement, flags, mode);
          return syncFd;
        },
      })).toThrow(/symbolic link or replaced file/);
      expect(() => fstatSync(syncFd!)).toThrow(/EBADF/);
    }
    expect(readFileSync(path, "utf8")).toBe("expected contents");
    expect(readFileSync(replacement, "utf8")).toBe("keep me");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the fallback does not truncate a file created after the missing-path check", () => {
  const directory = mkdtempSync(join(tmpdir(), "board-safe-open-"));
  try {
    const path = join(directory, "new");
    expect(() => openNoFollowSync(path, "overwrite", {
      ...fallback,
      openFile: (file, flags, mode) => {
        writeFileSync(file, "keep me");
        return openSync(file, flags, mode);
      },
    })).toThrow(/EEXIST/);
    expect(readFileSync(path, "utf8")).toBe("keep me");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("the fallback distinguishes a disappeared file from an initially missing file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "board-safe-open-"));
  try {
    const path = join(directory, "expected");
    await expect(openNoFollow(path, fallback)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => openNoFollowSync(path, "read", fallback)).toThrow(/ENOENT/);

    writeFileSync(path, "expected contents");
    const missing = () => { throw Object.assign(new Error("Path disappeared"), { code: "ENOENT" }); };
    const options = { ...fallback, openFile: missing };
    await expect(openNoFollow(path, options)).rejects.toMatchObject({ code: "ELOOP" });
    expect(() => openNoFollowSync(path, "read", options)).toThrow(/symbolic link or replaced file/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
