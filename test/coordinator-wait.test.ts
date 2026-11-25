import { expect, test } from "bun:test";
import { boardSnapshot, type SessionRow } from "../shared/contract";
import { decisionCount, displayLane } from "../shared/decision-count";
import { detectCoordinatorWait, coordinatorWaitLabel, isLongCoordinatorWait } from "../shared/coordinator-wait";
import { placeMergeCards } from "../shared/merge-card-place";
import { trackedDecisionSchema } from "../shared/tracked-decisions";
import { excerpt } from "../server/conversation";
import { decorateReviewWait } from "../server/review-wait";
import { kanbanSessionLanes, progressLane, projectCards } from "../client/model";

const examples = [
  ["코디네이터에게 보고했고 화면 사용 승인을 기다립니다.", "screen"],
  ["코디네이터에게 보고했고 '화면 써도 된다'는 답을 기다립니다.", "report"],
  ["화면 차례가 오면 이어 갑니다.", "screen"],
  ["I sent the coordinator a report and I'm waiting for its go-ahead.", "report"],
  ["Waiting for the coordinator.", "reply"],
  ["코디네이터의 판단을 기다립니다.", "decision"],
  ["Waiting for the coordinator to merge the PR.", "merge"],
  ["병렬 세션의 답변을 기다립니다.", "reply"],
  ["I'll resume once the coordinator replies.", "reply"],
  ["Awaiting the coordinator's approval.", "decision"],
  ["Waiting for a visual QA slot.", "screen"],
  ["코디네이터가 답을 주면 다시 진행하겠습니다.", "reply"],
  ["Waiting for a reply from another session.", "reply"],
  ["The coordinator has the report. I'll wait for a reply.", "report"],
  ["코디네이터에게 화면 차례를 요청했습니다. 답을 기다리겠습니다.", "screen"],
  ["I've asked the coordinator for a screen turn. Waiting for approval.", "screen"],
  ["코디네이터가 PR을 병합할 때까지 기다립니다.", "merge"],
  ["병합은 코디네이터 승인 후에 진행합니다. 지금은 대기 중입니다.", "merge"],
  ["Waiting for approval. The coordinator has the proposed merge.", "merge"],
] as const;

test("identifies who the session is waiting on and a short reason in both languages", () => {
  for (const [message, reason] of examples) {
    expect([message, detectCoordinatorWait(message)]).toEqual([message, reason]);
  }
  const ko = (a: string) => a;
  const en = (_: string, b: string) => b;
  expect(coordinatorWaitLabel("screen", ko)).toBe("코디네이터 대기 · 화면 차례");
  expect(coordinatorWaitLabel("screen", en)).toBe("Waiting on coordinator · Screen access");
});

test("ignores human questions, examples, finished waits and unrelated blockers", () => {
  for (const message of [
    "Waiting for the coordinator. Please choose the export size.",
    "코디네이터의 판단을 기다립니다.\n**결정할 것:** 내보낼 크기",
    "> Waiting for the coordinator.\nAll done.",
    "The text says “Waiting for the coordinator”.",
    "The value is `waiting for the coordinator`.",
    "Example:\n\n```text\nWaiting for the coordinator.\n```",
    "Example:\n\n   ~~~~text\nWaiting for the coordinator.\n",
    "Not waiting for the coordinator.",
    "코디네이터의 답을 기다리지 않습니다.",
    "I was waiting for the coordinator.",
    "I am waiting for the coordinator's reply. The coordinator has replied.",
    "Waiting for CI. I sent the coordinator a report.",
    "Waiting for CI before I update the coordinator.",
    "Waiting for CI to finish before my screen slot.",
    "The coordinator is waiting for my report.",
    "코디네이터가 제 보고를 기다립니다.",
    "코디네이터가 기다립니다.",
    "코디네이터가 화면 차례를 기다립니다.",
    "코디네이터에게 보고했고 CI 완료를 기다립니다.",
    "코디네이터에게 보고했고 사용자 승인을 기다립니다.",
    "위 내용을 코디네이터에게 보고했습니다. 사용자 승인을 기다립니다.",
    "코디네이터에게 보고했습니다. 유지관리자님의 답을 기다립니다.",
    "I told the coordinator. Waiting for the user to approve.",
    "The coordinator has the report. I'm waiting for your decision.",
    "Waiting for you to approve. I notified the coordinator.",
    "Waiting for a reply from the user. The coordinator has the report.",
    "화면 차례를 요청했습니다. 담당자님 답을 기다리겠습니다.",
    "코디네이터와 확인했습니다. 여전히 사람의 판단을 기다립니다.",
    "Waiting for your reply.",
    "답을 기다립니다.",
  ]) expect([message, detectCoordinatorWait(message)]).toEqual([message, undefined]);
  expect(detectCoordinatorWait("> Please confirm.\nWaiting for the coordinator.")).toBe("reply");
  expect(detectCoordinatorWait("Waiting for the coordinator.\n\n~~~\nPlease confirm.\n~~~")).toBe("reply");
});

const at = "2026-11-25T08:00:00Z";
const now = Date.parse(at) + 30 * 60_000;
const worker: SessionRow = {
  id: "worker-1", title: "Export", projectId: "alpha", projectTitle: "Alpha",
  workspaceTitle: "Export", model: null, status: "idle", activityAt: new Date(now).toISOString(),
  lane: "review", detail: "세션 결과 확인 필요",
};
const assistant = (text: string) => ({ type: "assistant_message", text });
const lastWait = assistant("코디네이터의 판단을 기다립니다.");
function decorate(items: object[], changes: Partial<SessionRow> = {}) {
  const observed = excerpt({
    epoch: "fixture",
    entries: items.map((item, seqEnd) => ({ item, seqEnd, timestamp: at })),
  } as never);
  const row = { ...worker, ...changes };
  decorateReviewWait([row], new Map([[row.id, observed]]), {
    coordinator: "coordinator", now, thresholdHours: 12, covered: new Set(), judgments: {},
  });
  return row;
}

