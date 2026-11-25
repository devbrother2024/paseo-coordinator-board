import type { Card } from "./model";
import type { MergeNotification, PullRequestItem } from "../shared/prs";
import type { ReplyEntry } from "../shared/reply-history";
import type { TrackedDecision } from "../shared/tracked-decisions";

export const pullRowKey = (pr: Pick<PullRequestItem, "repo" | "number">) => JSON.stringify(["pull", pr.repo, pr.number]);
// A ledger card keeps its row across revisions so an open draft survives a display-only update.
export const recordRowKey = (item: TrackedDecision) => JSON.stringify(["record", item.key]);
export const recordActionKey = (item: Pick<TrackedDecision, "key" | "fingerprint">) => JSON.stringify(["record", item.key, item.fingerprint]);
export const unsentActionKey = (item: TrackedDecision) => JSON.stringify(["unsent", item.key, item.fingerprint]);
export const sessionRowKey = (card: Card) => JSON.stringify(["session", card.session.projectId, card.session.id, card.session.decision?.version]);

export type CompletedAction = {
  actionKey: string;
  rowKey: string;
  projectIds: (string | null)[];
  status: "merged" | "already-merged" | "sent" | "already-closed" | "unsent";
  title: string;
  detail?: string;
  recipientId?: string;
  mergeProjectId?: string;
  notification?: MergeNotification;
  // When the reply was sent, and the card revision that finds its entry in reply history.
  sentAt?: number;
  match?: { projectId: string | null; cardId: string; revision: string };
};
// `settled`: a refresh has shown the reply's follow-up or its card taken down, so the next refresh folds it.
export type InlineReceipt = CompletedAction & { order: readonly string[]; hidden?: boolean; settled?: boolean };

// Reinsert removed rows beside the same neighbors, even when two actions finish out of order.
// A session revision is part of its row key, so a new question can coexist with its earlier receipt.
// A ledger card's receipt shares the row with the card's newer revision.
export function withReceiptPositions(active: readonly string[], receipts: readonly InlineReceipt[]) {
  const rows = [...active];
  for (const { rowKey, order, hidden } of receipts) {
    if (hidden || rows.includes(rowKey)) continue;
    const index = order.indexOf(rowKey);
    const next = order.slice(index + 1).find(key => rows.includes(key));
    const previous = order.slice(0, Math.max(0, index)).reverse().find(key => rows.includes(key));
    const nextIndex = next === undefined ? -1 : rows.indexOf(next);
    const previousIndex = previous === undefined ? -1 : rows.indexOf(previous);
    // Fresh priorities can reverse the neighbors when the finished editor releases its position.
    let position = Math.min(Math.max(0, index), rows.length);
    if (nextIndex > previousIndex) position = nextIndex;
    else if (nextIndex < 0 && previousIndex >= 0) position = previousIndex + 1;
    rows.splice(position, 0, rowKey);
  }
  return rows;
}

// A result line stays a few seconds where the person acted, then folds into recent decision activity.
// An unsent reply holds text found nowhere else, so it stays until the person hides it. A sent reply stays as a folded
// card that opens to what was sent, until `settleReceipt` folds it.
export const RECEIPT_FOLD_MS = 6000;
export const RECEIPT_KEEP_MS = 24 * 60 * 60 * 1000;
const receiptId = (receipt: Pick<InlineReceipt, "actionKey" | "rowKey">) => JSON.stringify([receipt.actionKey, receipt.rowKey]);

export function receiptsToFold(receipts: readonly InlineReceipt[]) {
  return receipts.filter(receipt => !receipt.hidden && receipt.status !== "unsent" && receipt.status !== "sent").map(receiptId);
}

// The reply history entry for a sent reply: same card revision and recipient, the latest when it was sent more than once.
export function receiptEntry(receipt: Pick<InlineReceipt, "match" | "recipientId">, history: readonly ReplyEntry[]) {
  const match = receipt.match;
  if (!match) return undefined;
  let found: ReplyEntry | undefined;
  for (const entry of history) {
    if (entry.projectId !== match.projectId || entry.origin?.cardId !== match.cardId || entry.origin.revision !== match.revision) continue;
    if (receipt.recipientId && entry.recipientId !== receipt.recipientId) continue;
    if (!found || entry.at > found.at) found = entry;
  }
  return found;
}

