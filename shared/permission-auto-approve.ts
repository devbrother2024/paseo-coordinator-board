import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { shellPermissionTargets, type ShellReadTarget } from "./permission-summary";
import { guardedWord, hiddenPart, resolveReadPath } from "./permission-read-paths";
import { optionAfterOperand } from "./permission-read-options";
import { shellCommands, type ShellCommand } from "./shell-permission-command";

// Host setting a person switches on in the board settings. The plugin server can read it and
// cannot write it. Off by default: with it off the board answers no request on its own.
export const permissionAutoApprove = defineSettings({
  id: "permission-auto-approve", scope: "host", version: 1,
  schema: z.object({ readOnlyShell: z.boolean().default(false) }),
});

// What the board keeps about a request the rule answered. `state` starts as `sent`, becomes
// `allowed` when the host reports the request resolved as allowed, and `other` when it ended some other way.
export const autoApprovalEntry = z.object({
  session: z.string().min(1).max(256), request: z.string().min(1).max(256), at: z.number(),
  title: z.string().max(400), projectId: z.string().max(256), summary: z.string().max(400), command: z.string().max(400),
  state: z.enum(["sent", "allowed", "other"]),
});
export type AutoApprovalEntry = z.infer<typeof autoApprovalEntry>;
export const autoApprovalView = z.object({ supported: z.boolean(), entries: z.array(autoApprovalEntry) });
export const AUTO_APPROVAL_KEEP = 100;
const maxAge = 14 * 24 * 60 * 60 * 1000;

// Adds or replaces records, newest last. Old and surplus records fall off the front.
export function withAutoApprovals(records: readonly AutoApprovalEntry[], added: readonly AutoApprovalEntry[], now: number): AutoApprovalEntry[] {
  const merged = new Map<string, AutoApprovalEntry>();
  for (const entry of [...records, ...added]) {
    if (now - entry.at <= maxAge) merged.set(JSON.stringify([entry.session, entry.request]), entry);
  }
  return [...merged.values()].sort((a, b) => a.at - b.at).slice(-AUTO_APPROVAL_KEEP);
}

// Shell requests whose form and effect were checked in Paseo's providers: the tool name, that
// `input.command` is the text the provider runs, and that a plain allow runs it once and adds no
// standing permission. A request from any other provider or tool is left to a person.
const shellSources: Record<string, string> = { claude: "Bash", codex: "CodexBash" };

// Commands the rule may approve. It is its own list, so a command the card learns to label
// "read" later does not become approvable without a decision here. Git is left out: a repository's
// own configuration (external diff, textconv, fsmonitor, pager) can run code on a read. So is printf:
// in bash its format can write a shell variable ("%n"), which would change how a later command is found.
const approvable = new Set("ls cat head tail wc sort uniq rg grep find sed awk readlink stat file sips echo pwd".split(" "));
// These list names and metadata, so they may be given a folder. Every other command must be given files.
const listing = new Set(["ls", "find", "stat", "readlink", "file"]);

export type AutoApprovalRequest = {
  provider: string; name: string; kind: string; input?: Record<string, unknown> | null;
  detail?: { type: string; command?: string } | null; actions?: readonly unknown[] | null;
};
export type AutoApprovalRefusal = "source" | "action" | "input" | "size" | "syntax" | "redirect" | "expansion" | "risk" | "command" | "option" | "sensitive" | "relative";
export type AutoApprovalPlan = {
  // The folder the request says it runs in, when the provider states one.
  cwd?: string;
  // Paths the host must resolve before the request is approved. `content` marks a command that reads file contents.
  reads: (ShellReadTarget & { content: boolean })[];
  summary: string; command: string;
  // Always a single run. The board never sends a standing permission or a changed input.
  response: { behavior: "allow" };
};

const claudeInputs = new Set(["command", "description", "timeout"]);
const absolute = (path: string) => /^(?:\/|[a-z]:[\\/])/i.test(path);
const shellWrapper = /^(?:\/(?:usr\/)?bin\/)?(?:sh|bash|zsh)$/;

// Codex sends the whole argv as one line, usually a shell given one script. The script is read
// with the board's own tokenizer, never by cutting quotes off the line.
function codexScript(line: string) {
  const parsed = shellCommands(line);
  if (parsed?.length !== 1) return line;
  const [only] = parsed;
  const [shell, flag, script] = only.words;
  if (only.words.length !== 3 || !shellWrapper.test(shell.value) || shell.dynamic || !["-lc", "-c"].includes(flag.value) || flag.dynamic) return line;
  if (script.dynamic || only.redirects.length || only.inputs.length || only.substitutions.length || only.inlineInput || only.expandsInputParameters) return null;
  return script.value;
}

