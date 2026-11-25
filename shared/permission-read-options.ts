// Only exact options in these lists qualify as reads. A value-taking option
// consumes its argument before the remaining words are interpreted as operands.
type ReadOptions = { short?: string; shortValue?: string; flags?: string; values?: string; optionalValues?: string; numeric?: boolean };
const gitHistory: ReadOptions = { short: "pqs", shortValue: "n", numeric: true,
  flags: "--oneline --stat --shortstat --summary --name-only --name-status --no-patch --patch --all --graph --no-decorate --no-color --no-ext-diff --no-textconv --no-notes --first-parent --reverse --full-history",
  values: "--max-count --format --since --until --author --grep", optionalValues: "--pretty --decorate --abbrev" };
const search: ReadOptions = {
  short: "abcHhilLnNoqrsSuvwxzFEPIR", shortValue: "ABCemfg",
  flags: "--line-number --no-line-number --fixed-strings --ignore-case --smart-case --hidden --no-ignore --files --files-with-matches --files-without-match --count --only-matching --invert-match --word-regexp --no-heading --heading --no-config --no-messages --text --quiet",
  values: "--regexp --file --glob --iglob --type --type-not --max-count --max-depth --max-filesize --context --after-context --before-context",
  optionalValues: "--color",
};

const readOptions: Readonly<Record<string, ReadOptions>> = {
  ls: { short: "aAbcCdFghHikLlmnopqrRstUux1", flags: "--all --almost-all --directory --human-readable --reverse --recursive", values: "--sort --time-style --format", optionalValues: "--color --classify" },
  cat: { short: "AbBenstTuv", flags: "--number --number-nonblank --show-all --show-ends --show-tabs --show-nonprinting --squeeze-blank" },
  head: { short: "qv", shortValue: "nc", numeric: true, flags: "--quiet --verbose", values: "--lines --bytes" },
  tail: { short: "fqvF", shortValue: "ncs", numeric: true, flags: "--quiet --verbose --follow", values: "--lines --bytes --sleep-interval --pid" },
  wc: { short: "clmLw", flags: "--bytes --chars --lines --max-line-length --words" },
  sort: { short: "bdfghiMmnRrsuVz", shortValue: "ktS", flags: "--ignore-leading-blanks --dictionary-order --ignore-case --general-numeric-sort --human-numeric-sort --numeric-sort --reverse --stable --unique --version-sort --zero-terminated", values: "--key --field-separator --buffer-size --parallel" },
  uniq: { short: "cdiuz", shortValue: "fsw", flags: "--count --repeated --ignore-case --unique --zero-terminated", values: "--skip-fields --skip-chars --check-chars" },
  rg: { ...search, short: search.short?.replace("L", "") },
  grep: { ...search, short: search.short?.replace("R", ""), flags: search.flags + " --recursive" },
  find: { flags: "-H -L -P -print -print0 -ls -depth -empty -readable -writable -executable -xdev -mount -ignore_readdir_race -not -and -or", values: "-name -iname -path -ipath -type -xtype -maxdepth -mindepth -size -mtime -mmin -user -group -perm" },
  awk: { shortValue: "F", values: "--field-separator" },
  readlink: { short: "efmnqsvz", flags: "--canonicalize --canonicalize-existing --canonicalize-missing --no-newline --quiet --silent --verbose --zero" },
  stat: { short: "fLt", shortValue: "c", flags: "--dereference --file-system --terse", values: "--format --printf" },
  file: { short: "bEhikLNnprsz", flags: "--brief --mime --mime-type --mime-encoding --dereference --no-dereference --no-buffer --extension", values: "--exclude" },
  sips: { shortValue: "g", values: "--getProperty" },
  echo: { short: "Een" },
  printf: {},
  pwd: { short: "LP", flags: "--logical --physical" },
  "git log": gitHistory,
  "git show": gitHistory,
  "git diff": { short: "pqsuwbR", flags: "--cached --staged --stat --shortstat --summary --name-only --name-status --numstat --no-patch --patch --no-index --no-ext-diff --no-textconv --no-color --check --exit-code --ignore-space-change --ignore-all-space --no-renames", values: "--diff-filter", optionalValues: "--unified --color" },
  "git status": { short: "sbzv", flags: "--short --branch --long --no-renames --show-stash", optionalValues: "--untracked-files --ignored --porcelain" },
  "git branch": { short: "arv", flags: "--list --all --remotes --show-current --no-color", values: "--format --sort", optionalValues: "--contains --no-contains --merged --no-merged" },
  "git rev-parse": { flags: "--verify --show-toplevel --show-prefix --show-cdup --git-dir --absolute-git-dir --is-inside-work-tree --is-bare-repository --symbolic --symbolic-full-name --quiet", optionalValues: "--short --abbrev-ref" },
  "git merge-base": { short: "ao", flags: "--all --octopus --independent --is-ancestor --fork-point" },
  "git blame": { short: "selw", shortValue: "L", flags: "--line-porcelain --porcelain --show-name --show-number --date", values: "--date" },
};

