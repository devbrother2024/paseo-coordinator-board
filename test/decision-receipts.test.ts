import { describe, expect, test } from "bun:test";
import {
  foldReceipts, holdsActivityClosed, needsHostWideFilter, receiptDetails, receiptEntry, receiptInScope, receiptsToFold, RECEIPT_KEEP_MS,
  sentTimeLabel, settleReceipt, withReceiptPositions, type InlineReceipt,
} from "../client/decision-receipts";
import type { ReplyEntry } from "../shared/reply-history";

function receipt(rowKey: string, order: string[], overrides: Partial<InlineReceipt> = {}): InlineReceipt {
  return { rowKey, actionKey: rowKey, order, projectIds: ["project"], title: rowKey, status: "sent", ...overrides };
}

describe("in-place decision results", () => {
  test("keeps the original place, even after the completed action vanishes on refresh", () => {
    const before = ["first", "merged", "last"];
    expect(withReceiptPositions(["first", "last", "next"], [receipt("merged", before)])).toEqual([...before, "next"]);
  });

  test("preserves neighbors when concurrent actions complete in reverse order", () => {
    const before = ["first", "second", "third"];
    expect(withReceiptPositions(["third", "new question"], [receipt("second", before), receipt("first", before)]))
      .toEqual([...before, "new question"]);
  });

  test("handles project filters removing both immediate neighbors", () => {
    const before = ["a:one", "b:other", "a:sent", "b:two", "a:remaining"];
    expect(withReceiptPositions(["a:one", "a:remaining"], [receipt("a:sent", before)])).toEqual(["a:one", "a:sent", "a:remaining"]);
  });

  test("a changed question revision stays available beside the previous successful reply", () => {
    const before = ["previous", "card:v1", "next"];
    expect(withReceiptPositions(["previous", "card:v2", "next"], [receipt("card:v1", before)]))
      .toEqual(["previous", "card:v2", "card:v1", "next"]);
  });

  test("a merged PR inside an open record shares its row with outstanding work", () => {
    const before = ["pr-and-question", "next"];
    expect(withReceiptPositions(before, [receipt("pr-and-question", before, { actionKey: "pr" })])).toEqual(before);
  });

  test("hiding a receipt never hides an active follow-up in the same row", () => {
    const before = ["compound", "done", "other"];
    const hidden = [receipt("compound", before, { hidden: true }), receipt("done", before, { hidden: true })];
    expect(withReceiptPositions(["compound", "other"], hidden)).toEqual(["compound", "other"]);
  });
});

test("retains a finished editor's slot when newly unpinned priorities reverse its neighbors", () => {
  const duringEdit = ["before", "my-reply", "urgent", "other"];
  const afterSubmit = ["urgent", "before", "other"];
  expect(withReceiptPositions(afterSubmit, [receipt("my-reply", duringEdit)]))
    .toEqual(["urgent", "my-reply", "before", "other"]);
});

test("a finished result folds into recent activity after a few seconds, except a sent or unsent reply", () => {
  const receipt = (actionKey: string, status: InlineReceipt["status"], hidden?: boolean): InlineReceipt =>
    ({ actionKey, rowKey: "row-" + actionKey, projectIds: ["p"], status, title: actionKey, order: [], ...(hidden ? { hidden } : {}) });
  const list = [receipt("sent", "sent"), receipt("merged", "merged"), receipt("unsent", "unsent"), receipt("old", "sent", true), receipt("done", "already-closed")];
  expect(receiptsToFold(list)).toEqual([JSON.stringify(["merged", "row-merged"]), JSON.stringify(["done", "row-done"])]);
  const folded = foldReceipts(list, receiptsToFold(list));
  expect(folded.map(entry => !!entry.hidden)).toEqual([false, true, false, true, true]);
  // A receipt updated in place (a merge notification) keeps its identity and still folds.
  const updated = foldReceipts([{ ...list[1], notification: undefined }], receiptsToFold(list));
  expect(updated[0].hidden).toBe(true);
  expect(receiptsToFold(folded)).toEqual([]);
  expect(foldReceipts(folded, [])).toBe(folded);
});

