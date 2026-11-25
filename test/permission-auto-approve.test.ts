import { expect, test } from "bun:test";
import { readOnlyShellPlan, permissionAutoApprove, withAutoApprovals, AUTO_APPROVAL_KEEP, type AutoApprovalRequest } from "../shared/permission-auto-approve";
import { guardedWord, hiddenPart } from "../shared/permission-read-paths";

const workspace = "/Users/you/projects/alpha";
const claude = (command: string, input: Record<string, unknown> = {}, extra: Partial<AutoApprovalRequest> = {}): AutoApprovalRequest =>
  ({ provider: "claude", name: "Bash", kind: "tool", input: { command, ...input }, detail: { type: "shell", command }, ...extra });
const codex = (command: string, cwd: string | undefined = workspace): AutoApprovalRequest =>
  ({ provider: "codex", name: "CodexBash", kind: "tool", input: { command, ...(cwd ? { cwd } : {}) }, detail: { type: "shell", command } });
const refusal = (request: AutoApprovalRequest) => { const result = readOnlyShellPlan(request, workspace); return "refused" in result ? result.refused : null; };
const plan = (request: AutoApprovalRequest) => { const result = readOnlyShellPlan(request, workspace); if ("refused" in result) throw Error(result.refused); return result.plan; };

test("the setting is a host setting that starts off", () => {
  expect(permissionAutoApprove.scope).toBe("host");
  expect(permissionAutoApprove.schema.parse({})).toEqual({ readOnlyShell: false });
});

test("a read-only command with a stated folder is planned as one plain allow with every path to resolve", () => {
  const result = plan(codex("cd ./src && cat index.ts | head -n 5; ls"));
  expect(result.response).toEqual({ behavior: "allow" });
  expect(result.cwd).toBe(workspace);
  expect(result.summary).toBe("cd · cat · head · ls");
  expect(result.reads).toContainEqual({ command: "cd", value: "./src", cwd: workspace, content: false });
  expect(result.reads).toContainEqual({ command: "cat", value: "index.ts", cwd: workspace + "/src", content: true });
  // A failed `cd` leaves the shell in the earlier folder, so that folder is resolved as well.
  expect(result.reads).toContainEqual({ command: "cat", value: "index.ts", cwd: workspace, content: true });
  expect(result.reads).toContainEqual({ command: "ls", value: ".", cwd: workspace + "/src", content: false });
  expect(plan(codex("pwd")).reads).toEqual([]);
  expect(plan(codex("rg -n sample src/index.ts")).reads).toEqual([{ command: "rg", value: "src/index.ts", cwd: workspace, content: true }]);
});

test("Codex's shell wrapper is read with the board's tokenizer and anything else around it is refused", () => {
  expect(plan(codex(`/bin/zsh -lc 'cat README.md'`)).summary).toBe("cat");
  expect(plan(codex(`bash -lc 'rg -n '"'"'a b'"'"' README.md'`)).command).toBe("rg -n 'a b' README.md");
  expect(refusal(codex(`/bin/zsh -lc 'cat README.md' > out.txt`))).toBe("expansion");
  expect(refusal(codex(`/bin/zsh -lc "cat $FILE"`))).toBe("expansion");
  expect(refusal(codex(`/bin/zsh -lc 'cat README.md; rm README.md'`))).toBe("risk");
  expect(refusal(codex(`/bin/zsh -lc 'cat README.md' extra`))).toBe("risk");
  expect(refusal(codex(`/opt/tools/zsh -lc 'cat README.md'`))).toBe("risk");
  // Claude runs the line itself, so a shell given a script there is an interpreter call.
  expect(refusal(claude(`bash -lc 'cat ${workspace}/README.md'`))).toBe("risk");
});

test("a provider that does not say where the command runs gets only absolute paths approved", () => {
  expect(plan(claude(`cat ${workspace}/README.md`)).reads).toEqual([{ command: "cat", value: workspace + "/README.md", cwd: workspace, content: true }]);
  expect(plan(claude("pwd")).cwd).toBeUndefined();
  for (const command of ["cat README.md", "ls", "rg -n sample", `cd ${workspace}/src && cat index.ts`, "cd src", "cd ./src"]) {
    expect([command, refusal(claude(command))]).toEqual([command, "relative"]);
  }
  expect(refusal(codex("cat README.md", ""))).toBe("relative");
});

test("only checked shell requests without choices of their own are considered", () => {
  expect(refusal({ ...claude("pwd"), kind: "question" })).toBe("source");
  expect(refusal({ ...claude("pwd"), name: "Read" })).toBe("source");
  expect(refusal({ ...claude("pwd"), provider: "opencode", name: "bash" })).toBe("source");
  expect(refusal({ ...claude("pwd"), detail: { type: "unknown" } })).toBe("source");
  expect(refusal({ ...claude("pwd"), input: { cmd: "pwd" } })).toBe("source");
  expect(refusal({ ...claude("pwd"), input: { command: "  " } })).toBe("source");
  expect(refusal({ ...codex("pwd"), name: "CodexFileChange" })).toBe("source");
  expect(refusal(claude("pwd", {}, { actions: [{ id: "allow_always", label: "Always", behavior: "allow" }] }))).toBe("action");
  expect(refusal(claude("pwd", {}, { detail: { type: "shell", command: "pwd; rm x" } }))).toBe("input");
  // Claude's input is held to the keys that were checked. Any other key, whatever its value, goes to a person.
  for (const extra of [{ dangerouslyDisableSandbox: true }, { dangerouslyDisableSandbox: false }, { run_in_background: true }, { run_in_background: false }, { shell: "sh" }, { cwd: workspace }]) {
    expect([extra, refusal(claude("pwd", extra))]).toEqual([extra, "input"]);
  }
  expect(refusal({ ...codex("pwd"), input: { command: "pwd", cwd: "relative/folder" } })).toBe("input");
  expect(refusal({ ...codex("pwd"), input: { command: "pwd", cwd: 3 } })).toBe("input");
  expect(plan(claude("pwd", { description: "Show the folder", timeout: 1000 })).summary).toBe("pwd");
});

