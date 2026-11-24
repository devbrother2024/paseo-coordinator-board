import { expect, test } from "bun:test";
import { digestRequestWaiting, shouldRefreshDigest } from "../client/digest-freshness";
import type { Card } from "../client/model";

const iso = (value: number) => new Date(value).toISOString();
const digest = Date.parse("2026-02-01T10:00:00Z");
const threeHours = 3 * 60 * 60 * 1000;
const question: Card = { lane: "human", note: undefined, session: {
  id: "sample", projectId: "studio", projectTitle: "Studio", workspaceTitle: "Example", title: "Review audio",
  lane: "human", status: "idle", model: null, detail: "", decisionRequestedAt: iso(digest + 1000),
  decision: { source: "conversation", question: "Which take?", version: "sample-question" },
} };

test("refresh is offered at three hours only if a new unanswered session question has appeared", () => {
  expect(shouldRefreshDigest(iso(digest), [question], "coordinator", digest + threeHours - 1)).toBe(false);
  expect(shouldRefreshDigest(iso(digest), [question], "coordinator", digest + threeHours)).toBe(true);
  expect(shouldRefreshDigest(iso(digest), [], "coordinator", digest + threeHours)).toBe(false);
  for (const time of [undefined, "invalid", iso(digest), iso(digest - 1), iso(digest + threeHours + 1)]) {
    expect(shouldRefreshDigest(iso(digest), [{ ...question, session: { ...question.session, decisionRequestedAt: time } }], "coordinator", digest + threeHours)).toBe(false);
  }
});

test("missing digest, prior classifications and non-session questions do not offer refresh", () => {
  const now = digest + threeHours;
  expect(shouldRefreshDigest(undefined, [question], "coordinator", now)).toBe(false);
  expect(shouldRefreshDigest("invalid", [question], "coordinator", now)).toBe(false);
  expect(shouldRefreshDigest(iso(digest), [question], null, now)).toBe(false);
  expect(shouldRefreshDigest(iso(digest), [question], "sample", now)).toBe(false);
  for (const source of ["coordinator", "permission", "person-note"] as const) {
    const session = { ...question.session, decision: { ...question.session.decision!, source } };
    expect(shouldRefreshDigest(iso(digest), [{ ...question, session }], "coordinator", now)).toBe(false);
  }
  expect(shouldRefreshDigest(iso(digest), [{ ...question, session: { ...question.session, decisionAnswered: true } }], "coordinator", now)).toBe(false);
  const report: Card = { ...question, session: { ...question.session, decision: undefined },
    note: { sessionId: "sample", kind: "question", origin: "agent", revision: 1, text: "Which take?", requestedAt: iso(digest + 1) } };
  expect(shouldRefreshDigest(iso(digest), [report], "coordinator", now)).toBe(true);
});

test("an acknowledged request remains disabled until a newer digest or a different coordinator", () => {
  const submitted = { coordinator: "coordinator", lastDigestAt: iso(digest) };
  expect(digestRequestWaiting(submitted, "coordinator", iso(digest))).toBe(true);
  expect(digestRequestWaiting(submitted, "coordinator", iso(digest - 1000))).toBe(true);
  expect(digestRequestWaiting(submitted, "coordinator", iso(digest + 1000))).toBe(false);
  expect(digestRequestWaiting(submitted, "replacement", iso(digest))).toBe(false);
  expect(digestRequestWaiting(null, "coordinator", iso(digest))).toBe(false);
});
