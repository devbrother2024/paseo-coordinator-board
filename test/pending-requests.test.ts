import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  actionLabel, actionResponse, answerResponse, buildAnswers, canSubmit, createResponder, dismissResponse, emptyDraft,
  outcomeText, parseQuestions, requestName, requestView, toggleOption, waitingLine, writeOther, type PendingRequest, type PermissionResponse,
} from "../client/pending-requests";
import { sessionDetail } from "../client/model";

const ko = (korean: string) => korean;
const en = (_: string, english: string) => english;
const request = (value: Record<string, unknown>) => ({ id: "request-1", provider: "claude", name: "Tool", ...value }) as unknown as PendingRequest;

// The shape a Claude AskUserQuestion request carries after the host normalizes it.
const claudeInput = {
  questions: [
    { header: "Database", question: "Which database should the sample app use?", multiSelect: false, allowOther: true,
      options: [{ label: "SQLite", description: "One local file" }, { label: "Postgres", description: "A separate server", preview: "docker compose up" }] },
    { header: "Extras", question: "Which extras do you want?", multiSelect: true, allowOther: true,
      options: [{ label: "Seed data" }, { label: "Migrations" }, { label: "Admin page" }] },
  ],
};
// The shape a Codex question carries: an id per question and isOther for the free answer.
const codexInput = {
  questions: [
    { id: "0", header: "Question 1", question: "Keep the old endpoint?", options: [{ label: "Keep" }, { label: "Remove" }], isOther: true },
    { id: "1", header: "Question 2", question: "What should the new endpoint be called?", options: [], isOther: true },
  ],
};

test("a question request is read into its questions, options, multiple choice and free answer", () => {
  const claude = parseQuestions(claudeInput)!;
  expect(claude.map(q => [q.header, q.multiSelect, q.allowOther, q.options.map(o => o.label)])).toEqual([
    ["Database", false, true, ["SQLite", "Postgres"]],
    ["Extras", true, true, ["Seed data", "Migrations", "Admin page"]],
  ]);
  expect(claude[0].options[1]).toEqual({ label: "Postgres", description: "A separate server", preview: "docker compose up" });
  const codex = parseQuestions(codexInput)!;
  expect(codex.map(q => [q.header, q.question, q.allowOther, q.options.length])).toEqual([
    ["Question 1", "Keep the old endpoint?", true, 2],
    ["Question 2", "What should the new endpoint be called?", true, 0],
  ]);
});

test("an input the board cannot read as questions is left to the work session", () => {
  const one = claudeInput.questions[0];
  for (const input of [
    null, "text", {}, { questions: [] }, { questions: "one" }, { questions: [null] },
    { questions: [{ ...one, header: undefined }] }, { questions: [{ ...one, question: 3 }] },
    { questions: [{ ...one, header: "  " }] }, { questions: [{ ...one, question: "" }] },
    { questions: [{ ...one, options: "SQLite" }] }, { questions: [{ ...one, options: [{ description: "no label" }] }] },
    { questions: [{ ...one, options: ["SQLite"] }] },
    // Answers are keyed by header, so two questions with one header cannot both be answered.
    { questions: [one, { ...claudeInput.questions[1], header: "Database" }] },
  ]) expect(parseQuestions(input)).toBeNull();
  expect(requestView(request({ kind: "question", input: { prompt: "Which one?" } }))).toEqual({ mode: "session" });
});

test("one choice replaces another, a typed answer replaces the choice, and multiple choice keeps both in click order", () => {
  const questions = parseQuestions(claudeInput)!;
  let draft = emptyDraft(questions);
  expect(canSubmit(questions, draft)).toBe(false);
  draft = toggleOption(questions, draft, 0, 0);
  draft = toggleOption(questions, draft, 0, 1);
  expect(draft.selected[0]).toEqual([1]);
  draft = toggleOption(questions, draft, 0, 1);
  expect(draft.selected[0]).toEqual([]);
  draft = toggleOption(questions, draft, 0, 0);
  draft = writeOther(questions, draft, 0, "DuckDB");
  expect([draft.selected[0], draft.other[0]]).toEqual([[], "DuckDB"]);
  draft = toggleOption(questions, draft, 0, 1);
  expect([draft.selected[0], draft.other[0]]).toEqual([[1], ""]);
  expect(canSubmit(questions, draft)).toBe(false);
  draft = toggleOption(questions, draft, 1, 2);
  draft = toggleOption(questions, draft, 1, 0);
  draft = writeOther(questions, draft, 1, " Dark mode ");
  expect([draft.selected[1], draft.other[1]]).toEqual([[2, 0], " Dark mode "]);
  draft = toggleOption(questions, draft, 1, 2);
  expect(draft.selected[1]).toEqual([0]);
  expect(canSubmit(questions, draft)).toBe(true);
  expect(buildAnswers(questions, draft)).toEqual({ Database: "Postgres", Extras: "Seed data, Dark mode" });
});

