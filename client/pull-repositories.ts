import { repositorySlug } from "../shared/prs";

/**
 * GitHub repositories the board already knows, by the names a session might write for them.
 * Names are the repository part of owner/repository and the project titles mapped to it, compared case-insensitively.
 */
export type RepositoryIndex = {
  readonly names: ReadonlyMap<string, readonly string[]>;
  readonly repos: ReadonlySet<string>;
  /** Names that are not one word (spaces, Korean and other letters), lowercased and longest first, matched whole before splitting text into words. */
  readonly phrases: readonly string[];
};

/** Which repository a PR number belongs to, or that it must not be linked (unknown or ambiguous name). */
export type RepositoryClue = { repo: string } | { blocked: true };

type Entry = { repo: string; names?: Iterable<string | null | undefined> };

const key = (name: string) => name.trim().toLowerCase();

export function repositoryIndex(entries: Iterable<Entry>): RepositoryIndex {
  const names = new Map<string, Set<string>>();
  const repos = new Set<string>();
  const put = (map: Map<string, Set<string>>, name: string | null | undefined, repo: string) => {
    if (!name?.trim()) return;
    const set = map.get(key(name)) ?? new Set<string>();
    set.add(repo);
    map.set(key(name), set);
  };
  const add = (name: string | null | undefined, repo: string) => put(names, name, repo);
  for (const entry of entries) {
    const parsed = repositorySlug.safeParse(entry.repo);
    if (!parsed.success) continue;
    const repo = parsed.data;
    repos.add(repo);
    add(repo.split("/")[1], repo);
    for (const name of entry.names ?? []) add(name, repo);
  }
  const sorted = (map: Map<string, Set<string>>) => new Map([...map].map(([name, set]) => [name, [...set].sort()]));
  const phrases = [...names.keys()].filter(name => !/^[\w.-]+(?:\/[\w.-]+)?$/.test(name)).sort((a, b) => b.length - a.length || a.localeCompare(b));
  return { names: sorted(names), repos, phrases };
}

/** The repository a name stands for: null when the board does not know the name. */
export function resolveRepositoryName(index: RepositoryIndex | undefined, name: string): RepositoryClue | null {
  if (!index) return null;
  const wanted = key(name);
  if (!wanted) return null;
  if (wanted.includes("/")) return index.repos.has(wanted) ? { repo: wanted } : null;
  const found = index.names.get(wanted);
  if (!found?.length) return null;
  return found.length === 1 ? { repo: found[0] } : { blocked: true };
}

type Target = { repo: string } | null | undefined;
type KnownSources = {
  projects?: readonly { id: string; title: string }[];
  pullRequests?: {
    projects: readonly { projectId: string; repo: string | null; mode: string }[];
    items: readonly { repo: string }[];
  };
  trackedDecisions?: { items: readonly {
    projectId: string | null; projectTitle?: string | null; pullRepository?: string; mergeTarget?: Target; pullTarget?: Target; matchedPull?: Target;
  }[] };
  replyHistory?: readonly { pullMerge?: { repo: string } | null }[];
};

/**
 * Repositories from the board's own data only: project repository settings, ledger cards, the PR list and merge history.
 * Nothing here comes from session text, so a link never points at a repository the board was not told about.
 */
export function knownPullRepositories(snapshot: KnownSources | null | undefined): RepositoryIndex {
  const titles = new Map(snapshot?.projects?.map(project => [project.id, project.title]));
  const entries: Entry[] = [];
  for (const project of snapshot?.pullRequests?.projects ?? []) {
    if (project.repo && project.mode !== "off") entries.push({ repo: project.repo, names: [titles.get(project.projectId)] });
  }
  for (const pr of snapshot?.pullRequests?.items ?? []) entries.push({ repo: pr.repo });
  for (const item of snapshot?.trackedDecisions?.items ?? []) {
    const names = [item.projectTitle, item.projectId ? titles.get(item.projectId) : undefined];
    if (item.pullRepository) entries.push({ repo: item.pullRepository, names });
    for (const target of [item.mergeTarget, item.pullTarget, item.matchedPull]) if (target) entries.push({ repo: target.repo });
  }
  for (const entry of snapshot?.replyHistory ?? []) if (entry.pullMerge) entries.push({ repo: entry.pullMerge.repo });
  return repositoryIndex(entries);
}
