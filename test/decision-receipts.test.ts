import { describe, expect, test } from "bun:test";
import { foldReceipts, receiptsToFold, withReceiptPositions, type InlineReceipt } from "../client/decision-receipts";

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

test("a finished result folds into recent activity after a few seconds, except an unsent reply", () => {
  const receipt = (actionKey: string, status: InlineReceipt["status"], hidden?: boolean): InlineReceipt =>
    ({ actionKey, rowKey: "row-" + actionKey, projectIds: ["p"], status, title: actionKey, order: [], ...(hidden ? { hidden } : {}) });
  const list = [receipt("sent", "sent"), receipt("merged", "merged"), receipt("unsent", "unsent"), receipt("old", "sent", true)];
  expect(receiptsToFold(list)).toEqual([JSON.stringify(["sent", "row-sent"]), JSON.stringify(["merged", "row-merged"])]);
  const folded = foldReceipts(list, receiptsToFold(list));
  expect(folded.map(entry => !!entry.hidden)).toEqual([true, true, false, true]);
  // A receipt updated in place (a merge notification) keeps its identity and still folds.
  const updated = foldReceipts([{ ...list[1], notification: undefined }], receiptsToFold(list));
  expect(updated[0].hidden).toBe(true);
  expect(receiptsToFold(folded)).toEqual([]);
  expect(foldReceipts(folded, [])).toBe(folded);
});