test("a question without options needs typed text unless it accepts an empty answer", () => {
  const questions = parseQuestions(codexInput)!;
  let draft = toggleOption(questions, emptyDraft(questions), 0, 1);
  expect(canSubmit(questions, draft)).toBe(false);
  draft = writeOther(questions, draft, 1, "   ");
  expect(canSubmit(questions, draft)).toBe(false);
  draft = writeOther(questions, draft, 1, "/v2/items");
  expect(canSubmit(questions, draft)).toBe(true);
  expect(buildAnswers(questions, draft)).toEqual({ "Question 1": "Remove", "Question 2": "/v2/items" });
  const optional = parseQuestions({ questions: [{ header: "Note", question: "Anything to add?", options: [], allowEmpty: true }] })!;
  expect(canSubmit(optional, emptyDraft(optional))).toBe(true);
  expect(buildAnswers(optional, emptyDraft(optional))).toEqual({ Note: "" });
});

test("a submitted answer allows the request with the original input and only the chosen or typed values", () => {
  for (const [input, picks, typed, answers] of [
    [claudeInput, [[0, 1], [1, 0], [1, 1]], [[1, "Audit log"]], { Database: "Postgres", Extras: "Seed data, Migrations, Audit log" }],
    [codexInput, [[0, 0]], [[1, "/v2/items"]], { "Question 1": "Keep", "Question 2": "/v2/items" }],
  ] as const) {
    const pending = request({ kind: "question", input });
    const questions = parseQuestions(input)!;
    let draft = emptyDraft(questions);
    for (const [question, option] of picks) draft = toggleOption(questions, draft, question, option);
    for (const [question, text] of typed) draft = writeOther(questions, draft, question, text);
    const response = answerResponse(pending, questions, draft);
    expect(response).toEqual({ behavior: "allow", updatedInput: { ...input, answers } });
    // Every part of an answer is an option label of that question or the text the person typed.
    const allowed = new Set([...questions.flatMap(q => q.options.map(o => o.label)), ...typed.map(([, text]) => text)]);
    for (const value of Object.values(answers)) for (const part of value.split(", ")) expect(allowed.has(part)).toBe(true);
  }
});

test("closing a question denies it, and a question that accepts an empty answer is answered empty", () => {
  const questions = parseQuestions(claudeInput)!;
  const pending = request({ kind: "question", input: claudeInput });
  expect(dismissResponse(pending, questions, toggleOption(questions, emptyDraft(questions), 0, 0)))
    .toEqual({ behavior: "deny", message: "Dismissed by user" });
  const input = { questions: [{ header: "Note", question: "Anything to add?", options: [], allowEmpty: true }] };
  const optional = parseQuestions(input)!;
  expect(dismissResponse(request({ kind: "question", input }), optional, emptyDraft(optional)))
    .toEqual({ behavior: "allow", updatedInput: { ...input, answers: { Note: "" } } });
});

test("a plan request shows its text and actions, and each action sends only its own choice", () => {
  const actions = [
    { id: "reject", label: "Reject", behavior: "deny", variant: "danger", intent: "dismiss" },
    { id: "implement", label: "Implement", behavior: "allow", variant: "primary", intent: "implement" },
    { id: "implement_resume", label: "Implement with Auto", behavior: "allow", intent: "implement_resume" },
  ];
  const view = requestView(request({ kind: "plan", input: { plan: "1. Add the table" }, actions }));
  expect(view).toEqual({ mode: "plan", plan: "1. Add the table", actions: actions.map(({ id, label, behavior, intent }) => ({ id, label, behavior, intent })) });
  expect(requestView(request({ kind: "plan", metadata: { planText: "From metadata" }, input: { plan: "From input" }, actions })))
    .toMatchObject({ mode: "plan", plan: "From metadata" });
  if (view.mode !== "plan") throw Error("plan expected");
  expect(view.actions.map(actionResponse)).toEqual([
    { behavior: "deny", selectedActionId: "reject", message: "Denied by user" },
    { behavior: "allow", selectedActionId: "implement" },
    { behavior: "allow", selectedActionId: "implement_resume" },
  ]);
  expect(view.actions.map(action => actionLabel(action, ko))).toEqual(
    ["계획 거절 · 구현하지 않음", "계획 승인 · 구현 시작", "계획 승인 · Implement with Auto"]);
  expect(view.actions.map(action => actionLabel(action, en))).toEqual(
    ["Reject plan · Do not implement", "Approve plan · Start implementing", "Approve plan · Implement with Auto"]);
  const unknown = [{ id: "later", label: "Ask again later", behavior: "deny" as const }, { id: "go", label: "Go", behavior: "allow" as const }];
  expect(unknown.map(action => actionLabel(action, ko))).toEqual(["거절 · Ask again later", "승인 · Go"]);
  expect(unknown.map(action => actionLabel(action, en))).toEqual(["Reject · Ask again later", "Approve · Go"]);
});

