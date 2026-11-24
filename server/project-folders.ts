import { realpathSync, statSync } from "node:fs";
import type { ProjectFolders } from "../shared/project-folders";

type Entry = { dev: bigint; ino: bigint; isDirectory(): boolean };
export type Disk = { stat(path: string): Entry; realpath(path: string): string };
const disk: Disk = { stat: path => statSync(path, { bigint: true }), realpath: path => realpathSync.native(path) };

// Two project roots are one folder when the disk gives both the same device and file numbers and both resolve to one
// path apart from letter case. The numbers keep apart two folders whose names differ only in case on a case-sensitive
// disk. The path keeps folders apart on volumes whose file numbers are not unique, such as Windows ReFS.
// The reads stay synchronous: asynchronous reads finish in any order and could reorder replies queued together.
export function projectFolders(projects: readonly { projectId: string; projectRootPath?: string | null }[],
  read: Disk = disk): ProjectFolders {
  const folders: Record<string, string> = {};
  for (const { projectId, projectRootPath } of projects) {
    if (!projectRootPath) continue;
    try {
      const entry = read.stat(projectRootPath);
      if (entry.isDirectory()) folders[projectId] = `${entry.dev}:${entry.ino}:${read.realpath(projectRootPath).toLowerCase()}`;
    } catch {
      // A root the disk cannot read only matches its own project.
    }
  }
  return folders;
}
