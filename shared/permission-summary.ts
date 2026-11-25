import { shellCommands, type ShellCommand, type ShellWord } from "./shell-permission-command";

const risks = ["read", "write", "network", "execute", "destructive", "unknown"] as const;
type Risk = typeof risks[number];
type Group = { name: string; risk: Risk | "folder"; count: number; detail?: string };
type ShellSummary = { kind: "shell"; risk: Risk; command: string; cwd?: string; count: number; groups: Group[] };
type ToolSummary = { kind: "read" | "edit" | "write" | "delete" | "mcp" | "fetch" | "unknown"; risk: Risk; target?: string };
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
const sensitiveArgs = new Set(["git", "sips", "sort", "rg", "find", "sed", "awk", "file"]);
const moreRisk = (a: Risk, b: Risk) => risks.indexOf(a) >= risks.indexOf(b) ? a : b;
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
    const option = name === "sort" ? /^(-o|--output(?:=|$))/ : /^--out(?:=|$)/;
    const index = words.findIndex(word => option.test(word.value));
    if (index < 0) return undefined;
    const word = words[index];
    const inline = word.value.replace(option, "");
    return targets(inline ? [{ ...word, value: inline }] : words.slice(index + 1, index + 2), cwd);
  }
  if (name === "sed") return targets(operands(words).filter(word => word.value).slice(1), cwd);
  if (fileCommands.has(name) || name.startsWith("git ")) {
    const sub = words.findIndex(word => "git " + word.value === name);
    return targets(operands(words.slice(sub + 1)), cwd);
  }
  return undefined;
}

function gitCommand(args: string[]): { risk: Risk; name: string; detail?: string } {
  if (args.length === 1 && ["--version", "--help"].includes(args[0])) return { risk: "read", name: "git" };
  let index = 0;
  while (args[index] === "-C" && args[index + 1]) index += 2;
  const sub = args[index];
  const flags = args.slice(index + 1);
  const name = sub && /^[a-z][a-z-]*$/.test(sub) ? "git " + sub : "git";
  if (flags.includes("--ext-diff")) return { risk: "execute", name };
  if (["reset", "clean", "restore", "rm"].includes(sub) || sub === "branch" && flags.some(flag => /^-[^-]*[dD]|^--delete$/.test(flag)) ||
    sub === "push" && flags.some(flag => /^--(?:force(?:$|[=-])|mirror$|prune$|delete$)|^-[^-]*[fd]|^[+:]/.test(flag))) return { risk: "destructive", name };
  if (["fetch", "pull", "push"].includes(sub) || sub === "ls-remote" || sub === "clone") return { risk: "network", name };
  if (flags.some(flag => /^--output(?:=|$)/.test(flag) || flag === "--output-directory")) return { risk: "write", name };
  if (gitWrite.has(sub)) return { risk: "write", name };
  if (sub === "branch") {
    if (flags.some(flag => /^(?:-[^-]*[mcMCu]|--(?:move|copy|edit-description|set-upstream-to|unset-upstream))/.test(flag))) return { risk: "write", name };
    return { risk: !flags.length || flags.every(flag => ["-a", "-r", "-l", "-v", "-vv", "--list", "--all", "--remotes", "--show-current"].includes(flag))
      ? "read" : flags[0] && !flags[0].startsWith("-") ? "write" : "unknown", name };
  }
  return { risk: gitRead.has(sub) ? "read" : "unknown", name };
}