test("redirection, substitution, expansion and an environment prefix send the request to a person", () => {
  for (const [command, reason] of [
    ["git log > out.txt", "redirect"], ["cat README.md >> out.txt", "redirect"], ["cat < README.md", "redirect"],
["cat <<EOF\nsample\nEOF", "redirect"], ["cat <<'EOF'\nsample; rm x\nEOF", "redirect"], ["cat <<< sample", "redirect"],
    ["ls $(echo src)", "expansion"], ["ls `echo src`", "expansion"], ["echo $HOME", "expansion"], ['echo "$SAMPLE_TOKEN"', "expansion"],
    ["ls *.ts", "expansion"], ["cat src/[ab].ts", "expansion"], ["echo *", "expansion"],
    ["echo <(ls)", "syntax"], ["ls {a,b}", "syntax"], ["ls &", "syntax"], ["(ls)", "syntax"], ["cat 'unterminated", "syntax"],
    [String.raw`echo $'\'' ; rm y ; echo $'\'' x'`, "syntax"], ["ls # ; rm x", "syntax"], ["rg '#include' src/a.c", "syntax"],
    ["ls\rrm x", "syntax"], ["ls \u0007", "syntax"],
    ["eval ls", "risk"], ["FOO=bar ls", "risk"], ["env ls", "risk"], ["command ls", "risk"], ["sudo ls", "risk"],
    ["ls; rm x", "risk"], ["ls && mystery", "risk"], ["cat README.md | sh", "risk"], ["cat README.md | tee out.txt", "risk"],
    ["curl https://example.invalid", "risk"], ["python3 -c 'print(1)'", "risk"], ["npm ci", "risk"],
  ]) expect([command, refusal(codex(command))]).toEqual([command, reason]);
  expect(plan(codex("echo 'a;b' && ls 2>&1")).summary).toBe("echo · ls");
  // Output thrown away to exactly /dev/null writes nothing. Any other target, and reading from it, stays a redirect.
  for (const command of ["ls 2>/dev/null", "ls >/dev/null", "ls &>/dev/null", "ls > /dev/null 2>&1", "ls 2>>/dev/null", "ls &>>/dev/null", "ls 2> '/dev/null'", "cat README.md 2>/dev/null | head -n 3"]) {
    expect([command, refusal(codex(command))]).toEqual([command, null]);
  }
  for (const command of ["ls 2>/dev/null2", "ls >/dev/null/x", "ls >/dev/../dev/null", "ls > dev/null", "ls >/dev/zero", "ls >/dev/null >out.txt", "ls 2>/dev/null >out.txt",
    "ls < /dev/null", "ls <>/dev/null", "ls >/dev/nul*"]) {
    expect([command, ["redirect", "expansion"].includes(refusal(codex(command)) ?? "")]).toEqual([command, true]);
  }
  // Characters only some shells expand are refused when they stand outside quotes: zsh turns "=name"
  // into the path of a command, and extended globbing reads "^" and a later "~" as patterns.
  for (const command of ["cat =ls", "cat a^b", "cat notes.txt~", "cat a~b", "rg --file=~/patterns README.md", "ls ^README.md"]) {
    expect([command, refusal(codex(command))]).toEqual([command, "expansion"]);
  }
  for (const command of ["rg '^import' src/index.ts", "sed -n '/^a/p' README.md", 'rg "a~b" README.md', "rg -e '=x' README.md", "sort -t= -k2 README.md", "rg --color=never x README.md"]) {
    expect([command, refusal(codex(command))]).toEqual([command, null]);
  }
});

test("the options that slipped past an earlier classifier stay with a person", () => {
  for (const command of ["uniq in out", "uniq -c in out", "sort -uo out in", "sort -ro out in", "sort --out=out in", "sort --compress-prog=sh",
    "awk -E prog.awk", "awk -o x", "awk --profile=x", "awk -d x", "awk '{print > \"out.txt\"}' in", "awk 'BEGIN {system(\"echo hi\")}'",
    "sort --unverified in", "uniq -Z in", "rg --unverified text in", "rg --pre=custom pattern", "sed -f program.sed in", "sed -ni 's/a/b/' in",
    "sed -e '1e echo sample' in", "sed -e 's/x/y/w out.txt' in", "find . -delete", "find . -exec echo {} \;", "find . -fprint out",
    "file --compile -m magic", "sips -g pixelWidth --out result image.png", "my-tool --help"]) {
    expect([command, refusal(codex(command))]).toEqual([command, "risk"]);
  }
  // The card labels a version query "read". The rule still approves only the commands on its own list.
  expect(refusal(codex("node --version"))).toBe("command");
});

// bash's printf can write a shell variable ("%n" stores a count in the named variable), so a later
// command in the same request could be looked up through a changed PATH.
test("printf is not approved by the rule", () => {
  for (const command of ["printf '%n' PATH; cat README.md", "printf '%n' PATH", "printf '%s\\n' sample", "printf sample", "cat README.md | printf '%s'"]) {
    expect([command, refusal(codex(command))]).toEqual([command, "command"]);
  }
  expect(refusal(codex("printf -v PATH 0"))).toBe("risk");
  expect(plan(codex("echo sample")).summary).toBe("echo");
});

