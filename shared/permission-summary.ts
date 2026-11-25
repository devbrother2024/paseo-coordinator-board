import { shellCommands, type ShellCommand, type ShellWord } from "./shell-permission-command";
import { gitSubcommandIndex, hasLongOption, readCommandOperands } from "./permission-read-options";
import { readPathRisks, resolveReadPath } from "./permission-read-paths";
import { curlEffects, githubCredentialRead, sedArguments, sedScriptRisk, wgetEffects } from "./permission-command-effects";

const risks = ["read", "outside-read", "sensitive-read", "write", "network", "execute", "destructive", "unknown"] as const;
export type PermissionRisk = typeof risks[number];
type Operation = { name: string; risk: PermissionRisk | "folder"; detail?: string; additionalRisks?: PermissionRisk[] };
type Group = Operation & { count: number };
export type ShellPermissionClassification = {
  risk: PermissionRisk;
  cwd?: string;
  count: number;
  readPathsUnresolved?: true;
  commands: (Operation & { setsWorkingFolder?: true })[];
};
// A path one command of the request reads, as written, with the folder it would be read from.
// `cd` entries are the folders the request moves to. The host resolves these itself.
export type ShellReadTarget = { command: string; value: string; cwd?: string };
type ShellSummary = Omit<ShellPermissionClassification, "commands"> & { kind: "shell"; command: string; groups: Group[] };
type ToolSummary = { kind: "read" | "edit" | "write" | "delete" | "mcp" | "fetch" | "unknown"; risk: PermissionRisk;
  target?: string; additionalRisks?: PermissionRisk[]; readPathsUnresolved?: true };
export type PermissionSummary = ShellSummary | ToolSummary;
type Translate = (ko: string, en: string) => string;
type Request = {
  kind: string; name: string; title?: string; input?: Record<string, unknown>;
  detail?: { type: string; command?: string; cwd?: string; filePath?: string; url?: string };
};

const readCommands = new Set("ls cat head tail wc sort uniq rg grep find sed awk readlink stat file sips git echo pwd printf".split(" "));
const fileCommands = new Set(["mkdir", "touch", "cp", "mv", "tee", "rm", "rmdir"]);
const interpreters = new Set(["python", "python3", "node", "bun", "bash", "sh"]);
const gitRead = new Set(["log", "show", "diff", "status", "rev-parse", "merge-base", "blame"]);
const gitWrite = new Set(["add", "commit", "checkout", "switch", "stash", "merge", "rebase"]);
const packageActions = new Set(["install", "i", "ci", "add", "update", "dlx", "x"]);
const moreRisk = (a: PermissionRisk, b: PermissionRisk) => risks.indexOf(a) >= risks.indexOf(b) ? a : b;
const str = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;
const firstLine = (value?: string) => value?.split(/\r?\n/, 1)[0];
const concise = (value?: string) => {
  const text = value?.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]+/gu, " ").trim();
  return text && (text.length > 120 ? text.slice(0, 119) + "…" : text);
};

// These paths come from the session's host. The client might use a different OS.
// Shorten literal prefixes without resolving paths, symlinks or casing on the client.
function displayPath(value: string, cwd?: string) {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd ?? value);
  const path = windows ? value.replace(/\\/g, "/") : value;
  const base = (windows ? cwd?.replace(/\\/g, "/") : cwd)?.replace(/\/+$/, "");
  let display = path;
  if (base && path === base) display = ".";
  else if (base && path.startsWith(base + "/") && !path.slice(base.length + 1).split("/").includes("..")) display = path.slice(base.length + 1);
  else display = path.replace(/^(?:\/Users\/|\/home\/|[a-z]:\/Users\/)[^/]+(?=\/|$)/i, "~");
  if (windows) display = display.replace(/\//g, "\\");
  return concise(display);
}

function folderName(cwd: string) {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(cwd);
  const parts = cwd.split(windows ? /[\\/]+/ : /\/+/);
  return concise(parts.filter(Boolean).at(-1) ?? cwd);
}

