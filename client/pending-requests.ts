import type { getPaseoClient } from "@getpaseo/plugin/client";
import type { Translate } from "./language";
import type { SentRecord } from "../shared/answered-requests";

type AgentHandle = ReturnType<ReturnType<typeof getPaseoClient>["agents"]["ref"]>;
export type PendingRequest = NonNullable<AgentHandle["pendingPermissions"]>[number];
export type PermissionResponse = Parameters<AgentHandle["respondToPermission"]>[0]["response"];

export type QuestionOption = { label: string; description?: string; preview?: string };
export type Question = {
  question: string; header: string; options: QuestionOption[];
  multiSelect: boolean; allowOther: boolean; allowEmpty: boolean; masked: boolean; placeholder?: string;
};
// What the person chose and typed for each question. Choices keep the order they were pressed in.
export type Draft = { selected: number[][]; other: string[] };
export type PlanAction = { id: string; label: string; behavior: "allow" | "deny"; intent: "implement" | "dismiss"; danger: boolean };
// `more` marks a plan with further choices the board leaves to the work session.
export type RequestView =
  | { mode: "question"; questions: Question[] }
  | { mode: "plan"; plan: string; actions: PlanAction[]; more: boolean }
  | { mode: "session" };

// Paseo's own app sends these fixed values with a denial. The board sends the same ones, so a
// session reads a request closed on the board exactly as one closed in the app.
const dismissed = "Dismissed by user";
const denied = "Denied by user";

const record = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value : undefined;

// Reads the question form every Paseo provider puts in a question request. Answers go back keyed
// by header, so an input without distinct headers cannot be answered here and returns null.
export function parseQuestions(input: unknown): Question[] | null {
  const raw = record(input)?.questions;
  if (!Array.isArray(raw) || !raw.length) return null;
  const questions: Question[] = [];
  for (const item of raw) {
    const q = record(item);
    const header = text(q?.header), question = text(q?.question);
    if (!q || !header?.trim() || !question?.trim() || !Array.isArray(q.options)) return null;
    if (questions.some(prior => prior.header === header)) return null;
    const options: QuestionOption[] = [];
    for (const entry of q.options) {
      const option = record(entry);
      const label = text(option?.label);
      if (!option || !label) return null;
      options.push({ label, description: text(option.description), preview: text(option.preview) });
    }
    questions.push({
      question, header, options, multiSelect: q.multiSelect === true,
      allowOther: q.allowOther === true || q.isOther === true, allowEmpty: q.allowEmpty === true,
      // Codex marks a question whose answer must not be shown.
      masked: q.isSecret === true, placeholder: text(q.placeholder),
    });
  }
  return questions;
}

export function emptyDraft(questions: Question[]): Draft {
  return { selected: questions.map(() => []), other: questions.map(() => "") };
}

export function showsTextInput(question: Question) {
  return !question.options.length || question.allowOther;
}

function replace<T>(list: T[], index: number, value: T) {
  return list.map((entry, position) => position === index ? value : entry);
}

// One choice and a typed answer replace each other. Multiple choice keeps both.
export function toggleOption(questions: Question[], draft: Draft, index: number, option: number): Draft {
  const question = questions[index];
  if (!question?.options[option]) return draft;
  const current = draft.selected[index] ?? [];
  const chosen = current.includes(option);
  if (question.multiSelect) {
    return { ...draft, selected: replace(draft.selected, index, chosen ? current.filter(entry => entry !== option) : [...current, option]) };
  }
  return { selected: replace(draft.selected, index, chosen ? [] : [option]), other: replace(draft.other, index, "") };
}

export function writeOther(questions: Question[], draft: Draft, index: number, value: string): Draft {
  const question = questions[index];
  if (!question || !showsTextInput(question)) return draft;
  const other = replace(draft.other, index, value);
  return !question.multiSelect && value ? { selected: replace(draft.selected, index, []), other } : { ...draft, other };
}

function answered(question: Question, draft: Draft, index: number) {
  if (draft.selected[index]?.length) return true;
  return showsTextInput(question) && (!!draft.other[index]?.trim() || question.allowEmpty);
}

export function canSubmit(questions: Question[], draft: Draft) {
  return questions.every((question, index) => answered(question, draft, index));
}

// Only option labels and typed text go into an answer. The board adds no wording of its own.
export function buildAnswers(questions: Question[], draft: Draft) {
  const answers: Record<string, string> = {};
  questions.forEach((question, index) => {
    const labels = (draft.selected[index] ?? []).map(option => question.options[option].label);
    const typed = showsTextInput(question) ? draft.other[index]?.trim() : "";
    if (typed) answers[question.header] = question.multiSelect ? [...labels, typed].join(", ") : typed;
    else if (showsTextInput(question) && question.allowEmpty && !question.options.length) answers[question.header] = "";
    else if (labels.length) answers[question.header] = labels.join(", ");
  });
  return answers;
}

export function answerResponse(request: PendingRequest, questions: Question[], draft: Draft): PermissionResponse {
  return { behavior: "allow", updatedInput: { ...request.input, answers: buildAnswers(questions, draft) } };
}

// What the board keeps on screen about an answer. A masked answer is never shown again.
export function answerSummary(questions: Question[], draft: Draft) {
  const answers = buildAnswers(questions, draft);
  return questions.flatMap(question => !answers[question.header] ? [] : [question.masked ? "••••" : answers[question.header]]).join(" · ");
}

export function dismissResponse(request: PendingRequest, questions: Question[]): PermissionResponse {
  // A form made only of optional free answers is closed by answering it empty. Text the person
  // was typing is not sent: closing means not answering.
  if (questions.every(question => question.allowEmpty && !question.options.length)) return answerResponse(request, questions, emptyDraft(questions));
  return { behavior: "deny", message: dismissed };
}

