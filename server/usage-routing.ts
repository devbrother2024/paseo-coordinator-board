import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { AccountUsage } from "../shared/usage-routing";

type Sdk = Pick<PluginHandlerContext["paseo"],"providers">;
const amount = (n:unknown) => typeof n === "number" && Number.isFinite(n) ? n : null;
const percent = (n:unknown) => typeof n === "number" && Number.isFinite(n) && n>=0 && n<=100 ? n : null;
const time = (s:unknown) => typeof s==="string" && Number.isFinite(Date.parse(s)) ? s : null;

function usageIssue(error: string | null | undefined) {
  if (!error) return undefined;
  if (/\b429\b|rate.limit/i.test(error)) return "rate-limit" as const;
  if (/\b401\b|sign in again|login expired/i.test(error)) return "login" as const;
  return undefined;
}

export async function readAccountUsage(paseo:Sdk):Promise<AccountUsage[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    // Slow account reporters must not stall model discovery or prevent an
    // otherwise valid assignment. The daemon retains its own usage cache.
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Usage lookup timed out")), 3000);
      timeout.unref?.();
    });
    const snapshot = await Promise.race([paseo.providers.listUsage(), deadline]);
    return snapshot.providers.map(p=>({
      providerId:p.providerId,label:p.displayName || p.providerId,plan:p.planLabel ?? null,status:p.status,
      issue:p.status === "available" ? undefined : usageIssue(p.error),
      fetchedAt:time(p.fetchedAt) ?? time(snapshot.fetchedAt),
      windows:p.windows.map(w=>({
        id:w.id,label:w.label,summary:w.summary ?? false,resetsAt:time(w.resetsAt),
        remainingPct:percent(w.remainingPct) ?? (percent(w.usedPct) !== null ? 100 - w.usedPct! : null),
      })),
      balances:(p.balances ?? []).map(b=>({
        id:b.id,label:b.label,unit:b.unit,limit:amount(b.limit),resetsAt:time(b.resetsAt),
        remaining:amount(b.remaining) ?? (amount(b.limit) !== null && amount(b.used) !== null ? Math.max(0,b.limit!-b.used!) : null),
      })),
    }));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}
