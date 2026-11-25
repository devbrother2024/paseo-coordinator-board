import type { Token, Tokens } from "./vendor/marked/marked";
import { lexBoardMarkdown } from "./board-markdown";
import { resolveRepositoryName, type RepositoryClue, type RepositoryIndex } from "./pull-repositories";

/*
 * Which repository a bare `#N` belongs to, from explicit clues only:
 *   1. owner/repository#N names its repository (linked when the board knows it).
 *   2. The name right beside the number: before it (a Korean particle may follow the name) or in brackets right after it.
 *      A name the board knows links there; any other name leaves the number unlinked.
 *   3. A table's repository column, found by its header.
 *   4. The card's own repository, only when the whole text names no other repository (see {@link fallbackRepository}).
 * Nothing else in a line is read as a clue: guessing from the rest of a sentence opened a new wrong link for every kind of clue.
 */

// Bare references, with GitHub's owner/repository#number shorthand captured as the qualifier.
const reference = /(^|[^\w/#.-])(?:([\w.-]+\/[\w.-]+)[ \t]*)?#([1-9]\d*)(?![\w#])/g;
// A name a session might write for a repository: alpha-web, AlphaWeb, _alpha-web, owner/repository.
// The whole run of name characters is one name, so "_alpha-web" or "x_alpha-web" never reads as "alpha-web".
const word = "(?=[\\w.-]*[A-Za-z0-9])[\\w.-]+(?:\\/[\\w.-]+)?";
const names = new RegExp(word, "g");
// Korean particles after a name: "alpha-web의 #12", "Alpha에서는 #12", longest first.
// Agents often put a space before it ("alpha-web 의 #12"), so a space between the name and the particle is allowed.
const particles = "(?:에서는|에서|으로는|으로|이랑|하고|까지|부터|에는|랑|의|은|는|이|가|을|를|에|와|과|도|로|만)";
const particle = "(?:[ \\t]*" + particles + ")?";
const particleAtEnd = new RegExp("[ \\t]*" + particles + "$");
const particleAtStart = new RegExp("^" + particles);
// What is left before a number once "PR" and the spaces before it are taken off: "Alpha Web PR #12" → "Alpha Web".
const gapBeforeNumber = /[ \t]+(?:PR[ \t]*)?$/i;
// The name right before a number ("alpha-web #12", "alpha-web PR #12", "alpha-web의 #12") or in brackets right after it ("#12 (alpha-web)").
const before = new RegExp("(" + word + ")" + particle + "[ \\t]+(?:PR[ \\t]*)?$", "i");
const after = /^[ \t]?\(([^()\n]{1,100})\)/;
const oneWord = new RegExp("^" + word + "$");
// owner/repository as GitHub allows it (shared/prs.ts repositorySlug).
const qualifiedShape = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i;
const githubUrl = /github\.com\/([\w.-]+\/[\w.-]+)/gi;
const plainText = (text: string): Tokens.Text => ({ type: "text", raw: text, text });

export type PullLinkContext = {
  /** The card's repository after {@link fallbackRepository}: used only for a number with no name beside it. */
  repository?: string;
  known?: RepositoryIndex;
  /** What the table row's repository column says, from {@link tableRowClues}. */
  row?: RepositoryClue | null;
};

// A sentence's closing dot is not part of the name: "alpha-web." is alpha-web.
const bare = (text: string) => text.replace(/\.+$/, "");

/** A known name, as written or without a closing dot. */
function lookup(known: RepositoryIndex | undefined, text: string) {
  return resolveRepositoryName(known, text) ?? (bare(text) !== text ? resolveRepositoryName(known, bare(text)) : null);
}

function matches(text: string) {
  return [...text.matchAll(reference)].flatMap(match => {
    const [whole, , qualifier, digits] = match;
    const number = Number(digits);
    if (number > 2147483647) return [];
    return [{ start: match.index + whole.length - digits.length - 1, digits, number, qualifier }];
  });
}

const blockTypes = new Set(["paragraph", "heading", "blockquote", "list", "list_item", "space", "code", "hr", "table"]);

function plain(tokens: Token[]): string {
  return tokens.map(token => "tokens" in token && Array.isArray(token.tokens) ? plain(token.tokens)
    : "text" in token && typeof token.text === "string" ? token.text : "").join("");
}

// One walk over the inline tokens in reading order, shared by the scan and the rewrite so their positions agree.
function walk(tokens: Token[], visit: { text(text: string): void; other(text: string): void }) {
  for (const token of tokens) {
    // A link's words still name things ("[alpha-web](…) #12"), but numbers inside a link are never rewritten.
    if (token.type === "link") visit.other(plain(token.tokens ?? []) || token.text);
    else if (token.type === "image") visit.other(" ");
    // HistoryMarkdown draws <br> as a line break.
    else if (token.type === "br" || (token.type === "html" && /^<br\s*\/?\s*>$/i.test(token.raw))) visit.other("\n");
    else if (token.type === "codespan") visit.other(token.text);
    // "alpha\-web" shows alpha-web: an escaped character reads as itself, but is never a reference.
    else if (token.type === "escape") visit.other(token.text);
    else if ("tokens" in token && Array.isArray(token.tokens)) {
      walk(token.tokens, visit);
      if (blockTypes.has(token.type)) visit.other("\n");
    } else if (blockTypes.has(token.type)) visit.other("\n");
    else if (token.type === "text" && typeof token.text === "string") visit.text(token.text);
    else visit.other(" ");
  }
}

type Reference = { at: number; length: number; qualifier?: string };

/** The inline text as one string with line breaks, and where each reference sits in it. */
function flatten(tokens: Token[]) {
  let flat = "";
  const refs: Reference[] = [];
  walk(tokens, {
    other: text => { flat += text; },
    text: text => {
      for (const ref of matches(text)) refs.push({ at: flat.length + ref.start, length: ref.digits.length + 1, qualifier: ref.qualifier });
      flat += text;
    },
  });
  return { flat, refs };
}

// Letters, digits and name punctuation continue a name; any other letter (Korean included) counts as a letter too.
const nameChar = (char: string | undefined) => !!char && (/[\w.-]/.test(char) || char.charCodeAt(0) >= 0xc0);

/** The project title (see {@link RepositoryIndex.phrases}) that `text` ends with, as a whole name. */
function phraseEnding(text: string, known: RepositoryIndex | undefined): string | null {
  const lower = text.toLowerCase();
  if (!known || lower.length !== text.length) return null;
  return known.phrases.find(phrase => lower.endsWith(phrase) && !nameChar(text[text.length - phrase.length - 1])) ?? null;
}

/** True when a name ending at `end` stops there: nothing name-like follows, or only a Korean particle does ("알파 웹에서"). */
function nameEndsAt(line: string, end: number) {
  if (!nameChar(line[end])) return true;
  const found = particleAtStart.exec(line.slice(end))?.[0];
  return !!found && !nameChar(line[end + found.length]);
}

/** Whole project titles in a text (longest first), and the text with them blanked out so their words are not read again. */
function phrasesIn(line: string, known: RepositoryIndex | undefined) {
  const found: string[] = [];
  const lower = line.toLowerCase();
  if (!known?.phrases.length || lower.length !== line.length) return { found, rest: line };
  let rest = line;
  for (const phrase of known.phrases) {
    for (let at = lower.indexOf(phrase); at >= 0; at = lower.indexOf(phrase, at + 1)) {
      const end = at + phrase.length;
      // An earlier, longer title already covers part of this one.
      if (rest.slice(at, end) !== line.slice(at, end) || nameChar(line[at - 1]) || !nameEndsAt(line, end)) continue;
      found.push(phrase);
      rest = rest.slice(0, at) + " ".repeat(phrase.length) + rest.slice(end);
    }
  }
  return { found, rest };
}

/** The name right before a number: a project title or a word. A known one links there, any other blocks. "PR" and numbers are not names. */
function nameBefore(head: string, known: RepositoryIndex | undefined): RepositoryClue | null {
  const gap = gapBeforeNumber.exec(head);
  if (gap) {
    const stem = head.slice(0, gap.index);
    const phrase = phraseEnding(stem, known) ?? phraseEnding(stem.replace(particleAtEnd, ""), known);
    if (phrase) return lookup(known, phrase);
  }
  const found = before.exec(head);
  if (!found) return null;
  const name = found[1];
  if (/^pr$/i.test(name) || /^\d+$/.test(name) || head[found.index - 1] === "#") return null;
  return lookup(known, name) ?? { blocked: true };
}

/** The name in brackets right after a number: a known name links there, another one-word name blocks, other words are not names. */
function nameAfter(text: string | undefined, known: RepositoryIndex | undefined): RepositoryClue | null {
  const name = text?.trim();
  if (!name) return null;
  return lookup(known, name) ?? (oneWord.test(name) ? { blocked: true } : null);
}

function resolve(flat: string, ref: Reference, context: PullLinkContext): string | null {
  if (ref.qualifier) {
    const clue = lookup(context.known, ref.qualifier);
    return clue && "repo" in clue ? clue.repo : null;
  }
  const start = flat.lastIndexOf("\n", ref.at - 1) + 1;
  const endAt = flat.indexOf("\n", ref.at);
  const end = endAt < 0 ? flat.length : endAt;
  let from = Math.max(start, ref.at - 200);
  // Never start the slice inside a name, or its tail could read as another repository.
  while (from > start && /[\w./-]/.test(flat[from - 1])) from--;
  const left = nameBefore(flat.slice(from, ref.at), context.known);
  const right = nameAfter(after.exec(flat.slice(ref.at + ref.length, Math.min(end, ref.at + ref.length + 200)))?.[1], context.known);
  // "Merged #12 (alpha-web)": a known name in brackets wins over an unknown word before; two different known names cancel.
  if (right && "repo" in right) return left && "repo" in left && left.repo !== right.repo ? null : right.repo;
  if (left) return "repo" in left ? left.repo : null;
  if (right) return null;
  if (context.row) return "repo" in context.row ? context.row.repo : null;
  return context.repository ?? null;
}

/**
 * Turns `#N` into links by the explicit clues above. An unknown or ambiguous name leaves it unlinked:
 * a missing link is better than one that opens the wrong PR.
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

const repositoryColumn = (table: Pick<Tokens.Table, "header">) =>
  table.header.findIndex(cell => repositoryHeaders.has(plain(cell.tokens).trim().toLowerCase()));

/**
 * What each body row's repository column says. The column is found only by its header ("저장소", "Repository"…).
 * A name there the board knows links the row; any other name blocks it; an empty cell says nothing.
 */
export function tableRowClues(table: Pick<Tokens.Table, "header" | "rows">, known: RepositoryIndex | undefined): (RepositoryClue | null)[] {
  const column = repositoryColumn(table);
  return table.rows.map(row => {
    const text = column >= 0 && row[column] ? plain(row[column].tokens).trim() : "";
    if (!text) return null;
    return lookup(known, text) ?? { blocked: true };
  });
}

/** Whether a piece of text names a repository other than `card`: a known name or project title, or any owner/repository. */
function namesOther(text: string, card: string, known: RepositoryIndex | undefined) {
  const other = (clue: RepositoryClue | null) => !!clue && (!("repo" in clue) || clue.repo !== card);
  for (const match of text.matchAll(githubUrl)) if (bare(match[1]).toLowerCase() !== card) return true;
  const { found, rest } = phrasesIn(text, known);
  if (found.some(phrase => other(lookup(known, phrase)))) return true;
  for (const match of rest.matchAll(names)) {
    const name = bare(match[0]);
    if (name.includes("/")) {
      if (qualifiedShape.test(name) && name.toLowerCase() !== card) return true;
    } else if (other(lookup(known, name))) return true;
  }
  return false;
}

/** Link addresses anywhere in inline tokens. */
function hrefs(tokens: Token[], out: string[]) {
  for (const token of tokens) {
    if (token.type === "link") out.push(String(token.href ?? ""));
    if ("tokens" in token && Array.isArray(token.tokens)) hrefs(token.tokens, out);
  }
}

/**
 * The text a reader sees, one entry per block (paragraph, heading, list item, table cell) with formatting removed,
 * so a name split by formatting ("**Alpha** Web") reads whole. Code blocks aside. Also each table's repository column values.
 */
function texts(tokens: Token[], out: string[] = [], columns: string[] = []) {
  const inline = (list: Token[]) => { out.push(flatten(list).flat); hrefs(list, out); };
  for (const token of tokens) {
    if (token.type === "code") continue;
    if (token.type === "table") {
      const table = token as Tokens.Table;
      const column = repositoryColumn(table);
      for (const cell of [...table.header, ...table.rows.flat()]) inline(cell.tokens);
      if (column >= 0) for (const row of table.rows) if (row[column]) columns.push(plain(row[column].tokens).trim());
    } else if (token.type === "list") {
      for (const item of (token as Tokens.List).items) texts(item.tokens, out, columns);
    } else if (token.type === "blockquote") texts(token.tokens ?? [], out, columns);
    else if ("tokens" in token && Array.isArray(token.tokens)) inline(token.tokens);
    else if ("text" in token && typeof token.text === "string") out.push(token.text);
  }
  return { out, columns };
}

/**
 * The card's repository for numbers with no name beside them, or nothing when the text (all of it, not only the line)
 * names any other repository: a known name or project title, an owner/repository, or a repository-column value other
 * than the card's own. Then such numbers stay unlinked rather than guess.
 */
export function fallbackRepository(tokens: Token[], repository: string | undefined, known: RepositoryIndex | undefined): string | undefined {
  if (!repository) return undefined;
  const card = repository.toLowerCase();
  const { out, columns } = texts(tokens);
  const otherColumn = columns.some(value => {
    if (!value) return false;
    const clue = lookup(known, value);
    return !clue || !("repo" in clue) || clue.repo !== card;
  });
  return otherColumn || out.some(text => namesOther(text, card, known)) ? undefined : repository;
}

/** The links the board draws for a Markdown text, in reading order, the way HistoryMarkdown renders it. */
export function pullLinksIn(source: string, context: { repository?: string; known?: RepositoryIndex; fallbackSource?: string }): { repo: string; number: number }[] {
  const tokens = lexBoardMarkdown(source);
  // A collapsed preview shows part of a text; the fallback is still decided on all of it.
  const whole = context.fallbackSource === undefined ? tokens : lexBoardMarkdown(context.fallbackSource);
  const repository = fallbackRepository(whole, context.repository, context.known);
  const found: { repo: string; number: number }[] = [];
  const collect = (list: Token[]) => {
    for (const token of list) {
      if (token.type === "pullReference") found.push({ repo: token.repo, number: token.number });
      else if ("tokens" in token && Array.isArray(token.tokens)) collect(token.tokens);
    }
  };
  const inline = (list: Token[], row?: RepositoryClue | null) => collect(pullReferenceTokens(list, { repository, known: context.known, row }));
  const blocks = (list: Token[]) => {
    for (const token of list) {
      if (token.type === "table") {
        const table = token as Tokens.Table;
        const clues = tableRowClues(table, context.known);
        for (const cell of table.header) inline(cell.tokens);
        table.rows.forEach((row, r) => { for (const cell of row) inline(cell.tokens, clues[r]); });
      } else if (token.type === "list") for (const item of (token as Tokens.List).items) blocks(item.tokens);
      else if (token.type === "blockquote") blocks(token.tokens ?? []);
      else if (token.type !== "code" && "tokens" in token && Array.isArray(token.tokens)) inline(token.tokens);
    }
  };
  blocks(tokens);
  return found;
}
