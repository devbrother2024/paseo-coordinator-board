import { realpath, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { posix, win32 } from "node:path";

type HostPaths = {
  platform: NodeJS.Platform;
  temp: string;
  home?: string;
  localAppData?: string;
  windowsDir?: string;
};
type Disk = {
  stat: (path: string) => Promise<{ dev: bigint; ino: bigint; isDirectory: () => boolean }>;
  realpath: (path: string) => Promise<string>;
};
type PathDetails = { canonical?: string; rootKey?: string };
type PathRequest = { path: string; identity: boolean };
const parallelReads = 2;
const cacheMs = 3 * 60_000;

function hostPaths(): HostPaths {
  return {
    platform: process.platform, temp: tmpdir(),
    ...(process.platform === "win32" ? {
      home: homedir(), localAppData: process.env.LOCALAPPDATA, windowsDir: process.env.SystemRoot || process.env.WINDIR,
    } : {}),
  };
}

function temporaryRoots(host: HostPaths) {
  if (host.platform === "win32") {
    const local = host.localAppData || (host.home && win32.join(host.home, "AppData", "Local"));
    return [host.temp, ...(local ? [win32.join(local, "Temp")] : []), ...(host.windowsDir ? [win32.join(host.windowsDir, "Temp")] : [])];
  }
  return [host.temp, "/tmp", "/var/tmp",
    ...(host.platform === "linux" ? ["/dev/shm"] : []),
    ...(host.platform === "darwin" ? ["/private/tmp", "/private/var/tmp", "/var/folders", "/private/var/folders"] : [])];
}

function key({ path, identity }: PathRequest) { return JSON.stringify([path, identity]); }

export class ProjectRootReader {
  private readonly cached = new Map<string, { expires: number; value: PathDetails }>();
  private readonly running = new Map<string, Promise<PathDetails>>();
  private readonly paths;
  private readonly roots;

  constructor(private readonly options: {
    host?: HostPaths;
    disk?: Disk;
    now?: () => number;
    timeoutMs?: number;
  } = {}) {
    const host = options.host ?? hostPaths();
    this.paths = host.platform === "win32" ? win32 : posix;
    this.roots = temporaryRoots(host).filter(path => this.paths.isAbsolute(path));
    this.temp = host.temp;
  }

  private readonly temp: string;

  private underRoot(path: string, roots: readonly string[], ignoreCase = false) {
    if (!this.paths.isAbsolute(path)) return false;
    const normalize = (value: string) => {
      const path = this.paths.normalize(value);
      const normalized = this.paths === win32 ? path.replace(/^[a-z]:/i, drive => drive.toUpperCase()) : path;
      return ignoreCase ? normalized.toLowerCase() : normalized;
    };
    const candidate = normalize(path);
    return roots.some(root => {
      const normalized = normalize(root);
      const prefix = normalized.endsWith(this.paths.sep) ? normalized : normalized + this.paths.sep;
      return candidate === normalized || candidate + this.paths.sep === prefix || candidate.startsWith(prefix);
    });
  }

  private lookup(request: PathRequest): PathDetails | Promise<PathDetails> {
    const id = key(request);
    const cached = this.cached.get(id);
    if (cached) return cached.value;
    const pending = this.running.get(id);
    if (pending) return pending;
    // A timeout cannot cancel a filesystem syscall. A blocked mount keeps its slot
    // until that syscall settles, so repeated snapshots leave other I/O threads free.
    if (this.running.size >= parallelReads) return {};
    const disk = this.options.disk ?? { stat: path => stat(path, { bigint: true }), realpath };
    const now = this.options.now ?? Date.now;
    const read = (async () => {
      const { path, identity } = request;
      const entry = identity ? await disk.stat(path) : undefined;
      const rootKey = entry?.isDirectory() && entry.ino !== 0n ? `${entry.dev}:${entry.ino}` : undefined;
      const canonical = await disk.realpath(path).catch(() => undefined);
      return { rootKey, canonical };
    })().catch((): PathDetails => ({})).then(value => {
      this.running.delete(id);
      this.cached.set(id, { value, expires: now() + (value.canonical || value.rootKey ? cacheMs : 15_000) });
      return value;
    });
    this.running.set(id, read);
    return read;
  }

  private async readRequests(pending: readonly PathRequest[]) {
    const results = new Map<string, PathDetails>();
    if (!pending.length) return results;
    const now = (this.options.now ?? Date.now)();
    for (const [id, entry] of this.cached) if (entry.expires <= now) this.cached.delete(id);

    let cursor = 0;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.timeoutMs ?? 150); });
    const worker = async () => {
      while (!finished && cursor < pending.length) {
        const request = pending[cursor++];
        const details = await this.lookup(request);
        if (!finished) results.set(key(request), details);
      }
    };
    try {
      await Promise.race([Promise.all(Array.from({ length: parallelReads }, worker)), deadline]);
    } finally {
      finished = true;
      clearTimeout(timer);
    }

    return results;
  }

  async folderKeys(paths: readonly string[]) {
    const requests = [...new Set(paths)].filter(path => this.paths.isAbsolute(path)).map(path => ({ path, identity: true }));
    const results = await this.readRequests(requests);
    return new Map(requests.map(request => [request.path, results.get(key(request))?.rootKey]));
  }

  async describe(projects: readonly { id: string; path: string }[], selected: ReadonlySet<string>): Promise<{ rootKey?: string; temporary: boolean }[]> {
    if (!projects.some(project => this.paths.isAbsolute(project.path))) return projects.map(() => ({ temporary: false }));
    const temp = { path: this.temp, identity: false };
    const managed = projects.filter(project => selected.has(project.id) && this.paths.isAbsolute(project.path));
    const reads = new Map<string, PathRequest>();
    if (this.paths.isAbsolute(temp.path)) reads.set(key(temp), temp);
    for (const { path } of managed) {
      const request = { path, identity: true };
      reads.set(key(request), request);
    }

    // Unmanaged paths need no stat. Resolve only possible spelling variants of known temp roots.
    for (const { id, path } of projects) {
      if (selected.has(id) || this.underRoot(path, this.roots) || !this.underRoot(path, this.roots, true)) continue;
      const request = { path, identity: false };
      reads.set(key(request), request);
    }
    const results = await this.readRequests([...reads.values()]);

    const canonicalTemp = results.get(key(temp))?.canonical;
    const roots = canonicalTemp ? [...this.roots, canonicalTemp] : this.roots;
    return projects.map(({ id, path }) => {
      const details = results.get(key({ path, identity: selected.has(id) }));
      return { ...(details?.rootKey ? { rootKey: details.rootKey } : {}), temporary: this.underRoot(details?.canonical ?? path, roots) };
    });
  }
}