describe("a sent reply stays as a folded card", () => {
  const sentAt = Date.parse("2026-11-25T03:00:00Z");
  const match = { projectId: "alpha", cardId: "card", revision: "r1" };
  const sent = (overrides: Partial<InlineReceipt> = {}): InlineReceipt =>
    ({ actionKey: "a", rowKey: "row", projectIds: ["alpha"], status: "sent", title: "Pick a name", order: [], recipientId: "coord",
      detail: "Q1 A · Keep the default\nShip it today", sentAt, match, ...overrides });
  const entry = (overrides: Partial<ReplyEntry> = {}): ReplyEntry => ({ key: "k", title: "Pick a name", projectId: "alpha", status: "sent",
    at: "2026-11-25T03:00:01.000Z", recipientId: "coord", origin: { sessionId: null, cardId: "card", revision: "r1", questions: [] }, ...overrides });

  test("finds the latest history entry for the same card, revision and recipient", () => {
    const history = [
      entry({ key: "old", at: "2026-11-25T02:00:00.000Z" }),
      entry({ key: "new", at: "2026-11-25T03:00:05.000Z" }),
      entry({ key: "other card", origin: { sessionId: null, cardId: "other", revision: "r1", questions: [] } }),
      entry({ key: "other revision", origin: { sessionId: null, cardId: "card", revision: "r2", questions: [] } }),
      entry({ key: "other project", projectId: "beta" }),
      entry({ key: "other recipient", recipientId: "worker-1", at: "2026-11-25T04:00:00.000Z" }),
    ];
    expect(receiptEntry(sent(), history)?.key).toBe("new");
    expect(receiptEntry(sent({ match: undefined }), history)).toBeUndefined();
    expect(receiptEntry(sent(), [])).toBeUndefined();
  });

  test("stays until a day has passed", () => {
    expect(settleReceipt(sent(), undefined, sentAt + RECEIPT_KEEP_MS - 1).hidden).toBeFalsy();
    expect(settleReceipt(sent(), undefined, sentAt + RECEIPT_KEEP_MS).hidden).toBe(true);
    // Without a send time, only hiding folds it.
    expect(settleReceipt(sent({ sentAt: undefined }), undefined, sentAt + 2 * RECEIPT_KEEP_MS).hidden).toBeFalsy();
  });

  test("a follow-up shows once, then the next refresh folds it", () => {
    const now = sentAt + 60_000;
    const first = settleReceipt(sent(), entry({ response: "Done, renamed it" }), now);
    expect(first).toMatchObject({ settled: true });
    expect(first.hidden).toBeFalsy();
    expect(settleReceipt(first, entry({ response: "Done, renamed it" }), now + 1000).hidden).toBe(true);
    // Still waiting: the card stays as it was.
    const waiting = sent();
    expect(settleReceipt(waiting, entry(), now)).toBe(waiting);
    expect(settleReceipt(waiting, undefined, now)).toBe(waiting);
  });

  test("a ledger reply stays through its follow-up until the card is taken down", () => {
    const now = sentAt + 60_000;
    // The session answered, but the card is still on the ledger: what was asked may still be open.
    const ledger = sent({ untilRemoved: true });
    expect(settleReceipt(ledger, entry({ response: "It needs a server we do not run." }), now)).toBe(ledger);
    expect(settleReceipt(ledger, entry({ response: "ok" }), now + 60_000)).toBe(ledger);
    // Taken down: shown once more, then folded. A day still folds it either way.
    const down = settleReceipt(ledger, entry({ response: "ok", cardRemoved: true }), now);
    expect(down).toMatchObject({ settled: true });
    expect(down.hidden).toBeFalsy();
    expect(settleReceipt(down, entry({ response: "ok", cardRemoved: true }), now).hidden).toBe(true);
    expect(settleReceipt(ledger, entry({ response: "ok" }), sentAt + RECEIPT_KEEP_MS).hidden).toBe(true);
  });

  test("a card taken down from the ledger folds on the next refresh", () => {
    const now = sentAt + 60_000;
    const first = settleReceipt(sent(), entry({ cardRemoved: true }), now);
    expect(first.settled).toBe(true);
    expect(first.hidden).toBeFalsy();
    expect(settleReceipt(first, entry({ cardRemoved: true }), now).hidden).toBe(true);
  });

  test("other results and hidden ones are left alone", () => {
    const merged = sent({ status: "merged" });
    expect(settleReceipt(merged, entry({ response: "ok" }), sentAt + 2 * RECEIPT_KEEP_MS)).toBe(merged);
    const hidden = sent({ hidden: true });
    expect(settleReceipt(hidden, entry({ response: "ok" }), sentAt)).toBe(hidden);
  });

  test("the opened card lists what was sent, photos, the recipient and the follow-up's first line", () => {
    const ko = (korean: string) => korean;
    const en = (_korean: string, english: string) => english;
    expect(receiptDetails(sent(), entry({ imageCount: 2, response: "Renamed it\nmore detail" }), "Coordinator", ko)).toEqual([
      { label: "보낸 글", text: "Q1 A · Keep the default\nShip it today" },
      { label: "사진", text: "2장" },
      { label: "받은 세션", text: "Coordinator" },
      { label: "후속 응답", text: "Renamed it" },
    ]);
    expect(receiptDetails(sent(), entry({ imageCount: 1 }), undefined, en)).toEqual([
      { label: "Sent", text: "Q1 A · Keep the default\nShip it today" },
      { label: "Photos", text: "1 photo" },
    ]);
    expect(receiptDetails(sent({ detail: undefined }), undefined, undefined, en)).toEqual([]);
  });
});

