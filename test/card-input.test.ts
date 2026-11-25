import { expect, test } from "bun:test";
import { cardInputPlaceholder, openQuestionsBlock, sendWords, withRequest } from "../client/card-input";

test("a decision card sends with Send, a merge card with Send change request", () => {
  expect(sendWords("decision").label).toEqual(["보내기", "Send"]);
  expect(sendWords("merge").label).toEqual(["수정 요청 보내기", "Send change request"]);
  // Where it goes is said beside the button and in the button's accessible name.
  expect(sendWords("decision", "session")).toEqual({ label: ["보내기", "Send"], to: ["받는 곳 · 작업 세션", "To · work session"],
    name: ["작업 세션에 보내기", "Send to work session"] });
  expect(sendWords("decision", "coordinator").name).toEqual(["코디네이터에 보내기", "Send to coordinator"]);
  expect(sendWords("decision", "owner").to).toEqual(["받는 곳 · 운영 코디네이터", "To · ledger owner"]);
  expect(sendWords("merge", "session").name).toEqual(["작업 세션에 수정 요청 보내기", "Send change request to work session"]);
  expect(sendWords("merge", "coordinator").to).toEqual(["받는 곳 · 코디네이터", "To · coordinator"]);
  expect(sendWords("merge")).toEqual({ label: ["수정 요청 보내기", "Send change request"], to: null, name: ["수정 요청 보내기", "Send change request"] });
  // One input takes anything, and says so.
  expect(cardInputPlaceholder.decision[0]).toContain("질문");
  expect(cardInputPlaceholder.decision[1]).toContain("question");
  expect(cardInputPlaceholder.merge[1]).toContain("change");
});

test("open questions block sending only while the card's input is empty", () => {
  expect(openQuestionsBlock(true, "", 0)).toBe(true);
  expect(openQuestionsBlock(true, "  \n", 0)).toBe(true);
  expect(openQuestionsBlock(true, "Why not Redis?", 0)).toBe(false);
  expect(openQuestionsBlock(true, "", 1)).toBe(false);
  expect(openQuestionsBlock(false, "", 0)).toBe(false);
});

test("a suggested request joins what the person wrote, once", () => {
  const request = "Please explain options (a) and (b).";
  expect(withRequest("", request)).toBe(request);
  expect(withRequest("  ", request)).toBe(request);
  expect(withRequest("I lean toward (a).\n", request)).toBe("I lean toward (a).\n\n" + request);
  const once = withRequest("I lean toward (a).", request);
  expect(withRequest(once, request)).toBe(once);
});
