import { closeSync, constants, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { repositorySlug } from "../shared/prs";
import { trackedDecisionInputSchema } from "../shared/tracked-decisions";
import { ledgerFieldLimit, ledgerIssueLimit, type LedgerField, type LedgerIssue } from "../shared/ledger-diagnostics";
import { openNoFollowSync } from "./safe-open";

// Only an operator-provided local manifest can name a ledger directory.
// The UI, sessions, and decision content cannot change which files are opened.
const nonempty = z.string().trim().min(1);
const match = z.object({ id: nonempty, title: nonempty, ask: z.array(z.string()), projectId: nonempty, sessionId: nonempty, question: nonempty });
const manifest = z.object({ version: z.literal(1), sources: z.array(z.object({
  source: nonempty, projectId: nonempty.nullable(), projectTitle: nonempty,
  directory: nonempty.refine(isAbsolute), coordinatorFile: z.unknown().optional(), repository: repositorySlug.optional(), matches: z.array(match).default([]),
})).max(200) });
const lines = z.union([z.string(), z.array(z.string())]).nullish()
  .transform(value => (typeof value === "string" ? [value] : value ?? []).map(s => s.trim()).filter(Boolean));
const entry = z.object({
  id: nonempty, title: nonempty, kind: z.string().optional(), where: z.string().optional(), agentId: nonempty.nullish(), sessionHost:nonempty.nullish(),
  ask: lines, recommend: lines, why: lines, risk: lines, steps: lines, qa: z.array(z.unknown()).default([]),
  questions: z.array(z.object({ id:z.string().optional(), text:nonempty, multi:z.boolean().optional(), options:z.array(z.object({
    key:nonempty,text:nonempty,recommended:z.boolean().default(false),does:lines,pros:lines,cons:lines,note:z.string().nullish(),
  })) })).default([]),
  pr: z.number().int().positive().nullish(), since:z.string().nullish(), howToAnswer:z.string().nullish(), answerLead:z.string().nullish(), urgency:z.string().nullish(),
  dueAt:z.string().max(64).nullish(), blocksWork:z.boolean().nullish(), recommendedReply:z.string().nullish(),
});
const ledger = z.object({ items: z.array(z.unknown()) });
type LedgerSource = z.infer<typeof manifest>["sources"][number];

function diagnosticText(value: unknown) {
  if (typeof value !== "string") return;
  const cleaned = value.replace(/[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu, "").trim();
  return cleaned.slice(0, 256).replace(/[\uD800-\uDBFF]$/, "").trimEnd() || undefined;
}

function diagnosticFields(error: z.ZodError, raw?: unknown, imported = false): LedgerField[] {
  const card = raw as { questions?: { options?: { label?: unknown }[] }[] } | null | undefined;
  return error.issues.slice(0, ledgerFieldLimit).map(issue => {
    const path = imported && issue.path[0] === "sessionId" ? ["agentId", ...issue.path.slice(1)] : issue.path;
    const reason = issue.code === "invalid_type" && issue.input === undefined ? "missing" : "invalid";
    const [questions, question, options, option, text] = path;
    const labelOnly = reason === "missing" && path.length === 5 && questions === "questions" &&
      options === "options" && text === "text" && typeof question === "number" && typeof option === "number" &&
      card?.questions?.[question]?.options?.[option]?.label !== undefined;
    return { path: path.join(".").slice(0, 256), reason, ...(labelOnly ? { hint: "option-text" } : {}) };
  });
}
function openSourceFile(path: string, optional: boolean, ownerFile = false) {
  try { return ownerFile ? openNoFollowSync(path) : openSync(path, constants.O_RDONLY | constants.O_NONBLOCK); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Could not open decision source");
  }
}
function localFile(path: string, optional = false, ownerFile = false) {
  const fd = openSourceFile(path, optional, ownerFile);
  if (fd === null) return null;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid decision source");
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}

const historyRowLimit = 200;
const historyByteLimit = 256 * 1024;

function historyRows(path: string) {
  const fd = openSourceFile(path, true);
  if (fd === null) return [];
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Invalid decision history");
    const buffer = Buffer.alloc(Math.min(stat.size, historyByteLimit));
    const start = stat.size - buffer.length;
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, start + length);
      if (!count) throw new Error("Incomplete decision history");
      length += count;
    }
    // Skip the header on a complete read, or the possibly partial first line of a tail.
    // If the tail begins just after a newline, its first row is already complete.
    const preceding = Buffer.alloc(1);
    if (start > 0 && readSync(fd, preceding, 0, 1, start - 1) !== 1) throw new Error("Incomplete decision history");
    const after = fstatSync(fd);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Decision history changed during read");
    const rows = buffer.toString("utf8").split(/\r?\n/).slice(preceding[0] === 10 ? 0 : 1).filter(Boolean);
    if (start > 0 && rows.length < historyRowLimit) throw new Error("Incomplete decision history");
    return rows.slice(-historyRowLimit);
  } finally { closeSync(fd); }
}

