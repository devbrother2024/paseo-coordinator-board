import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  actionLabel, actionResponse, answerResponse, answerSummary,buildAnswers, canSubmit, createResponder, dismissResponse, emptyDraft,
  noteSent, outcomeText, parseQuestions, requestName, requestView, sentOn, toggleOption, waitingLine, writeOther, type PendingRequest, type PermissionResponse,
} from "../client/pending-requests";
import { wasSent, withSent } from "../shared/answered-requests";
import { sessionDetail } from "../client/model";
import contribute from "../index.server";

const ko = (korean: string) => korean;
const en = (_: string, english: string) => english;
const request = (value: Record<string, unknown>) => ({ id: "request-1", provider: "claude", name: "Tool", ...value }) as unknown as PendingRequest;
const claudeQuestion = (value: Record<string, unknown> = {}) => request({ kind: "question", name: "AskUserQuestion", ...value });
const claudePlan = (value: Record<string, unknown> = {}) => request({ kind: "plan", name: "ExitPlanMode", ...value });

test("the plugin registers a host response record that starts empty and rejects malformed entries", () => {
  const registered = new Map<string, { scope: string; schema: { parse(value: unknown): unknown; safeParse(value: unknown): { success: boolean } } }>();
  contribute({
    handle() {}, addHook: () => () => {},
    registerSettings(definition: typeof import("../shared/answered-requests").answeredRequests) { registered.set(definition.id, definition); },
  } as never);
  const record = registered.get("answered-requests");
  expect(record?.scope).toBe("host");
  expect(record?.schema.parse({})).toEqual({ sent: [] });
  expect(record?.schema.safeParse({ sent: [{ request: "" }] }).success).toBe(false);
  const sent = [{ session: "worker-1", request: "request-1", at: 123 }];
  expect(record?.schema.parse({ sent })).toEqual({ sent });
});

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
  expect(requestView(claudeQuestion({ input: { prompt: "Which one?" } }))).toEqual({ mode: "session" });
  expect(requestView(claudeQuestion({ input: claudeInput }))).toMatchObject({ mode: "question" });
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

test("a masked answer is sent to the session and never kept on the board", () => {
  const input = { questions: [
    { id: "0", header: "Token", question: "Paste the sample token.", options: [], isOther: true, isSecret: true },
    { id: "1", header: "Region", question: "Which region?", options: [{ label: "East" }, { label: "West" }], isOther: true },
  ] };
  const pending = request({ kind: "question", provider: "codex", name: "request_user_input", input });
  const view = requestView(pending);
  if (view.mode !== "question") throw Error("question expected");
  expect(view.questions.map(q => q.masked)).toEqual([true, false]);
  let draft = writeOther(view.questions, emptyDraft(view.questions), 0, "sample-value-123");
  draft = toggleOption(view.questions, draft, 1, 1);
  expect(answerResponse(pending, view.questions, draft)).toMatchObject({ updatedInput: { answers: { Token: "sample-value-123", Region: "West" } } });
  expect(answerSummary(view.questions, draft)).toBe("•••• · West");
  expect(answerSummary(view.questions, draft)).not.toContain("sample-value-123");
  const plain = parseQuestions(claudeInput)!;
  expect(plain.every(q => !q.masked)).toBe(true);
  expect(answerSummary(plain, toggleOption(plain, toggleOption(plain, emptyDraft(plain), 0, 0), 1, 1))).toBe("SQLite · Migrations");
});

test("closing a question denies it, and a question that accepts an empty answer is answered empty", () => {
  const questions = parseQuestions(claudeInput)!;
  const pending = request({ kind: "question", input: claudeInput });
  expect(dismissResponse(pending, questions)).toEqual({ behavior: "deny", message: "Dismissed by user" });
  const input = { questions: [{ header: "Note", question: "Anything to add?", options: [], allowEmpty: true }, { header: "More", question: "Anything else?", options: [], allowEmpty: true }] };
  const optional = parseQuestions(input)!;
  expect(dismissResponse(request({ kind: "question", input }), optional))
    .toEqual({ behavior: "allow", updatedInput: { ...input, answers: { Note: "", More: "" } } });
  // Closing does not answer: text left in the input is never part of what is sent.
  const typing = writeOther(optional, emptyDraft(optional), 0, "a half-written note");
  expect(JSON.stringify(dismissResponse(request({ kind: "question", input }), optional))).not.toContain("half-written");
  expect(answerResponse(request({ kind: "question", input }), optional, typing)).toMatchObject({ updatedInput: { answers: { Note: "a half-written note", More: "" } } });
});

