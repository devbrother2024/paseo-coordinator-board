import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConversationEvidence, classify, closesQuestion, ConversationReader, excerpt, wantsOlder } from "../server/conversation";
import { decorateDecision, retireCoveredKeptQuestions } from "../server/session-decisions";
import { maxClosedQuestions, PreferenceStore, recordClosedQuestion } from "../server/preferences";
import { keptQuestionNotice } from "../client/kept-question";

const NOW = Date.parse("2030-01-02T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const row = () => ({ id: "worker", status: "idle", projectId: "p", projectTitle: "Project", workspaceTitle: "w", model: null, title: "Release prep",
  lane: "idle", detail: "Waiting for the next request", activityAt: "1" }) as any;
const prefs = (extra: Record<string, unknown> = {}) => ({ projects: ["p"], coordinator: null, judgments: {}, answers: {}, closedQuestions: {}, ...extra }) as any;

type Step = ["assistant" | "user" | "agent" | "heartbeat", string, number?];
const entry = ([kind, text, hoursAgo]: Step, seqEnd: number) => {
  const timestamp = hoursAgo === undefined ? undefined : at(hoursAgo);
  if (kind === "agent") return { seqEnd, timestamp, item: { type: "tool_call", callId: "paseo-agent-message:m" + seqEnd, name: "message", status: "completed",
    agentMessage: { event: "message", sender: { id: "other-session" }, text } } };
  if (kind === "heartbeat") return { seqEnd, timestamp, item: { type: "tool_call", callId: "hb" + seqEnd, name: "heartbeat", status: "completed" } };
  return { seqEnd, timestamp, item: { type: kind === "user" ? "user_message" : "assistant_message", text } };
};
const page = (steps: Step[], extra: Record<string, unknown> = {}) => ({ epoch: "e1", entries: steps.map(entry), error: null, ...extra }) as any;
const evidence = (...steps: Step[]) => excerpt(page(steps));
const ask: Step = ["assistant", "Release 0.9 is ready.\nShall I publish it now?", 1];
const report: Step = ["agent", "Status from another session: tests passed.", 0.9];
const reply: Step = ["assistant", "Noted the other session's report. Nothing else changed.", 0.8];
const judge = (e: ReturnType<typeof evidence>, options = {}) => classify(e, row(), undefined, false, { now: NOW, ...options });

test("R1: a question stays open after a report from another session and a reply without a question", () => {
  const result = judge(evidence(ask, report, reply));
  expect(result).toMatchObject({ lane: "human", detail: "세션의 확인 요청 · Shall I publish it now?", decisionRequestedAt: at(1), keptQuestion: { later: 1 } });
  expect(result.keptQuestion?.stale).toBeUndefined();
  // Heartbeats and further reports do not answer it either.
  const longer = judge(evidence(ask, report, reply, ["heartbeat", ""], report, ["assistant", "Second report noted.", 0.5]));
  expect(longer).toMatchObject({ lane: "human", keptQuestion: { later: 2 } });
});

test("R2: input from the person closes it, even a message without text", () => {
  expect(judge(evidence(ask, ["user", "Let's talk about something else."], reply)).lane).toBe("idle");
  expect(judge(evidence(ask, ["user", ""], reply)).lane).toBe("idle");
  // The person's message right after the question is still the existing "check the reply" state.
  expect(judge(evidence(ask, ["user", "Wait."])).lane).toBe("review");
});

test("R3: a settling line in any later message closes it", () => {
  for (const line of ["질문 닫음", "**Question resolved.**", "question closed", "질문은 카드 a1b2c3으로 옮김", "질문은 원장 카드 release-0.9로 옮겼습니다.",
    "Question moved to ledger card release-0.9."]) {
    expect(closesQuestion("Done.\n" + line)).toBe(true);
    expect(closesQuestion("Merged the notes. " + line)).toBe(true);
    expect(judge(evidence(ask, report, ["assistant", "Handled.\n" + line, 0.7])).lane).toBe("idle");
    expect(judge(evidence(ask, report, ["assistant", "Handled.\n" + line, 0.7], report, reply)).lane).toBe("idle");
  }
  for (const line of ["The question resolved itself? No.", "질문 닫음을 기다립니다", "I closed the question about the API last week", "질문 닫음은 사람이 정합니다. 계속합니다."]) {
    expect(closesQuestion(line)).toBe(false);
  }
  // A new question after a settling line is open again.
  expect(judge(evidence(ask, ["assistant", "질문 닫음", 0.9], ["assistant", "Which region should I use? Please choose one.", 0.8], reply)).keptQuestion?.later).toBe(1);
});

