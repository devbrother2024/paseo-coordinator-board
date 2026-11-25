import { expect, test } from "bun:test";
import { sessionReplyDraft, suggestionOverflows } from "../client/decision-reply-state";

test("the editable reply is the submitted text, including a cleared recommendation and photos alone", () => {
  const proposed = "결과 이미지는 보관해 주세요.";
  expect(sessionReplyDraft(proposed, null, null, false)).toEqual({ text: proposed, needsReview: false, canSend: true });
  expect(sessionReplyDraft(proposed, "  수정한 답장  ", null, false).text).toBe("  수정한 답장  ");
  expect(sessionReplyDraft(proposed, "", null, false).canSend).toBe(false);
  expect(sessionReplyDraft(proposed, "", null, true)).toEqual({ text: "", needsReview: false, canSend: true });
  expect(sessionReplyDraft(undefined, " \n ", null, false).canSend).toBe(false);
  expect(sessionReplyDraft(undefined, "a".repeat(24001), null, true).canSend).toBe(false);
});

test("the full suggested reply is reviewed for each long selection and the edited reply has its own wording", () => {
  const one = "첫째 줄\n둘째 줄";
  const two = "가".repeat(121);
  expect(sessionReplyDraft(one, null, null, true).canSend).toBe(false);
  expect(sessionReplyDraft(one, null, one, false).canSend).toBe(true);
  expect(sessionReplyDraft(two, null, one, false).needsReview).toBe(true);
  expect(sessionReplyDraft(two, "직접 쓴 답변", null, false).canSend).toBe(true);
  expect(sessionReplyDraft(two, two, null, false).needsReview).toBe(true);
  expect(sessionReplyDraft("가".repeat(120), null, null, false).canSend).toBe(true);
});

test("a suggested reply that fits in the input is sent without a read confirmation, however long its text", () => {
  const long = "가".repeat(300) + "\n둘째 줄";
  expect(sessionReplyDraft(long, null, null, false, false)).toEqual({ text: long, needsReview: false, canSend: true });
  expect(suggestionOverflows(long, false)).toBe(false);
});

test("only a reply that scrolls inside the input waits for the confirmation, and the confirmation unlocks it", () => {
  const short = "짧은 답장";
  const tall = "줄\n".repeat(80);
  expect(sessionReplyDraft(short, null, null, false, true)).toEqual({ text: short, needsReview: true, canSend: false });
  expect(sessionReplyDraft(tall, null, null, false, true).canSend).toBe(false);
  expect(sessionReplyDraft(tall, null, tall, false, true)).toEqual({ text: tall, needsReview: false, canSend: true });
  expect(sessionReplyDraft(tall, "직접 고친 답장", null, false, true).canSend).toBe(true);
});

test("before the input has measured itself, the text length stands in for the overflow", () => {
  expect(suggestionOverflows("가".repeat(121), undefined)).toBe(true);
  expect(suggestionOverflows("짧은 답장", undefined)).toBe(false);
  expect(sessionReplyDraft("가".repeat(121), null, null, false, undefined).canSend).toBe(false);
  expect(sessionReplyDraft("짧은 답장", null, null, false, undefined).canSend).toBe(true);
});

test("the confirmation button and the send lock always come from the same overflow rule", () => {
  for (const overflow of [true, false, undefined]) {
    for (const suggestion of ["짧은 답장", "가".repeat(200), "첫 줄\n둘째 줄"]) {
      const draft = sessionReplyDraft(suggestion, null, null, false, overflow);
      expect(draft.needsReview).toBe(suggestionOverflows(suggestion, overflow));
      expect(draft.canSend).toBe(!draft.needsReview);
    }
  }
});
