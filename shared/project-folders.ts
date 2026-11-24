// Paseo can register one folder as two projects, for example under paths that differ only in letter case.
// The server asks the disk which selected project roots are one folder and gives those projects the same `rootKey`.
export type ProjectFolders = Readonly<Record<string, string>>;

export function projectFolderMap(projects: readonly { id: string; rootKey?: string }[]): ProjectFolders {
  const folders: Record<string, string> = {};
  for (const { id, rootKey } of projects) if (rootKey) folders[id] = rootKey;
  return folders;
}

export function sameProject(a: string | null, b: string | null, folders: ProjectFolders) {
  if (a === b) return true;
  const folder = a ? folders[a] : undefined;
  return folder !== undefined && !!b && folders[b] === folder;
}