test("git is not approved by the rule, even for a read", () => {
  for (const command of ["git status", "git log --oneline", "git diff --no-ext-diff --no-textconv", "git --no-pager log -4", "git --version", "git diff --ext-di", "git log --outp=o"]) {
    expect([command, refusal(codex(command))]).toEqual([command, command.includes("--ext") || command.includes("--outp") ? "risk" : "command"]);
  }
});

test("a bare relative cd, following a file and searching compressed files are refused", () => {
  // CDPATH can send a bare name somewhere else. "./" and an absolute path cannot be redirected.
  for (const command of ["cd src", "cd src && ls", "cd src/lib", "cd ..", "cd ./src && cd lib"]) expect([command, refusal(codex(command))]).toEqual([command, "relative"]);
  for (const command of ["cd ./src", "cd ./src && ls", `cd ${workspace}/src && ls`]) expect([command, refusal(codex(command))]).toEqual([command, null]);
  for (const command of ["tail -f log.txt", "tail -F log.txt", "tail -n 5 -f log.txt", "tail -fn5 log.txt", "tail --follow log.txt", "tail --follow=name log.txt",
    "rg -z x a.gz", "rg -nz x a.gz", "rg --search-zip x a.gz",
    // `file` also hands a compressed file to an external program when asked to look inside it.
    "file -z archive.gz", "file -bz archive.gz", "file -zb archive.gz", "file -Z archive.gz", "file --uncompress archive.gz", "file --uncompress-noreport archive.gz"]) {
    expect([command, ["option", "risk"].includes(refusal(codex(command)) ?? "")]).toEqual([command, true]);
  }
  for (const command of ["tail -n 5 log.txt", "tail -c 100 log.txt", "rg -n x a.txt", "grep -z x a.txt", "file -b archive.gz", "file --mime-type archive.gz"]) expect([command, refusal(codex(command))]).toEqual([command, null]);
});

// Codex builds the command line by joining the argv with shell quoting (shlex), so reading it back
// with a POSIX tokenizer gives the argv again. These are lines in that form.
test("a Codex command line in shlex form is read back into the script it carries", () => {
  for (const [line, script] of [
    ["/bin/zsh -lc 'cat README.md'", "cat README.md"],
    ["/bin/zsh -lc pwd", "pwd"],
    [`bash -lc "rg -n 'a b' README.md"`, "rg -n 'a b' README.md"],
    [`bash -lc 'rg -n "a b" README.md'`, 'rg -n "a b" README.md'],
    [`bash -lc 'rg -n '"'"'a b'"'"' README.md'`, "rg -n 'a b' README.md"],
    ["cat README.md", "cat README.md"],
    ["cat 'two words.md'", "cat 'two words.md'"],
  ]) expect([line, plan(codex(line)).command]).toEqual([line, script]);
  // A quoted script that would expand or run something is judged as that script.
  expect(refusal(codex(String.raw`bash -lc "echo \$HOME"`))).toBe("expansion");
  expect(refusal(codex(String.raw`bash -lc "cat \`ls\`"`))).toBe("expansion");
  expect(refusal(codex("bash -lc 'cat a; rm a'"))).toBe("risk");
  expect(refusal(codex("<command included NUL byte>"))).not.toBeNull();
});

// Many utilities stop reading options at the first operand and take every later word as a file,
// so a word the board reads as an option's value there would be a file it never resolved.
test("an option written after an operand is refused", () => {
  for (const command of ["head safe.txt -n ../private.txt", "head safe.txt -n 5", "cat a.txt -n", "tail a.txt -c 10", "wc a.txt -l", "sort a.txt -k 2", "uniq a.txt -c",
    "ls src -la", "stat a.txt -c %s", "file a.txt -b", "readlink a -f", "rg sample a.txt -n", "grep sample a.txt -f patterns.txt", "rg sample a.txt --file patterns.txt",
    "awk '{print $1}' a.txt -F :", "sips a.png -g all", "head -n 5 a.txt -5"]) {
    expect([command, refusal(codex(command))]).toEqual([command, "option"]);
  }
  for (const command of ["head -n 5 -q safe.txt", "sort -t , -k 2 a.txt", "rg -n -e sample -g '*.ts' a.txt", "grep -n -e sample a.txt", "cat -- a.txt -n", "ls -la -- src -R",
    "head -n 5 -- -n", "tail -c 10 a.txt", "echo a -n", "find . -name sample -type f", "sed -n '1,5p' a.txt", "cat -", "cat - a.txt"]) {
    expect([command, refusal(codex(command))]).toEqual([command, null]);
  }
});

test("an option that follows symbolic links while listing is refused", () => {
  for (const command of ["find -L . -name sample", "find -H .", "ls -lL", "ls -RL src", "stat -L src", "file -L src", "file --dereference src"]) {
    expect([command, refusal(codex(command))]).toEqual([command, "option"]);
  }
  expect(plan(codex("find . -name '*.ts' -type f")).summary).toBe("find");
  expect(plan(codex("ls -la -- -L")).reads).toEqual([{ command: "ls", value: "-L", cwd: workspace, content: false }]);
});

