import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, parse, relative, sep } from "node:path";
import { z } from "zod";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { SessionRow } from "../shared/contract";
import { wasSent, type SentRecord } from "../shared/answered-requests";
import { autoApprovalEntry, readOnlyShellPlan, withAutoApprovals, type AutoApprovalEntry, type AutoApprovalPlan, type AutoApprovalRefusal } from "../shared/permission-auto-approve";
import { guardedWord, hiddenPart } from "../shared/permission-read-paths";
import { createResponder, type Outcome } from "../shared/permission-responder";
import { isManagedCoordinator, type Preferences } from "./preferences";
import { managedSessions } from "./session-links";

type Sdk = PluginHandlerContext["paseo"];
const file = z.object({ version: z.literal(1), entries: z.array(autoApprovalEntry) });

// Requests the read-only rule answered, kept in the plugin's data folder on the host that runs
// the sessions. The plugin server cannot write host settings, so this is its own file.
export class AutoApprovalStore {
  constructor(private readonly path: string) {}
  // A missing file is an empty record. A file that cannot be read is an error, so the rule
  // answers nothing while it cannot tell what it already answered.
  read(): AutoApprovalEntry[] {
    try { return file.parse(JSON.parse(readFileSync(this.path, "utf8"))).entries; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
  has(session: string, request: string) {
    return this.read().some(entry => entry.session === session && entry.request === request);
  }
  put(entry: AutoApprovalEntry, now: number) {
    this.write(withAutoApprovals(this.read(), [entry], now));
  }
  // Returns whether a record changed.
  settle(session: string, request: string, state: "allowed" | "other", now: number) {
    const entries = this.read();
    const entry = entries.find(item => item.session === session && item.request === request);
    if (!entry || entry.state !== "sent") return false;
    this.write(withAutoApprovals(entries, [{ ...entry, state }], now));
    return true;
  }
  private write(entries: AutoApprovalEntry[]) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, entries }), { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.path);
    } finally { rmSync(temporary, { force: true }); }
  }
}

export type HostFiles = {
  realpath(path: string): Promise<string>;
  // What a resolved path is, and how many names (hard links) point at it.
  describe(path: string): Promise<{ kind: "file" | "folder" | "other"; links: number }>;
  home: string; platform: string;
  // Folders under a dot folder of the home folder that still hold ordinary work, such as Paseo's own worktrees.
  workRoots?: readonly string[];
};
const hostFiles: HostFiles = {
  realpath: path => realpath(path),
  describe: async path => { const found = await stat(path); return { kind: found.isFile() ? "file" : found.isDirectory() ? "folder" : "other", links: found.nlink }; },
  home: homedir(), platform: process.platform,
};