describe("a sent reply's folded card is not a result line", () => {
  const card = (status: InlineReceipt["status"], projectIds: (string | null)[], hidden = false): InlineReceipt =>
    ({ actionKey: status, rowKey: status, projectIds, status, title: status, order: [], ...(hidden ? { hidden } : {}) });

  test("it does not keep Recent decision activity closed when no decision is left", () => {
    expect(holdsActivityClosed([card("sent", ["alpha"])])).toBe(false);
    expect(holdsActivityClosed([card("merged", ["alpha"])])).toBe(true);
    expect(holdsActivityClosed([card("unsent", ["alpha"])])).toBe(true);
    expect(holdsActivityClosed([card("merged", ["alpha"], true)])).toBe(false);
    expect(holdsActivityClosed([])).toBe(false);
  });

  test("a host-wide sent reply alone adds no Host-wide filter, yet still shows while no filter is set", () => {
    expect(needsHostWideFilter([card("sent", [null])])).toBe(false);
    expect(needsHostWideFilter([card("already-closed", [null])])).toBe(true);
    expect(needsHostWideFilter([card("unsent", [null], true)])).toBe(false);
    const listed = (id: string | null) => id === "alpha";
    const all = () => true;
    expect(receiptInScope(card("sent", [null]), listed, all)).toBe(true);
    expect(receiptInScope(card("sent", [null]), listed, id => id === "alpha")).toBe(false);
    expect(receiptInScope(card("merged", [null]), listed, all)).toBe(false);
    expect(receiptInScope(card("sent", ["alpha"]), listed, all)).toBe(true);
    expect(receiptInScope(card("sent", ["beta"]), listed, all)).toBe(false);
  });
});

test("the folded card shows the time, and the date too when it was not sent today", () => {
  const now = new Date(2026, 10, 25, 18, 0).getTime();
  const today = new Date(2026, 10, 25, 9, 5).getTime();
  const yesterday = new Date(2026, 10, 24, 23, 40).getTime();
  const time = (at: number, locale: string) => new Date(at).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  expect(sentTimeLabel(today, now, "ko")).toBe(time(today, "ko-KR"));
  expect(sentTimeLabel(today, now, "en")).toBe(time(today, "en-US"));
  expect(sentTimeLabel(yesterday, now, "ko")).toBe("11월 24일 " + time(yesterday, "ko-KR"));
  expect(sentTimeLabel(yesterday, now, "en")).toBe("Nov 24, " + time(yesterday, "en-US"));
  expect(sentTimeLabel(new Date(2025, 10, 25, 9, 5).getTime(), now, "en")).toBe("Nov 25, 2025, " + time(new Date(2025, 10, 25, 9, 5).getTime(), "en-US"));
  expect(sentTimeLabel(undefined, now, "ko")).toBe("");
});