test("a sensitive name anywhere in the request is refused, path or not", () => {
  for (const command of ["cat .env", "cat config/.env.local", "rg -n x ~/.ssh", "find / -name id_rsa", "find . -name 'id_*'", "find . -name '*.pem'",
    "cat server.key", "cat ~/.aws/credentials", "ls ~/.config/gh", "cat credentials.json", "cat prod.tfvars", "ls ~/Library/Keychains",
    "rg '.env' README.md", "rg --file=.env README.md", "grep -f .env notes.txt", "echo id_ed25519", "cat secrets.yaml", "cat .netrc", "cat ~/.zsh_history",
    "find . -name '*.env'", "cat token.json", "cd ./.ssh",
    "cat terraform.tfstate", "cat terraform.tfstate.backup", "cat auth.json", "cat service-account.json", "cat my-service_account-prod.json", "cat kubeconfig",
    "cat aws-credentials.txt", "cat store.p12", "cat release.keystore",
    // A command that reads contents is refused every dot name outside a short list.
    "cat .git/config", "cat .mcp.json", "cat .dev.vars", "cat .npmrc", "cat config/.settings/app.json", "head -n 3 .vscode/settings.json", "rg -n x .claude/settings.json",
    "cd ./.git && cat config"]) {
    expect([command, refusal(codex(command))]).toEqual([command, "sensitive"]);
  }
  expect(refusal(claude(`cat ${workspace}/.env`))).toBe("sensitive");
  for (const word of [".env", ".env.local", "a.pem", "server.key", "id_rsa", "id_ed25519.pub", "id_*", "~/.ssh/config", "~/.aws/credentials", "~/.config/gh/hosts.yml",
    "credentials.json", "credentials*", "prod.tfvars", "~/Library/Keychains/login.keychain-db", "*.env", "--file=.env", "--file=id_rsa", String.raw`C:\Users\you\.ssh\id_ed25519`,
    ".docker/config.json", "vault.kdbx", ".bash_history", "passwords.txt", ".secret"]) {
    expect([word, guardedWord(word)]).toEqual([word, true]);
  }
  for (const word of ["README.md", "src/index.ts", "-n", "1,5p", "identity.ts", "package.json", "tokenizer.ts", "environment.ts", "keys.ts", "--color=auto", "author.json", "kube.ts"]) {
    expect([word, guardedWord(word)]).toEqual([word, false]);
  }
  for (const word of ["terraform.tfstate", "prod.tfstate.backup", "auth.json", "gcp-service-account.json", "kubeconfig", "db_credentials.yaml", "cert.p12"]) {
    expect([word, guardedWord(word)]).toEqual([word, true]);
  }
  // The few dot names that hold no secrets by convention can be read. Listing a dot folder shows names only.
  for (const command of ["cat .gitignore", "cat .gitattributes .editorconfig .nvmrc", "cat .github/workflows/ci.yml", "ls -la .git", "find .git -name config", "stat .mcp.json"]) {
    expect([command, refusal(codex(command))]).toEqual([command, null]);
  }
  for (const path of [".git/config", "a/.b/c", ".mcp.json", "x/.GitHub2/y"]) expect([path, hiddenPart(path)]).toEqual([path, true]);
  for (const path of ["a/b.c", "./a", "../a", ".github/x", ".GITIGNORE", "a/.nvmrc"]) expect([path, hiddenPart(path)]).toEqual([path, false]);
});

test("reads outside the stated folder are refused before the host is asked", () => {
  for (const command of ["cat ../notes.txt", "cat /etc/hosts", "ls ~", "cd ./.. && ls", "cd /tmp && cat a.txt", "ls ~/projects"]) {
    expect([command, refusal(codex(command))]).toEqual([command, "risk"]);
  }
});

test("an oversized request is refused", () => {
  expect(refusal(codex("echo " + "a".repeat(4100)))).toBe("size");
  expect(refusal(codex("cat " + Array.from({ length: 70 }, (_, index) => `f${index}.txt`).join(" ")))).toBe("size");
});

test("the record keeps one entry per request, replaces its state, drops old entries and stays bounded", () => {
  const day = 24 * 60 * 60 * 1000, now = 100 * day;
  const entry = (request: string, at: number, state: "sent" | "allowed" = "sent") =>
    ({ session: "worker-1", request, at, title: "Worker", projectId: "alpha", summary: "cat", command: "cat README.md", state });
  const next = withAutoApprovals([entry("request-1", now - 20 * day), entry("request-2", now - day)], [entry("request-2", now - day, "allowed"), entry("request-3", now)], now);
  expect(next.map(item => [item.request, item.state])).toEqual([["request-2", "allowed"], ["request-3", "sent"]]);
  const many = Array.from({ length: AUTO_APPROVAL_KEEP + 30 }, (_, index) => entry("request-" + index, now - 500 + index));
  expect(withAutoApprovals(many, [], now)).toHaveLength(AUTO_APPROVAL_KEEP);
  expect(withAutoApprovals(many, [], now).at(-1)).toEqual(many.at(-1)!);
});

// ---- The host side: real folders and links in a temporary directory ----
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutoApprovalStore, hostAllows, managedWorkSession, PermissionAutoApprover, type HostFiles } from "../server/permission-auto-approve";
import { realpath, stat } from "node:fs/promises";
import contribute from "../index.server";

// The rule is not used on a Windows host (see "the session, the record and the host each stop the rule").
// These cases put real host paths into a POSIX shell line, which a Windows path cannot be written into as is.
const posixHost = process.platform !== "win32";