function targets(words: ShellWord[], cwd?: string) {
  const paths = words.flatMap(word => !word.dynamic && word.value ? displayPath(word.value, cwd) ?? [] : []);
  return concise(paths.join(", "));
}

function operands(words: ShellWord[]) {
  const optionsEnd = words.findIndex(word => word.value === "--");
  return words.filter((word, index) => optionsEnd >= 0 && index > optionsEnd || !word.value.startsWith("-"));
}

function fileTargets(name: string, words: ShellWord[], cwd?: string) {
  if (name === "find") {
    const paths = words.filter(word => !["-H", "-L", "-P"].includes(word.value));
    const expression = paths.findIndex(word => word.value.startsWith("-"));
    return targets(expression < 0 ? paths : paths.slice(0, expression), cwd);
  }
  if (name === "sort" || name === "sips") {
    const option = name === "sort" ? /^(?:-[bdfghiMmnRrsuVz]*o|--ou(?:t(?:p(?:u(?:t)?)?)?)?(?:=|$))/ : /^--out(?:=|$)/;
    const index = words.findIndex(word => option.test(word.value));
    if (index < 0) return undefined;
    const word = words[index];
    const inline = word.value.replace(option, "");
    return targets(inline ? [{ ...word, value: inline }] : words.slice(index + 1, index + 2), cwd);
  }
  if (name === "uniq") return targets((readCommandOperands(name, words.map(word => word.value)) ?? []).slice(1).map(value => ({ value, dynamic: false })), cwd);
  if (fileCommands.has(name) || name.startsWith("git ")) {
    const sub = words.findIndex(word => "git " + word.value === name);
    return targets(operands(words.slice(sub + 1)), cwd);
  }
  return undefined;
}

function gitCommand(args: string[]): { risk: PermissionRisk; name: string } {
  if (args.length === 1 && ["--version", "--help"].includes(args[0])) return { risk: "read", name: "git" };
  const index = gitSubcommandIndex(args);
  const sub = args[index];
  const flags = args.slice(index + 1);
  const name = sub && /^[a-z][a-z-]*$/.test(sub) ? "git " + sub : "git";
  // Explicit external diff and textconv options request execution. Other git
  // calls still depend on host config (diff drivers, pagers, fsmonitor, etc.).
  if (hasLongOption(flags, "--ext-diff") || hasLongOption(flags, "--textconv")) return { risk: "execute", name };
  if (["reset", "clean", "restore", "rm"].includes(sub) || sub === "branch" && flags.some(flag => /^-[^-]*[dD]|^--delete$/.test(flag)) ||
    sub === "push" && flags.some(flag => /^--(?:force(?:$|[=-])|mirror$|prune$|delete$)|^-[^-]*[fd]|^[+:]/.test(flag))) return { risk: "destructive", name };
  if (["fetch", "pull", "push"].includes(sub) || sub === "ls-remote" || sub === "clone") return { risk: "network", name };
  if (hasLongOption(flags, "--output") || hasLongOption(flags, "--output-directory")) return { risk: "write", name };
  if (gitWrite.has(sub)) return { risk: "write", name };
  if (sub === "branch") {
    if (flags.some(flag => /^(?:-[^-]*[mcMCu]|--(?:move|copy|edit-description|set-upstream-to|unset-upstream))/.test(flag))) return { risk: "write", name };
    const operands = readCommandOperands(name, args);
    if (!operands) return { risk: "unknown", name };
    return { risk: operands.length && !flags.includes("--list") ? "write" : "read", name };
  }
  return { risk: gitRead.has(sub) ? "read" : "unknown", name };
}

