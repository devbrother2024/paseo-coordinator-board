import { createHash } from "node:crypto";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { ReplyEntry } from "../shared/reply-history";
import { coordinatorTool } from "./board-guide";
import { canReceiveBoardInput } from "./discovery";
import type { JudgeReason } from "./open-questions";
import type { Preferences, PreferenceStore } from "./preferences";

type Sdk = PluginHandlerContext["paseo"];
const sender = "plugin:coordinator-board";
export const judgeOpenQuestionName = "judge_open_question";
// A question the coordinator has not judged gets a new notice this long after the last attempt to tell it.
export const STILL_NOT_JUDGED_MS = 30 * 60 * 1000;
export const QUESTIONS_PER_NOTICE = 20;
// Handled needs evidence that names something: at least this many characters other than spaces.
export const MIN_EVIDENCE = 10;

export type JudgmentItem = { sessionId: string; questionKey: string; question: string; why: JudgeReason; askedAt?: string };
type Due = { item: JudgmentItem; again: boolean };

/**
 * The questions the coordinator has to judge and is due to hear about: never told (or told while another session was the
 * coordinator), or told at least 30 minutes ago and still not judged. Its own session's questions are left out.
 */
export function questionsToJudge(scope: Pick<Preferences, "coordinator" | "projects" | "raisedQuestions">, now = Date.now()): Due[] {
  const coordinator = scope.coordinator;
  if (!coordinator) return [];
  const due: Due[] = [];
  for (const [sessionId, saved] of Object.entries(scope.raisedQuestions ?? {})) {
    if (sessionId === coordinator || !scope.projects.includes(saved.projectId)) continue;
    for (const question of saved.questions) {
      if (!question.judge || question.verdict) continue;
      const told = question.notified === coordinator;
      if (told && question.notifiedAt && now - Date.parse(question.notifiedAt) < STILL_NOT_JUDGED_MS) continue;
      due.push({ again: told, item: { sessionId, questionKey: question.key, question: question.question.slice(0, 340), why: question.judge,
        ...(question.askedAt ? { askedAt: question.askedAt } : {}) } });
    }
  }
  return due;
}

/** The board's notice to the coordinator. Values only in the JSON lines; it carries the board's source and grants nothing. */
export function judgmentNotice(items: readonly JudgmentItem[], again = false) {
  return [
    again ? "[Coordinator Board · 아직 판단 안 됨 / Still not judged]" : "[Coordinator Board · 판단 필요 / Judgment needed]",
    ...items.map(item => JSON.stringify(item)),
    `각 질문이 처리됐는지 세션 기록에서 확인하고 board_action 의 ${judgeOpenQuestionName} 로 기록해 주세요. 처리됐으면 verdict "handled"와 근거(evidence: 어느 글, 어느 답, 어느 카드), 근거를 못 찾으면 "needed". 이 알림은 승인이 아닙니다.`,
    `Check each question in the session's record and record it with board_action ${judgeOpenQuestionName}: verdict "handled" with evidence (which message, reply or card), or "needed" when you find none. This notice is not an approval.`,
  ].join("\n");
}

function messageIdFor(coordinator: string, keys: readonly string[], at: string) {
  const h = createHash("sha256").update(JSON.stringify([sender, "judge-open-questions", coordinator, [...keys].sort(), at])).digest("hex");
  return [h.slice(0, 8), h.slice(8, 12), "4" + h.slice(13, 16), "8" + h.slice(17, 20), h.slice(20, 32)].join("-");
}

/**
 * Tells the coordinator which open questions to judge. Every attempt is recorded before the send, so a send that fails is
 * not sent again: the board does not retry a sourced send. A question still not judged 30 minutes after the last attempt
 * gets a new notice ("still not judged"), which is a new message rather than a retry. At most 20 questions per message.
 */
export class QuestionNotices {
  private running = false;
  constructor(private store: PreferenceStore) {}

  async deliver(sdk: Pick<Sdk, "agents">, now = Date.now()): Promise<"sent" | "waiting" | "nothing" | "unavailable"> {
    const scope = this.store.read();
    const coordinator = scope.coordinator;
    const due = questionsToJudge(scope, now);
    if (!coordinator || !due.length) return "nothing";
    if (this.running) return "waiting";
    this.running = true;
    try {
      const handle = sdk.agents.ref(coordinator);
      const agent = (await handle.refresh())?.agent;
      if (!agent || agent.id !== coordinator || agent.archivedAt || agent.internal || agent.status === "closed" || agent.status === "error") return "unavailable";
      // A coordinator waiting on a permission request would lose it to any message.
      if (!canReceiveBoardInput(agent, false)) return "waiting";
      if (this.store.read().coordinator !== coordinator) return "unavailable";
      const at = new Date(now).toISOString();
      for (const again of [false, true]) {
        const items = due.filter(entry => entry.again === again).map(entry => entry.item);
        for (let start = 0; start < items.length; start += QUESTIONS_PER_NOTICE) {
          const batch = items.slice(start, start + QUESTIONS_PER_NOTICE);
          const keys = new Set(batch.map(item => item.questionKey));
          // Recorded before the send: if the send fails, the next snapshot does not send it again.
          this.store.change(current => {
            for (const saved of Object.values(current.raisedQuestions)) {
              for (const question of saved.questions) if (keys.has(question.key)) { question.notified = coordinator; question.notifiedAt = at; }
            }
          });
          await handle.send(judgmentNotice(batch, again), { sourceAgentId: sender, messageId: messageIdFor(coordinator, [...keys], at), activeTurnBehavior: "steer" });
        }
      }
      return "sent";
    } finally { this.running = false; }
  }
}