function sandbox() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "board-auto-")));
  const root = join(base, "home", "projects", "alpha"), outside = join(base, "outside"), data = join(base, "data");
  for (const folder of [join(root, "src"), outside, data]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(root, "README.md"), "sample");
  writeFileSync(join(root, "src", "index.ts"), "sample");
  writeFileSync(join(root, ".env"), "SAMPLE=1");
  writeFileSync(join(outside, "notes.txt"), "sample");
  // The same name inside the folder and beside the linked folder: only walking the link tells them apart.
  writeFileSync(join(root, "notes.txt"), "sample");
  writeFileSync(join(base, "notes.txt"), "sample");
  symlinkSync(join(outside, "notes.txt"), join(root, "linked.txt"));
  symlinkSync(outside, join(root, "linked"));
  symlinkSync(join(root, ".env"), join(root, "settings.txt"));
  symlinkSync(join(root, "README.md"), join(root, "alias.md"));
  // A second name inside the folder for a file that lives outside it.
  linkSync(join(outside, "notes.txt"), join(root, "twin.txt"));
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "sample");
  writeFileSync(join(root, ".gitignore"), "sample");
  symlinkSync(join(root, ".git", "config"), join(root, "plain.txt"));
  const files: HostFiles = {
    realpath: path => realpath(path), home: join(base, "home"), platform: "linux",
    describe: async path => { const found = await stat(path); return { kind: found.isFile() ? "file" : found.isDirectory() ? "folder" : "other", links: found.nlink }; },
  };
  return { base, root, outside, data, files, clean: () => rmSync(base, { recursive: true, force: true }) };
}

test.skipIf(!posixHost)("the host resolves each path and refuses links that leave the folder, sensitive targets, folders read for content and missing files", async () => {
  const box = sandbox();
  try {
    const allowed = async (command: string, cwd = box.root) => {
      const result = readOnlyShellPlan(codex(command, cwd), box.root);
      return "refused" in result ? result.refused : await hostAllows(result.plan, box.root, box.files);
    };
    for (const command of ["cat README.md", "cat alias.md", "cd ./src && cat index.ts", "ls", "ls src", "find . -name '*.ts'", "head -n 2 src/index.ts | wc -l", "stat src", "pwd", "echo sample",
      "cat .gitignore", "ls .git", "stat twin.txt"]) {
      expect([command, await allowed(command)]).toEqual([command, command === "cd ./src && cat index.ts" ? false : true]);
    }
    // A `cd` can fail, so `cd ./src && cat index.ts` also resolves index.ts in the earlier folder, where it does not exist.
    expect(await allowed("cd ./src && ls")).toBe(true);
    expect(await allowed("cd ./src && cat ../README.md")).toBe("risk");
    // A hard link gives a file outside the folder a second name inside it, and a link can hide a dot name.
    expect(await allowed("cat twin.txt")).toBe(false);
    expect(await allowed("cat plain.txt")).toBe(false);
    expect(await allowed("cat config", join(box.root, ".git"))).toBe(false);
    expect(await allowed("cat index.ts", join(box.root, "src"))).toBe(true);
    for (const command of ["cat linked.txt", "ls linked", "cat linked/notes.txt", "cat settings.txt", "cat missing.txt", "cat src", "rg -n sample", "rg -n sample src",
      "grep -r sample", "cd ./linked", "cd ./README.md", "cat src/../linked/../outside/notes.txt"]) {
      expect([command, await allowed(command)]).toEqual([command, false]);
    }
    // ".." after a link leaves the folder the link points to, not the folder the link sits in.
    expect(await allowed("cat linked/../notes.txt")).toBe(false);
    expect(await allowed("cat src/../notes.txt")).toBe(true);
    expect(await allowed("cat linked/../home/projects/alpha/README.md")).toBe(true);
    expect(await allowed("cat notes.txt", box.outside)).toBe(false);
    // A session opened on the home folder or above it has no folder of its own.
    const plan = readOnlyShellPlan(codex("pwd", box.root), box.root);
    if ("refused" in plan) throw Error(plan.refused);
    expect(await hostAllows(plan.plan, box.files.home, box.files)).toBe(false);
    expect(await hostAllows(plan.plan, box.base, box.files)).toBe(false);
    expect(await hostAllows(plan.plan, "/", box.files)).toBe(false);
    expect(await hostAllows(plan.plan, join(box.root, "missing"), box.files)).toBe(false);
    expect(await hostAllows(plan.plan, box.root, box.files)).toBe(true);
    // A folder under a dot folder of the home folder, or under its Library, is not a place of work,
    // unless it is under a folder named as one (Paseo's own worktrees).
    const settings = join(box.files.home, ".config"), tree = join(box.files.home, ".paseo", "worktrees", "tree-1"), library = join(box.files.home, "Library", "App");
    for (const folder of [join(settings, "gh"), tree, library]) mkdirSync(folder, { recursive: true });
    writeFileSync(join(settings, "gh", "hosts.yml"), "sample");
    writeFileSync(join(tree, "README.md"), "sample");
    writeFileSync(join(library, "notes.txt"), "sample");
    const read = (command: string, cwd: string) => { const result = readOnlyShellPlan(codex(command, cwd), cwd); if ("refused" in result) throw Error(result.refused); return result.plan; };
    expect(await hostAllows(read("cat gh/hosts.yml", settings), settings, box.files)).toBe(false);
    expect(await hostAllows(read("pwd", settings), settings, box.files)).toBe(false);
    expect(await hostAllows(read("cat notes.txt", library), library, box.files)).toBe(false);
    expect(await hostAllows(read("cat README.md", tree), tree, box.files)).toBe(false);
    const withTrees = { ...box.files, workRoots: [join(box.files.home, ".paseo", "worktrees"), join(box.files.home, ".missing")] };
    expect(await hostAllows(read("cat README.md", tree), tree, withTrees)).toBe(true);
    // The named folder itself, and other dot folders, stay closed.
    expect(await hostAllows(read("pwd", join(box.files.home, ".paseo", "worktrees")), join(box.files.home, ".paseo", "worktrees"), withTrees)).toBe(false);
    expect(await hostAllows(read("cat gh/hosts.yml", settings), settings, withTrees)).toBe(false);
    // The whole resolved path is checked for sensitive names, not only the part below the folder.
    const vault = join(box.base, "secrets", "app");
    mkdirSync(vault, { recursive: true });
    writeFileSync(join(vault, "notes.txt"), "sample");
    expect(await hostAllows(read("cat notes.txt", vault), vault, box.files)).toBe(false);
  } finally { box.clean(); }
});

