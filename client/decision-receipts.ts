import type { Card } from "./model";
import type { MergeNotification, PullRequestItem } from "../shared/prs";
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
};
export type InlineReceipt = CompletedAction & { order: readonly string[]; hidden?: boolean };

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
// An unsent reply holds text found nowhere else, so it stays until the person hides it.
export const RECEIPT_FOLD_MS = 6000;
const receiptId = (receipt: Pick<InlineReceipt, "actionKey" | "rowKey">) => JSON.stringify([receipt.actionKey, receipt.rowKey]);

export function receiptsToFold(receipts: readonly InlineReceipt[]) {
  return receipts.filter(receipt => !receipt.hidden && receipt.status !== "unsent").map(receiptId);
}

export function foldReceipts(receipts: InlineReceipt[], ids: readonly string[]) {
  if (!ids.length) return receipts;
  const fold = new Set(ids);
  return receipts.map(receipt => fold.has(receiptId(receipt)) && !receipt.hidden ? { ...receipt, hidden: true } : receipt);
}
