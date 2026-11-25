import type { ReplyEntry } from "../shared/reply-history";
import type { HistorySession } from "./history-sessions";
import type { Lane } from "./model";

type Translate = (korean: string, english: string) => string;

// A sent reply waits on the project board for one day. After that, once the session answers, or once the ledger card it
// answered is taken down, it stays only in Recent decision activity.
export const FOLLOWUP_WINDOW_MS = 24 * 60 * 60 * 1000;

// Board replies are listed once, in Recent decision activity, not as a kanban column.
export const KANBAN_ORDER: readonly Lane[] = ["running", "review", "human", "idle", "done", "unknown"];

export function recipientLink(links: readonly HistorySession[]) {
  return links.find(link => link.role !== "source");
}

function findable(link: HistorySession | undefined) {
  return !!link && (link.available || !!link.verify);
}

// The board cannot find the recipient: neither this host's listed sessions nor a host that can still be checked has it.
// The session may be archived, or only outside the board's current scope (an earlier coordinator, a moved session).
export function recipientNotFound(entry: ReplyEntry, links: readonly HistorySession[]) {
  if (entry.status !== "sent") return false;
  const link = recipientLink(links);
  return !!link && !findable(link);
}

export type FollowupKind = "waiting" | "unsent";

export function followupKind(entry: ReplyEntry, links: readonly HistorySession[], now: number): FollowupKind | null {
  const at = Date.parse(entry.at);
  if (!Number.isFinite(at) || now - at >= FOLLOWUP_WINDOW_MS) return null;
  if (entry.status === "unsent") return "unsent";
  if (entry.status !== "sent" && entry.status !== "pending") return null;
  // Answered, or the ledger card it answered was handled and taken down: nothing left to wait for on the board.
  if (entry.response || entry.cardRemoved) return null;
  return findable(recipientLink(links)) ? "waiting" : null;
}

export function elapsedLabel(ms: number, t: Translate) {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t("방금", "just now");
  if (minutes < 60) return t(`${minutes}분 전`, `${minutes} min ago`);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t(`${hours}시간 전`, `${hours} hr ago`);
  const days = Math.floor(hours / 24);
  return t(`${days}일 전`, `${days} day${days === 1 ? "" : "s"} ago`);
}

export function hostWideVisible(count: { records: number; followups: number }) {
  return count.records > 0 || count.followups > 0;
}