export function actionResponse(action: PlanAction): PermissionResponse {
  return action.behavior === "allow" ? { behavior: "allow", selectedActionId: action.id }
    : { behavior: "deny", selectedActionId: action.id, message: denied };
}

// Requests whose form and effect were checked against Paseo's providers. A provider can use the
// question kind for other things, such as a yes or no dialog that approves a tool run, so a
// question or plan from any other source stays in the work session.
const questionSources: Record<string, readonly string[]> = {
  claude: ["AskUserQuestion"], codex: ["request_user_input", "request_user_input_async"], opencode: ["question"],
};
const planSources: Record<string, readonly string[]> = { claude: ["ExitPlanMode"], codex: ["CodexPlanApproval"] };
const known = (sources: Record<string, readonly string[]>, request: PendingRequest) =>
  Object.hasOwn(sources, request.provider) && sources[request.provider].includes(request.name);

// The board offers only rejecting a plan and implementing it. A choice that also changes the
// permission mode, or one it does not know, is left to the work session.
function planActions(actions: unknown) {
  if (!Array.isArray(actions) || !actions.length) return null;
  const offered: PlanAction[] = [];
  let more = false;
  for (const entry of actions) {
    const action = record(entry);
    const id = text(action?.id), label = text(action?.label), behavior = action?.behavior, intent = action?.intent;
    if (!id || !label || (behavior !== "allow" && behavior !== "deny")) return null;
    const usable = (intent === "implement" && behavior === "allow") || (intent === "dismiss" && behavior === "deny");
    if (!usable || offered.some(prior => prior.id === id || prior.intent === intent)) { more = true; continue; }
    offered.push({ id, label, behavior, intent, danger: action?.variant === "danger" });
  }
  return offered.length ? { actions: offered, more } : null;
}

// Decides what the board offers for a request. Anything it cannot read fully stays in the work session.
export function requestView(request: PendingRequest): RequestView {
  if (request.kind === "question") {
    if (!known(questionSources, request) || request.metadata?.extensionUiMethod !== undefined || request.metadata?.ompAsk !== undefined) return { mode: "session" };
    const questions = parseQuestions(request.input);
    return questions ? { mode: "question", questions } : { mode: "session" };
  }
  if (request.kind === "plan") {
    if (!known(planSources, request)) return { mode: "session" };
    const plan = text(request.metadata?.planText) || text(request.input?.plan) || "";
    const choices = planActions(request.actions);
    return plan.trim() && choices ? { mode: "plan", plan, ...choices } : { mode: "session" };
  }
  return { mode: "session" };
}

// Says in words what pressing a plan button does in that provider.
export function actionLabel(action: PlanAction, provider: string, t: Translate) {
  if (action.intent === "dismiss") return t("계획 거절 · 구현하지 않음", "Reject plan · Do not implement");
  return provider === "claude"
    ? t("계획 승인 · 편집 자동 허용으로 전환해 구현 시작", "Approve plan · Switch to auto-accept edits and implement")
    : t("계획 승인 · 계획 모드를 끄고 구현 시작", "Approve plan · Leave plan mode and implement");
}

// Names a request by its kind and title.
export function requestName(request: PendingRequest, t: Translate) {
  const kinds: Record<string, string> = {
    tool: t("도구 실행 승인", "Tool approval"), plan: t("계획 승인", "Plan approval"),
    question: t("질문", "Question"), mode: t("모드 변경", "Mode change"),
  };
  const kind = Object.hasOwn(kinds, request.kind) ? kinds[request.kind] : t("요청", "Request");
  // A plan or question without a title has only its tool name, which says nothing more than the kind.
  const named = request.kind === "plan" || request.kind === "question" ? request.title?.trim() : request.title?.trim() || request.name;
  return [kind, named].filter(Boolean).join(" · ");
}

// One line naming what a request is waiting for.
export function waitingLine(request: PendingRequest, t: Translate) {
  const detail = request.description?.replace(/\s+/g, " ").trim().slice(0, 200);
  return [requestName(request, t), detail].filter(Boolean).join(" · ");
}

// The responder lives in shared code so that the board has one place that answers a request.
export { createResponder, type Outcome } from "../shared/permission-responder";
import type { Outcome } from "../shared/permission-responder";

// What the card says after a response. `busy` is a second press and says nothing.
export function outcomeText(outcome: Outcome, t: Translate) {
  const words: Record<Outcome, string> = {
    sent: t("보냈습니다. 세션이 응답을 받았습니다.", "Sent. The session received the response."),
    handled: t("이미 처리된 요청입니다. 다른 화면에서 먼저 답했거나 세션이 요청을 거두었습니다.", "Already handled. It was answered elsewhere or the session withdrew it."),
    unconfirmed: t("보냈지만 세션이 받았는지 확인하지 못했습니다. 작업 세션에서 확인해 주세요.", "Sent, but the session has not confirmed it. Check the work session."),
    failed: t("보내지 못했습니다. 연결을 확인하고 다시 시도해 주세요.", "Could not send. Check the connection and try again."),
    busy: "",
  };
  return words[outcome];
}

// Requests answered in this app session, per host, until the stored record includes them.
const sentHere = new Map<string, { host: string; record: SentRecord }>();
export function noteSent(host: string, session: string, request: string, at: number) {
  sentHere.set(JSON.stringify([host, session, request]), { host, record: { session, request, at } });
}
export function sentOn(host: string): SentRecord[] {
  return [...sentHere.values()].filter(entry => entry.host === host).map(entry => entry.record);
}
