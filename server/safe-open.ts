import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, type BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";

const readFlags = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
const writeFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;
const statOptions = { bigint: true } as const;

function replacedFile(path: string) {
  return Object.assign(new Error("Refusing to open a symbolic link or replaced file"), { code: "ELOOP", path });
}

function isMissing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

type FileIdentity = Pick<BigIntStats, "dev" | "ino">;

export function sameFileIdentity(before: FileIdentity, after: FileIdentity, platform = process.platform) {
  if (before.ino === 0n || before.ino !== after.ino) return false;
  if (before.dev === after.dev) return true;
  // Older libuv can report the same Windows volume using its full or short serial.
  return platform === "win32" && (before.dev === BigInt.asUintN(32, after.dev) || after.dev === BigInt.asUintN(32, before.dev));
}

function verifyIdentity(path: string, before: BigIntStats, after: BigIntStats) {
  if (after.isSymbolicLink() || !sameFileIdentity(before, after)) {
    throw replacedFile(path);
  }
}

export function openNoFollowSync(
  path: string,
  access: "read" | "overwrite" = "read",
  { noFollow = constants.O_NOFOLLOW, openFile = openSync } = {},
): number {
  const writing = access === "overwrite";
  if (noFollow) return writing
    ? openFile(path, writeFlags | noFollow, 0o600)
    : openFile(path, readFlags | noFollow);

  let before: BigIntStats;
  try {
    before = lstatSync(path, statOptions);
  } catch (error) {
    if (!writing || !isMissing(error)) throw error;
    // If another writer creates the path first, leave that entry alone.
    return openFile(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  }
  if (before.isSymbolicLink()) throw replacedFile(path);

  let fd: number | undefined;
  try {
    // Opening without O_CREAT or O_TRUNC cannot create or truncate a replacement.
    fd = openFile(path, writing ? constants.O_WRONLY : readFlags);
    verifyIdentity(path, before, fstatSync(fd, statOptions));
    // A link to the original file could still have the same open-file identity.
    verifyIdentity(path, before, lstatSync(path, statOptions));
    if (writing) ftruncateSync(fd, 0);
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw isMissing(error) ? replacedFile(path) : error;
  }
}

export async function openNoFollow(
  path: string,
  { noFollow = constants.O_NOFOLLOW, openFile = open } = {},
) {
  if (noFollow) return openFile(path, readFlags | noFollow);

  const before = await lstat(path, statOptions);
  if (before.isSymbolicLink()) throw replacedFile(path);
  let file: FileHandle | undefined;
  try {
    file = await openFile(path, readFlags);
    verifyIdentity(path, before, await file.stat(statOptions));
    verifyIdentity(path, before, await lstat(path, statOptions));
    return file;
  } catch (error) {
    await file?.close();
    throw isMissing(error) ? replacedFile(path) : error;
  }
}