function safeReadOperands(args: string[], rules: ReadOptions) {
  const flags = new Set((rules.flags ?? "").split(" "));
  const values = new Set((rules.values ?? "").split(" "));
  const optionalValues = new Set((rules.optionalValues ?? "").split(" "));
  const operands: string[] = [];
  const patternFiles: string[] = [];
  let patternOption = false;
  let recursive = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === "--") { operands.push(...args.slice(index + 1)); break; }
    if (word === "-" || !word.startsWith("-")) { operands.push(word); continue; }
    if (rules.numeric && /^-\d+$/.test(word)) continue;
    const equals = word.indexOf("=");
    const flag = equals < 0 ? word : word.slice(0, equals);
    if (equals < 0 && flags.has(flag)) {
      recursive ||= flag === "--recursive";
      continue;
    }
    if (optionalValues.has(flag)) continue;
    if (values.has(flag)) {
      if (["--file", "--regexp"].includes(flag)) patternOption = true;
      const value = equals < 0 ? args[++index] : word.slice(equals + 1);
      if (value === undefined || equals < 0 && value.startsWith("-") && value !== "-") return null;
      if (flag === "--file") patternFiles.push(value);
      continue;
    }
    if (word.startsWith("--") || (rules === readOptions.find)) return null;
    for (let offset = 1; offset < word.length; offset++) {
      const option = word[offset];
      if (rules.shortValue?.includes(option)) {
        if (["e", "f"].includes(option)) patternOption = true;
        const attached = word.slice(offset + 1);
        const value = attached || args[++index];
        if (value === undefined || !attached && value.startsWith("-") && value !== "-") return null;
        if (option === "f" && (rules === readOptions.rg || rules === readOptions.grep)) patternFiles.push(value);
        break;
      }
      if (!rules.short?.includes(option)) return null;
      recursive ||= option === "r";
    }
  }
  return { operands, patternOption, patternFiles, recursive };
}

export function gitSubcommandIndex(args: string[]) {
  let index = 0;
  while (args[index] === "--no-pager" || args[index] === "-C" && args[index + 1]) {
    index += args[index] === "-C" ? 2 : 1;
  }
  return index;
}

export function readCommandOperands(name: string, args: string[]): string[] | null {
  if (args.length === 1 && ["--help", "--version"].includes(args[0])) return [];
  const rules = Object.hasOwn(readOptions, name) ? readOptions[name] : undefined;
  if (!rules) return null;
  if (name.startsWith("git ")) args = args.slice(gitSubcommandIndex(args) + 1);
  const parsed = safeReadOperands(args, rules);
  if (!parsed) return null;
  if (name === "awk") {
    // Only a simple print action with literal field numbers can qualify. AWK
    // programs and options can load files, invoke external commands, and write.
    if (!/^\s*\{\s*print(?:\s+\$\d+(?:\s*,\s*\$\d+)*)?\s*;?\s*\}\s*$/.test(parsed.operands[0] ?? "")) return null;
    return parsed.operands.slice(1);
  }
  if (name === "rg" || name === "grep") {
    const files = parsed.patternOption || args.includes("--files") ? parsed.operands : parsed.operands.slice(1);
    return [...parsed.patternFiles, ...(!files.length && (name === "rg" || parsed.recursive) ? ["."] : files)];
  }
  return ["echo", "printf", "pwd"].includes(name) ? [] : parsed.operands;
}

export function hasLongOption(args: string[], option: string) {
  for (const arg of args) {
    if (arg === "--") return false;
    const flag = arg.split("=", 1)[0];
    if (flag.startsWith("--") && flag.length >= 4 && option.startsWith(flag)) return true;
  }
  return false;
}