type History = {at:string; text:string};
function history(path: string) {
  const byId = new Map<string, History[]>();
  for (const row of historyRows(path)) {
    const [at,id,...parts] = row.split("\t");
    if (!id || !at || !parts.length) continue;
    // New rows store the original message, attachment count and (optionally) a shorter copy.
    if (parts.length === 3 && /^\d+$/.test(parts[1])) parts.splice(1);
    else if (parts.length > 1 && /^\d+$/.test(parts[parts.length-1])) parts.pop();
    const text = parts.join(" ").trim();
    if (text) byId.set(id, [...byId.get(id) ?? [], {at,text}]);
  }
  return byId;
}

const ownerRecord = z.object({ agentId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,255}$/) });

function sourceCoordinator(path: unknown, cache: Map<string, string | null>) {
  if (typeof path !== "string" || !isAbsolute(path)) return null;
  if (cache.has(path)) return cache.get(path)!;
  let id: string | null = null;
  try {
    id = ownerRecord.parse(JSON.parse(localFile(path, false, true)!)).agentId;
  } catch { /* An unreadable owner leaves the ledger available for local recording. */ }
  cache.set(path, id);
  return id;
}

export function readProjectDecisionSources(manifestPath: string, selected: Set<string>) {
  if (!selected.size) return { items: [] };
  const raw = localFile(manifestPath, true);
  if (raw === null) return { items: [] };
  const { sources } = manifest.parse(JSON.parse(raw));
  const visible = sources.filter(s => !s.projectId || selected.has(s.projectId));
  const keys = visible.map(s => JSON.stringify([s.source,s.projectId]));
  if (new Set(keys).size !== keys.length) throw new Error("Ambiguous decision source");
  const owners = new Map<string,string | null>();
  const sourceIssues: LedgerIssue[] = [];
  const otherIssues: LedgerIssue[] = [];
  let count = 0;
  const report = (issue: LedgerIssue) => {
    count++;
    const bucket = issue.kind === "source" ? sourceIssues : otherIssues;
    if (bucket.length < ledgerIssueLimit) bucket.push(issue);
  };
  const items = visible.flatMap(source => readLedger(source, selected, sourceCoordinator(source.coordinatorFile, owners), report));
  const issues = [...sourceIssues, ...otherIssues].slice(0, ledgerIssueLimit);
  return { items, ...(count ? { diagnostics: { count, issues } } : {}) };
}