function commandRisk(name: string, args: string[]): Risk {
  if (args.length === 1 && ["--help", "--version"].includes(args[0]) &&
    (readCommands.has(name) || fileCommands.has(name) || interpreters.has(name) || ["curl", "wget", "gh", "npm"].includes(name))) return "read";
  if (["curl", "wget", "gh"].includes(name) || ["npm", "bun"].includes(name) && ["install", "i", "ci", "add", "update", "dlx", "x"].includes(args[0])) return "network";
  if (interpreters.has(name) || name === "eval") return "execute";
  if (name === "rm" || name === "rmdir" || name === "find" && args.includes("-delete")) return "destructive";
  if (name === "find" && args.some(arg => /^-(?:exec|ok)(?:dir)?$/.test(arg))) return "execute";
  if (name === "awk" && args.some(arg => /\bsystem\s*\(|\||@(?:include|load)|^-(?:f|i|l|W)|^--(?:file|include|load|exec)/.test(arg))) return "execute";
  if (name === "rg" && args.some(arg => /^--(?:pre|hostname-bin)(?:=|$)/.test(arg))) return "execute";
  if (name === "sort" && args.some(arg => /^--compress-program(?:=|$)/.test(arg))) return "execute";
  if (fileCommands.has(name) ||
    name === "find" && args.some(arg => /^-f(?:ls|print|print0|printf)$/.test(arg)) ||
    name === "sort" && args.some(arg => /^-o|^--output(?:=|$)/.test(arg)) ||
    name === "awk" && args.some(arg => arg.includes(">")) || name === "file" && args.includes("-C") ||
    name === "sips" && args.some(arg => /^--(?:out|setProperty|deleteProperty|rotate|resample|crop|pad|flip)|^-(?:s|d|o|r|z|Z|c|p|f)/.test(arg))) return "write";
  if (name === "sips") return args[0] === "-g" || args[0] === "--getProperty" ? "read" : "unknown";
  if (name === "sed") {
    if (args.some(arg => /^-[^-]*i|^--in-place/.test(arg))) return "write";
    if (args.some(arg => /^(?:-f|--file)|^\s*(?:\d+[,\d]*\s*)?e\b|\/[^/]*e[^/]*$/.test(arg))) return "execute";
    if (args.some(arg => /\/[^/]*w[^/]*$|^\s*(?:\d+[,\d]*\s*)?w\s/.test(arg))) return "write";
    // Give the read label to common print and substitution forms. Other sed programs
    // may contain commands with side effects, arbitrary delimiters or GNU extensions.
    return args[0] === "-n" && /^(?:[\d,$]*p|s\/(?:[^/\\]|\\.)*\/(?:[^/\\]|\\.)*\/[gp0-9]*)$/.test(args[1] ?? "") &&
      args.slice(2, args.includes("--") ? args.indexOf("--") : undefined).every(arg => !arg.startsWith("-")) ? "read" : "unknown";
  }
  return readCommands.has(name) ? "read" : "unknown";
}

function classify(command: ShellCommand, cwd?: string): Omit<Group, "count"> {
  const [program, ...words] = command.words;
  let name = concise(firstLine(program?.value)) || "";
  const args = words.map(word => word.value);
  let risk: Risk;
  let detail: string | undefined;
  if (!program) {
    risk = command.redirects.length ? "write" : "unknown";
    name = ">";
  } else if (program.dynamic || !/^[\w.-]+$/.test(name) || program.value !== name) {
    risk = "unknown";
    name = program.dynamic ? "" : name;
  } else if (name === "cd" && !command.redirects.length && !command.substitutions.length &&
    words.length === 1 && !args[0].startsWith("-") && !words[0].dynamic) {
    return { name, risk: "folder", detail: displayPath(args[0], cwd) };
  } else if (name === "git") {
    ({ risk, name } = gitCommand(args));
  } else {
    risk = commandRisk(name, args);
  }
  if (risk === "read" && sensitiveArgs.has(program.value) && words.some(word => word.dynamic)) risk = "unknown";
  if (command.redirects.length) {
    risk = moreRisk(risk, "write");
    detail = targets(command.redirects, cwd);
  } else if (risk === "execute" && (interpreters.has(name) || name === "eval")) {
    const inline = args.findIndex(arg => ["-c", "-e", "--eval", "-p", "--print"].includes(arg));
    detail = concise(firstLine(inline >= 0 ? args[inline + 1] : name === "eval" ? args.join(" ") : operands(words)[0]?.value));
  } else if (risk === "write" || risk === "destructive") {
    detail = fileTargets(name, words, cwd);
  }
  return { name, risk, ...(detail ? { detail } : {}) };
}

function shellSummary(command: string, initialCwd?: string): ShellSummary {
  const parsed = shellCommands(command);
  let cwd = initialCwd;
  const groups = new Map<string, Group>();
  let risk: Risk = "read";
  let count = 0;
  const add = (group: Omit<Group, "count">) => {
    const key = JSON.stringify(group);
    const earlier = groups.get(key);
    groups.set(key, { ...group, count: (earlier?.count ?? 0) + 1 });
    if (group.risk !== "folder") risk = moreRisk(risk, group.risk);
  };
  const list = (commands: ShellCommand[], nested = false) => {
    for (const [index, item] of commands.entries()) {
      const group = classify(item, cwd);
      if (group.risk !== "folder") count++;
      // A leading cd in a chain gives the intended working folder. Keep other
      // changes visible without assuming that conditional branches will run.
      const directory = item.words[1]?.value;
      if (!nested && index === 0 && group.risk === "folder" && directory && /^(?:[a-z]:[\\/]|[~/])/i.test(directory)) {
        cwd = directory;
      } else add(group);
      for (const inner of item.substitutions) {
        add({ name: "$()", risk: "execute" });
        list(inner, true);
      }
    }
  };
  if (parsed?.length) list(parsed);
  else add({ name: "", risk: "unknown" });
  return { kind: "shell", risk, command, cwd, count, groups: [...groups.values()] };
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
  if (detail?.type === "read" || reads.has(tool)) return { kind: "read", risk: "read", target };
  if (detail?.type === "fetch") return { kind: "fetch", risk: "network", target: concise(detail.url) };
  return { kind: "unknown", risk: "unknown", target: concise(firstLine(name)) };
}

function riskLabel(risk: Group["risk"], t: Translate) {
  const labels = {
    read: ["읽기만", "Read only"],
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
    return [riskLabel(risk, t), count, folder && t(`${folder} 작업 폴더`, `${folder} working folder`)].filter(Boolean).join(" · ");
  }
  const labels = {
    read: ["파일 읽기", "Read file"], edit: ["파일 편집", "Edit file"], write: ["파일 쓰기", "Write file"], delete: ["파일 삭제", "Delete file"],
    mcp: ["MCP 도구 실행", "Run MCP tool"], fetch: ["네트워크 접근", "Network access"], unknown: ["도구 실행 요청", "Tool request"],
  } as const;
  const [ko, en] = labels[summary.kind];
  return [t(ko, en), summary.target].filter(Boolean).join(" · ");
}

export function permissionGroup(group: Group, t: Translate) {
  const operation = group.risk === "read"
    ? group.name === "git log" ? t("기록 읽기", "Read history")
      : ["rg", "grep", "find"].includes(group.name) ? t("검색", "Search") : undefined
    : riskLabel(group.risk, t);
  return [group.name && (group.count > 1 ? `${group.name} ×${group.count}` : group.name), operation, group.detail].filter(Boolean).join(" · ");
}
