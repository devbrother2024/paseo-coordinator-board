import type { Token, Tokens } from "./vendor/marked/marked";
import { resolveRepositoryName, type RepositoryClue, type RepositoryIndex } from "./pull-repositories";

// Match bare references and leave GitHub's owner/repository#number shorthand alone.
const reference = /(^|[^\w/#.-])(?:([\w.-]+\/[\w.-]+)[ \t]*)?#([1-9]\d*)(?![\w#])/g;
// A name a session might write for a repository: alpha-web, AlphaWeb, owner/repository.
const name = /[A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?(?:\/[A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?)?/g;
// The word written right before a PR number: "alpha-web #12", "alpha-web PR #12".
const adjacent = /([A-Za-z0-9](?:[\w.-]*[A-Za-z0-9])?)[ \t]+(?:PR[ \t]*)?$/i;
const plainText = (text: string): Tokens.Text => ({ type: "text", raw: text, text });

export type PullLinkContext = {
  /** The card's own repository, used only when the line names none. */
  repository?: string;
  known?: RepositoryIndex;
  /** What the rest of a table row says, from {@link tableRowClues}. */
  row?: RepositoryClue | null;
};

/** Looks like a repository name rather than a plain word: has a dash, dot or underscore inside, or a capital after a small letter. */
const looksLikeRepository = (word: string) => /[A-Za-z]/.test(word) && (/[a-z][A-Z]/.test(word) || /[A-Za-z0-9][-_.][A-Za-z0-9]/.test(word));

// Words that join a sentence rather than name a repository: "fixed in #12", "see PR #12".
const joining = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "is", "issue", "of", "on", "or", "pr", "pull", "see", "the", "to", "via", "was", "with"]);

// What the word right before a number says: a repository, a blocked name, or (unknown) a word that may still name one.
type Adjacent = RepositoryClue | "unknown" | null;
type Scan = { clues: { at: number; line: number; clue: RepositoryClue }[]; refs: { at: number; line: number; adjacent: Adjacent }[] };

function matches(text: string) {
  return [...text.matchAll(reference)].flatMap(match => {
    const [, prefix, qualifier, digits] = match;
    const number = Number(digits);
    if (qualifier || number > 2147483647) return [];
    return [{ start: match.index + prefix.length, digits, number }];
  });
}

function namesIn(text: string, known: RepositoryIndex | undefined) {
  if (!known) return [];
  return [...text.matchAll(name)].flatMap(match => {
    if (text[match.index - 1] === "#" || /^\d+$/.test(match[0])) return [];
    const clue = resolveRepositoryName(known, match[0]);
    return clue ? [{ index: match.index, clue }] : [];
  });
}

// One walk over the inline tokens in reading order, shared by the scan and the rewrite so their positions agree.
function walk(tokens: Token[], visit: { text(text: string): void; code(text: string): void; br(): void }) {
  for (const token of tokens) {
    if (token.type === "link" || token.type === "image") continue;
    if (token.type === "br") visit.br();
    else if (token.type === "codespan") visit.code(token.text);
    else if ("tokens" in token && Array.isArray(token.tokens)) walk(token.tokens, visit);
    else if (token.type === "text" && typeof token.text === "string") visit.text(token.text);
  }
}

function scan(tokens: Token[], known: RepositoryIndex | undefined): Scan {
  const result: Scan = { clues: [], refs: [] };
  let at = 0;
  let line = 0;
  const lines = (text: string) => {
    let offset = 0;
    for (const part of text.split("\n")) {
      for (const found of namesIn(part, known)) result.clues.push({ at: at + offset + found.index, line, clue: found.clue });
      offset += part.length + 1;
      line++;
    }
    line--;
  };
  walk(tokens, {
    br: () => { line++; at++; },
    code: text => { lines(text); at += text.length; },
    text: text => {
      const refs = matches(text);
      for (const ref of refs) {
        const before = text.slice(0, ref.start);
        const word = adjacent.exec(before.slice(before.lastIndexOf("\n") + 1))?.[1];
        const clue: Adjacent = !word || joining.has(word.toLowerCase()) ? null
          : resolveRepositoryName(known, word) ?? (looksLikeRepository(word) ? { blocked: true } : "unknown");
        result.refs.push({ at: at + ref.start, line: line + (before.match(/\n/g)?.length ?? 0), adjacent: clue });
      }
      lines(text);
      at += text.length;
    },
  });
  return result;
}

const same = (a: RepositoryClue, b: RepositoryClue) => "repo" in a && "repo" in b && a.repo === b.repo;

function resolve(ref: Scan["refs"][number], clues: Scan["clues"], context: PullLinkContext): string | null {
  const chosen = (clue: RepositoryClue) => "repo" in clue ? clue.repo : null;
  if (ref.adjacent && ref.adjacent !== "unknown") return chosen(ref.adjacent);
  const onLine = clues.filter(clue => clue.line === ref.line);
  // "delta #5, off #6": on a line that names repositories, an unknown name before the number is one more repository.
  if (ref.adjacent === "unknown" && onLine.length) return null;
  const before = onLine.filter(clue => clue.at < ref.at).at(-1);
  if (before) return chosen(before.clue);
  if (onLine.length) return onLine.every(clue => same(clue.clue, onLine[0].clue)) ? chosen(onLine[0].clue) : null;
  if (context.row) return chosen(context.row);
  return context.repository ?? null;
}

/**
 * Turns bare `#N` into links. The repository comes from the same line when it names one the board knows
 * ("alpha-web #12", a table row's repository cell), otherwise from the card. An unknown or ambiguous name leaves it unlinked.
 */
export function pullReferenceTokens(tokens: Token[], context: PullLinkContext = {}): Token[] {
  if (!context.repository && !context.known && !context.row) return tokens;
  const found = scan(tokens, context.known);
  if (!found.refs.length) return tokens;
  const repos = found.refs.map(ref => resolve(ref, found.clues, context));
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
