import type { Token, Tokens } from "./vendor/marked/marked";
import { resolveRepositoryName, type RepositoryClue, type RepositoryIndex } from "./pull-repositories";

// Match bare references and leave GitHub's owner/repository#number shorthand alone.
const reference = /(^|[^\w/#.-])(?:([\w.-]+\/[\w.-]+)[ \t]*)?#([1-9]\d*)(?![\w#])/g;
// A name a session might write for a repository: alpha-web, AlphaWeb, owner/repository.
const word = "[A-Za-z0-9](?:[\\w.-]*[A-Za-z0-9])?(?:\\/[A-Za-z0-9](?:[\\w.-]*[A-Za-z0-9])?)?";
const names = new RegExp(word, "g");
// Korean particles written right after a name: "alpha-web의 #12", "alpha-web에서 #12".
const particle = "(?:에서|으로|의|은|는|이|가|을|를|에|와|과|도|로|만)?";
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

// Words that join a sentence rather than name a repository: "fixed in #12", "see PR #12".
const joining = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "is", "issue", "of", "on", "or", "pr", "pull", "see", "the", "to", "via", "was", "with"]);
// Ordinary hyphenated words that are not repository names.
const ordinary = new Set(["follow-up", "e-mail", "re-run", "sign-in", "log-in", "set-up", "opt-in", "add-on", "built-in", "check-in", "pre-commit", "pre-push", "read-only", "co-author", "non-blocking"]);
const fileOrSite = /\.(md|mdx|json|jsonc|ts|tsx|js|jsx|mjs|cjs|py|sh|yml|yaml|toml|lock|txt|html|css|png|jpe?g|svg|com|org|net|io|dev|ai|app)$/i;

/** A slug such as zeta-api or zeta_api: a dash, underscore or dot inside, and not a common word, version, file or site name. */
const looksLikeRepository = (text: string) => /[A-Za-z]/.test(text) && /[A-Za-z0-9][-_.][A-Za-z0-9]/.test(text)
  && !ordinary.has(text.toLowerCase()) && !/^v?\d+(\.\d+)+$/i.test(text) && !fileOrSite.test(text);

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

// The word right beside a number: a repository, a blocked name, a plain word that might still be a name, or nothing.
type Beside = RepositoryClue | "word" | null;

function beside(text: string | undefined, known: RepositoryIndex | undefined): Beside {
  if (!text || joining.has(text.toLowerCase())) return null;
  return resolveRepositoryName(known, text) ?? (looksLikeRepository(text) ? { blocked: true } : "word");
}

/** Repository names anywhere in a line (project titles only count right beside a number), and whether it names one the board does not know. */
function lineClues(line: string, known: RepositoryIndex | undefined) {
  const repos = new Set<string>();
  let blocked = false;
  for (const match of line.matchAll(names)) {
    if (line[match.index - 1] === "#" || /^\d+$/.test(match[0])) continue;
    const clue = resolveRepositoryName(known, match[0], true);
    if (clue) {
      if ("repo" in clue) repos.add(clue.repo); else blocked = true;
    } else if (!resolveRepositoryName(known, match[0]) && looksLikeRepository(match[0])) blocked = true;
  }
  return { repos, blocked };
}

function resolve(flat: string, ref: { at: number; length: number }, context: PullLinkContext): string | null {
  const start = flat.lastIndexOf("\n", ref.at - 1) + 1;
  const endAt = flat.indexOf("\n", ref.at);
  const end = endAt < 0 ? flat.length : endAt;
  const chosen = (clue: RepositoryClue) => "repo" in clue ? clue.repo : null;
  // Only the text just before the number can hold the name beside it; a bounded slice keeps long lines cheap.
  const left = beside(before.exec(flat.slice(Math.max(start, ref.at - 200), ref.at))?.[1], context.known);
  if (left && left !== "word") return chosen(left);
  const right = beside(after.exec(flat.slice(ref.at + ref.length, Math.min(end, ref.at + ref.length + 200)))?.[1], context.known);
  if (right && right !== "word") return chosen(right);
  const line = lineClues(flat.slice(start, end), context.known);
  if (line.blocked || line.repos.size > 1) return null;
  // "beta #2, delta #5": on a line that names repositories, an unknown word before the number is one more repository.
  if (line.repos.size === 1) return left === "word" ? null : [...line.repos][0];
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
  const repos = refs.map(ref => resolve(flat, ref, context));
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
 * or else the column whose cells name repositories the board knows. A row naming one the board does not know is blocked.
 */
export function tableRowClues(table: Pick<Tokens.Table, "header" | "rows">, known: RepositoryIndex | undefined): (RepositoryClue | null)[] {
  if (!known) return table.rows.map(() => null);
  let column = table.header.findIndex(cell => repositoryHeaders.has(cellText(cell.tokens).toLowerCase()));
  if (column < 0) {
    let best = 0;
    table.header.forEach((_, c) => {
      const count = table.rows.filter(row => {
        const clue = row[c] && resolveRepositoryName(known, cellText(row[c].tokens));
        return !!clue && "repo" in clue;
      }).length;
      if (count > best) { best = count; column = c; }
    });
  }
  if (column < 0) return table.rows.map(() => null);
  return table.rows.map(row => {
    const text = row[column] ? cellText(row[column].tokens) : "";
    if (!text) return null;
    return resolveRepositoryName(known, text) ?? { blocked: true };
  });
}