type Pending = Record<string, unknown> & { id: string };
function host(box: ReturnType<typeof sandbox>, pending: Pending[], extra: Record<string, unknown> = {}) {
  const state = { pending, responses: [] as { requestId: string; response: unknown }[], refreshes: 0, on: true, answered: [] as { session: string; request: string; at: number }[] | null,
    managed: { title: "Worker one", projectId: "alpha" } as { title: string; projectId: string } | null, failSend: false, clearOnSend: true };
  const paseo = { agents: { ref: (id: string) => ({
    refresh: async () => { state.refreshes++; return { agent: { id, cwd: box.root, pendingPermissions: state.pending, ...extra } }; },
    respondToPermission: async (options: { requestId: string; response: unknown }) => {
      if (state.failSend) throw Error("offline");
      state.responses.push(options);
      if (state.clearOnSend) state.pending = state.pending.filter(request => request.id !== options.requestId);
    },
  }) } };
  const store = new AutoApprovalStore(join(box.data, "permission-auto-approvals.json"));
  let changes = 0;
  const approver = new PermissionAutoApprover({ store, files: box.files, now: () => 1_000, checks: 2, wait: async () => {},
    enabled: async () => state.on, answered: async () => state.answered, managed: async () => state.managed, changed: () => { changes++; } });
  const run = (requestId: string) => approver.requested({ agent: { id: "worker-1" }, request: { id: requestId } }, { paseo: paseo as never });
  return { state, store, approver, run, changes: () => changes };
}
const pendingShell = (id: string, command: string, cwd: string) => ({ id, ...codex(command, cwd) });

test("with the rule off nothing is read and nothing is answered", async () => {
  const box = sandbox();
  try {
    const { state, store, run } = host(box, [pendingShell("request-1", "cat README.md", box.root)]);
    state.on = false;
    expect(await run("request-1")).toBe("off");
    expect(state.refreshes).toBe(0);
    expect(state.responses).toEqual([]);
    expect(store.read()).toEqual([]);
    expect(readdirSync(box.data)).toEqual([]);
  } finally { box.clean(); }
});

test("with the rule on a read-only request is allowed once, recorded and never answered twice", async () => {
  const box = sandbox();
  try {
    const { state, store, approver, run, changes } = host(box, [pendingShell("request-1", "cat README.md | head -n 3", box.root)]);
    expect(await run("request-1")).toBe("sent");
    expect(state.responses).toEqual([{ requestId: "request-1", response: { behavior: "allow" } }]);
    expect(store.read()).toEqual([{ session: "worker-1", request: "request-1", at: 1_000, title: "Worker one", projectId: "alpha", summary: "cat · head", command: "cat README.md | head -n 3", state: "sent" }]);
    expect(changes()).toBe(1);
    // The same request again, even if the host still lists it, is not answered a second time.
    state.pending = [pendingShell("request-1", "cat README.md | head -n 3", box.root)];
    expect(await run("request-1")).toBe("recorded");
    expect(state.responses).toHaveLength(1);
    // The host's report settles the record. A denial from elsewhere is not shown as an approval.
    approver.resolved({ agent: { id: "worker-1" }, requestId: "request-1", resolution: { behavior: "allow" } });
    expect(store.read()[0].state).toBe("allowed");
    approver.resolved({ agent: { id: "worker-1" }, requestId: "request-1", resolution: { behavior: "deny" } });
    expect(store.read()[0].state).toBe("allowed");
    approver.resolved({ agent: { id: "worker-1" }, requestId: "request-9", resolution: { behavior: "allow" } });
    expect(store.read()).toHaveLength(1);
    expect(approver.view(new Set(["alpha"])).entries).toHaveLength(1);
    expect(approver.view(new Set(["beta"]))).toEqual({ supported: true, entries: [] });
    expect((readFileSync(join(box.data, "permission-auto-approvals.json"), "utf8"))).toContain('"version":1');
    // The record is written to a temporary file, renamed into place and readable only by its owner.
    expect(readdirSync(box.data)).toEqual(["permission-auto-approvals.json"]);
    if (posixHost) expect(statSync(join(box.data, "permission-auto-approvals.json")).mode & 0o777).toBe(0o600);
  } finally { box.clean(); }
});

test("every other request stays with a person and leaves no record", async () => {
  const box = sandbox();
  try {
    const cases: [string, Pending, string][] = [
      ["a write", pendingShell("r", "cat README.md > out.txt", box.root), "redirect"],
      ["a sensitive file", pendingShell("r", "cat .env", box.root), "sensitive"],
      ["a link that leaves the folder", pendingShell("r", "cat linked.txt", box.root), "path"],
      ["git", pendingShell("r", "git status", box.root), "command"],
      ["a question", { id: "r", provider: "claude", name: "AskUserQuestion", kind: "question", input: { questions: [] } }, "source"],
      ["a file edit", { id: "r", provider: "claude", name: "Edit", kind: "tool", input: { file_path: "a" }, detail: { type: "edit", filePath: "a" } }, "source"],
      ["a relative path with no stated folder", { id: "r", ...claude("cat README.md") }, "relative"],
    ];
    for (const [label, pending, expected] of cases) {
      const { state, store, run } = host(box, [pending]);
      expect([label, await run("r")]).toEqual([label, expected]);
      expect(state.responses).toEqual([]);
      expect(store.read()).toEqual([]);
    }
    if (posixHost) {
      const absolute = host(box, [{ id: "r", ...claude(`cat ${box.root}/README.md`) }]);
      expect(await absolute.run("r")).toBe("sent");
    }
  } finally { box.clean(); }
});