function commandRisk(name: string, args: string[]): PermissionRisk {
  if (args.length === 1 && ["--help", "--version"].includes(args[0]) &&
    (readCommands.has(name) || fileCommands.has(name) || interpreters.has(name) || ["curl", "wget", "gh", "npm"].includes(name))) return "read";
  if (["curl", "wget", "gh"].includes(name)) return "network";
  if (interpreters.has(name) || name === "eval") return "execute";
  if (name === "rm" || name === "rmdir" || name === "find" && args.includes("-delete")) return "destructive";
  if (name === "find" && args.some(arg => /^-(?:exec|ok)(?:dir)?$/.test(arg))) return "execute";
  if (name === "awk" && (args.some(arg => /\bsystem\s*\(|\||@(?:include|load)|^-(?:E|f|i|l|W)/.test(arg)) ||
    ["--file", "--include", "--load", "--exec"].some(option => hasLongOption(args, option)))) return "execute";
  if (name === "rg" && ["--pre", "--hostname-bin"].some(option => hasLongOption(args, option))) return "execute";
  if (name === "sort" && hasLongOption(args, "--compress-program")) return "execute";
  if (fileCommands.has(name) ||
    name === "find" && args.some(arg => /^-f(?:ls|print|print0|printf)$/.test(arg)) ||
    name === "sort" && (args.some(arg => /^-[bdfghiMmnRrsuVz]*o/.test(arg)) || hasLongOption(args, "--output")) ||
    name === "uniq" && (readCommandOperands(name, args)?.length ?? 0) >= 2 ||
    name === "awk" && (args.some(arg => arg.includes(">") || /^-[od]/.test(arg)) ||
      ["--pretty-print", "--profile", "--dump-variables"].some(option => hasLongOption(args, option))) ||
    name === "file" && args.some(arg => arg === "--compile" || /^-[^-]*C/.test(arg)) ||
    name === "sips" && args.some(arg => /^--(?:out|setProperty|deleteProperty|rotate|resample|crop|pad|flip|matchTo|embedProfile)|^-(?:s|d|o|r|z|Z|c|p|f|m|M|e|E)/.test(arg))) return "write";
  if (name === "sips") {
    const query = /^(?:-g|--getProperty(?:=.+)?)$/;
    return query.test(args[0] ?? "") && args.every(arg => !arg.startsWith("-") || query.test(arg)) ? "read" : "unknown";
  }
  return readCommands.has(name) ? "read" : "unknown";
}

function readTargets(name: string, args: string[], cwd?: string) {
  const files = readCommandOperands(name, args);
  if (!files) return null;
  if (!name.startsWith("git ")) {
    const implicitFolder = !files.length && ["ls", "find"].includes(name);
    return { cwd, files: implicitFolder ? ["."] : files };
  }
  for (let index = 0; index < gitSubcommandIndex(args); index++) {
    if (args[index] === "-C") cwd = resolveReadPath(args[++index], cwd);
  }
  const paths = name === "git show" ? files.map(file => /^[^:]*:(?:[0-3]:)?(.+)$/.exec(file)?.[1] ?? file) : files;
  return { cwd, files: [".", ...paths] };
}

type FolderCandidates = { paths: ReadonlySet<string | undefined>; uncertain: boolean };

function classify(command: ShellCommand, folders: FolderCandidates, workspace?: string): Operation & { readPathsUnresolved?: true; reads?: Omit<ShellReadTarget, "command">[] } {
  const cwd = folders.paths.size === 1 && !folders.uncertain ? folders.paths.values().next().value : workspace;
  const [program, ...words] = command.words;
  let name = concise(firstLine(program?.value)) || "";
  const args = words.map(word => word.value);
  let risk: PermissionRisk;
  let detail: string | undefined;
  const effects: PermissionRisk[] = [];
  let sed: ReturnType<typeof sedArguments> = null;
  if (!program) {
    risk = command.redirects.length ? "write" : "unknown";
    name = ">";
  } else if (program.dynamic || !/^[\w.-]+$/.test(name) || program.value !== name) {
    risk = "unknown";
    name = program.dynamic ? "" : name;
  } else if (name === "cd" && !command.redirects.length && !command.inputs.length && !command.substitutions.length &&
    words.length === 1 && !args[0].startsWith("-") && !words[0].dynamic) {
    return { name, risk: "folder", detail: displayPath(args[0], cwd) };
  } else if (name === "git") {
    ({ risk, name } = gitCommand(args));
  } else if ((name === "npm" || name === "bun") && packageActions.has(args[0])) {
    // Package downloads can also run lifecycle scripts and package entry points.
    risk = "execute";
    effects.push("network");
  } else if (name === "sed" && !(args.length === 1 && ["--help", "--version"].includes(args[0]))) {
    sed = sedArguments(args);
    risk = sed?.scripts.length || sed?.scriptFiles.length
      ? sed.scripts.map(sedScriptRisk).reduce<PermissionRisk>(moreRisk, sed.scriptFiles.length ? "execute" : "read") : "unknown";
    if (sed?.inPlace) effects.push("write");
  } else {
    risk = commandRisk(name, args);
  }
  const transfer = risk === "network" && (name === "curl" || name === "wget")
    ? (name === "curl" ? curlEffects : wgetEffects)(args) : undefined;
  if (transfer?.writes) effects.push("write");
  if (transfer?.sensitive || name === "gh" && risk === "network" && githubCredentialRead(args)) effects.push("sensitive-read");
  if (transfer) detail = concise([...new Set([...transfer.files, ...transfer.inputs])].map(file => displayPath(file, cwd)).join(", "));
  const reads = [...folders.paths].map(folder => sed ? { cwd: folder, files: [...sed.scriptFiles, ...sed.files] }
    : risk === "read" ? readTargets(name, args, folder) : null);
  const prints = name === "echo" || name === "printf";
  if (command.expandsInputParameters || prints && words.some(word => word.parameterExpansion)) effects.push("sensitive-read");
  if (risk === "read" && (reads.some(read => !read) || !prints && words.some(word => word.dynamic) || command.inputs.some(word => word.dynamic))) risk = "unknown";
  const inputFiles = [...command.inputs.filter(word => !word.dynamic).map(word => word.value), ...(transfer?.inputs ?? [])];
  const paths = [...reads.flatMap(read => read?.files.map(value => ({ value, cwd: read.cwd })) ?? []),
    ...[...folders.paths].flatMap(folder => inputFiles.map(value => ({ value, cwd: folder })))]
    .filter(path => path.value && path.value !== "-");
  const warnings = paths.map(path => ({ ...path, risks: readPathRisks(path.value, path.cwd, workspace) })).filter(path => path.risks.length);
  effects.push(...warnings.flatMap(path => path.risks));
  if (paths.length && folders.uncertain) effects.push("outside-read");
  if (command.redirects.length) {
    risk = moreRisk(risk, "write");
    detail = targets(command.redirects, cwd);
  } else if (risk === "execute" && (interpreters.has(name) || name === "eval")) {
    const inline = args.findIndex(arg => ["-c", "-e", "--eval", "-p", "--print"].includes(arg));
    detail = concise(firstLine(inline >= 0 ? args[inline + 1] : name === "eval" ? args.join(" ") : operands(words)[0]?.value));
  } else if (sed?.inPlace) {
    detail = concise(sed.files.map(file => displayPath(file, cwd)).join(", "));
  } else if (risk === "write" || risk === "destructive") {
    detail = fileTargets(name, words, cwd);
  }
  const highest = effects.reduce(moreRisk, risk);
  const additionalRisks = [...new Set([risk, ...effects])].filter(item => item !== highest && item !== "read");
  if (!detail && warnings.length) detail = concise([...new Set(warnings.map(path => displayPath(path.value, path.cwd)))].join(", "));
  return { name, risk: highest, ...(additionalRisks.length ? { additionalRisks } : {}), ...(detail ? { detail } : {}),
    ...(paths.length || command.inputs.some(word => word.dynamic) ? { readPathsUnresolved: true } : {}), reads: paths };
}

// Classifies literal command text without executing it or consulting the shell's
// environment, aliases, or functions. An unparsed request always has unknown risk.
export function classifyShellPermission(command: string, initialCwd?: string): ShellPermissionClassification {
  return shellPermissionTargets(command, initialCwd).classification;
}

// The same classification with the paths it found. Nothing is read from disk here: a caller that
// must know what a path really is (a symbolic link, a folder) resolves `reads` on the session's host.
export function shellPermissionTargets(command: string, initialCwd?: string): { classification: ShellPermissionClassification; reads: ShellReadTarget[] } {
  const parsed = shellCommands(command);
  const targets: ShellReadTarget[] = [];
  const classified: ShellPermissionClassification["commands"] = [];
  let risk: PermissionRisk = "read";
  let count = 0;
  let readPathsUnresolved = false;
  const add = (operation: ShellPermissionClassification["commands"][number]) => {
    classified.push(operation);
    if (operation.risk !== "folder") risk = moreRisk(risk, operation.risk);
  };
  const list = (commands: ShellCommand[], initial: FolderCandidates, nested = false) => {
    let folders = initial;
    for (const [index, item] of commands.entries()) {
      const { readPathsUnresolved: unresolved, reads = [], ...group } = classify(item, folders, initialCwd);
      readPathsUnresolved ||= unresolved === true;
      targets.push(...reads.map(read => ({ command: group.name, ...read })));
      if (group.risk !== "folder") count++;
      const directory = item.words[1]?.value;
      if (group.risk === "folder" && directory) {
        // A shell can keep the earlier directory when cd fails, is skipped by
        // a condition, or runs in another process (for example in a pipeline).
        targets.push(...[...folders.paths].map(path => ({ command: "cd", value: directory, cwd: path })));
        const next = new Set([...folders.paths, ...[...folders.paths].map(path => resolveReadPath(directory, path))]);
        folders = next.size > 16 ? { paths: folders.paths, uncertain: true } : { ...folders, paths: next };
        add(!nested && index === 0 && next.size === 1 ? { ...group, setsWorkingFolder: true } : group);
      } else {
        add(group);
      }
      for (const inner of item.substitutions) {
        add({ name: "$()", risk: "execute" });
        list(inner, folders, true);
      }
    }
  };
  if (parsed?.length) list(parsed, { paths: new Set([initialCwd]), uncertain: false });
  else add({ name: "", risk: "unknown" });
  return { classification: { risk, cwd: initialCwd, count, commands: classified, ...(readPathsUnresolved ? { readPathsUnresolved: true } : {}) }, reads: targets };
}

function shellSummary(command: string, initialCwd?: string): ShellSummary {
  const { commands, ...classification } = classifyShellPermission(command, initialCwd);
  const groups = new Map<string, Group>();
  for (const { setsWorkingFolder, ...operation } of commands) {
    if (setsWorkingFolder) continue;
    const key = JSON.stringify(operation);
    const prior = groups.get(key);
    groups.set(key, { ...operation, count: (prior?.count ?? 0) + 1 });
  }
  return { kind: "shell", ...classification, command, groups: [...groups.values()] };
}

const shellNames = new Set(["bash", "shell", "exec", "exec_command", "execute", "terminal", "run_terminal_command", "run_command"]);
const edits = new Set(["edit", "apply_patch", "multiedit", "strreplace", "edit_file", "str_replace_editor"]);
const writes = new Set(["write", "write_file", "create_file"]);
const reads = new Set(["read", "read_file"]);

export function permissionSummary(request: Request, sessionCwd?: string): PermissionSummary | null {
  if (request.kind !== "tool") return null;
  const { name, title, detail, input } = request;
  const tool = name.toLowerCase();
  const cwd = str(detail?.cwd) ?? str(input?.cwd) ?? str(input?.workdir) ?? sessionCwd;
  if (/^mcp__/.test(name) || tool === "mcp") return { kind: "mcp", risk: "unknown", target: concise(name === "mcp" ? title : name) };
  const command = detail?.type === "shell" ? str(detail.command)
    : shellNames.has(tool) ? str(input?.command) ?? str(input?.cmd) : undefined;
  if (command) return shellSummary(command, cwd);
  const path = str(detail?.filePath) ?? str(input?.file_path) ?? str(input?.filePath) ?? str(input?.path);
  const target = path ? displayPath(path, cwd) : undefined;
  if (tool === "delete" || tool === "delete_file") return { kind: "delete", risk: "destructive", target };
  if (detail?.type === "edit" || edits.has(tool)) return { kind: "edit", risk: "write", target };
  if (detail?.type === "write" || writes.has(tool)) return { kind: "write", risk: "write", target };
  if (detail?.type === "read" || reads.has(tool)) {
    const readRisks = path ? readPathRisks(path, cwd, sessionCwd ?? cwd) : [];
    const risk = readRisks.reduce<PermissionRisk>(moreRisk, "read");
    return { kind: "read", risk, target, ...(readRisks.length > 1 ? { additionalRisks: readRisks.filter(item => item !== risk) } : {}),
      ...(path && path !== "-" ? { readPathsUnresolved: true } : {}) };
  }
  if (detail?.type === "fetch") return { kind: "fetch", risk: "network", target: concise(detail.url) };
  return { kind: "unknown", risk: "unknown", target: concise(firstLine(name)) };
}

function riskLabel(risk: Group["risk"], t: Translate) {
  const labels = {
    read: ["읽기만", "Read only"],
    "sensitive-read": ["민감한 파일 읽기", "Read sensitive files"],
    "outside-read": ["작업 폴더 밖 읽기", "Read outside the working folder"],
    folder: ["폴더 이동", "Change folder"],
    write: ["파일 쓰기·변경", "Write or modify files"],
    network: ["네트워크 접근", "Network access"],
    execute: ["코드 실행", "Run code"],
    destructive: ["삭제·되돌리기", "Delete or revert"],
    unknown: ["알 수 없는 명령", "Unknown command"],
  } as const;
  const [ko, en] = labels[risk];
  return t(ko, en);
}

export function permissionHeading(summary: PermissionSummary, t: Translate) {
  if (summary.kind === "shell") {
    const folder = summary.cwd && folderName(summary.cwd);
    const count = summary.count > 0 && t(`명령 ${summary.count}개`, `${summary.count} command${summary.count === 1 ? "" : "s"}`);
    const risk = summary.risk === "read" && !summary.count ? "folder" : summary.risk;
    const observed = new Set(summary.groups.flatMap(group => [group.risk, ...(group.additionalRisks ?? [])]));
    const additional = [...risks].reverse().filter(item => item !== summary.risk && item !== "read" && observed.has(item));
    return [riskLabel(risk, t), ...additional.map(item => riskLabel(item, t)), count,
      folder && t(`${folder} 작업 폴더`, `${folder} working folder`)].filter(Boolean).join(" · ");
  }
  const labels = {
    read: ["파일 읽기", "Read file"], edit: ["파일 편집", "Edit file"], write: ["파일 쓰기", "Write file"], delete: ["파일 삭제", "Delete file"],
    mcp: ["MCP 도구 실행", "Run MCP tool"], fetch: ["네트워크 접근", "Network access"], unknown: ["도구 실행 요청", "Tool request"],
  } as const;
  const [ko, en] = labels[summary.kind];
  return [...(summary.kind === "read" && summary.risk !== "read"
    ? [summary.risk, ...(summary.additionalRisks ?? [])].map(risk => riskLabel(risk, t)) : [t(ko, en)]),
    summary.target].filter(Boolean).join(" · ");
}

export function permissionGroup(group: Group, t: Translate) {
  const operation = group.risk === "read"
    ? group.name === "git log" ? t("기록 읽기", "Read history")
      : ["rg", "grep", "find"].includes(group.name) ? t("검색", "Search") : undefined
    : riskLabel(group.risk, t);
  return [group.name && (group.count > 1 ? `${group.name} ×${group.count}` : group.name), operation,
    ...(group.additionalRisks ?? []).map(risk => riskLabel(risk, t)), group.detail].filter(Boolean).join(" · ");
}