function inside(root: string, target: string) {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

// Walks a path one part at a time the way the system does: a link is followed where it stands and
// ".." then leaves the folder the link pointed to. Tidying ".." in the text first would name a different file.
async function physical(path: string, files: HostFiles) {
  const { root } = parse(path);
  let current = root;
  for (const part of path.slice(root.length).split(sep)) {
    if (!part || part === ".") continue;
    current = part === ".." ? dirname(current) : await files.realpath(join(current, part));
  }
  return current;
}

// Resolves every path of a plan on this host, symbolic links included, and allows the plan only
// when each one exists, lies inside the session's folder and has no sensitive name. A path that
// cannot be resolved refuses the plan. A command that reads contents must be given regular files
// with a single name and no dot name below the folder: the board cannot vouch for every file under a folder.
export async function hostAllows(plan: AutoApprovalPlan, workspace: string, files: HostFiles = hostFiles) {
  try {
    const root = await physical(workspace, files);
    const home = await physical(files.home, files).catch(() => files.home);
    // A session opened on the home folder, or above it, has no folder of its own to stay inside.
    if (parse(root).root === root || inside(root, home)) return false;
    // A dot folder of the home folder, or its Library, holds settings and sign-in data rather than work.
    const [top] = inside(home, root) ? relative(home, root).split(sep) : [];
    if (top && (top.startsWith(".") || top === "Library")) {
      const workRoots = await Promise.all((files.workRoots ?? []).map(path => physical(path, files).catch(() => null)));
      if (!workRoots.some(path => path && path !== root && inside(path, root))) return false;
    }
    if (plan.cwd !== undefined && !inside(root, await physical(plan.cwd, files))) return false;
    for (const read of plan.reads) {
      if (read.value.startsWith("~") || (!isAbsolute(read.value) && (!read.cwd || !isAbsolute(read.cwd)))) return false;
      const real = await physical(isAbsolute(read.value) ? read.value : read.cwd + sep + read.value, files);
      // The whole resolved path is checked, not only the part below the session's folder.
      if (!inside(root, real) || guardedWord(real)) return false;
      const { kind, links } = await files.describe(real);
      if (read.command === "cd" ? kind !== "folder" : read.content ? kind !== "file" : kind === "other") return false;
      // A second name for the same file can sit outside the folder, where none of these checks reach.
      if (read.content && (links !== 1 || hiddenPart(relative(root, real)))) return false;
    }
    return true;
  } catch { return false; }
}

// A session the board manages on this host that is not a coordinator. A coordinator's own request stays with a person.
export function managedWorkSession(rows: SessionRow[], scope: Preferences, id: string) {
  if (scope.coordinator === id || isManagedCoordinator(scope, id)) return null;
  return managedSessions(rows, scope).find(row => row.id === id && !row.serverId) ?? null;
}

export type AutoApprovalResult = Outcome | AutoApprovalRefusal | "skipped" | "unsupported" | "off" | "recorded" | "record" | "session" | "workspace" | "unmanaged" | "path";
type Options = {
  store: AutoApprovalStore;
  // Whether a person has the rule switched on. Anything but a readable "on" is off.
  enabled: () => Promise<boolean>;
  // The record of requests answered from the board's buttons, or null when it cannot be read.
  answered: () => Promise<readonly SentRecord[] | null>;
  managed: (paseo: Sdk, sessionId: string) => Promise<Pick<SessionRow, "title" | "projectId"> | null>;
  changed?: () => void; files?: HostFiles; workRoots?: readonly string[]; now?: () => number; checks?: number; wait?: (ms: number) => Promise<void>;
};

// Answers a waiting shell request with one plain allow when a person switched the read-only
// rule on and every condition holds. It runs only from the hook for a new request: nothing here
// looks for waiting requests on a timer, asks an agent, or sends a message to a session.
export class PermissionAutoApprover {
  private readonly active = new Set<string>();
  private readonly files: HostFiles;
  private readonly now: () => number;
  constructor(private readonly options: Options) {
    this.files = { ...(options.files ?? hostFiles), ...(options.workRoots ? { workRoots: options.workRoots } : {}) };
    this.now = options.now ?? Date.now;
  }
  // Windows shells read a command line differently from the grammar the board checks.
  get supported() { return this.files.platform !== "win32"; }

  async requested(event: { agent?: { id: string }; request?: { id: string } }, context: { paseo: Sdk; signal?: AbortSignal }): Promise<AutoApprovalResult> {
    const session = event.agent?.id, requestId = event.request?.id;
    if (!session || !requestId) return "skipped";
    if (!this.supported) return "unsupported";
    const { store, enabled } = this.options;
    const key = JSON.stringify([session, requestId]);
    if (this.active.has(key)) return "busy";
    this.active.add(key);
    try {
      if (!await enabled()) return "off";
      if (store.has(session, requestId)) return "recorded";
      const answered = await this.options.answered();
      if (!answered) return "record";
      if (wasSent(answered, session, requestId)) return "recorded";
      const handle = context.paseo.agents.ref(session);
      const agent = (await handle.refresh())?.agent;
      if (!agent || agent.id !== session || agent.archivedAt || agent.internal) return "session";
      // The request is judged as the host holds it now, not as the event described it.
      const request = agent.pendingPermissions.find(pending => pending.id === requestId);
      if (!request) return "handled";
      if (!agent.cwd || !isAbsolute(agent.cwd)) return "workspace";
      const judged = readOnlyShellPlan(request, agent.cwd);
      if ("refused" in judged) return judged.refused;
      const row = await this.options.managed(context.paseo, session);
      if (!row) return "unmanaged";
      if (!await hostAllows(judged.plan, agent.cwd, this.files)) return "path";
      // A person may have switched the rule off while the paths were being resolved.
      if (context.signal?.aborted || !await enabled()) return "off";
      const { summary, command, response } = judged.plan;
      const responder = createResponder(handle, {
        checks: this.options.checks ?? 5, ...(this.options.wait ? { wait: this.options.wait } : {}),
        wasSent: id => store.has(session, id),
        onSent: id => {
          store.put({ session, request: id, at: this.now(), title: row.title.slice(0, 400), projectId: row.projectId, summary, command, state: "sent" }, this.now());
          this.options.changed?.();
        },
      });
      return await responder.respond(requestId, response);
    } catch { return "failed"; }
    finally { this.active.delete(key); }
  }

  // The host reports how a request ended. Only then does a record say the session was allowed.
  resolved(event: { agent?: { id: string }; requestId?: string; resolution?: { behavior?: string } }) {
    if (!event.agent?.id || !event.requestId) return;
    try {
      if (this.options.store.settle(event.agent.id, event.requestId, event.resolution?.behavior === "allow" ? "allowed" : "other", this.now())) this.options.changed?.();
    } catch { /* The record stays as sent. */ }
  }

  view(projects: ReadonlySet<string>) {
    let entries: AutoApprovalEntry[] = [];
    try { entries = this.options.store.read(); } catch { /* An unreadable record shows nothing and answers nothing. */ }
    return { supported: this.supported, entries: entries.filter(entry => projects.has(entry.projectId)).reverse() };
  }
}
