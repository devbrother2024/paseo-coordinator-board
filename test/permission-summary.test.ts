import { expect, test } from "bun:test";
import { permissionSummary, permissionHeading } from "../shared/permission-summary";

const cwd = "/Users/you/projects/alpha";
const shell = (command: string) => permissionSummary({ kind: "tool", name: "Bash", detail: { type: "shell", command } }, cwd)!;
const ko = (korean: string) => korean;
const en = (_: string, english: string) => english;

test("a shell request counts and groups commands, using the requested working folder", () => {
  const command = `cd '${cwd}' && git log | cat; git log || rg 'x|y;z && a' README.md\npwd`;
  const summary = shell(command);
  expect(summary).toMatchObject({ kind: "shell", risk: "read", command, cwd, count: 5 });
  expect(summary.groups).toContainEqual({ name: "git log", risk: "read", count: 2 });
  expect(permissionHeading(summary, ko)).toBe("읽기만 · 명령 5개 · alpha 작업 폴더");
  expect(permissionHeading(summary, en)).toBe("Read only · 5 commands · alpha working folder");
});

test("quoted arguments, escapes and literal heredoc contents are not split into commands", () => {
  const summary = shell("cat <<-'DOC' | sort\n\t$(rm example) && echo x\n\tDOC\necho 'a;b' \\| c \\\n d");
  expect(summary).toMatchObject({ count: 3, risk: "read" });
  expect(summary.groups.map(group => group.name)).toEqual(["cat", "sort", "echo"]);
});

test("substitutions, including those in an expandable heredoc, keep their inner risk", () => {
  const summary = shell('echo "$(echo $(rm output/result.txt))" `git status`; cat <<EOF\n$(curl https://example.invalid); text\nEOF');
  expect(summary.risk).toBe("destructive");
  expect(summary.groups).toContainEqual({ name: "rm", risk: "destructive", count: 1, detail: "output/result.txt" });
  expect(summary.groups).toContainEqual({ name: "git status", risk: "read", count: 1 });
  expect(summary.groups).toContainEqual({ name: "curl", risk: "network", count: 1 });
  expect(summary.groups).toContainEqual({ name: "$()", risk: "execute", count: 4 });
  expect(shell("echo $(printf example)").risk).toBe("execute");
});

test("risky options and unknown syntax do not look like read-only commands", () => {
  for (const [command, risk] of [
    ["git diff --output=out.txt", "write"], ["cat input 2>>out.txt", "write"],
    ["sort -o out infile", "write"], ["sed -ni 's/a/b/' in", "write"],
    ["git branch feature", "write"], ["git branch -D feature", "destructive"],
    ["git push --force-with-lease", "destructive"], ["git push origin +a:b", "destructive"],
    ["git restore file.txt", "destructive"], ["git diff $FLAGS", "unknown"],
    ["find . -delete", "destructive"], ["find . -exec echo {} \\;", "execute"],
    ["awk '{print > \"output.txt\"}' input", "write"], ["awk 'BEGIN {system(\"echo hi\")}'", "execute"],
    ["rg --pre=custom pattern", "execute"], ["echo <(rm example)", "unknown"],
    ["echo '${USER}'", "read"], ["echo ${value:-$(rm example)}", "unknown"],
    ["git -c diff.external=custom diff", "unknown"], ["my-tool --help", "unknown"],
    ["cat 'unterminated", "unknown"], ["cat <<EOF\nbody", "unknown"],
    ["git status &&", "unknown"], ["git status &&\ncat README.md", "read"],
    ["npm ci", "network"], ["bun install", "network"], ["git fetch", "network"],
    ["sips -g pixelWidth image.png", "read"], ["sips -g pixelWidth --out result image.png", "write"],
    ["git branch --show-current", "read"], ["sed -n '1,5p' file", "read"],
    ["awk '{print $1}' data", "read"], ["node --version", "read"], ["git --version", "read"],
  ]) expect([command, shell(command).risk]).toEqual([command, risk]);
});

test("write and delete groups show targets and code execution shows the first line", () => {
  const summary = shell(`mkdir -p '${cwd}/out folder' && python3 -c 'from PIL import Image\nprint("sample; text")' && rm ~/scratch/example`);
  expect(summary.groups).toEqual([
    { name: "mkdir", risk: "write", count: 1, detail: "out folder" },
    { name: "python3", risk: "execute", count: 1, detail: "from PIL import Image" },
    { name: "rm", risk: "destructive", count: 1, detail: "~/scratch/example" },
  ]);
  expect(shell("mkdir /Users/you/other").groups[0].detail).toBe("~/other");
  expect(shell("echo hi > result.txt").groups[0].detail).toBe("result.txt");
  expect(shell("find output -delete").groups[0].detail).toBe("output");
  expect(shell("sort -o out.txt in.txt").groups[0].detail).toBe("out.txt");
  expect(shell("sed -i '' 's/a/b/' in.txt").groups[0].detail).toBe("in.txt");
});

test("uses known provider fields for shell, edit and MCP requests without guessing from prose", () => {
  const windows = "C:\\Users\\you\\project";
  expect(permissionSummary({ kind: "tool", name: "edit", detail: { type: "edit", filePath: windows + "\\src\\file.ts" } }, windows))
    .toEqual({ kind: "edit", risk: "write", target: "src\\file.ts" });
  expect(permissionSummary({ kind: "tool", name: "shell", detail: { type: "shell", cwd: windows, command: "git diff" } }, cwd))
    .toMatchObject({ risk: "read", cwd: windows });
  expect(permissionSummary({ kind: "tool", name: "Bash", input: { command: "cat notes.md" } }, cwd))
    .toMatchObject({ kind: "shell", risk: "read" });
  expect(permissionSummary({ kind: "tool", name: "mcp__sample__lookup", title: "A long description" }, cwd))
    .toEqual({ kind: "mcp", risk: "unknown", target: "mcp__sample__lookup" });
  expect(permissionSummary({ kind: "tool", name: "edit", title: "cat file" }, cwd)).toMatchObject({ kind: "edit", risk: "write" });
  expect(permissionSummary({ kind: "tool", name: "delete", detail: { type: "edit", filePath: "scratch.txt" } }, cwd))
    .toEqual({ kind: "delete", risk: "destructive", target: "scratch.txt" });
  expect(permissionSummary({ kind: "question", name: "execute", input: { command: "cat file" } }, cwd)).toBeNull();
});
