import type { PullRequestItem } from "../shared/prs";

type Pull = Omit<PullRequestItem, "projectIds">;
type Limit = <T>(task: () => Promise<T>) => Promise<T>;
export type MergeabilityOptions = { retryMs: number; attempts: number; perRead: number; resolvedMs: number; restMs: number };
type Entry = { attempts: number; nextAt: number; item?: Pull; inflight?: Promise<void> };

const keyOf = (pr: Pull) => JSON.stringify([pr.repo, pr.number, pr.headSha ?? pr.updatedAt]);
const unreadable = (pr: Pull): Pull => ({ ...pr, lane: "progress", reason: "unknown" });

// GitHub's PR list leaves mergeability UNKNOWN until someone asks for that PR alone.
// Ask only for PRs whose verdict hangs on it, a few at a time, and give up after a short round.
export class MergeabilityChecks {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly lookup: (repo: string, number: number) => Promise<Pull>, private readonly now: () => number,
    private readonly options: MergeabilityOptions) {}

  // budget is shared by every repository in one board read.
  async apply(items: readonly Pull[], limit: Limit, allowed: () => boolean, budget: { left: number }): Promise<Pull[]> {
    const now = this.now();
    for (const [key, entry] of this.entries) if (!entry.inflight && entry.nextAt + this.options.restMs < now) this.entries.delete(key);
    return Promise.all(items.map(async pr => {
      if (pr.reason !== "computing") return pr;
      const key = keyOf(pr);
      let entry = this.entries.get(key);
      if (!entry) this.entries.set(key, entry = { attempts: 0, nextAt: 0 });
      if (!entry.inflight && now >= entry.nextAt && budget.left > 0 && allowed()) {
        budget.left--;
        const current = entry;
        current.inflight = limit(() => this.check(pr, current)).finally(() => { current.inflight = undefined; });
      }
      if (entry.inflight) await entry.inflight;
      return entry.item ?? pr;
    }));
  }

  private async check(pr: Pull, entry: Entry) {
    let fresh: Pull | null;
    try { fresh = await this.lookup(pr.repo, pr.number); } catch { fresh = null; }
    const now = this.now();
    if (fresh && fresh.reason !== "computing") {
      Object.assign(entry, { attempts: 0, nextAt: now + this.options.resolvedMs, item: fresh });
      return;
    }
    entry.attempts++;
    const exhausted = entry.attempts >= this.options.attempts;
    // A failed read is unknown right away. A PR still computing reads as unknown once the round runs out.
    entry.item = !fresh || exhausted ? unreadable(pr) : fresh;
    entry.nextAt = now + (exhausted ? this.options.restMs : this.options.retryMs);
    if (exhausted) entry.attempts = 0;
  }
}
