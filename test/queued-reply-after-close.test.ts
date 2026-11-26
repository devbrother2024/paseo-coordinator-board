import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canReceiveBoardInput } from "../server/discovery";
import { parallelEligible, queueProvider, steerProvider } from "../shared/busy-delivery";
import { sessionRow } from "../server/discovery";
import { photoNote } from "../client/reply-followup";
import { PreferenceStore } from "../server/preferences";
import { NoteStore } from "../server/notes";
import { ConversationReader } from "../server/conversation";
import { DecisionSender } from "../server/decisions";
import { skippedReplyHistory } from "../server/skipped-replies";

const running = (extra: Record<string, unknown>) => ({ id: "w", status: "running", activeTurn: { id: "t" }, pendingPermissions: [], ...extra }) as any;

test("a Claude Code or Codex profile session takes a reply during its turn, by the implementation it runs on", () => {
  expect(canReceiveBoardInput(running({ provider: "claude-2", persistence: { provider: "claude", sessionId: "s" } }), true)).toBe(true);
  expect(canReceiveBoardInput(running({ provider: "codex-work", persistence: { provider: "codex", sessionId: "s" } }), true)).toBe(true);
  expect(canReceiveBoardInput(running({ provider: "claude-2", persistence: { provider: "claude-2", sessionId: "s", metadata: { provider: "claude" } } }), true)).toBe(true);
  // A name that only looks alike, or no record of the implementation, waits for the turn to end.
  expect(canReceiveBoardInput(running({ provider: "claude-like", persistence: { provider: "other-runner", sessionId: "s" } }), true)).toBe(false);
  expect(canReceiveBoardInput(running({ provider: "claude-2" }), true)).toBe(false);
  expect(steerProvider({ provider: "claude-2", persistence: { provider: "claude" } })).toBe("claude");
  // Parallel review is offered right away only to sessions that cannot take a reply during a turn.
  const now = Date.parse("2030-01-02T12:00:00Z");
  expect(parallelEligible(new Date(now - 60_000).toISOString(), "claude", 10, now)).toBe(false);
  expect(parallelEligible(new Date(now - 60_000).toISOString(), "claude-like", 10, now)).toBe(true);
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "queued-reply-after-close-"));
  const prefs = new PreferenceStore(join(dir, "scope.json"));
  const at = "2030-01-02T01:00:00.000Z";
  const queued = (sessionId: string, title: string, extra: Record<string, unknown> = {}) => ({
    input: { projectId: "p", sessionId, recipientId: sessionId, version: "v-" + sessionId, action: "reply" as const, text: "Q1 · Proxy?: A · 720p", requestKey: "request-" + sessionId + "-0001" },
    at, title, fingerprint: "f", serverId: null, stopped: true, photos: [], ...extra });
  prefs.change(scope => {
    scope.projects = ["p"];
    scope.coordinator = "coord";
    scope.queuedDecisions = {
      "11111111-1111-4111-8111-111111111111": queued("handled", "Q1 · Proxy resolution?", { question: "k-handled" }),
      "22222222-2222-4222-8222-222222222222": queued("still-open", "Q1 · Keep sources?", { question: "k-open" }),
      // Queued before the question key was recorded: matched by the closed question's words.
      "33333333-3333-4333-8333-333333333333": queued("legacy", "Q1 · Screen proxy resolution?"),
      "44444444-4444-4444-8444-444444444444": queued("legacy-open", "Q1 · Export format?"),
    };
    scope.closedQuestions["k-handled"] = { sessionId: "handled", at, reason: "ledger", question: "Q1 · Proxy resolution?" };
    scope.closedQuestions["k-legacy"] = { sessionId: "legacy", at, reason: "coordinator", question: "Q1 · Screen proxy resolution?", evidence: "Handled on the ledger card m5.", by: "coord", projectId: "p" };
    // The same words closed once, but the session asked them again and that question is open.
    scope.closedQuestions["k-legacy-old"] = { sessionId: "legacy-open", at, reason: "session", question: "Q1 · Export format?" };
    scope.raisedQuestions["legacy-open"] = { projectId: "p", title: "t", projectTitle: "P", workspaceTitle: "w",
      questions: [{ key: "k-new", epoch: "e", seq: 9, question: "Q1 · Export format?", raisedAt: at, later: 0 }] };
    scope.raisedQuestions["still-open"] = { projectId: "p", title: "t", projectTitle: "P", workspaceTitle: "w",
      questions: [{ key: "k-open", epoch: "e", seq: 3, question: "Q1 · Keep sources?", raisedAt: at, later: 0 }] };
  });
  return { prefs, sender: new DecisionSender(prefs, new NoteStore(join(dir, "notes.json")), new ConversationReader()) };
}

