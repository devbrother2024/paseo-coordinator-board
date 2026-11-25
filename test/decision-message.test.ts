import { expect, test } from "bun:test";
import { REPLY_MAY_BE, sessionReplyMessage, trackedReplyMessage } from "../server/decision-message";
import { trackedDecisionInputSchema } from "../shared/tracked-decisions";

const item = trackedDecisionInputSchema.parse({ source: "feed", projectId: "alpha", id: "cache", title: "Cache location", where: "manager",
  questions: [{ id: "Q1", text: "Where should it live?" }] });
const fingerprint = "a".repeat(64);
const context = (message: string) => JSON.parse(message.split("\n")[1]);

test("a card reply says it may be a decision, a question or a change request", () => {
  const written = "Why not Redis?\n\nI would rather not add a file.";
  const tracked = trackedReplyMessage(item, { source: "feed", projectId: "alpha", id: "cache", fingerprint, recipientId: "coord", answer: written, questionIndexes: [] });
  expect(tracked.split("\n")[0]).toBe("[Coordinator Board · Cache location]");
  expect(context(tracked)).toMatchObject({ action: "reply", cardId: "cache", questions: [], mayBe: ["decision", "question", "change-request"] });
  expect(REPLY_MAY_BE).toEqual(["decision", "question", "change-request"]);
  // The person's words follow the context untouched. Nothing the board wrote stands beside them.
  expect(tracked.split("\n").slice(2).join("\n")).toBe("\n" + written);

  const row = { id: "worker-1", title: "Cache work", projectId: "alpha", projectTitle: "Alpha", workspaceTitle: "main", model: null, lane: "human", detail: "",
    evidenceId: "e1", decision: { question: "Where should it live?", version: "v1", source: "conversation" } } as const;
  const send = { projectId: "alpha", sessionId: "worker-1", recipientId: "worker-1", version: "v1", text: written, requestKey: "decision-key-1" };
  const reply = sessionReplyMessage(row, { ...send, action: "reply" });
  expect(context(reply)).toMatchObject({ action: "reply", mayBe: ["decision", "question", "change-request"] });
  expect(reply.endsWith("\n\n" + written)).toBe(true);
  // A coordination request already says what it is.
  expect(context(sessionReplyMessage(row, { ...send, action: "coordinate" })).mayBe).toBeUndefined();
});

test("a reply recorded before the change is rebuilt in the form it was written", () => {
  const input = { source: "feed", projectId: "alpha", id: "cache", fingerprint, recipientId: "coord", answer: "A" };
  const first = trackedReplyMessage(item, input, 1);
  expect(context(first).mayBe).toBeUndefined();
  expect(context(first).action).toBe("reply");
  expect(trackedReplyMessage(item, input)).toBe(trackedReplyMessage(item, input, 2));
  expect(trackedReplyMessage(item, input)).not.toBe(first);
});