const judgment = z.strictObject({
  sessionId: z.string().min(1).max(256),
  questionKey: z.string().min(1).max(64),
  verdict: z.enum(["handled", "needed"]),
  evidence: z.string().max(2000).optional(),
}).refine(input => input.verdict !== "handled" || (input.evidence ?? "").replace(/\s/g, "").length >= MIN_EVIDENCE, {
  path: ["evidence"],
  message: `handled 에는 근거가 필요합니다: 어느 글, 어느 답, 어느 카드인지 ${MIN_EVIDENCE}자 이상으로 적어 주세요. / `
    + `handled needs evidence of at least ${MIN_EVIDENCE} characters naming the message, reply or card.`,
});

const usage = [
  "보드가 [Coordinator Board · 판단 필요] 또는 [아직 판단 안 됨] 알림으로 보낸 열린 질문을 판단해 기록합니다. 그 세션 기록에서 질문 뒤를 읽고:",
  "- 사람의 답, 결정 반영 줄, 다른 세션의 처리, 원장 카드 해결이 있으면 verdict \"handled\", evidence 에 어느 글·답·카드인지 적습니다(공백 빼고 10자 이상).",
  "- 질문이 실제 결정 요청이 아니라 다른 카드의 안내나 상태 설명이면 \"handled\", evidence 에 같은 질문을 가진 카드를 적습니다.",
  "- 그 밖이거나 근거를 못 찾으면 \"needed\" 입니다. 카드는 사람에게 남습니다. 세션이 끝났어도 같은 기준입니다.",
  "Judge an open question the board listed in a [Coordinator Board · Judgment needed] or [Still not judged] notice. Read the session's record after the question:",
  "- If the person answered, the session wrote a decision-applied line, another session handled it, or a ledger card resolved it, use verdict \"handled\" with evidence naming the message, reply or card (at least 10 characters besides spaces).",
  "- If it is not a real request for a decision but guidance for another card or a status note, use \"handled\" with evidence naming the card that holds the question.",
  "- Otherwise, or when you find no evidence, use \"needed\". The card stays with the person. The same holds when the session ended.",
].join("\n");

const fail = (ko: string, en: string) => ({ isError: true, text: `${ko} / ${en}` });

/** board_action only: the coordinator records whether an open question was handled. */
export function judgeOpenQuestionTool(prefs: PreferenceStore, invalidate: () => void) {
  return coordinatorTool({
    name: judgeOpenQuestionName,
    description: "Record whether an open question the board raised from a session was handled (with evidence) or still needs the person.",
    usage,
    actionOnly: true,
    input: judgment,
    async execute({ sessionId, questionKey, verdict, evidence }, { agent }) {
      // Recording handled again for a question the coordinator already closed is fine.
      const already = (scope: Preferences) => verdict === "handled" && scope.closedQuestions[questionKey]?.reason === "coordinator" &&
        scope.closedQuestions[questionKey]?.sessionId === sessionId;
      const check = (scope: Preferences) => {
        if (!scope.coordinator || scope.coordinator !== agent.id) return fail("지금 코디네이터만 판단을 기록할 수 있습니다.", "Only the current coordinator can record a judgment.");
        if (already(scope)) return null;
        const saved = scope.raisedQuestions[sessionId];
        if (!saved || !scope.projects.includes(saved.projectId) || !saved.questions.some(question => question.key === questionKey)) {
          return fail("그 세션에 이 열린 질문이 없습니다. 이미 닫혔거나 key 가 다릅니다.", "That session has no such open question. It was closed already, or the key differs.");
        }
        return null;
      };
      const problem = check(prefs.read());
      if (problem) return problem;
      if (already(prefs.read())) return { text: "이미 처리됨으로 기록돼 있습니다. / Already recorded as handled." };
      let refused: ReturnType<typeof fail> | null = null;
      const at = new Date().toISOString();
      const note = evidence?.trim();
      prefs.change(scope => {
        refused = check(scope);
        if (refused || already(scope)) return;
        const saved = scope.raisedQuestions[sessionId];
        const question = saved.questions.find(item => item.key === questionKey)!;
        if (verdict === "handled") {
          scope.closedQuestions[questionKey] = { sessionId, at, reason: "coordinator", epoch: question.epoch, seq: question.seq, evidence: note!,
            by: agent.id, question: question.question.slice(0, 340), projectId: saved.projectId };
          saved.questions = saved.questions.filter(item => item.key !== questionKey);
          if (!saved.questions.length) delete scope.raisedQuestions[sessionId];
        } else {
          question.verdict = { kind: "needed", ...(note ? { evidence: note } : {}), at, by: agent.id };
          delete question.judge;
        }
      });
      if (refused) return refused;
      invalidate();
      return verdict === "handled"
        ? { text: "처리됨으로 기록했습니다. 카드가 닫히고 최근 결정 기록에 근거가 남습니다. / Recorded as handled. The card closes and its evidence shows in recent decisions." }
        : { text: "처리 필요로 기록했습니다. 카드는 사람에게 남습니다. / Recorded as needing the person. The card stays." };
    },
  });
}

/** Questions the coordinator closed as handled, for recent decisions in the selected projects. */
export function coordinatorClosures(scope: Pick<Preferences, "closedQuestions">, selected: ReadonlySet<string>): ReplyEntry[] {
  return Object.entries(scope.closedQuestions ?? {}).flatMap(([key, entry]) => entry.reason === "coordinator" && entry.projectId && selected.has(entry.projectId)
    ? [{ key: "question:" + key, title: entry.question ?? "", projectId: entry.projectId, at: entry.at, status: "closed" as const,
      ...(entry.by ? { reviewedBy: entry.by } : {}), ...(entry.evidence ? { reviewReason: entry.evidence } : {}) }]
    : []);
}