function readLedger(source: LedgerSource, selected: Set<string>, sourceCoordinatorId: string | null, report: (issue: LedgerIssue) => void) {
  const name = diagnosticText(source.source) ?? "?";
  const location = { source: name, projectTitle: diagnosticText(source.projectTitle) ?? name };
  let items: unknown[];
  try {
    const document = localFile(join(source.directory, "decisions.json"));
    items = ledger.parse(JSON.parse(document!)).items;
  } catch {
    report({ ...location, kind: "source" });
    return [];
  }
  const readHistory = (part: "answers" | "questions") => {
    try { return history(join(source.directory, "live", `board-${part}.tsv`)); }
    catch {
      report({ ...location, kind: "history", part });
      return null;
    }
  };
  const answers = readHistory("answers");
  const asked = readHistory("questions");
  const historyUnavailable = !answers || !asked;
  const invalid = (raw: unknown, row: number, fields: LedgerField[]) => {
    const metadata = raw && typeof raw === "object" ? raw as { id?: unknown; title?: unknown } : undefined;
    report({ ...location, kind: "entry", row, id: diagnosticText(metadata?.id), title: diagnosticText(metadata?.title), fields });
  };
  const valid = items.flatMap((raw, index) => {
    const parsed = entry.safeParse(raw, { reportInput: true });
    if (!parsed.success) {
      invalid(raw, index + 1, diagnosticFields(parsed.error, raw));
      return [];
    }
    const row = parsed.data;
    const binding = source.matches.find(m => m.id === row.id && m.sessionId === row.agentId && m.title === row.title &&
      JSON.stringify(m.ask) === JSON.stringify(row.ask) && selected.has(m.projectId));
    const kind = row.kind === "approval" ? "approve" : row.kind === "human" ? "check"
      : ["check","answer","approve","merge","cleanup"].includes(row.kind ?? "") ? row.kind : "other";
    const pullTarget = source.repository && row.pr ? { repo: source.repository, number: row.pr } : undefined;
    const since = Date.parse(row.since ?? "");
    const current = (event: History) => Number.isFinite(since) && Date.parse(event.at) >= since;
    const qa = [...row.qa];
    for (const prior of (asked?.get(row.id) ?? []).filter(current)) {
      if (!row.qa.some(q => q && typeof q === "object" && "q" in q && q.q === prior.text)) qa.push({q:prior.text,a:null,askedAt:prior.at});
    }
    const item = {
      sourceCoordinatorId, source: source.source, projectId: source.projectId, projectTitle: source.projectTitle,
      ...(historyUnavailable ? { historyUnavailable: true } : {}),
      id:row.id,title:row.title,kind,where:row.where,ask:row.ask,recommend:row.recommend,why:row.why,risk:row.risk,steps:row.steps,
      dueAt:row.dueAt, blocksWork:row.blocksWork, recommendedReply:row.recommendedReply, since:row.since, urgency:row.urgency, howToAnswer:row.howToAnswer, answerLead:row.answerLead, sessionId:row.agentId ?? null, sessionHost:row.sessionHost ?? null,
      questions:row.questions.map(q => ({...q, multi:q.multi ?? /복수|여러\s*개|여럿|select (?:all|multiple)/i.test(q.text)})),
      qa, replyHistory:(answers?.get(row.id) ?? []).filter(current),
      pullRepository:source.repository, pullTarget,
      mergeTarget:kind === "merge" ? pullTarget : undefined,
      sessionMatch:binding ? {projectId:binding.projectId, sessionId:binding.sessionId, question:binding.question} : undefined,
    };
    // Validate the imported card against the same limits as the decision store.
    const checked = trackedDecisionInputSchema.safeParse(item, { reportInput: true });
    if (!checked.success) {
      invalid(raw, index + 1, diagnosticFields(checked.error, raw, true));
      return [];
    }
    return [{ item, raw, row: index + 1 }];
  });
  const counts = new Map<string, number>();
  for (const { item } of valid) counts.set(item.id, (counts.get(item.id) ?? 0) + 1);
  return valid.flatMap(({ item, raw, row }) => {
    if (counts.get(item.id) === 1) return [item];
    invalid(raw, row, [{ path: "id", reason: "duplicate" }]);
    return [];
  });
}
