import type { Token, Tokens } from "./vendor/marked/marked";
import { resolveRepositoryName, type RepositoryClue, type RepositoryIndex } from "./pull-repositories";

// Match bare references and leave GitHub's owner/repository#number shorthand alone.
const reference = /(^|[^\w/#.-])(?:([\w.-]+\/[\w.-]+)[ \t]*)?#([1-9]\d*)(?![\w#])/g;
// A name a session might write for a repository: alpha-web, AlphaWeb, owner/repository.
const word = "[A-Za-z0-9](?:[\\w.-]*[A-Za-z0-9])?(?:\\/[A-Za-z0-9](?:[\\w.-]*[A-Za-z0-9])?)?";
const names = new RegExp(word, "g");
// Korean particles written right after a name: "alpha-web의 #12", "Alpha에서는 #12", longest first.
const particle = "(?:에서는|에서|으로는|으로|이랑|하고|까지|부터|에는|랑|의|은|는|이|가|을|를|에|와|과|도|로|만)?";
// The name right before a number ("alpha-web #12", "alpha-web PR #12", "alpha-web의 #12") or in brackets right after it ("#12 (alpha-web)").
const before = new RegExp("(" + word + ")" + particle + "[ \\t]+(?:PR[ \\t]*)?$", "i");
const after = new RegExp("^[ \\t]*\\((" + word + ")\\)");
const plainText = (text: string): Tokens.Text => ({ type: "text", raw: text, text });

export type PullLinkContext = {
  /** The card's own repository, used only when the line names none. */
  repository?: string;
  known?: RepositoryIndex;
  /** What the rest of a table row says, from {@link tableRowClues}. */
  row?: RepositoryClue | null;
};

/**
 * Words that are not repository names even right before a number: sentence words ("fixed in #12", "Approve #12"),
 * products and platforms ("GitHub", "macOS"), and ordinary hyphenated or status words ("follow-up", "checks-failed").
 */
const ordinary = new Set([
  "a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "is", "of", "on", "or", "per", "so", "than", "the", "then", "to", "via", "vs", "was", "with",
  "also", "after", "before", "plus", "see", "cf", "ref", "refs", "related", "pr", "prs", "pull", "request", "requests", "issue", "issues", "ticket", "number", "no",
  "approve", "approved", "merge", "merged", "review", "reviewed", "fix", "fixes", "fixed", "close", "closes", "closed", "resolve", "resolves", "resolved",
  "revert", "reverts", "reverted", "land", "landed", "ship", "shipped", "open", "opened", "draft", "done", "wip", "update", "updated", "bump", "bumped",
  "add", "added", "remove", "removed", "check", "checked", "test", "tested", "deploy", "deployed", "release", "released", "follow", "todo",
  "github", "gitlab", "macos", "ios", "ipados", "iphone", "ipad", "icloud", "airpods", "javascript", "typescript", "powershell", "youtube",
  "openai", "chatgpt", "posthog", "linkedin", "wordpress", "nextjs", "nodejs", "paypal", "whatsapp", "playstation", "deepseek", "fastapi",
  "e.g", "i.e", "follow-up", "e-mail", "re-run", "sign-in", "log-in", "set-up", "opt-in", "add-on", "built-in", "check-in", "pre-commit", "pre-push",
  "read-only", "co-author", "non-blocking", "no-op", "up-to-date", "in-progress", "work-in-progress", "auto-merge", "checks-failed", "checks-pending",
  "changes-requested", "needs-changes", "ready-for-review", "re-review", "hot-fix", "end-to-end", "e2e",
]);
const fileOrSite = /\.(md|mdx|json|jsonc|ts|tsx|js|jsx|mjs|cjs|py|sh|yml|yaml|toml|lock|txt|html|css|png|jpe?g|svg|com|org|net|io|dev|ai|app)$/i;

/** Never a repository clue: ordinary words, anything with a digit (versions, models, UTF-8), branch paths, CI images, files and sites. */
const neutral = (text: string) => ordinary.has(text.toLowerCase()) || /\d/.test(text) || text.includes("/") || /-latest$/i.test(text) || fileOrSite.test(text);

/** A name that reads like a repository anywhere in a line: a slug (zeta-api, zeta_api) or CamelCase (ZetaApp). */
const looksLikeRepository = (text: string) => /[A-Za-z]/.test(text) && !neutral(text)
  && (/[A-Za-z0-9][-_.][A-Za-z0-9]/.test(text) || /[a-z][A-Z]/.test(text));

function matches(text: string) {
  return [...text.matchAll(reference)].flatMap(match => {
    const [, prefix, qualifier, digits] = match;
    const number = Number(digits);
    if (qualifier || number > 2147483647) return [];
    return [{ start: match.index + prefix.length, digits, number }];
  });
}

// One walk over the inline tokens in reading order, shared by the scan and the rewrite so their positions agree.
function walk(tokens: Token[], visit: { text(text: string): void; other(text: string): void }) {
  for (const token of tokens) {
    if (token.type === "link" || token.type === "image") visit.other(" ");
    else if (token.type === "br") visit.other("\n");
    else if (token.type === "codespan") visit.other(token.text);
    else if ("tokens" in token && Array.isArray(token.tokens)) walk(token.tokens, visit);
    else if (token.type === "text" && typeof token.text === "string") visit.text(token.text);
    else visit.other(" ");
  }
}

/** The inline text as one string with line breaks, and where each bare reference sits in it. */
function flatten(tokens: Token[]) {
  let flat = "";
  const refs: { at: number; length: number }[] = [];
  walk(tokens, {
    other: text => { flat += text; },
    text: text => {
      for (const ref of matches(text)) refs.push({ at: flat.length + ref.start, length: ref.digits.length + 1 });
      flat += text;
    },
  });
  return { flat, refs };
}

/** The name right before a number: a known name, or any other word except ordinary ones, which then names an unknown repository. */
function nameBefore(text: string | undefined, known: RepositoryIndex | undefined): RepositoryClue | null {
  if (!text) return null;
  return resolveRepositoryName(known, text) ?? (neutral(text) ? null : { blocked: true });
}

/** The name in brackets after a number: a known name, or a repository-like one the board does not know. */
function nameAfter(text: string | undefined, known: RepositoryIndex | undefined): RepositoryClue | null {
  if (!text) return null;
  return resolveRepositoryName(known, text) ?? (looksLikeRepository(text) ? { blocked: true } : null);
}

/**
 * What a whole line says: the one repository it names, blocked when it names several, an unknown or ambiguous one,
 * or a project (project titles never pick the link from afar, but they keep the card's repository out), or null for nothing.
 */
function lineTarget(line: string, known: RepositoryIndex | undefined): RepositoryClue | null {
  const repos = new Set<string>();
  const projects = new Set<string>();
  for (const match of line.matchAll(names)) {
    if (line[match.index - 1] === "#" || /^\d+$/.test(match[0])) continue;
    const repository = resolveRepositoryName(known, match[0], true);
    const any = repository ?? resolveRepositoryName(known, match[0]);
    if (any && !("repo" in any)) return { blocked: true };
    if (repository && "repo" in repository) repos.add(repository.repo);
    else if (any && "repo" in any) projects.add(any.repo);
    else if (looksLikeRepository(match[0])) return { blocked: true };
  }
  if (repos.size > 1 || [...projects].some(repo => !repos.has(repo))) return { blocked: true };
  return repos.size ? { repo: [...repos][0] } : null;
}

function resolve(flat: string, ref: { at: number; length: number }, context: PullLinkContext, lines: Map<number, RepositoryClue | null>): string | null {
  const start = flat.lastIndexOf("\n", ref.at - 1) + 1;
  const endAt = flat.indexOf("\n", ref.at);
  const end = endAt < 0 ? flat.length : endAt;
  const chosen = (clue: RepositoryClue) => "repo" in clue ? clue.repo : null;
  // Only the text just beside the number can hold its name; bounded slices keep long lines cheap.
  const left = nameBefore(before.exec(flat.slice(Math.max(start, ref.at - 200), ref.at))?.[1], context.known);
  if (left) return chosen(left);
  const right = nameAfter(after.exec(flat.slice(ref.at + ref.length, Math.min(end, ref.at + ref.length + 200)))?.[1], context.known);
  if (right) return chosen(right);
  if (!lines.has(start)) lines.set(start, lineTarget(flat.slice(start, end), context.known));
  const line = lines.get(start);
  if (line) return chosen(line);
  if (context.row) return chosen(context.row);
  return context.repository ?? null;
}

/**
 * Turns bare `#N` into links. The repository comes from the name right beside the number, or from the one repository
 * the line names, or from the table row, and only then from the card. Unknown or ambiguous names leave it unlinked.
 */
export function pullReferenceTokens(tokens: Token[], context: PullLinkContext = {}): Token[] {
  if (!context.repository && !context.known && !context.row) return tokens;
  const { flat, refs } = flatten(tokens);
  if (!refs.length) return tokens;
  const lines = new Map<number, RepositoryClue | null>();
  const repos = refs.map(ref => resolve(flat, ref, context, lines));
  let next = 0;
  const rewrite = (list: Token[]): Token[] => list.flatMap(token => {
    if (token.type === "link" || token.type === "image" || token.type === "codespan") return [token];
    if ("tokens" in token && Array.isArray(token.tokens)) return [{ ...token, tokens: rewrite(token.tokens) }];
    if (token.type !== "text" || typeof token.text !== "string") return [token];
    const output: Token[] = [];
    let end = 0;
    for (const ref of matches(token.text)) {
      const repo = repos[next++];
      if (!repo) continue;
      const text = "#" + ref.digits;
      if (ref.start > end) output.push(plainText(token.text.slice(end, ref.start)));
      output.push({ type: "pullReference", raw: text, text, repo, number: ref.number });
      end = ref.start + text.length;
    }
    if (!output.length) return [token];
    if (end < token.text.length) output.push(plainText(token.text.slice(end)));
    return output;
  });
  return rewrite(tokens);
}

const repositoryHeaders = new Set(["저장소", "레포", "리포", "프로젝트", "repo", "repos", "repository", "repositories", "project", "projects"]);

function cellText(tokens: Token[]): string {
  return tokens.map(token => "tokens" in token && Array.isArray(token.tokens) ? cellText(token.tokens)
    : "text" in token && typeof token.text === "string" ? token.text : "").join("").trim();
}

/**
 * What each body row says about its repository. The repository column is the one headed like "저장소" or "Repository",
 * or else the column whose cells name repositories the board knows; a name there the board does not know blocks the row.
 * Without that column, the row's other cells are read like one line, so an unknown repository name still keeps the card's out.
 */
export function tableRowClues(table: Pick<Tokens.Table, "header" | "rows">, known: RepositoryIndex | undefined): (RepositoryClue | null)[] {
  if (!known) return table.rows.map(() => null);
  let column = table.header.findIndex(cell => repositoryHeaders.has(cellText(cell.tokens).toLowerCase()));
  const headed = column >= 0;
  if (!headed) {
    let best = 0;
    table.header.forEach((_, c) => {
      const count = table.rows.filter(row => {
        const clue = row[c] && resolveRepositoryName(known, cellText(row[c].tokens));
        return !!clue && "repo" in clue;
      }).length;
      if (count > best) { best = count; column = c; }
    });
  }
  return table.rows.map(row => {
    const text = column >= 0 && row[column] ? cellText(row[column].tokens) : "";
    if (text) {
      const clue = resolveRepositoryName(known, text);
      if (clue) return clue;
      // Under a repository header any other name is an unknown repository; in a guessed column, ordinary words are not.
      if (headed || !neutral(text)) return { blocked: true };
    }
    return lineTarget(row.map(cell => cellText(cell.tokens)).join(" | "), known);
  });
}