test("the session, the record and the host each stop the rule", async () => {
  const box = sandbox();
  try {
    const request = () => [pendingShell("request-1", "cat README.md", box.root)];
    const unmanaged = host(box, request()); unmanaged.state.managed = null;
    expect(await unmanaged.run("request-1")).toBe("unmanaged");
    const gone = host(box, []);
    expect(await gone.run("request-1")).toBe("handled");
    const archived = host(box, request(), { archivedAt: "2026-01-01T00:00:00Z" });
    expect(await archived.run("request-1")).toBe("session");
    const unreadable = host(box, request()); unreadable.state.answered = null;
    expect(await unreadable.run("request-1")).toBe("record");
    const answered = host(box, request()); answered.state.answered = [{ session: "worker-1", request: "request-1", at: 1 }];
    expect(await answered.run("request-1")).toBe("recorded");
    const offline = host(box, request()); offline.state.failSend = true;
    expect(await offline.run("request-1")).toBe("failed");
    expect(offline.store.read()).toEqual([]);
    const silent = host(box, request()); silent.state.clearOnSend = false;
    expect(await silent.run("request-1")).toBe("unconfirmed");
    expect(silent.state.responses).toHaveLength(1);
    expect(await silent.run("request-1")).toBe("recorded");
    expect(silent.state.responses).toHaveLength(1);
    for (const stopped of [unmanaged, gone, archived, unreadable, answered, offline]) expect(stopped.state.responses).toEqual([]);
    const windows = new PermissionAutoApprover({ store: silent.store, files: { ...box.files, platform: "win32" }, enabled: async () => true, answered: async () => [], managed: async () => null });
    expect(windows.supported).toBe(false);
    expect(await windows.requested({ agent: { id: "worker-1" }, request: { id: "request-2" } }, { paseo: {} as never })).toBe("unsupported");
    // A record file that cannot be read answers nothing.
    writeFileSync(join(box.data, "permission-auto-approvals.json"), "{broken");
    const broken = host(box, request());
    expect(await broken.run("request-1")).toBe("failed");
    expect(broken.state.responses).toEqual([]);
    expect(broken.approver.view(new Set(["alpha"])).entries).toEqual([]);
  } finally { box.clean(); }
});

test("a switch turned off while the request is being judged, or a cancelled hook, sends nothing", async () => {
  const box = sandbox();
  try {
    const midway = host(box, [pendingShell("request-1", "cat README.md", box.root)]);
    let reads = 0;
    const approver = new PermissionAutoApprover({ store: midway.store, files: box.files, checks: 1, wait: async () => {},
      enabled: async () => ++reads === 1, answered: async () => [], managed: async () => ({ title: "Worker one", projectId: "alpha" }) });
    const paseo = { agents: { ref: (id: string) => ({ refresh: async () => ({ agent: { id, cwd: box.root, pendingPermissions: midway.state.pending } }),
      respondToPermission: async (options: { requestId: string; response: unknown }) => { midway.state.responses.push(options); } }) } };
    expect(await approver.requested({ agent: { id: "worker-1" }, request: { id: "request-1" } }, { paseo: paseo as never })).toBe("off");
    expect(reads).toBe(2);
    const cancelled = new PermissionAutoApprover({ store: midway.store, files: box.files, checks: 1, wait: async () => {},
      enabled: async () => true, answered: async () => [], managed: async () => ({ title: "Worker one", projectId: "alpha" }) });
    expect(await cancelled.requested({ agent: { id: "worker-1" }, request: { id: "request-1" } }, { paseo: paseo as never, signal: AbortSignal.abort() })).toBe("off");
    expect(midway.state.responses).toEqual([]);
    expect(midway.store.read()).toEqual([]);
    // The same request with the switch left on does go out, so the two cases above were stopped by the switch and the signal.
    expect(await cancelled.requested({ agent: { id: "worker-1" }, request: { id: "request-1" } }, { paseo: paseo as never })).toBe("unconfirmed");
    expect(midway.state.responses).toHaveLength(1);
  } finally { box.clean(); }
});

test("the plugin treats the switch as on only when the host setting is readable and true", async () => {
  for (const [state, reads] of [
    [{ status: "ready", revision: "1", values: { readOnlyShell: true } }, 1], [{ status: "ready", revision: "1", values: { readOnlyShell: false } }, 0],
    [{ status: "ready", revision: "1", values: { readOnlyShell: "true" } }, 0], [{ status: "invalid", revision: "1", error: "bad" }, 0],
    [{ status: "loading", values: { readOnlyShell: true } }, 0], [undefined, 0], ["throw", 0],
  ] as const) {
    let hook: ((event: unknown, context: unknown) => Promise<void>) | undefined;
    contribute({ handle() {}, addHook: (name: string, handler: typeof hook) => { if (name === "agent.permission.before") hook = handler; return () => {}; },
      registerSettings(definition: { id: string }) {
        if (definition.id === "answered-requests") return { read: async () => ({ status: "ready", revision: "1", values: { sent: [] } }) };
        if (definition.id !== "permission-auto-approve") return undefined;
        return { read: async () => { if (state === "throw") throw Error("offline"); return state; } };
      } } as never);
    let refreshes = 0;
    const paseo = { agents: { ref: () => ({ refresh: async () => { refreshes++; return null; } }) } };
    await hook!({ agent: { id: "worker-1" }, request: { id: "request-1" } }, { paseo });
    // On a Windows runner the rule stops before it reads the setting.
    expect([JSON.stringify(state), refreshes]).toEqual([JSON.stringify(state), posixHost ? reads : 0]);
  }
});