// Run on each refresh. A sent reply folds a day after sending. Once its recipient has answered or its card was taken down
// from the ledger, that refresh marks it so the follow-up shows once, and the next refresh folds it.
export function settleReceipt(receipt: InlineReceipt, entry: Pick<ReplyEntry, "response" | "cardRemoved"> | undefined, now: number): InlineReceipt {
  if (receipt.hidden || receipt.status !== "sent") return receipt;
  if (receipt.sentAt !== undefined && now - receipt.sentAt >= RECEIPT_KEEP_MS) return { ...receipt, hidden: true };
  if (!entry?.response && !entry?.cardRemoved) return receipt;
  return receipt.settled ? { ...receipt, hidden: true } : { ...receipt, settled: true };
}

type Translate = (korean: string, english: string) => string;
const firstLine = (text: string) => text.split("\n").map(line => line.trim()).find(Boolean) ?? "";

// What the opened card shows: the whole reply, its photos, who took it, and the first line of their answer.
export function receiptDetails(receipt: Pick<InlineReceipt, "detail">, entry: Pick<ReplyEntry, "imageCount" | "response"> | undefined,
  recipient: string | undefined, t: Translate) {
  const photos = entry?.imageCount;
  const response = entry?.response ? firstLine(entry.response) : "";
  return [
    receipt.detail ? { label: t("보낸 글", "Sent"), text: receipt.detail } : null,
    photos ? { label: t("사진", "Photos"), text: t(`${photos}장`, `${photos} photo${photos === 1 ? "" : "s"}`) } : null,
    recipient ? { label: t("받은 세션", "Received by"), text: recipient } : null,
    response ? { label: t("후속 응답", "Follow-up"), text: response } : null,
  ].filter((line): line is { label: string; text: string } => !!line);
}

// A sent reply's folded card is not a result line: it neither keeps Recent decision activity closed when no decision is
// left nor adds a Host-wide filter of its own. A host-wide one still shows while no filter is set.
const resultLine = (receipt: InlineReceipt) => !receipt.hidden && receipt.status !== "sent";
export const holdsActivityClosed = (receipts: readonly InlineReceipt[]) => receipts.some(resultLine);
export const needsHostWideFilter = (receipts: readonly InlineReceipt[]) =>
  receipts.some(receipt => resultLine(receipt) && receipt.projectIds.includes(null));
export function receiptInScope(receipt: InlineReceipt, listed: (id: string | null) => boolean, inFilter: (id: string | null) => boolean) {
  return receipt.projectIds.some(id => (listed(id) || (id === null && receipt.status === "sent")) && inFilter(id));
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// When the reply was sent: the time, with the date when it was not today and the year when it was not this year.
export function sentTimeLabel(sentAt: number | undefined, now: number, language: "ko" | "en") {
  if (sentAt === undefined) return "";
  const at = new Date(sentAt), today = new Date(now);
  const time = at.toLocaleTimeString(language === "ko" ? "ko-KR" : "en-US", { hour: "numeric", minute: "2-digit" });
  if (at.toDateString() === today.toDateString()) return time;
  const year = at.getFullYear() !== today.getFullYear();
  return language === "ko"
    ? `${year ? at.getFullYear() + "년 " : ""}${at.getMonth() + 1}월 ${at.getDate()}일 ${time}`
    : `${months[at.getMonth()]} ${at.getDate()}, ${year ? at.getFullYear() + ", " : ""}${time}`;
}

export function foldReceipts(receipts: InlineReceipt[], ids: readonly string[]) {
  if (!ids.length) return receipts;
  const fold = new Set(ids);
  return receipts.map(receipt => fold.has(receiptId(receipt)) && !receipt.hidden ? { ...receipt, hidden: true } : receipt);
}