test("R4: a ledger card pointing at the session takes the kept question's place", () => {
  const e = evidence(ask, report, reply);
  const covered = row(), other = row();
  for (const target of [covered, other]) {
    applyConversationEvidence(e, target, prefs());
    decorateDecision(target, undefined, prefs(), e);
  }
  expect(covered.decision?.source).toBe("conversation");
  retireCoveredKeptQuestions([covered], new Set(["worker"]));
  retireCoveredKeptQuestions([other], new Set(["someone-else"]));
  expect(covered).toMatchObject({ lane: "idle", detail: "Waiting for the next request" });
  expect(covered.decision).toBeUndefined();
  expect(covered.keptQuestion).toBeUndefined();
  expect(other.decision?.source).toBe("conversation");
  // A question in the last message is not a kept question and stays.
  const last = row();
  applyConversationEvidence(evidence(ask), last, prefs());
  decorateDecision(last, undefined, prefs(), evidence(ask));
  retireCoveredKeptQuestions([last], new Set(["worker"]));
  expect(last.decision?.source).toBe("conversation");
});

test("R5: old questions dim after half the limit and leave after it", () => {
  const replies = (count: number) => Array.from({ length: count }, (_, i): Step => ["assistant", `Report ${i} noted.`, 0.5]);
  expect(judge(evidence(ask, ...replies(15))).keptQuestion?.stale).toBeUndefined();
  expect(judge(evidence(ask, ...replies(16))).keptQuestion).toMatchObject({ later: 16, stale: true });
  expect(judge(evidence(ask, ...replies(30))).keptQuestion?.later).toBe(30);
  expect(judge(evidence(ask, ...replies(31))).lane).toBe("idle");
  const asked = (hoursAgo: number): Step => ["assistant", "Shall I publish it now?", hoursAgo];
  expect(judge(evidence(asked(11), reply)).keptQuestion?.stale).toBeUndefined();
  expect(judge(evidence(asked(13), reply)).keptQuestion?.stale).toBe(true);
  expect(judge(evidence(asked(25), reply)).lane).toBe("idle");
  // Without a time only the message count applies.
  expect(judge(evidence(["assistant", "Shall I publish it now?"], ["assistant", "Noted."])).keptQuestion?.later).toBe(1);
});

test("R6: sessions without a question, and a question in the last message, keep today's behavior", () => {
  expect(judge(evidence(["assistant", "Done. Tests pass.", 1], report, reply)).lane).toBe("idle");
  const last = judge(evidence(report, ask));
  expect(last).toMatchObject({ lane: "human", decisionRequestedAt: at(1) });
  expect(last.keptQuestion).toBeUndefined();
  expect(evidence(ask, ["user", "ok"]).since).toBeUndefined();
  // The excerpt the coordinator reads keeps its shape.
  expect(Object.keys(evidence(ask, report, reply).turns[0]).sort()).toEqual(["at", "role", "text"]);
});

test("R7: the kept card keeps one version however many times the session speaks", () => {
  const card = (...steps: Step[]) => {
    const target = row(), e = evidence(...steps);
    applyConversationEvidence(e, target, prefs());
    decorateDecision(target, undefined, prefs(), e);
    return target;
  };
  const once = card(ask, report, reply), twice = card(ask, report, reply, report, ["assistant", "Another report noted.", 0.4]);
  expect(once.evidenceId).not.toBe(twice.evidenceId);
  expect(once.decision?.version).toBe(twice.decision?.version);
  expect(once.decision?.question).toBe("Shall I publish it now?");
  expect(once.decision?.questionMarkdown).toBeUndefined();
  expect(once.decision?.contextMarkdown).toContain("Release 0.9 is ready.");
  expect(card(ask).decision?.version).not.toBe(once.decision?.version);
});

test("R8: a question the person closed stays closed, and a new question opens again", () => {
  const e = evidence(ask, report, reply);
  const key = judge(e).keptQuestion!.key;
  expect(judge(e, { closedKey: key }).lane).toBe("idle");
  const target = row();
  applyConversationEvidence(e, target, prefs({ closedQuestions: { worker: { key, at: at(0) } } }));
  expect(target.lane).toBe("idle");
  const next = evidence(ask, report, reply, ["assistant", "Which tag should I use? Please choose one.", 0.3], report, ["assistant", "Noted.", 0.2]);
  expect(judge(next, { closedKey: key })).toMatchObject({ lane: "human", detail: expect.stringContaining("Which tag") });
});