test("a queued reply to a question that closed some other way is folded as already handled, never sent", () => {
  const { prefs, sender } = fixture();
  const folded = sender.foldHandled(Date.parse("2030-01-02T12:00:00Z"));
  expect([...folded].sort()).toEqual(["11111111-1111-4111-8111-111111111111", "33333333-3333-4333-8333-333333333333"]);
  const scope = prefs.read();
  // Nothing is left waiting at the top of the board without its card.
  expect(Object.keys(scope.queuedDecisions).sort()).toEqual(["22222222-2222-4222-8222-222222222222", "44444444-4444-4444-8444-444444444444"]);
  // Recent decisions show them as already handled and not sent.
  const history = skippedReplyHistory(scope, new Set(["p"]));
  expect(history.map(entry => entry.title).sort()).toEqual(["Q1 · Proxy resolution?", "Q1 · Screen proxy resolution?"]);
  expect(history.every(entry => entry.status === "closed" && entry.skipped && entry.answer === "Q1 · Proxy?: A · 720p")).toBe(true);
  expect(skippedReplyHistory(scope, new Set(["q"]))).toEqual([]);
  // Folding again changes nothing.
  expect([...sender.foldHandled(Date.parse("2030-01-02T12:05:00Z"))]).toEqual([]);
});

test("the session row carries the implementation a profile runs on, and the queue judges by it", () => {
  const row = sessionRow({ id: "w", title: "w", status: "running", provider: "claude-2", persistence: { provider: "claude", sessionId: "s" },
    updatedAt: "1", pendingPermissions: [] } as any, null);
  expect(row).toMatchObject({ provider: "claude-2", runtime: "claude" });
  expect(queueProvider(row)).toBe("claude");
  const plain = sessionRow({ id: "w", title: "w", status: "idle", provider: "codex", updatedAt: "1", pendingPermissions: [] } as any, null);
  expect(plain).not.toHaveProperty("runtime");
  expect(queueProvider(plain)).toBe("codex");
});

test("an old queued reply left after the question closed and was asked again is not folded", () => {
  const { prefs, sender } = fixture();
  prefs.change(scope => {
    // Closed at 01:00; the person replied at 03:00 to the question asked again (not on record yet).
    scope.queuedDecisions["55555555-5555-4555-8555-555555555555"] = { ...scope.queuedDecisions["33333333-3333-4333-8333-333333333333"],
      at: "2030-01-02T03:00:00.000Z", input: { ...scope.queuedDecisions["33333333-3333-4333-8333-333333333333"].input, requestKey: "request-legacy-0002" } };
    // A reply to a card restored after a clarification whose question could not be found never matches a closure.
    scope.queuedDecisions["66666666-6666-4666-8666-666666666666"] = { ...scope.queuedDecisions["11111111-1111-4111-8111-111111111111"],
      question: "unmatched-restored-card", input: { ...scope.queuedDecisions["11111111-1111-4111-8111-111111111111"].input, requestKey: "request-restored-0001" } };
  });
  const folded = sender.foldHandled(Date.parse("2030-01-02T12:00:00Z"));
  expect(folded.has("55555555-5555-4555-8555-555555555555")).toBe(false);
  expect(folded.has("66666666-6666-4666-8666-666666666666")).toBe(false);
  expect(Object.keys(prefs.read().queuedDecisions)).toContain("55555555-5555-4555-8555-555555555555");
});

test("a folded reply with photos says they were not sent and were removed", () => {
  const { prefs, sender } = fixture();
  prefs.change(scope => {
    scope.queuedDecisions["11111111-1111-4111-8111-111111111111"].photos = [{ mimeType: "image/png", digest: "a".repeat(64) }];
  });
  sender.foldHandled(Date.parse("2030-01-02T12:00:00Z"));
  const entry = skippedReplyHistory(prefs.read(), new Set(["p"])).find(item => item.title === "Q1 · Proxy resolution?")!;
  expect(entry).toMatchObject({ imageCount: 1, photosDropped: true });
  expect(photoNote(entry)).toEqual(["사진 1장은 보내지 않아 지웠습니다", "1 photo was not sent and was removed"]);
  expect(photoNote({ imageCount: 2 } as any)).toBeNull();
});