test("local and assigned remote waits move into session progress without becoming decisions", () => {
  for (const serverId of [undefined, "peer-host"]) {
    const row = decorate([lastWait], { serverId });
    expect(row).toMatchObject({ coordinatorWait: "decision", detail: worker.detail, waitingSince: at });
    const snapshot = boardSnapshot.output.parse({ sessions: [row], notes: {}, projects: [], coordinator: null });
    expect(snapshot.sessions[0].coordinatorWait).toBe("decision");
    expect(decisionCount(snapshot)).toBe(0);
    const lane = displayLane(row, undefined);
    expect(lane).toBe("review");
    expect(progressLane({ session: row, note: undefined, lane })).toBe("running");
    const note = { sessionId: row.id, kind: "question" as const, text: "Which size?", revision: 1 };
    expect(displayLane(row, note)).toBe("human");
  }
});

test("a later coordinator wait leaves an open conversation decision and its original request intact", () => {
  const question = "Please choose the export size.";
  const decision = { source: "conversation" as const, question, version: "open-question" };
  const decisionRequestedAt = new Date(now - 90 * 60_000).toISOString();
  // The decision-retention layer has kept the earlier question. The wait uses the latest turn.
  const row = decorate([assistant(question), lastWait], {
    lane: "human", detail: question, decision, decisionRequestedAt,
  });
  const snapshot = boardSnapshot.output.parse({ sessions: [row], notes: {}, projects: [], coordinator: null });
  const [card] = projectCards(snapshot).human;
  expect(decisionCount(snapshot)).toBe(1);
  expect(card.session).toMatchObject({ decision, detail: question, decisionRequestedAt, coordinatorWait: "decision", waitingSince: at });
  expect(progressLane(card)).toBe("running");
  expect(kanbanSessionLanes(card, false)).toEqual(["human", "running"]);
});

test("an open ledger decision covering a conversation stays in My decisions when its session waits", () => {
  const question = "Please choose the export size.";
  const row = decorate([assistant(question), lastWait], {
    lane: "human", detail: question, decision: { source: "conversation", question, version: "open-question" },
  });
  const record = trackedDecisionSchema.parse({
    id: "export-size", key: "record-export-size", source: "ledger", projectId: row.projectId, title: "Export size",
    where: "human", kind: "answer", fingerprint: "a".repeat(64), matchedSessionId: row.id, matchedPull: null,
  });
  const snapshot = boardSnapshot.output.parse({
    sessions: [row], notes: {}, projects: [], coordinator: null, trackedDecisions: { status: "ok", items: [record] },
  });
  expect(decisionCount(snapshot)).toBe(1);
  expect(placeMergeCards(snapshot.trackedDecisions!.items, snapshot.pullRequests).deciding).toEqual([record]);
  const [card] = projectCards(snapshot).projects[0].cards;
  expect(progressLane(card)).toBe("running");
  expect(kanbanSessionLanes(card, true)).toEqual(["running"]);
});

test("a newer input, native request, later assistant turn or closed session supersedes a wait", () => {
  const reply = { type: "tool_call", callId: "paseo-agent-message:1", status: "completed",
    agentMessage: { event: "message", sender: { id: "coordinator" }, text: "Go ahead." } };
  for (const row of [
    decorate([lastWait, reply]),
    decorate([lastWait, { type: "user_message", text: "Go ahead." }]),
    decorate([lastWait, { type: "user_message", text: "" }]),
    decorate([lastWait, assistant("완료했습니다.")]),
    decorate([lastWait], { status: "closed" }),
    decorate([lastWait], { lane: "running", status: "running" }),
    decorate([lastWait], { lane: "human", nativePending: true }),
    decorate([lastWait], { id: "coordinator" }),
  ]) expect(row.coordinatorWait).toBeUndefined();
});

test("a long turn is classified before cutting its excerpt or losing the opening code fence", () => {
  expect(decorate([assistant("Waiting for the coordinator.\n\n" + "Details ".repeat(300))]).coordinatorWait)
    .toBe("reply");
  expect(decorate([assistant("Please confirm the export size.\n\n" + "Details ".repeat(300) + "\n\nWaiting for the coordinator.")]).coordinatorWait)
    .toBeUndefined();
  expect(decorate([assistant("```text\n" + "Details ".repeat(300) + "\nWaiting for the coordinator.\n```")]).coordinatorWait)
    .toBeUndefined();
});

test("an explicit question block takes priority over a coordinator wait", () => {
  const text = "Waiting for the coordinator.\n\n" + [
    "```board-question",
    '{"questions":[{"text":"Pick the export size.","options":[{"key":"a","text":"Small"},{"key":"b","text":"Large"}]}]}',
    "```",
  ].join("\n");
  expect(decorate([assistant(text)]).coordinatorWait).toBeUndefined();
});

test("an answered note does not hide a new wait in the latest assistant message", () => {
  expect(decorate([lastWait], { decisionAnswered: true }).coordinatorWait).toBe("decision");
});

test("emphasis starts at 30 minutes using the message time", () => {
  expect(isLongCoordinatorWait(at, now - 1)).toBe(false);
  expect(isLongCoordinatorWait(at, now)).toBe(true);
  expect(isLongCoordinatorWait(undefined, now)).toBe(false);
  expect(isLongCoordinatorWait("unknown", now)).toBe(false);
});