test("a plan request shows its text, offers only rejecting and implementing, and each sends its own choice", () => {
  const actions = [
    { id: "reject", label: "Reject", behavior: "deny", variant: "danger", intent: "dismiss" },
    { id: "implement", label: "Implement", behavior: "allow", variant: "primary", intent: "implement" },
  ];
  const offered = [
    { id: "reject", label: "Reject", behavior: "deny", intent: "dismiss", danger: true },
    { id: "implement", label: "Implement", behavior: "allow", intent: "implement", danger: false },
  ];
  const view = requestView(claudePlan({ input: { plan: "1. Add the table" }, actions }));
  expect(view).toEqual({ mode: "plan", plan: "1. Add the table", actions: offered, more: false });
  expect(requestView(claudePlan({ metadata: { planText: "From metadata" }, input: { plan: "From input" }, actions })))
    .toMatchObject({ mode: "plan", plan: "From metadata" });
  expect(requestView(request({ kind: "plan", provider: "codex", name: "CodexPlanApproval", input: { plan: "A plan" }, actions })))
    .toMatchObject({ mode: "plan", actions: offered });
  if (view.mode !== "plan") throw Error("plan expected");
  expect(view.actions.map(actionResponse)).toEqual([
    { behavior: "deny", selectedActionId: "reject", message: "Denied by user" },
    { behavior: "allow", selectedActionId: "implement" },
  ]);
  // The button says what approving changes in that provider.
  expect(view.actions.map(action => actionLabel(action, "claude", ko))).toEqual(
    ["계획 거절 · 구현하지 않음", "계획 승인 · 편집 자동 허용으로 전환해 구현 시작"]);
  expect(view.actions.map(action => actionLabel(action, "claude", en))).toEqual(
    ["Reject plan · Do not implement", "Approve plan · Switch to auto-accept edits and implement"]);
  expect(actionLabel(view.actions[1], "codex", ko)).toBe("계획 승인 · 계획 모드를 끄고 구현 시작");
  expect(actionLabel(view.actions[1], "codex", en)).toBe("Approve plan · Leave plan mode and implement");
});

test("a plan choice that changes the permission mode, or one the board does not know, is left to the work session", () => {
  const reject = { id: "reject", label: "Reject", behavior: "deny", variant: "danger", intent: "dismiss" };
  const implement = { id: "implement", label: "Implement", behavior: "allow", intent: "implement" };
  for (const extra of [
    { id: "implement_resume", label: "Implement with Bypass", behavior: "allow", intent: "implement_resume" },
    { id: "later", label: "Ask again later", behavior: "deny" },
    { id: "go", label: "Go", behavior: "allow" },
    { id: "implement_again", label: "Implement", behavior: "allow", intent: "implement" },
    { id: "odd", label: "Implement", behavior: "deny", intent: "implement" },
  ]) {
    const view = requestView(claudePlan({ input: { plan: "A plan" }, actions: [reject, implement, extra] }));
    expect(view).toMatchObject({ mode: "plan", more: true });
    if (view.mode !== "plan") throw Error("plan expected");
    expect(view.actions.map(action => action.id)).toEqual(["reject", "implement"]);
  }
  // Nothing the board may send: the whole request stays in the work session.
  expect(requestView(claudePlan({ input: { plan: "A plan" }, actions: [{ id: "implement_resume", label: "Implement with Auto", behavior: "allow", intent: "implement_resume" }] })))
    .toEqual({ mode: "session" });
});

test("only questions and plans from checked sources are answered on the board", () => {
  const yesNo = { questions: [{ header: "Confirm", question: "Delete the build folder?", options: [{ label: "Yes" }, { label: "No" }], multiSelect: false }] };
  const actions = [{ id: "implement", label: "Implement", behavior: "allow", intent: "implement" }];
  for (const [provider, name] of [["claude", "AskUserQuestion"], ["codex", "request_user_input"], ["codex", "request_user_input_async"], ["opencode", "question"]]) {
    expect(requestView(request({ kind: "question", provider, name, input: yesNo }))).toMatchObject({ mode: "question" });
    // A dialog raised through an extension is not a plain question, whatever it is named.
    expect(requestView(request({ kind: "question", provider, name, input: yesNo, metadata: { extensionUiMethod: "confirm" } }))).toEqual({ mode: "session" });
    expect(requestView(request({ kind: "question", provider, name, input: yesNo, metadata: { ompAsk: true } }))).toEqual({ mode: "session" });
  }
  for (const [provider, name] of [
    ["pi", "confirm"], ["pi", "ask_user"], ["omp", "ask"], ["omp", "select"], ["claude", "Bash"], ["codex", "AskUserQuestion"],
    ["opencode", "AskUserQuestion"], ["custom", "AskUserQuestion"], ["hasOwnProperty", "AskUserQuestion"], ["claude", "question"],
  ]) {
    expect(requestView(request({ kind: "question", provider, name, input: yesNo }))).toEqual({ mode: "session" });
    expect(requestView(request({ kind: "plan", provider, name, input: { plan: "A plan" }, actions }))).toEqual({ mode: "session" });
  }
  expect(requestView(request({ kind: "plan", provider: "codex", name: "ExitPlanMode", input: { plan: "A plan" }, actions }))).toEqual({ mode: "session" });
});