function structure(commands: ShellCommand[]): AutoApprovalRefusal | null {
  for (const command of commands) {
    if (command.redirects.length || command.inputs.length || command.inlineInput) return "redirect";
    if (command.substitutions.length || command.expandsInputParameters || command.words.some(word => word.dynamic || word.shellSpecific)) return "expansion";
    const [program, ...words] = command.words;
    const name = program?.value ?? "";
    const end = words.findIndex(word => word.value === "--");
    const options = (end < 0 ? words : words.slice(0, end)).map(word => word.value);
    // Where a utility stops reading options at the first operand, a later option and its value are files the
    // board never resolved. `find` takes its expression after the paths, and `echo` reads no files.
    if (!["find", "echo", "sed"].includes(name) && optionAfterOperand(name, words.map(word => word.value))) return "option";
    // An option that follows symbolic links can list what lies outside the folder the host checked.
    if (listing.has(name) && options.some(option => /^-[a-zA-Z0-9]*[LH]/.test(option) || option === "--dereference")) return "option";
    // Following a file never ends, so the session would wait on it until its own time limit.
    if (name === "tail" && options.some(option => /^-[a-zA-Z0-9]*[fF]/.test(option) || /^--follow(?:=|$)/.test(option))) return "option";
    // Looking inside compressed files runs whichever decompression program the PATH names.
    if (name === "rg" && options.some(option => /^-[a-zA-Z0-9]*z/.test(option) || option === "--search-zip")) return "option";
    if (name === "file" && options.some(option => /^-[a-zA-Z0-9]*[zZ]/.test(option) || /^--uncompress/.test(option))) return "option";
    // A bare relative name can be looked up through CDPATH. An explicit "./" or an absolute path cannot.
    if (name === "cd" && !words.every(word => absolute(word.value) || word.value.startsWith("./"))) return "relative";
    if (command.words.some(word => guardedWord(word.value))) return "sensitive";
  }
  return null;
}

// Decides from the request alone whether the read-only rule may answer it. Nothing here touches
// the disk: the caller still resolves every path in `reads` on the session's host. `workspace` is
// the session's own folder, used for a provider that does not say where the command runs.
export function readOnlyShellPlan(request: AutoApprovalRequest, workspace: string): { plan: AutoApprovalPlan } | { refused: AutoApprovalRefusal } {
  const refuse = (refused: AutoApprovalRefusal) => ({ refused });
  const input = request.input ?? {};
  if (request.kind !== "tool" || !Object.hasOwn(shellSources, request.provider) || shellSources[request.provider] !== request.name ||
    request.detail?.type !== "shell" || typeof input.command !== "string" || !input.command.trim()) return refuse("source");
  // A request that carries its own choices is one the board has not checked. A plain allow may mean something else there.
  if (request.actions?.length) return refuse("action");
  let cwd: string | undefined;
  let script: string | null = input.command;
  if (request.provider === "claude") {
    // Only the inputs whose meaning was checked. Any other key (running in the background, leaving the sandbox,
    // or one a later version adds) sends the request to a person.
    if (request.detail.command !== input.command || Object.keys(input).some(key => !claudeInputs.has(key))) return refuse("input");
  } else {
    if (input.cwd !== undefined && input.cwd !== null) {
      if (typeof input.cwd !== "string" || !absolute(input.cwd)) return refuse("input");
      cwd = input.cwd;
    }
    script = codexScript(script);
  }
  if (script === null) return refuse("expansion");
  if (script.length > 4000) return refuse("size");
  // A comment sign is refused outright: shells differ on when it starts a comment, and a
  // comment the board skips could be a command the shell runs.
  if (/[\u0000-\u0008\u000b-\u001f\u007f#]/.test(script)) return refuse("syntax");
  const parsed = shellCommands(script);
  if (!parsed?.length) return refuse("syntax");
  const shape = structure(parsed);
  if (shape) return refuse(shape);
  const { classification, reads } = shellPermissionTargets(script, cwd ?? workspace);
  if (classification.risk !== "read") return refuse("risk");
  if (classification.commands.some(command => command.risk !== "folder" && !approvable.has(command.name))) return refuse("command");
  if (reads.length > 64) return refuse("size");
  // A command that reads contents is refused any dot name below the folder, apart from a few plain ones.
  const base = resolveReadPath(cwd ?? workspace).replace(/\/$/, "");
  const below = (path: string) => path.startsWith(base + "/") ? path.slice(base.length + 1) : path;
  if (reads.some(read => read.command !== "cd" && !listing.has(read.command) && hiddenPart(below(resolveReadPath(read.value, read.cwd))))) return refuse("sensitive");
  // Without a stated folder the board cannot know where a relative path points.
  if (cwd === undefined && reads.some(read => !absolute(read.value))) return refuse("relative");
  const counts = new Map<string, number>();
  for (const command of classification.commands) counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
  const summary = [...counts].map(([name, count]) => count > 1 ? `${name} ×${count}` : name).join(" · ").slice(0, 400);
  const text = script.replace(/[\p{Cc}‪-‮⁦-⁩]+/gu, " ").trim();
  return { plan: {
    ...(cwd ? { cwd } : {}), summary, command: text.length > 200 ? text.slice(0, 199) + "…" : text, response: { behavior: "allow" },
    reads: reads.map(read => ({ ...read, content: read.command !== "cd" && !listing.has(read.command) })),
  } };
}