test("a coordinator's own request and a session outside the managed projects are not the rule's to answer", () => {
  const row = (id: string, projectId: string, serverId?: string) => ({ id, title: id, projectId, projectTitle: projectId, workspaceTitle: "main", model: null, lane: "running" as const, detail: "", ...(serverId ? { serverId } : {}) });
  const rows = [row("worker-1", "alpha"), row("coordinator-1", "alpha"), row("created-1", "alpha"), row("worker-2", "beta"), row("remote-1", "alpha", "host-b")];
  const scope = { projects: ["alpha"], coordinator: "coordinator-1", sessionLinks: {}, createdCoordinator: { id: "created-1" } } as never;
  expect(managedWorkSession(rows, scope, "worker-1")?.id).toBe("worker-1");
  for (const id of ["coordinator-1", "created-1", "worker-2", "remote-1", "missing"]) expect([id, managedWorkSession(rows, scope, id)]).toEqual([id, null]);
});

test("the plugin wires the rule to the hook for a new request and to nothing else", () => {
  const hooks: string[] = [], settings: string[] = [];
  contribute({ handle() {}, registerSettings(definition: { id: string }) { settings.push(definition.id); }, addHook: (name: string) => { hooks.push(name); return () => {}; } } as never);
  expect(settings).toContain("permission-auto-approve");
  expect(hooks.filter(name => name === "agent.permission.before")).toHaveLength(1);
  const root = join(import.meta.dir, "..");
  const sources = (folder: string): string[] => readdirSync(join(root, folder), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sources(join(folder, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(folder, entry.name)] : []);
  const all = [...sources("server"), ...sources("shared"), ...sources("client"), "index.server.ts", "index.client.tsx"];
  const using = (pattern: RegExp) => all.filter(file => pattern.test(readFileSync(join(root, file), "utf8")));
  // One place calls the host. A person's button and the rule are its only two users.
  expect(using(/\.respondToPermission\(/)).toEqual([join("shared", "permission-responder.ts")]);
  expect(using(/\bcreateResponder(?:<[^>]*>)?\(/).sort()).toEqual([join("client", "pending-request-forms.tsx"), join("server", "permission-auto-approve.ts"), join("shared", "permission-responder.ts")].sort());
  expect(using(/\.requested\(/)).toEqual(["index.server.ts"]);
  const server = readFileSync(join(root, "index.server.ts"), "utf8");
  expect(server.match(/autoApprover\.requested\(/g)).toHaveLength(1);
  expect(server).toMatch(/addHook\("agent\.permission\.before", async \(event, context\) => \{ await autoApprover\.requested\(event, context\); \}\)/);
  // The rule's own code starts no timer, sends no message and never offers a standing permission.
  const rule = readFileSync(join(root, "server", "permission-auto-approve.ts"), "utf8") + readFileSync(join(root, "shared", "permission-auto-approve.ts"), "utf8");
  expect(rule).not.toMatch(/setInterval|setTimeout|\.send\(|updatedPermissions|updatedInput|selectedActionId/);
});

// ---- What the board shows ----
import { approvalLine, approvalState, approvalTime, autoApproveExplanation, autoApproveUnsupported, sessionApprovals } from "../client/permission-auto-approve";

test("the card line and the setting text read in both languages", () => {
  const ko = (korean: string) => korean, en = (_: string, english: string) => english;
  const now = new Date(2026, 0, 15, 18, 0).getTime(), at = new Date(2026, 0, 15, 14, 3).getTime();
  const entry = { session: "worker-1", request: "request-1", at, title: "Worker one", projectId: "alpha", summary: "cat · head", command: "cat README.md | head -n 3", state: "allowed" as const };
  expect(approvalLine(entry, ko, "ko", now)).toBe("읽기 전용 자동 승인 · cat · head · " + approvalTime(at, "ko", now));
  expect(approvalLine(entry, en, "en", now)).toBe("Read-only auto-approval · cat · head · " + approvalTime(at, "en", now));
  expect(approvalTime(at, "en", now)).toMatch(/^0?2:03\s?PM$/);
  // An earlier day shows its date.
  expect(approvalTime(at, "en", now + 3 * 24 * 60 * 60 * 1000)).toContain("Jan 15");
  expect(approvalLine({ ...entry, state: "sent" }, ko, "ko", now)).toEndWith("응답 보냄 · 세션 확인 전");
  expect(approvalState({ state: "other" }, en)).toBe("Response sent, but the request ended with another response");
  expect(approvalState({ state: "allowed" }, ko)).toBe("");
  expect(sessionApprovals([entry, { ...entry, session: "worker-2" }], "worker-1")).toEqual([entry]);
  expect(sessionApprovals(undefined, "worker-1")).toEqual([]);
  for (const text of [autoApproveExplanation(ko), autoApproveExplanation(en), autoApproveUnsupported(ko), autoApproveUnsupported(en)]) {
    expect(text.length).toBeGreaterThan(40);
    expect(text).not.toContain("—");
  }
  expect(autoApproveExplanation(ko)).toContain("한 번만 허용");
  expect(autoApproveExplanation(en)).toContain("allows once");
  // The limit the board cannot close is said in plain words next to the switch.
  expect(autoApproveExplanation(ko)).toContain("믿는 세션에서만 켜세요");
  expect(autoApproveExplanation(en)).toContain("only for sessions you trust");
});
