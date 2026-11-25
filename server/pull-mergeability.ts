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

  // One board read: every repository's PRs together, so the budget goes to unanswered PRs
  // across all repositories before any answered one is refreshed.
  async apply(groups: readonly { items: readonly Pull[]; allowed: () => boolean }[], limit: Limit, budget: number): Promise<Pull[][]> {
    const now = this.now();
    for (const [key, entry] of this.entries) if (!entry.inflight && entry.nextAt + this.options.restMs < now) this.entries.delete(key);
    const waiting = groups.flatMap(({ items, allowed }) => items.filter(pr => pr.reason === "computing").map(pr => {
      const key = keyOf(pr);
      let entry = this.entries.get(key);
      if (!entry) this.entries.set(key, entry = { attempts: 0, nextAt: 0 });
      return { pr, entry, allowed };
    }));
    // PRs that never got a usable answer go first, then the longest waiting.
    const due = waiting.filter(({ entry }) => !entry.inflight && now >= entry.nextAt)
      .sort((a, b) => Number(answered(a.entry)) - Number(answered(b.entry)) || a.entry.nextAt - b.entry.nextAt);
    let left = budget;
    for (const { pr, entry, allowed } of due) {
      if (left <= 0) break;
      if (!allowed()) continue;
      left--;
      entry.inflight = limit(() => this.check(pr, entry)).finally(() => { entry.inflight = undefined; });
    }
    return Promise.all(groups.map(({ items }) => Promise.all(items.map(async pr => {
      if (pr.reason !== "computing") return pr;
      const entry = this.entries.get(keyOf(pr))!;
      // A quick answer is used in this read. A slow one keeps running and serves a later read,
      // so this read never waits for the full gh timeout.
      if (entry.inflight) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([entry.inflight, new Promise<void>(resolve => { timer = setTimeout(resolve, this.options.waitMs); })]);
        clearTimeout(timer);
      }
      return entry.item ?? pr;
    }))));
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