test("a plan without text or usable actions and every tool, mode or other request stays in the work session", () => {
  const actions = [{ id: "implement", label: "Implement", behavior: "allow" }];
  for (const value of [
    { kind: "plan", input: { plan: "A plan" } },
    { kind: "plan", input: { plan: "A plan" }, actions: [] },
    { kind: "plan", input: { plan: "A plan" }, actions: [{ id: "", label: "Implement", behavior: "allow" }] },
    { kind: "plan", input: { plan: "A plan" }, actions: [{ id: "x", label: "Maybe", behavior: "ask" }] },
    { kind: "plan", input: { plan: "  " }, actions },
    { kind: "plan", input: {}, actions },
    { kind: "tool", name: "Bash", title: "Run command", input: { command: "rm -rf build" }, actions },
    { kind: "mode", title: "Switch mode", actions },
    { kind: "other", title: "Something else", input: claudeInput, actions },
  ]) expect(requestView(request(value))).toEqual({ mode: "session" });
  expect(waitingLine(request({ kind: "tool", name: "Bash", title: "Run command", description: "rm -rf build" }), ko))
    .toBe("도구 실행 승인 · Run command · rm -rf build");
  expect(waitingLine(request({ kind: "tool", name: "Bash" }), en)).toBe("Tool approval · Bash");
  expect(requestName(request({ kind: "plan", title: "Plan", description: "Review the proposed plan." }), ko)).toBe("계획 승인 · Plan");
  expect(requestName(request({ kind: "plan", name: "ExitPlanMode" }), ko)).toBe("계획 승인");
  expect(requestName(request({ kind: "question", name: "AskUserQuestion" }), en)).toBe("Question");
  expect(waitingLine(request({ kind: "mode", title: "Switch mode" }), en)).toBe("Mode change · Switch mode");
  expect(waitingLine(request({ kind: "question", title: "Question" }), ko)).toBe("질문 · Question");
  expect(waitingLine(request({ kind: "plan", title: "Plan" }), en)).toBe("Plan approval · Plan");
  expect(waitingLine(request({ kind: "other", name: "elicitation", description: "line one\nline two" }), ko)).toBe("요청 · elicitation · line one line two");
});

function agent(pending: string[]) {
  const state = { pending: [...pending], sent: [] as { requestId: string; response: PermissionResponse }[], reads: 0,
    failRead: false, failSend: false, clearOnSend: true, hold: null as null | Promise<void> };
  return { state, port: {
    refresh: async () => {
      state.reads++;
      if (state.failRead) throw Error("offline");
      return { agent: { pendingPermissions: state.pending.map(id => ({ id })) } };
    },
    respondToPermission: async (options: { requestId: string; response: PermissionResponse }) => {
      if (state.hold) await state.hold;
      if (state.failSend) throw Error("not connected");
      state.sent.push(options);
      if (state.clearOnSend) state.pending = state.pending.filter(id => id !== options.requestId);
    },
  } };
}
const allow: PermissionResponse = { behavior: "allow", selectedActionId: "implement" };
const quick = { checks: 3, wait: async () => {} };

test("a response is sent once to a request that is still waiting and reported after the request clears", async () => {
  const { state, port } = agent(["request-1", "request-2"]);
  const { respond } = createResponder(port, quick);
  expect(await respond("request-1", allow)).toBe("sent");
  expect(state.sent).toEqual([{ requestId: "request-1", response: allow }]);
  expect(state.pending).toEqual(["request-2"]);
  // The same request is not answered a second time.
  expect(await respond("request-1", allow)).toBe("sent");
  expect(state.sent).toHaveLength(1);
});