test("R9: the board reads further back only while a question could be there", async () => {
  const cursor = { epoch: "e1", seq: 100 };
  const quiet = page([report, reply], { hasOlder: true, startCursor: cursor });
  expect(wantsOlder(quiet, NOW)).toBe(true);
  expect(wantsOlder(page([report, reply], { hasOlder: false, startCursor: cursor }), NOW)).toBe(false);
  expect(wantsOlder(page([["user", "hi"], reply], { hasOlder: true, startCursor: cursor }), NOW)).toBe(false);
  expect(wantsOlder(page([ask, reply], { hasOlder: true, startCursor: cursor }), NOW)).toBe(false);
  expect(wantsOlder(page([["assistant", "질문 닫음", 1], reply], { hasOlder: true, startCursor: cursor }), NOW)).toBe(false);
  expect(wantsOlder(page([["assistant", "Noted.", 30], reply], { hasOlder: true, startCursor: cursor }), NOW)).toBe(false);
  expect(wantsOlder(page(Array.from({ length: 31 }, (): Step => ["assistant", "Noted.", 0.5]), { hasOlder: true, startCursor: cursor }), NOW)).toBe(false);

  const calls: any[] = [];
  const pages = [
    page([report, reply], { hasOlder: true, startCursor: { epoch: "e1", seq: 50 } }),
    page([["assistant", "Working.", 0.95]], { hasOlder: true, startCursor: { epoch: "e1", seq: 20 } }),
    page([ask], { hasOlder: true, startCursor: { epoch: "e1", seq: 1 } }),
  ];
  const sdk = { agents: { ref: () => ({ timeline: { refetch: async (options: any) => { calls.push(options); return pages[calls.length - 1]; } } }) } };
  const reader = new ConversationReader();
  const read = await reader.read(sdk as any, row());
  expect(calls.map(c => [c.direction, c.limit, c.cursor?.seq])).toEqual([["tail", 48, undefined], ["before", 96, 50], ["before", 96, 20]]);
  expect(classify(read!, row(), undefined, false, { now: NOW })).toMatchObject({ lane: "human", keptQuestion: { later: 2 } });

  // A different epoch, or a failed read further back, keeps what was read.
  calls.length = 0;
  pages[1] = page([ask], { epoch: "e2", hasOlder: false, startCursor: null });
  const changed = await new ConversationReader().read(sdk as any, row());
  expect(calls).toHaveLength(2);
  expect(classify(changed!, row(), undefined, false, { now: NOW }).lane).toBe("idle");
});

test("R10: the card line counts the later messages in both languages", () => {
  const decision = { source: "conversation" } as any;
  expect(keptQuestionNotice({ keptQuestion: { key: "k", later: 1 }, decision })?.line).toEqual(
    ["이 뒤로 세션이 1번 더 말함 · 아직 답 없음", "The session spoke 1 more time since · No answer yet"]);
  expect(keptQuestionNotice({ keptQuestion: { key: "k", later: 17, stale: true }, decision })).toMatchObject({ stale: true,
    line: ["오래된 질문 · 이 뒤로 세션이 17번 더 말함 · 아직 답 없음", "Old question · The session spoke 17 more times since · No answer yet"] });
  expect(keptQuestionNotice({ keptQuestion: { key: "k", later: 1 }, decision: { source: "coordinator" } as any })).toBeNull();
  expect(keptQuestionNotice({ decision })).toBeNull();
});

test("R11: closed questions keep one per session, up to the limit, and old settings files still load", () => {
  const dir = mkdtempSync(join(tmpdir(), "kept-question-"));
  writeFileSync(join(dir, "scope.json"), JSON.stringify({ projects: ["p"], coordinator: null, judgments: {} }));
  const store = new PreferenceStore(join(dir, "scope.json"));
  expect(store.read().closedQuestions).toEqual({});
  writeFileSync(join(dir, "broken.json"), JSON.stringify({ projects: ["p"], coordinator: null, judgments: {}, closedQuestions: { worker: { key: "" } } }));
  expect(new PreferenceStore(join(dir, "broken.json")).read().closedQuestions).toEqual({});
  store.change(scope => { recordClosedQuestion(scope, "worker", "first", NOW); recordClosedQuestion(scope, "worker", "second", NOW + 1); });
  expect(store.read().closedQuestions).toEqual({ worker: { key: "second", at: new Date(NOW + 1).toISOString() } });
  store.change(scope => { for (let i = 0; i <= maxClosedQuestions; i++) recordClosedQuestion(scope, "s" + i, "k", NOW + 10 + i); });
  const saved = store.read().closedQuestions;
  expect(Object.keys(saved)).toHaveLength(maxClosedQuestions);
  expect(saved.worker).toBeUndefined();
  expect(saved.s0).toBeUndefined();
  expect(saved["s" + maxClosedQuestions]).toBeDefined();
});
