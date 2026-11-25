import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConversationEvidence, applyRecordedQuestions, classify, ConversationReader, excerpt, questionDetails, recordedSessionRows, scanOf, wantsOlder } from "../server/conversation";
import { displayLane } from "../shared/decision-count";
import { verifiedBoardFact } from "../server/board-facts";
import { snapshotHoldSessions } from "../shared/merge-hold";
import { applyDoneNotes, decorateDecision } from "../server/session-decisions";
import { PreferenceStore } from "../server/preferences";
import { answersChoices, closeQuestionByPerson, ledgerCardId, ledgerQuestionsBySession, questionContext, recordDisplay, saveScan, settlingLines } from "../server/open-questions";
import { TrackedDecisionStore } from "../server/tracked-decisions";
import { keptQuestionNotice } from "../client/kept-question";

const NOW = Date.parse("2030-01-02T12:00:00.000Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3600_000).toISOString();
const row = (extra: Record<string, unknown> = {}) => ({ id: "worker", status: "idle", projectId: "p", projectTitle: "Project", workspaceTitle: "w", model: null,
  title: "Release prep", lane: "idle", detail: "Waiting for the next request", activityAt: "1", ...extra }) as any;
const blank = () => ({ projects: ["p"], coordinator: null, judgments: {}, answers: {}, closedQuestions: {}, raisedQuestions: {}, decisionReceipts: {}, clarifications: {} }) as any;

type Step = ["assistant" | "user" | "agent" | "heartbeat", string, number?, string?];
const entry = ([kind, text, hoursAgo, id]: Step, seqEnd: number) => {
  const timestamp = hoursAgo === undefined ? undefined : at(hoursAgo);
  if (kind === "agent") return { seqEnd, timestamp, item: { type: "tool_call", callId: "paseo-agent-message:m" + seqEnd, name: "message", status: "completed",
    agentMessage: { event: "message", sender: { id: "other-session" }, text } } };
  if (kind === "heartbeat") return { seqEnd, timestamp, item: { type: "tool_call", callId: "hb" + seqEnd, name: "heartbeat", status: "completed" } };
  return { seqEnd, timestamp, item: { type: kind === "user" ? "user_message" : "assistant_message", text, ...(id ? { messageId: id } : {}) } };
};
const page = (steps: Step[], extra: Record<string, unknown> = {}, base = 0) => ({ epoch: "e1", entries: steps.map((step, i) => entry(step, base + i)), error: null, ...extra }) as any;
const evidence = (...steps: Step[]) => excerpt(page(steps));
const ask: Step = ["assistant", "Release 0.9 is ready.\nShall I publish it now?", 1];
const report: Step = ["agent", "Status from another session: tests passed.", 0.9];
const reply: Step = ["assistant", "Noted the other session's report. Nothing else changed.", 0.8];
const judge = (e: ReturnType<typeof evidence>, scope = blank(), target = row()) =>
  classify(e, target, undefined, false, { ...questionContext(scope, target.id), now: NOW });
const blockAsk: Step = ["assistant", "Pick a cache.\n\n```board-question\n" + JSON.stringify({ questions: [{ id: "Q1", text: "Where should the cache live?",
  options: [{ key: "A", text: "Memory", recommended: true }, { key: "B", text: "Disk" }] }], recommendedReply: "Use memory for now." }) + "\n```", 1];

type Ledger = { cards: Record<string, string>; resolved?: string[] };
const ledgerView = (ledger?: Ledger) => ledger && { questions: new Map([["worker", new Map(Object.entries(ledger.cards))]]),
  ...(ledger.resolved ? { resolved: new Set(ledger.resolved) } : {}) };
/** Shows the card the way a snapshot does, and saves what it found. */
function snapshot(scope: any, e: ReturnType<typeof evidence> | null, target = row(), ledgerCards?: Ledger) {
  const ledger = ledgerView(ledgerCards);
  if (e) applyConversationEvidence(e, target, scope, ledger, NOW);
  else applyRecordedQuestions(target, scope, ledger, NOW);
  decorateDecision(target, undefined, scope, e ?? undefined);
  const scan = scanOf(target);
  if (scan) saveScan(scope, target, scan, item => recordDisplay(questionDetails(item)), NOW);
  return target;
}

test("closes (a): a reply sent from the board's card that arrived in the session", () => {
  const scope = blank();
  scope.decisionReceipts = { "board-reply-1": { fingerprint: "f", sessionId: "worker", version: "v", status: "sent" } };
  expect(judge(evidence(ask, ["user", "Publish it.", 0.5, "board-reply-1"], reply), scope).lane).toBe("idle");
  // The same words from the person, not through the board, only mark the question as maybe answered.
  expect(judge(evidence(ask, ["user", "Publish it.", 0.5, "typed-1"], reply), scope)).toMatchObject({ lane: "human", keptQuestion: { maybeAnswered: true } });
});

test("closes (b): the session says on its own line that the decision was applied, or that the question moved", () => {
  for (const line of ["결정 반영: 0.9를 게시함", "**Decision applied:** published 0.9", "- decision applied: published", "질문은 카드 release-0.9로 옮김",
    "Merged the notes. 질문은 카드 k1로 옮겼습니다.", "Question moved to ledger card release-0.9."]) {
    expect(settlingLines("Done.\n" + line)).toBe(1);
    expect(judge(evidence(ask, report, ["assistant", "Handled.\n" + line, 0.7], report, reply)).lane).toBe("idle");
  }
  for (const line of ["결정 반영:", "질문 닫음", "`결정 반영: 예시`", "> 결정 반영: 인용", "결정 반영은 사람이 정합니다.", "I applied the decision about the API last week"]) {
    expect(settlingLines(line)).toBe(0);
  }
  expect(settlingLines("```\n결정 반영: 예시\n```")).toBe(0);
  // A settling line refers to the latest question before it, even one already closed, so an older open question stays.
  const scope = blank();
  scope.decisionReceipts = { r1: { fingerprint: "f", sessionId: "worker", version: "v", status: "sent" } };
  const older: Step = ["assistant", "Which region should I use? Please choose one.", 3];
  const result = judge(evidence(older, report, ask, ["user", "Publish.", 0.6, "r1"], ["assistant", "결정 반영: published", 0.5]), scope);
  expect(result).toMatchObject({ lane: "human", detail: expect.stringContaining("Which region") });
});

test("closes (c): a question that moved to a ledger card closes only when that card has a resolution", () => {
  const scope = blank();
  const e = evidence(ask, report, reply);
  const moved = snapshot(scope, e, row(), { cards: { "Shall I publish it now?": "card-1" }, resolved: [] });
  expect(moved.decision?.source).toBe("conversation");
  expect(scope.raisedQuestions.worker.questions[0]).toMatchObject({ moved: true, movedTo: "card-1" });
  // A ledger the board could not read leaves it open and moved.
  expect(snapshot(scope, e, row(), undefined).decision?.source).toBe("conversation");
  expect(scope.raisedQuestions.worker.questions[0].moved).toBe(true);
  // The card left the ledger without a resolution: the question goes back to the conversation card.
  const back = snapshot(scope, e, row(), { cards: {}, resolved: ["another-card"] });
  expect(back.decision?.source).toBe("conversation");
  expect(scope.raisedQuestions.worker.questions[0].moved).toBeUndefined();
  // Resolutions the board could not read leave it as it is.
  const unread = blank();
  snapshot(unread, e, row(), { cards: { "Shall I publish it now?": "card-1" }, resolved: [] });
  expect(snapshot(unread, e, row(), { cards: {} }).decision?.source).toBe("conversation");
  expect(unread.raisedQuestions.worker.questions[0].moved).toBe(true);
  // The card was resolved: the question closes.
  const done = blank();
  snapshot(done, e, row(), { cards: { "Shall I publish it now?": "card-1" }, resolved: [] });
  const gone = snapshot(done, e, row(), { cards: {}, resolved: ["card-1"] });
  expect(gone.decision).toBeUndefined();
  expect(done.closedQuestions[moved.keptQuestion.key]?.reason).toBe("ledger");
});

test("closes (d): the person pressed Close as handled", () => {
  const scope = blank();
  const shown = snapshot(scope, evidence(ask, report, reply));
  closeQuestionByPerson(scope, "worker", shown.keptQuestion.key, NOW);
  expect(scope.raisedQuestions.worker).toBeUndefined();
  expect(snapshot(scope, evidence(ask, report, reply)).lane).toBe("idle");
  // A new question opens again.
  expect(snapshot(scope, evidence(ask, report, reply, ["assistant", "Which tag should I use? Please choose one.", 0.3])).lane).toBe("human");
});

test("closes (e): the person wrote an answer the card offered", () => {
  for (const text of ["Q1 A", "q1: a", "A", "Memory", "Q1 · Where should the cache live?: A · Memory", "Use memory for now."]) {
    expect(judge(evidence(blockAsk, ["user", text, 0.5], reply)).lane).toBe("idle");
  }
  for (const text of ["A and also check the logs", "Q2 A", "What does B cost?"]) {
    expect(judge(evidence(blockAsk, ["user", text, 0.5], reply))).toMatchObject({ lane: "human", keptQuestion: { maybeAnswered: true } });
  }
  const labelled: Step = ["assistant", "Two ways:\n(a) Ship today.\n(b) Wait for review.\nShall I go with (a) or (b)?", 1];
  expect(judge(evidence(labelled, ["user", "(b)", 0.5], reply)).lane).toBe("idle");
  expect(judge(evidence(labelled, ["user", "b", 0.5], reply)).lane).toBe("idle");
  expect(answersChoices("b로 하되 내일", { choices: [{ label: "(b)", markdown: "Wait for review." }] })).toBe(false);
});

test("does not close (1): the person wrote about something else", () => {
  const result = judge(evidence(ask, ["user", "Let's talk about the logo first.", 0.5], reply));
  expect(result).toMatchObject({ lane: "human", detail: expect.stringContaining("Shall I publish"), keptQuestion: { maybeAnswered: true } });
  expect(judge(evidence(ask, ["user", "", 0.5], reply)).keptQuestion?.maybeAnswered).toBe(true);
  expect(keptQuestionNotice({ keptQuestion: result.keptQuestion!, decision: { source: "conversation" } as any })?.line?.[0]).toContain("세션에 답했을 수 있음 · 확인");
});

test("does not close (2): messages and heartbeats from other sessions", () => {
  expect(judge(evidence(ask, report, ["heartbeat", ""], report))).toMatchObject({ lane: "human", keptQuestion: { later: 0 } });
});

test("does not close (3): later messages from the session without a question", () => {
  const result = judge(evidence(ask, report, reply, report, ["assistant", "Second report noted.", 0.5]));
  expect(result).toMatchObject({ lane: "human", decisionRequestedAt: at(1), keptQuestion: { later: 2 } });
});

test("does not close (4): time and the number of later messages only dim the card", () => {
  const replies = (count: number) => Array.from({ length: count }, (_, i): Step => ["assistant", `Report ${i} noted.`, 0.5]);
  expect(judge(evidence(ask, ...replies(15))).keptQuestion?.stale).toBeUndefined();
  expect(judge(evidence(ask, ...replies(16))).keptQuestion).toMatchObject({ later: 16, stale: true });
  expect(judge(evidence(ask, ...replies(120))).keptQuestion).toMatchObject({ later: 120, stale: true });
  expect(judge(evidence(["assistant", "Shall I publish it now?", 13], reply)).keptQuestion?.stale).toBe(true);
  expect(judge(evidence(["assistant", "Shall I publish it now?", 24 * 30], reply)).lane).toBe("human");
});

test("does not close (5): a session that works, ends, is archived or cannot be found", () => {
  const scope = blank();
  const first = snapshot(scope, evidence(ask));
  const key = first.keptQuestion.key;
  // Working: the board does not read it, the record keeps the card. The session still reads as running.
  const working = snapshot(scope, null, row({ status: "running", lane: "running", detail: "Working" }));
  expect(working).toMatchObject({ lane: "running", detail: "Working", keptQuestion: { key },
    decision: { source: "conversation", question: "Shall I publish it now?", version: first.decision.version } });
  expect(displayLane(working, undefined)).toBe("human");
  expect(snapshotHoldSessions([working])[0].running).toBe(true);
  expect(working.decision.contextMarkdown).toContain("Release 0.9 is ready.");
  // Ended, or gone from the list (archived, host unreachable): the card stays as ended.
  const ended = snapshot(scope, null, row({ status: "closed", lane: "idle" }));
  expect(ended).toMatchObject({ lane: "human", keptQuestion: { key, ended: true } });
  expect(keptQuestionNotice(ended)?.line?.[0]).toContain("세션 끝남 · 미처리");
  // The question scrolled out of what the board reads: still open from the record.
  const scrolled = snapshot(scope, excerpt(page([reply], { entries: [entry(reply, 900)] })));
  expect(scrolled).toMatchObject({ lane: "human", keptQuestion: { key } });
});

test("the card keeps one version however many times the session speaks, and the details come from the question", () => {
  const card = (...steps: Step[]) => snapshot(blank(), evidence(...steps));
  const asked = card(ask), once = card(ask, report, reply), twice = card(ask, report, reply, report, ["assistant", "Another report noted.", 0.4]);
  expect(once.evidenceId).not.toBe(twice.evidenceId);
  expect(asked.decision.version).toBe(once.decision.version);
  expect(once.decision.version).toBe(twice.decision.version);
  expect(once.decision.question).toBe("Shall I publish it now?");
  expect(once.decision.contextMarkdown).toContain("Release 0.9 is ready.");
  expect(card(blockAsk, reply).decision.block.questions[0].id).toBe("Q1");
});

test("older questions still open ride along on the latest card", () => {
  const older: Step = ["assistant", "Which region should I use? Please choose one.", 3];
  const result = judge(evidence(older, report, ask, report, reply));
  expect(result).toMatchObject({ lane: "human", detail: expect.stringContaining("Shall I publish"),
    keptQuestion: { older: [{ question: expect.stringContaining("Which region") }] } });
});

test("sessions without a question keep today's behavior, and the coordinator's excerpt keeps its shape", () => {
  expect(judge(evidence(["assistant", "Done. Tests pass.", 1], report, reply)).lane).toBe("idle");
  expect(Object.keys(evidence(ask, report, reply).turns[0]).sort()).toEqual(["at", "role", "text"]);
});

test("the board reads further back only while a question it has not seen could be there", async () => {
  const cursor = { epoch: "e1", seq: 100 };
  expect(wantsOlder(page([report, reply], { hasOlder: true, startCursor: cursor }), NOW)).toBe(true);
  expect(wantsOlder(page([report, reply], { hasOlder: false, startCursor: cursor }), NOW)).toBe(false);
  expect(wantsOlder(page([["user", "hi"], reply], { hasOlder: true, startCursor: cursor }), NOW)).toBe(false);
  expect(wantsOlder(page([ask, reply], { hasOlder: true, startCursor: cursor }), NOW)).toBe(false);
  expect(wantsOlder(page([["assistant", "결정 반영: done", 1], reply], { hasOlder: true, startCursor: cursor }), NOW)).toBe(false);
  expect(wantsOlder(page([["assistant", "Noted.", 30], reply], { hasOlder: true, startCursor: cursor }), NOW)).toBe(false);
  const calls: any[] = [];
  const pages = [
    page([report, reply], { hasOlder: true, startCursor: { epoch: "e1", seq: 50 } }, 50),
    page([["assistant", "Working.", 0.95]], { hasOlder: true, startCursor: { epoch: "e1", seq: 20 } }, 20),
    page([ask], { hasOlder: true, startCursor: { epoch: "e1", seq: 1 } }, 1),
  ];
  const sdk = { agents: { ref: () => ({ timeline: { refetch: async (options: any) => { calls.push(options); return pages[calls.length - 1]; } } }) } };
  const read = await new ConversationReader().read(sdk as any, row());
  expect(calls.map(c => [c.direction, c.limit, c.cursor?.seq])).toEqual([["tail", 48, undefined], ["before", 96, 50], ["before", 96, 20]]);
  expect(judge(read!)).toMatchObject({ lane: "human", keptQuestion: { later: 2 } });
});

test("card lines in both languages", () => {
  const decision = { source: "conversation" } as any;
  expect(keptQuestionNotice({ keptQuestion: { key: "k", later: 0 }, decision })?.line).toBeNull();
  expect(keptQuestionNotice({ keptQuestion: { key: "k", later: 1 }, decision })?.line).toEqual(
    ["이 뒤로 세션이 1번 더 말함 · 아직 답 없음", "The session spoke 1 more time since · No answer yet"]);
  expect(keptQuestionNotice({ keptQuestion: { key: "k", later: 17, stale: true }, decision })?.line).toEqual(
    ["오래된 질문 · 이 뒤로 세션이 17번 더 말함 · 아직 답 없음", "Old question · The session spoke 17 more times since · No answer yet"]);
  expect(keptQuestionNotice({ keptQuestion: { key: "k", later: 3, ended: true, maybeAnswered: true }, decision })?.line).toEqual(
    ["세션 끝남 · 미처리 · 세션에 답했을 수 있음 · 확인", "Session ended · Not handled · You may have answered in the session · Check"]);
  expect(keptQuestionNotice({ keptQuestion: { key: "k", later: 1 }, decision: { source: "coordinator" } as any })).toBeNull();
});

test("records survive old and damaged settings files entry by entry", () => {
  const dir = mkdtempSync(join(tmpdir(), "kept-question-"));
  writeFileSync(join(dir, "old.json"), JSON.stringify({ projects: ["p"], coordinator: null, judgments: {} }));
  expect(new PreferenceStore(join(dir, "old.json")).read()).toMatchObject({ raisedQuestions: {}, closedQuestions: {} });
  const good = { projectId: "p", title: "t", projectTitle: "P", workspaceTitle: "w",
    questions: [{ key: "k1", epoch: "e1", seq: 3, question: "Shall I publish?", raisedAt: at(1), later: 0 }] };
  writeFileSync(join(dir, "mixed.json"), JSON.stringify({ projects: ["p"], coordinator: null, judgments: {},
    raisedQuestions: { worker: good, broken: { questions: "nope" } }, closedQuestions: { k0: { sessionId: "worker", at: at(2), reason: "board" }, bad: {} } }));
  const read = new PreferenceStore(join(dir, "mixed.json")).read();
  expect(Object.keys(read.raisedQuestions)).toEqual(["worker"]);
  expect(Object.keys(read.closedQuestions)).toEqual(["k0"]);
});

// Regressions found by combining the earlier draft with another branch: both dropped an unhandled conversation decision.
test("regression: a person's message that does not answer the decision keeps the card through later snapshots", async () => {
  const scope = blank();
  const steps: Step[] = [ask, ["user", "Can you also check the changelog?", 0.7], ["assistant", "The changelog is fine.", 0.6]];
  const reader = new ConversationReader();
  const sdk = { agents: { ref: () => ({ timeline: { refetch: async () => page(steps) } }) } };
  const first = row();
  await reader.decorate(sdk as any, [first], scope);
  decorateDecision(first, undefined, scope, undefined);
  saveScan(scope, first, scanOf(first)!, item => recordDisplay(questionDetails(item)), NOW);
  expect(first).toMatchObject({ lane: "human", keptQuestion: { maybeAnswered: true }, decision: { source: "conversation", question: "Shall I publish it now?" } });
  // Later the session answers more reports and the question leaves what the board reads. The record keeps the card.
  steps.splice(0, steps.length, ["assistant", "Report noted.", 0.2]);
  const later = row({ activityAt: "2" });
  await reader.decorate(sdk as any, [later], scope);
  decorateDecision(later, undefined, scope, undefined);
  expect(later).toMatchObject({ lane: "human", keptQuestion: { key: first.keptQuestion.key, maybeAnswered: true },
    decision: { source: "conversation", question: "Shall I publish it now?" } });
});

test("regression: a question asked 26 hours ago is still a card, only dimmed, from the conversation and from the record", () => {
  const scope = blank();
  const old: Step = ["assistant", "Release 0.9 is ready.\nShall I publish it now?", 26];
  const shown = snapshot(scope, evidence(old, report, ["assistant", "Noted.", 25]));
  expect(shown).toMatchObject({ lane: "human", keptQuestion: { stale: true }, decision: { source: "conversation" } });
  const fromRecord = snapshot(scope, null, row({ status: "running", lane: "running", detail: "Working" }));
  expect(fromRecord).toMatchObject({ lane: "running", keptQuestion: { key: shown.keptQuestion.key, stale: true }, decision: { version: shown.decision.version } });
});

test("open questions are never cut by count: 70 stay", () => {
  const scope = blank();
  const asks = Array.from({ length: 70 }, (_, i): Step => ["assistant", `Shall I publish build ${i}?`, 2]);
  const shown = snapshot(scope, evidence(...asks));
  expect(scope.raisedQuestions.worker.questions).toHaveLength(70);
  expect(shown.keptQuestion.older).toHaveLength(10);
  // From the record alone, after they all scrolled out, all 70 are still open.
  const later = snapshot(scope, excerpt(page([reply], {}, 1000)));
  expect(scanOf(later)!.open).toHaveLength(70);
  expect(Object.keys(scope.closedQuestions)).toHaveLength(0);
});

test("a coordinator judgment that no person is needed does not hide a question still waiting", () => {
  const e = evidence(ask, report, reply);
  for (const kind of ["review", "idle"] as const) {
    const result = classify(e, row(), { kind, text: "Handled by delegation", evidenceId: e.id } as any, false, { now: NOW });
    expect(result).toMatchObject({ lane: "human", detail: expect.stringContaining("Shall I publish") });
  }
  // Without an open question the judgment applies as before.
  const quiet = evidence(["assistant", "Done. Tests pass.", 1]);
  expect(classify(quiet, row(), { kind: "review", text: "Check the report", evidenceId: quiet.id } as any).lane).toBe("review");
  // A coordinator question still becomes its card.
  expect(classify(e, row(), { kind: "question", text: "Publish now?", evidenceId: e.id } as any).detail).toBe("코디네이터 판단 · Publish now?");
});

test("an answer that fits two open questions closes neither", () => {
  const first: Step = ["assistant", "Two ways for the cache:\n(a) Memory.\n(b) Disk.\nShall I go with (a) or (b)?", 3];
  const second: Step = ["assistant", "Two ways for logs:\n(a) Keep.\n(b) Drop.\nShall I go with (a) or (b)?", 2];
  const result = judge(evidence(first, second, ["user", "a", 1]));
  expect(result).toMatchObject({ lane: "human", keptQuestion: { maybeAnswered: true, older: [{ question: expect.stringContaining("(a) or (b)") }] } });
  // With one open question it closes that one.
  expect(judge(evidence(first, ["user", "a", 1])).lane).toBe("idle");
});

test("a block with several questions closes only when every question is answered", () => {
  const block = (questions: number) => ["assistant", "Choices.\n\n```board-question\n" + JSON.stringify({
    questions: Array.from({ length: questions }, (_, i) => ({ id: "Q" + (i + 1), text: `Question ${i + 1}?`, options: [{ key: "A", text: "Yes" }, { key: "B", text: "No" }] })),
  }) + "\n```", 1] as Step;
  expect(judge(evidence(block(2), ["user", "Q1 A", 0.5]))).toMatchObject({ lane: "human", keptQuestion: { maybeAnswered: true } });
  expect(judge(evidence(block(2), ["user", "Q1 A, Q2 B", 0.5])).lane).toBe("idle");
  expect(judge(evidence(block(2), ["user", "Q1 · Question 1?: A · Yes\nQ2 · Question 2?: B · No", 0.5])).lane).toBe("idle");
  expect(answersChoices("Q1 · Question 1?: A · Yes", { block: (JSON.parse((block(2)[1] as string).split("```board-question\n")[1].split("\n```")[0])) })).toBe(false);
});

test("records are read question by question, and a save keeps questions another snapshot added meanwhile", () => {
  const dir = mkdtempSync(join(tmpdir(), "kept-question-"));
  const good = { key: "k1", epoch: "e1", seq: 3, question: "Shall I publish?", raisedAt: at(1), later: 0 };
  writeFileSync(join(dir, "scope.json"), JSON.stringify({ projects: ["p"], coordinator: null, judgments: {},
    raisedQuestions: { worker: { projectId: "p", title: "t", projectTitle: "P", workspaceTitle: "w", questions: [good, { key: "" }, { ...good, key: "k2" }] } } }));
  expect(new PreferenceStore(join(dir, "scope.json")).read().raisedQuestions.worker.questions.map(q => q.key)).toEqual(["k1", "k2"]);
  // A scan made from an older read does not drop a question saved after it, and the project follows the session.
  const scope = blank();
  const e = evidence(ask);
  const target = row();
  applyConversationEvidence(e, target, scope, undefined, NOW);
  scope.raisedQuestions.worker = { projectId: "old", title: "t", projectTitle: "P", workspaceTitle: "w", questions: [{ ...good, key: "from-other-snapshot" }] };
  saveScan(scope, target, scanOf(target)!, () => ({}), NOW);
  expect(scope.raisedQuestions.worker.questions.map((q: any) => q.key)).toContain("from-other-snapshot");
  expect(scope.raisedQuestions.worker.questions).toHaveLength(2);
  expect(scope.raisedQuestions.worker.projectId).toBe("p");
});

test("sessions the board can no longer find stay as ended cards, within the selected projects only", () => {
  const scope = blank();
  snapshot(scope, evidence(ask));
  scope.raisedQuestions.elsewhere = { ...scope.raisedQuestions.worker, projectId: "q" };
  const rows = recordedSessionRows(scope, new Set(["p"]), new Set(), undefined, NOW);
  expect(rows.map(r => r.id)).toEqual(["worker"]);
  expect(rows[0]).toMatchObject({ status: "closed", lane: "human", title: "Release prep", keptQuestion: { ended: true } });
  // A session still listed (in another project now) is left to that scope.
  expect(recordedSessionRows(scope, new Set(["p"]), new Set(["worker"]), undefined, NOW)).toEqual([]);
  const card = rows[0];
  decorateDecision(card, undefined, scope, undefined);
  expect(card.decision).toMatchObject({ source: "conversation", question: "Shall I publish it now?" });
});

test("review: a coordinator's digest row does not stop reading further back before its own question", () => {
  const digest: Step = ["assistant", "| Editing session | question + suggested reply | **Question**: Shall I publish the draft? |", 0.5];
  expect(wantsOlder(page([digest, reply], { hasOlder: true, startCursor: { epoch: "e1", seq: 100 } }), NOW)).toBe(true);
});

test("review: an option line followed by a question of the person's own is not an answer", () => {
  const written = "Q1 · Where should the cache live?: A · Memory\nIs this the right choice?";
  expect(judge(evidence(blockAsk, ["user", written, 0.5], reply))).toMatchObject({ lane: "human", keptQuestion: { maybeAnswered: true } });
  expect(judge(evidence(blockAsk, ["user", "Q1 · Where should the cache live?: A · Memory, but check the disk first", 0.5], reply)).lane).toBe("human");
  expect(judge(evidence(blockAsk, ["user", "Q1 · Where should the cache live?: A · Memory", 0.5], reply)).lane).toBe("idle");
});

test("review: a status report after the question does not turn the kept question into a board fact", () => {
  const scope = blank();
  const shown = snapshot(scope, evidence(ask, ["assistant", "Status update only. No decision is requested.", 0.5]));
  expect(shown).toMatchObject({ lane: "human", decision: { source: "conversation", question: "Shall I publish it now?" } });
  expect(verifiedBoardFact(shown, evidence(ask, ["assistant", "Status update only. No decision is requested.", 0.5]), scope)).toBeNull();
});

test("review 2: a board reply closes the question it answered, also when the same timeline is read again", () => {
  const older: Step = ["assistant", "Which region should I use? Please choose one.", 3];
  const steps: Step[] = [older, report, ask, ["user", "Publish it.", 0.5, "board-reply-1"], ["assistant", "Publishing.", 0.4]];
  const answered = evidence(...steps).events!.find(event => event.role === "assistant" && event.text.includes("Shall I publish")) as any;
  // With the question it answered on record, and without it (replies sent before the board recorded it).
  for (const question of [answered.key, undefined]) {
    const scope = blank();
    scope.decisionReceipts = { "board-reply-1": { fingerprint: "f", sessionId: "worker", version: "v", status: "sent", ...(question ? { question } : {}) } };
    const first = snapshot(scope, evidence(...steps));
    expect(first).toMatchObject({ lane: "human", detail: expect.stringContaining("Which region") });
    // The next snapshot reads the same timeline with the newer question already closed: the older one stays open.
    const again = snapshot(scope, evidence(...steps));
    expect(again).toMatchObject({ lane: "human", detail: expect.stringContaining("Which region") });
    expect(Object.values(scope.closedQuestions).map((entry: any) => entry.reason)).toEqual(["board"]);
  }
});

test("review 2: a ledger card revised after an earlier revision was resolved does not close the moved question", () => {
  const dir = mkdtempSync(join(tmpdir(), "kept-question-ledger-"));
  const feed = join(dir, "tracked.json");
  const write = (title: string) => writeFileSync(feed, JSON.stringify({ version: 1, items: [{ source: "fixture", projectId: "book", id: "c1", title,
    sessionId: "worker", where: "human", kind: "answer", sessionMatch: { projectId: "book", sessionId: "worker", question: "Shall I publish it now?" } }] }));
  const store = new TrackedDecisionStore(feed);
  const read = () => store.read(new Set(["book"]), [], { items: [], projects: [] }).items;
  write("Publish 0.9");
  const first = read()[0];
  expect(store.resolve({ source: "fixture", projectId: "book", id: "c1", fingerprint: first.fingerprint }, () => new Set(["book"])).status).toBe("closed");
  write("Publish 0.9 after the review");
  const second = read()[0];
  expect(second.fingerprint).not.toBe(first.fingerprint);
  const resolved = store.resolvedKeys()!;
  expect(resolved.has(ledgerCardId(first.key, first.fingerprint))).toBe(true);
  expect(resolved.has(ledgerCardId(second.key, second.fingerprint))).toBe(false);
  // The question moved to the revised card, which then left the ledger without its own resolution: it stays open.
  const scope = blank();
  const e = evidence(ask, report, reply);
  const ledger = (items: typeof first[]) => ({ questions: ledgerQuestionsBySession(items), resolved });
  applyConversationEvidence(e, row(), scope, ledger([second]), NOW);
  const moved = row();
  applyConversationEvidence(e, moved, scope, ledger([second]), NOW);
  saveScan(scope, moved, scanOf(moved)!, () => ({}), NOW);
  expect(scope.raisedQuestions.worker.questions[0].movedTo).toBe(ledgerCardId(second.key, second.fingerprint));
  const left = row();
  applyConversationEvidence(e, left, scope, ledger([]), NOW);
  expect(left).toMatchObject({ lane: "human", detail: expect.stringContaining("Shall I publish") });
  expect(scanOf(left)!.closed).toEqual([]);
});

test("review 3: an answer that was ambiguous stays ambiguous when the timeline is read again after a later closure", () => {
  const first: Step = ["assistant", "Two ways for the cache:\n(a) Memory.\n(b) Disk.\nShall I go with (a) or (b)?", 3];
  const second: Step = ["assistant", "Two ways for logs:\n(a) Keep.\n(b) Drop.\nShall I go with (a) or (b)?", 2];
  const steps: Step[] = [first, second, ["user", "a", 1], ["user", "Drop the logs.", 0.5, "board-reply-1"], ["assistant", "Dropping the logs.", 0.4]];
  const newer = evidence(...steps).events!.find(event => event.role === "assistant" && event.text.includes("logs")) as any;
  for (const question of [newer.key, undefined]) {
    const scope = blank();
    scope.decisionReceipts = { "board-reply-1": { fingerprint: "f", sessionId: "worker", version: "v", status: "sent", ...(question ? { question } : {}) } };
    const once = snapshot(scope, evidence(...steps));
    expect(once).toMatchObject({ lane: "human", detail: expect.stringContaining("(a) or (b)"), keptQuestion: { maybeAnswered: true } });
    expect(Object.keys(scope.closedQuestions)).toHaveLength(1);
    const again = snapshot(scope, evidence(...steps));
    expect(again).toMatchObject({ lane: "human", keptQuestion: { maybeAnswered: true } });
    expect(Object.keys(scope.closedQuestions)).toHaveLength(1);
  }
});

test("review 4: a person's done note closes only the question it was written on, once", () => {
  const older: Step = ["assistant", "Which region should I use? Please choose one.", 3];
  const steps: Step[] = [older, report, ask, report, reply];
  const scope = blank();
  const first = snapshot(scope, evidence(...steps));
  const note = { sessionId: "worker", origin: "person", kind: "done", text: "Handled", revision: 1, evidenceId: first.evidenceId } as any;
  const closing = applyDoneNotes([first], { worker: note }, scope);
  expect(closing).toEqual([["worker", first.keptQuestion.key, 1]]);
  for (const [id, question, revision] of closing) closeQuestionByPerson(scope, id, question, NOW, revision);
  // The next snapshot reads the same timeline: the older question is now the card, and the same note does not close it.
  const second = snapshot(scope, evidence(...steps));
  expect(second.detail).toContain("Which region");
  expect(applyDoneNotes([second], { worker: note }, scope)).toEqual([]);
  expect(second.keptQuestion.noteSpent).toBe(true);
  decorateDecision(second, note, scope, evidence(...steps));
  expect(second.decision?.question).toContain("Which region");
  expect(displayLane(second, note)).toBe("human");
  // A new done note closes the card it is written on.
  expect(applyDoneNotes([second], { worker: { ...note, revision: 2 } }, scope)).toEqual([["worker", second.keptQuestion.key, 2]]);
});