test("a request that was already handled or replaced is not answered", async () => {
  const { state, port } = agent(["request-2"]);
  const { respond } = createResponder(port, quick);
  expect(await respond("request-1", allow)).toBe("handled");
  expect(state.sent).toEqual([]);
  const missing = createResponder({ ...port, refresh: async () => null }, quick);
  expect(await missing.respond("request-2", allow)).toBe("failed");
  expect(state.sent).toEqual([]);
});

test("pressing twice sends one response", async () => {
  const { state, port } = agent(["request-1"]);
  let release = () => {};
  state.hold = new Promise<void>(resolve => { release = resolve; });
  const { respond } = createResponder(port, quick);
  const first = respond("request-1", allow);
  const second = respond("request-1", allow);
  const other = respond("request-2", allow);
  expect(await second).toBe("busy");
  expect(await other).toBe("busy");
  release();
  expect(await first).toBe("sent");
  expect(state.sent).toHaveLength(1);
});

test("a failed read or send is reported, sends nothing twice, and can be tried again", async () => {
  const { state, port } = agent(["request-1"]);
  const { respond } = createResponder(port, quick);
  state.failRead = true;
  expect(await respond("request-1", allow)).toBe("failed");
  expect(state.sent).toEqual([]);
  state.failRead = false; state.failSend = true;
  expect(await respond("request-1", allow)).toBe("failed");
  expect(state.sent).toEqual([]);
  state.failSend = false;
  expect(await respond("request-1", allow)).toBe("sent");
  expect(state.sent).toHaveLength(1);
});

test("a response whose request never clears is reported as unconfirmed and is not sent again", async () => {
  const { state, port } = agent(["request-1"]);
  state.clearOnSend = false;
  const waits: number[] = [];
  const { respond, check } = createResponder(port, { checks: 3, wait: async ms => { waits.push(ms); } });
  expect(await respond("request-1", allow)).toBe("unconfirmed");
  expect(waits).toHaveLength(3);
  expect(state.sent).toHaveLength(1);
  expect(await respond("request-1", allow)).toBe("unconfirmed");
  expect(await check("request-1")).toBe("unconfirmed");
  expect(state.sent).toHaveLength(1);
  state.pending = [];
  expect(await check("request-1")).toBe("sent");
  expect(await respond("request-1", allow)).toBe("sent");
  expect(state.sent).toHaveLength(1);
  // Checking never sends, even for a request this responder has not answered.
  state.pending = ["request-3"];
  expect(await check("request-3")).toBe("unconfirmed");
  expect(state.sent).toHaveLength(1);
  // A check that cannot read the session leaves the result unconfirmed instead of failed: the response went out.
  const offline = agent(["request-9"]);
  offline.state.clearOnSend = false;
  const again = createResponder({ ...offline.port, refresh: async () => {
    if (offline.state.sent.length) throw Error("offline");
    return offline.port.refresh();
  } }, quick);
  expect(await again.respond("request-9", allow)).toBe("unconfirmed");
  expect(offline.state.sent).toHaveLength(1);
});

test("each result is described in both languages", () => {
  for (const outcome of ["sent", "handled", "unconfirmed", "failed"] as const) {
    expect(outcomeText(outcome, ko)).toMatch(/[가-힣]/);
    expect(outcomeText(outcome, en)).toMatch(/^[A-Z][^가-힣]+$/);
  }
  expect(outcomeText("handled", ko)).toContain("이미 처리된 요청");
  expect(outcomeText("busy", en)).toBe("");
});

test("the card headline counts waiting requests in English and keeps the request titles", () => {
  expect(sessionDetail("응답을 기다리는 요청 2건", en)).toBe("Requests awaiting a response: 2");
  expect(sessionDetail("응답을 기다리는 요청 2건 · Question · Bash", en)).toBe("Requests awaiting a response: 2 · Question · Bash");
  expect(sessionDetail("응답을 기다리는 요청 1건 · Plan", ko)).toBe("응답을 기다리는 요청 1건 · Plan");
  expect(sessionDetail("응답을 기다리는 요청 1건이 있습니다", en)).toBe("응답을 기다리는 요청 1건이 있습니다");
});

test("only the client responder answers a waiting request, never the plugin server", () => {
  const root = join(import.meta.dir, "..");
  const sources = (folder: string) => readdirSync(join(root, folder)).filter(name => /\.tsx?$/.test(name)).map(name => join(folder, name));
  const callers = [...sources("server"), ...sources("shared"), ...sources("client"), "index.server.ts", "index.client.tsx"]
    .filter(file => /\.respondToPermission\(/.test(readFileSync(join(root, file), "utf8")));
  expect(callers).toEqual([join("client", "pending-requests.ts")]);
});