test("a plan without text or usable actions and every tool, mode or other request stays in the work session", () => {
  const actions = [{ id: "implement", label: "Implement", behavior: "allow", intent: "implement" }];
  for (const value of [
    { kind: "plan", name: "ExitPlanMode", input: { plan: "A plan" } },
    { kind: "plan", name: "ExitPlanMode", input: { plan: "A plan" }, actions: [] },
    { kind: "plan", name: "ExitPlanMode", input: { plan: "A plan" }, actions: [{ id: "", label: "Implement", behavior: "allow", intent: "implement" }] },
    { kind: "plan", name: "ExitPlanMode", input: { plan: "A plan" }, actions: [...actions, { id: "x", label: "Maybe", behavior: "ask" }] },
    { kind: "plan", name: "ExitPlanMode", input: { plan: "  " }, actions },
    { kind: "plan", name: "ExitPlanMode", input: {}, actions },
    { kind: "tool", name: "Bash", title: "Run command", input: { command: "npm run deploy" }, actions },
    { kind: "tool", name: "AskUserQuestion", input: claudeInput, actions },
    { kind: "mode", name: "ExitPlanMode", title: "Switch mode", input: { plan: "A plan" }, actions },
    { kind: "other", name: "AskUserQuestion", title: "Something else", input: claudeInput, actions },
  ]) expect(requestView(request(value))).toEqual({ mode: "session" });
  expect(requestView(claudePlan({ input: { plan: "A plan" }, actions }))).toMatchObject({ mode: "plan" });
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
  const sources = (folder: string): string[] => readdirSync(join(root, folder), { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sources(join(folder, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(folder, entry.name)] : []);
  const callers = [...sources("server"), ...sources("shared"), ...sources("client"), "index.server.ts", "index.client.tsx"]
    .filter(file => /respondToPermission\b/.test(readFileSync(join(root, file), "utf8")));
  expect(callers).toEqual([join("client", "pending-requests.ts")]);
});

test("a request another card, an earlier visit or another screen answered is checked, not sent again", async () => {
  const { state, port } = agent(["request-1", "request-2"]);
  state.clearOnSend = false;
  const recorded: string[] = [];
  const { respond } = createResponder(port, { ...quick, wasSent: id => recorded.includes(id), onSent: id => { recorded.push(id); } });
  expect(await respond("request-1", allow)).toBe("unconfirmed");
  expect(recorded).toEqual(["request-1"]);
  // A new card for the same session starts with no memory of its own and reads the shared record.
  const redrawn = createResponder(port, { ...quick, wasSent: id => recorded.includes(id) });
  expect(await redrawn.respond("request-1", allow)).toBe("unconfirmed");
  expect(state.sent).toHaveLength(1);
  state.pending = ["request-2"];
  expect(await redrawn.respond("request-1", allow)).toBe("sent");
  expect(state.sent).toHaveLength(1);
  // Nothing is recorded for a response that did not go out.
  state.failSend = true;
  expect(await respond("request-2", allow)).toBe("failed");
  expect(recorded).toEqual(["request-1"]);
  // A record that cannot be written does not turn a sent response into a failure.
  state.failSend = false; state.clearOnSend = true;
  const failing = createResponder(port, { ...quick, onSent: () => { throw Error("storage"); } });
  expect(await failing.respond("request-2", allow)).toBe("sent");
});

test("the record of sent requests keeps one entry per request, drops old ones and stays bounded", () => {
  const day = 24 * 60 * 60 * 1000, now = 100 * day;
  const stored = [{ session: "worker-1", request: "request-1", at: now - 20 * day }, { session: "worker-1", request: "request-2", at: now - day }];
  const next = withSent(stored, [{ session: "worker-2", request: "request-2", at: now }, { session: "worker-1", request: "request-2", at: now }], now);
  expect(next).toEqual([{ session: "worker-1", request: "request-2", at: now }, { session: "worker-2", request: "request-2", at: now }]);
  expect(wasSent(next, "worker-1", "request-2")).toBe(true);
  expect(wasSent(next, "worker-2", "request-1")).toBe(false);
  expect(wasSent(next, "worker-1", "request-1")).toBe(false);
  const many = Array.from({ length: 260 }, (_, index) => ({ session: "worker-1", request: "request-" + index, at: now - 260 + index }));
  const bounded = withSent(many, [], now);
  expect(bounded).toHaveLength(200);
  expect(bounded.at(-1)).toEqual(many.at(-1)!);
  // Records made in this app session are held per host until they are stored.
  noteSent("host-a", "worker-9", "request-9", now);
  noteSent("host-a", "worker-9", "request-9", now + 1);
  expect(sentOn("host-a").filter(entry => entry.session === "worker-9")).toEqual([{ session: "worker-9", request: "request-9", at: now + 1 }]);
  expect(sentOn("host-b")).toEqual([]);
});
