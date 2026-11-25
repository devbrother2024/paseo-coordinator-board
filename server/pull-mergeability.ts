import type { PullDetail, PullRequestItem } from "../shared/prs";

type Pull = Omit<PullRequestItem, "projectIds">;
type Limit = <T>(task: () => Promise<T>) => Promise<T>;
export type MergeabilityOptions = { retryMs: number; attempts: number; perRead: number; resolvedMs: number; restMs: number; waitMs: number };
type Entry = { attempts: number; nextAt: number; item?: Pull; inflight?: Promise<void> };

const keyOf = (pr: Pull) => JSON.stringify([pr.repo, pr.number, pr.headSha ?? pr.updatedAt]);
const unreadable = (pr: Pull, detail: PullDetail): Pull => ({ ...pr, lane: "progress", reason: "unknown", detail });
// An entry whose last single read settled the state (not computing, not a failed read).
const answered = (entry: Entry) => !!entry.item && entry.item.reason !== "computing" && entry.item.reason !== "unknown";

// GitHub's PR list leaves mergeability UNKNOWN until someone asks for that PR alone.
// Ask only for PRs whose verdict hangs on it, a few at a time, and give up after a short round.
export class MergeabilityChecks {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly lookup: (repo: string, number: number) => Promise<Pull>, private readonly now: () => number,
    private readonly options: MergeabilityOptions, private readonly failure: (error: unknown) => PullDetail) {}

  // budget is shared by every repository in one board read.
  async apply(items: readonly Pull[], limit: Limit, allowed: () => boolean, budget: { left: number }): Promise<Pull[]> {
    const now = this.now();
    for (const [key, entry] of this.entries) if (!entry.inflight && entry.nextAt + this.options.restMs < now) this.entries.delete(key);
    const waiting = items.filter(pr => pr.reason === "computing").map(pr => {
      const key = keyOf(pr);
      let entry = this.entries.get(key);
      if (!entry) this.entries.set(key, entry = { attempts: 0, nextAt: 0 });
      return { key, pr, entry };
    });
    // PRs that never got a usable answer go first, then the longest waiting. Refreshing an answered PR
    // must not use up the budget while others have not been asked at all.
    const due = waiting.filter(({ entry }) => !entry.inflight && now >= entry.nextAt)
      .sort((a, b) => Number(answered(a.entry)) - Number(answered(b.entry)) || a.entry.nextAt - b.entry.nextAt);
    for (const { pr, entry } of due) {
      if (budget.left <= 0 || !allowed()) break;
      budget.left--;
      entry.inflight = limit(() => this.check(pr, entry)).finally(() => { entry.inflight = undefined; });
    }
    const byKey = new Map(waiting.map(row => [row.key, row.entry]));
    return Promise.all(items.map(async pr => {
      if (pr.reason !== "computing") return pr;
      const entry = byKey.get(keyOf(pr))!;
      // A quick answer is used in this read. A slow one keeps running and serves a later read,
      // so this read never waits for the full gh timeout.
      if (entry.inflight) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([entry.inflight, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.waitMs); })]);
        clearTimeout(timer);
      }
      return entry.item ?? pr;
    }));
  }

  private async check(pr: Pull, entry: Entry) {
    let fresh: Pull | null;
    let failed: PullDetail = "lookup-failed";
    try { fresh = await this.lookup(pr.repo, pr.number); } catch (error) { fresh = null; failed = this.failure(error); }
    const now = this.now();
    if (fresh && fresh.reason !== "computing") {
      Object.assign(entry, { attempts: 0, nextAt: now + this.options.resolvedMs, item: fresh });
      return;
    }
    entry.attempts++;
    const exhausted = entry.attempts >= this.options.attempts;
    // A failed read is unknown right away. A PR still computing reads as unknown once the round runs out.
    entry.item = !fresh ? unreadable(pr, failed) : exhausted ? unreadable(pr, "still-computing") : fresh;
    entry.nextAt = now + (exhausted ? this.options.restMs : this.options.retryMs);
    if (exhausted) entry.attempts = 0;
  }
}
