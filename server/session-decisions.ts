import { createHash } from "node:crypto";
import { sourceQuestion } from "../shared/clarifications";
import type { Note, SessionRow } from "../shared/contract";
import type { Decision } from "../shared/decision-actions";
import { conversationQuestionDetails, type Evidence } from "./conversation";
import type { Preferences } from "./preferences";

export function decorateDecision(row: SessionRow, note: Note | undefined, prefs: Preferences, evidence?: Evidence) {
  const answer = prefs.answers[row.id];
  const noteQuestion = note?.kind === "question";
  const answeredNote = noteQuestion && answer?.noteRevision === note.revision;
  const dismissed = row.evidenceId && row.evidenceId === note?.evidenceId && note.origin === "person" && note.kind !== "question";
  let content: Omit<Decision, "version">;
  if (row.nativePending) {
    content = { source: "permission", question: row.detail };
  } else if (row.status === "idle" && row.evidenceId && !dismissed && row.lane === "human") {
    const judgment = prefs.judgments[row.id];
    const structured = judgment?.kind === "question" && judgment.evidenceId === row.evidenceId && judgment.projectId === row.projectId;
    content = structured
      ? { ...judgment.content, source: "coordinator", question: judgment.content?.question || judgment.text }
      : { source: "conversation", question: row.detail.replace(/^세션의 확인 요청 · /, "") };
  } else if (noteQuestion && !answeredNote && row.status === "idle" && row.evidenceId) {
    content = { source: note.origin === "agent" ? "agent-note" : "person-note", question: note.text };
  } else {
    if (answeredNote && !row.nativePending) row.decisionAnswered = true;
    return;
  }
  const version = createHash("sha256").update(JSON.stringify([
    row.projectId, row.id, row.nativePending ? row.permissionVersion : row.evidenceId, note?.revision ?? 0, content,
  ])).digest("hex");
  if (content.source !== "permission" && answer?.version === version) {
    row.decisionAnswered = true;
    row.lane = "review";
    row.detail = "답장을 보냈습니다. 작업 세션의 결과를 기다립니다.";
  } else {
    row.decision = { ...content, version };
    if (content.source === "conversation" && evidence) {
      const excerpt = conversationQuestionDetails(evidence, row.id === prefs.coordinator);
      // Display-only fields stay out of the version, so new context never reopens an answered card.
      if (excerpt?.question === content.question) {
        if (excerpt.markdown !== content.question) row.decision.questionMarkdown = excerpt.markdown;
        if (excerpt.context) row.decision.contextMarkdown = excerpt.context;
        if (excerpt.choices.length) row.decision.choices = excerpt.choices;
        if (excerpt.missingLabels.length) row.decision.missingLabels = excerpt.missingLabels;
      }
    }
  }
}

// The original answer buttons still refer to the original revision. Keep them
// only while this exact clarification is the latest input in its source session.
export function restoreClarifiedDecision(
  row: SessionRow,
  note: Note | undefined,
  prefs: Preferences,
  evidence?: Evidence,
) {
  if (
    row.nativePending ||
    row.status === "closed" ||
    row.status === "error" ||
    row.decisionAnswered ||
    !evidence ||
    evidence.laterInput
  )
    return;
  for (const id of evidence.lastInputIds ?? []) {
    const record = prefs.clarifications?.[id];
    const original = record && sourceQuestion(record.card);
    if (
      !record?.savedDecision ||
      !original ||
      original.projectId !== row.projectId ||
      original.sessionId !== row.id ||
      original.version !== record.savedDecision.version ||
      record.recipientId !== row.id ||
      prefs.answers[row.id]?.version === original.version ||
      (note?.revision ?? 0) !== record.noteRevision
    )
      continue;
    // Digest judgments classify the explanation turn. Its original decision stays
    // open until an answer, a new input, or a note revision supersedes it.
    row.decision = record.savedDecision;
    row.decisionRequestedAt = record.sourceRequestedAt;
    if (record.sourceEvidenceId) row.evidenceId = record.sourceEvidenceId;
    row.lane = "human";
    row.detail = record.savedDecision.question;
    return;
  }
}

export function pendingDecisionSessions(scope: Preferences) {
  const sessions = new Set<string>();
  for (const reply of Object.values(scope.decisionReceipts)) {
    if (reply.status !== "pending") continue;
    sessions.add(reply.sessionId);
    if (reply.activity?.recipientId) sessions.add(reply.activity.recipientId);
  }
  for (const clarification of Object.values(scope.clarifications)) {
    if (clarification.status !== "pending") continue;
    sessions.add(clarification.recipientId);
    const source = clarification.sourceSessionId ?? sourceQuestion(clarification.card)?.sessionId;
    if (source) sessions.add(source);
  }
  return sessions;
}
