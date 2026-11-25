import { join } from "node:path";
import { z } from "zod";
import { accountUsage, hasUsageReading, type AccountUsage, type ResetPass } from "../shared/usage-routing";
import { openNoFollow } from "./safe-open";

const timestamp = z.iso.datetime({offset:true});
const report = accountUsage.extend({
  providerId: z.string().trim().min(1).max(256),
  label: z.string().trim().min(1).max(256),
  fetchedAt: timestamp,
  windows: accountUsage.shape.windows.element.extend({resetsAt:timestamp.nullable()}).array().max(32),
  balances: accountUsage.shape.balances.element.extend({resetsAt:timestamp.nullable()}).array().max(32),
  // Checked one pass at a time below, so one bad pass does not cost the whole report.
  resetPasses: z.unknown().optional(),
});
const resetPass = z.object({
  id: z.string().trim().min(1).max(64),
  label: z.string().trim().min(1).max(64),
  left: z.number().int().nonnegative().max(9999),
  expiresAt: z.array(timestamp).max(16),
  // A blank note is the same as no note, so it does not cost the pass.
  note: z.preprocess(value => typeof value === "string" && !value.trim() ? undefined : value, z.string().trim().max(200).optional()),
});
const feed = z.object({version:z.literal(1),reports:z.array(z.unknown()).max(128)});
const maxBytes = 128 * 1024;
const maxPasses = 16;

// Keeps the valid passes of a report and drops the rest. Without one valid pass the report has none.
function resetPasses(raw: unknown): ResetPass[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const passes = raw.slice(0, maxPasses).flatMap(entry => {
    const pass = resetPass.safeParse(entry);
    return pass.success ? [pass.data] : [];
  });
  return passes.length ? passes : undefined;
}

async function readHostReports(directory: string): Promise<AccountUsage[]> {
  let file;
  try {
    file = await openNoFollow(join(directory, "account-usage.json"));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) return [];
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length !== stat.size) return [];
    const entries = feed.parse(JSON.parse(bytes.toString("utf8", 0, length))).reports;
    return entries.flatMap(raw => {
      const entry = report.safeParse(raw);
      if (!entry.success) return [];
      const { resetPasses: rawPasses, ...rest } = entry.data;
      const passes = resetPasses(rawPasses);
      return [passes ? { ...rest, resetPasses: passes } : rest];
    });
  } catch { return []; }
  finally { await file?.close(); }
}

// Pairs one account Paseo measures with the host report for it. One on each side pairs as is; otherwise only
// a label that names exactly one account on each side pairs. Anything unclear pairs nothing.
function pairedReport(own: AccountUsage, accounts: readonly AccountUsage[], reports: readonly AccountUsage[]) {
  if (accounts.length === 1 && reports.length === 1) return reports[0];
  const sameLabel = (entry: AccountUsage) => entry.label === own.label;
  const matches = reports.filter(sameLabel);
  return matches.length === 1 && accounts.filter(sameLabel).length === 1 ? matches[0] : undefined;
}

// Combines the host file with Paseo's own usage. Providers Paseo measures keep its windows and balances and
// only gain the file's reset passes; for the rest the file's reports become display-only cards.
export function mergeHostUsage(reports: readonly AccountUsage[], providers: readonly {id:string}[], native: readonly AccountUsage[]) {
  const installed = new Set(providers.map(p => p.id));
  const measured = new Set(native.filter(hasUsageReading).map(entry => entry.providerId));
  const display = reports.filter(entry => installed.has(entry.providerId) && !measured.has(entry.providerId));
  const usage = native.map(entry => {
    if (!installed.has(entry.providerId) || !measured.has(entry.providerId)) return entry;
    const accounts = native.filter(own => own.providerId === entry.providerId);
    const host = pairedReport(entry, accounts, reports.filter(own => own.providerId === entry.providerId));
    // The passes keep the time of the host report they came from, so an old file never looks as fresh as Paseo's reading.
    return host?.resetPasses ? { ...entry, resetPasses: host.resetPasses, resetPassesFetchedAt: host.fetchedAt ?? undefined } : entry;
  });
  return { display, usage };
}

// Optional host-maintained readings are for display only. Remote callers cannot select a file.
export async function readDisplayUsage(directory: string, providers: readonly {id:string}[], native: readonly AccountUsage[]) {
  if (!providers.length) return { display: [] as AccountUsage[], usage: [...native] };
  return mergeHostUsage(await readHostReports(directory), providers, native);
}
