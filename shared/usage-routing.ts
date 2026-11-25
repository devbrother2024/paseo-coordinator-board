import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const stamp = z.string().nullable();
const quotaWindow = z.object({
  id:z.string(), label:z.string(), remainingPct:z.number().min(0).max(100).nullable(), resetsAt:stamp, summary:z.boolean(),
});
const balance = z.object({
  id:z.string(), label:z.string(), remaining:z.number().nullable(), limit:z.number().nullable(), unit:z.string(), resetsAt:stamp,
});
// Free resets of a usage limit some subscriptions grant. Paseo does not report them, so they come
// only from the host's account-usage.json and are shown, never used to pick an account.
const resetPass = z.object({
  id:z.string(), label:z.string(), left:z.number().int().nonnegative(), expiresAt:z.array(z.string()), note:z.string().optional(),
});
export type ResetPass = z.infer<typeof resetPass>;
export const accountUsage = z.object({
  providerId:z.string(), label:z.string(), plan:z.string().nullable(), fetchedAt:stamp,
  issue:z.enum(["login","rate-limit"]).optional(),
  status:z.enum(["available","unavailable","error"]), windows:z.array(quotaWindow), balances:z.array(balance),
  resetPasses:z.array(resetPass).optional(),
  // When the passes came from a host report on an account Paseo measures, the time that report was taken.
  // Paseo's own fetchedAt says nothing about how fresh the passes are.
  resetPassesFetchedAt:z.string().optional(),
});
export type AccountUsage = z.infer<typeof accountUsage>;

export const setUsageRouting = defineRpc({
  name:"board.set-usage-routing",
  input:z.strictObject({enabled:z.boolean(),expectedRevision:z.number().int().nonnegative()}),
  output:z.object({ok:z.boolean()}),
});

export function recentUsage(report:AccountUsage, now=Date.now()) {
  return recentReading(report.fetchedAt, now);
}

// How long a reading counts as current before the card calls it the last known one.
export const readingFreshFor = 15 * 60000;

export function recentReading(fetchedAt:string|null|undefined, now=Date.now()) {
  const fetched = fetchedAt ? Date.parse(fetchedAt) : NaN;
  return Number.isFinite(fetched) && fetched <= now + 60000 && now - fetched <= readingFreshFor;
}

export function hasUsageReading(report: AccountUsage) {
  const live = (reset:string|null) => !reset || Date.parse(reset) > Date.now();
  return report.status === "available" && (report.windows.some(w => w.remainingPct !== null && live(w.resetsAt))
    || report.balances.some(b => b.remaining !== null && live(b.resetsAt)));
}

// The public SDK names a scoped duration "scope:weekly"; native reports also
// use e.g. "weekly_model_fable". Other feature-only windows remain displayable.
function appliesToModel(id:string, model:string|undefined) {
  const match = /(?:^|[_-])model[_-](.+)$/.exec(id);
  const scope = match?.[1] ?? (id.includes(":") ? id.split(":")[0] : null);
  if (scope) {
    if (!model) return false;
    const words = (s:string) => "-"+s.toLowerCase().replace(/[^a-z0-9]+/g,"-")+"-";
    return words(model).includes(words(scope));
  }
  return !/(?:^|[_-])feature[_-]/.test(id);
}

function capacity(report:AccountUsage, now:number, model?:string) {
  const result = new Map<string,number>();
  if (report.status !== "available" || !recentUsage(report,now)) return result;
  const live = (end:string|null) => !end || Date.parse(end) > now;
  for (const w of report.windows) {
    if (appliesToModel(w.id,model) && w.remainingPct !== null && live(w.resetsAt)) result.set("window/"+w.id,w.remainingPct);
  }
  for (const b of report.balances) {
    if (appliesToModel(b.id,model) && b.remaining !== null && b.limit !== null && b.limit > 0 && live(b.resetsAt)) {
      result.set("balance/"+b.unit+"/"+b.id,Math.min(100,Math.max(0,100*b.remaining/b.limit)));
    }
  }
  return result;
}

// Compare the same reported quota dimensions across providers. Unknown or incomparable
// capacities never displace the recommended provider by assumption.
export function preferCapacity<T extends {provider:string;model?:string}>(choices:T[], reports:readonly AccountUsage[], now=Date.now()):T|null {
  const first = choices[0];
  if (!first || choices.length < 2 || !reports.length) return first ?? null;
  const byProvider = new Map<string,AccountUsage|null>();
  for (const report of reports) {
    // A usage source can publish separate logins under one provider ID. The
    // public SDK does not identify the login a new session will use.
    byProvider.set(report.providerId,byProvider.has(report.providerId) ? null : report);
  }
  const candidates = choices.map(choice => {
    const report = byProvider.get(choice.provider);
    return {choice,capacity:report ? capacity(report,now,choice.model) : new Map<string,number>()};
  });
  const baseline = candidates[0].capacity;
  if (!baseline.size) return first;
  const known = candidates.filter(c=>[...baseline.keys()].some(k=>c.capacity.has(k)));
  const shared = [...baseline.keys()].filter(k=>known.every(c=>c.capacity.has(k)));
  if (!shared.length) return first;
  // An extra short-term window can limit this provider even when only the weekly
  // window is present on both. The summary flag is for display, not eligibility.
  const score = (c:typeof candidates[number])=>Math.min(...c.capacity.values());
  return known.reduce((best,c)=>score(c)>score(best) ? c : best, known[0]).choice;
}
