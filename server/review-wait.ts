import type { SessionRow } from "../shared/contract";
import type { TrackedDecision } from "../shared/tracked-decisions";
import { cleanSessionText, DEFAULT_STALE_HOURS, lastMessageSummary, needsCoordinator, reviewWaitSetting } from "../shared/review-wait";
import type { Evidence } from "./conversation";
import type { PluginServerContext } from "@getpaseo/plugin/server";

// Open ledger cards that point at a session already carry its next step.
export function coveredSessionIds(items: readonly Pick<TrackedDecision, "sessionId" | "sessionMatch" | "matchedSessionId">[]) {
  const ids = new Set<string>();
  for (const item of items) {
    for (const id of [item.sessionId, item.sessionMatch?.sessionId, item.matchedSessionId]) if (id) ids.add(id);
  }
  return ids;
}

type Context = {
  coordinator: string | null; now: number; thresholdHours: number; covered: ReadonlySet<string>;
  judgments: Record<string, { evidenceId: string; projectId: string }>;
};

export function coordinatorHandled(row: Pick<SessionRow, "id" | "projectId">, evidence: Evidence | undefined, context: Pick<Context, "coordinator" | "judgments">) {
  const judgment = context.judgments[row.id];
  return !!evidence && ((!!context.coordinator && evidence.lastInputSender === context.coordinator) ||
    (judgment?.projectId === row.projectId && judgment.evidenceId === evidence.id));
}

// Uses only excerpts the board already read for idle and review sessions.
export function decorateReviewWait(rows: SessionRow[], evidence: ReadonlyMap<string, Evidence>, context: Context) {
  for (const row of rows) {
    const observed = evidence.get(row.id);
    const resting = row.lane === "review" || row.lane === "idle";
    // A kept decision describes an earlier turn. The latest turn can still describe a wait.
    const wait = row.status === "idle" && row.id !== context.coordinator && !row.nativePending &&
      (resting || row.lane === "human") ? observed?.coordinatorWait : undefined;
    if (wait) {
      row.coordinatorWait = wait.reason;
      row.waitingSince = wait.since ?? row.waitingSince ?? row.activityAt;
    }
    if (!resting) {
      if (!wait) delete row.waitingSince;
      continue;
    }
    const last = observed?.turns.findLast(turn => turn.role === "assistant");
    if (last) {
      const summary = lastMessageSummary(last.text);
      if (summary) row.lastSummary = summary;
      if (row.lane === "review") {
        row.lastMessage = cleanSessionText(last.text);
        if (last.truncated) row.lastMessageTruncated = true;
      }
    }
    // Without an excerpt the board cannot tell whether the coordinator acted, so it does not flag.
    if (row.lane === "review" && observed && needsCoordinator({ coordinator: context.coordinator, sessionId: row.id, waitingSince: row.waitingSince, now: context.now,
      thresholdHours: context.thresholdHours, covered: context.covered.has(row.id),
      coordinatorTouched: coordinatorHandled(row, observed, context) })) {
      row.needsCoordinator = true;
    }
  }
}

export function reviewWaitThreshold(server: Pick<PluginServerContext, "registerSettings">) {
  const settings = server.registerSettings(reviewWaitSetting);
  return async () => {
    try {
      const state = await settings?.read();
      if (state?.status === "ready") return state.values.staleHours;
    } catch {
      // Fall back to the default when the host setting cannot be read.
    }
    return DEFAULT_STALE_HOURS;
  };
}
