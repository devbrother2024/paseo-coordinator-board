import { QueuedAnswer } from "./queued-answer";
import { useDecisionInteraction } from "./decision-editing";
import { DecisionReplyInput } from "./decision-reply";
import { SendButton } from "./send-input";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { AccessibilityInfo, Platform, Pressable, Text, View } from "react-native";
import {
  cancelQueuedReply, resolveTrackedDecision, mentionsSecurityGate, trackedAnswerLead, trackedAnswerText, trackedPullTarget, trackedReplyExample, usesSourceCoordinator,
  type TrackedDecision, type TrackedReplyBlock, type TrackedReplyReason, type TrackedReplyRoute,
} from "../shared/tracked-decisions";
import { Button, CardHeader, type Theme } from "./controls";
import { HistoryMarkdown } from "./history-markdown";
import { TrackedPullStatus } from "./pull-requests";
import { useBoardLanguage } from "./language";
import { ledgerHistoryUnavailableText } from "./ledger-diagnostics";
import { PhotoComposer, usePhotoDraft } from "./photo-composer";
import {
  closedRevision, nextFailureStreak, optionId, recommendedChoices, redirectAwaitsCheck, trackedBasisRecipient, trackedDraftLayout,
  trackedRecovery, trackedReplyBasis, trackedRetryFingerprint, type FailureStreak,
} from "./tracked-reply-draft";
import {
  advancesOnChoice, answerSummary, applyPicks, chooseAnswer, emptyAnswers, photoPlacement, skipQuestion, startWriting, stepAfterAnswer, typeAnswer,
  type AnswerDrafts, clampStep, foldsAsk, nextOpenStep, openingStep, recommendAllPicks, trackedChipSide,
  recordHeaderParts, stepText, trackedReplyOffer, trackedSuggestion, usesSteps, visibleSteps, type Step,
} from "./card-steps";
import { ledgerChoiceGaps } from "../shared/choice-gaps";
import { cardChoiceNotice } from "./choice-display";

import { TrackedSessionChips, type TrackedSessionLinks } from "./tracked-session-chips";

type Resolution = ReturnType<typeof resolveTrackedDecision.output.parse>["status"];
// The board only sends. Closing a record without a reply is left to the session that takes it.
type ResolutionMode = "send" | "fallback";
// `requested` is the revision the board was asked to answer; `revision` is an earlier one it confirmed instead.
export type TrackedOutcome = {
  status: Resolution; reason?: TrackedReplyReason; requested?: string; revision?: string; mode?: ResolutionMode; answer?: string; recipientId?: string;
};
// `fingerprint` is the revision on screen at the attempt.
type Outcome = TrackedOutcome & { fingerprint: string };
type Props = {
  item: TrackedDecision; theme: Theme; route?: TrackedReplyRoute; blockedNote?: string; links: TrackedSessionLinks; children?: ReactNode; pull?: ReactNode;
  // "ask" is the question box beside the reply; "history" is the earlier questions and answers inside the evidence.
  renderClarification?: (onDraftChange:((active:boolean) => void) | undefined, part: "ask" | "history") => ReactNode;
  // The digest row keeps an unsent reply as a receipt after the card leaves the list.
  keepsUnsent?: boolean;
  onResolved: (outcome: TrackedOutcome) => Promise<void> | void;
};
const messages = {
  sent: ["답을 전송하고 기록을 닫았습니다.", "Reply sent and record closed."],
  queued: ["자동 전송 대기 중", "Queued for automatic delivery"],
  busy: ["받는 세션이 작업 중이거나 권한 확인을 기다립니다. 대기 상태가 되면 보낼 수 있습니다.", "The recipient is busy or waiting for permission. Send when it is idle."],
  unconfirmed: ["전송 결과를 아직 확인할 수 없습니다. 같은 답으로 다시 누르면 수신 내역을 확인합니다.", "Delivery is unconfirmed. Retry the same answer to check the recipient’s history."],
  closed: ["결정 기록을 닫았습니다.", "Decision record closed."],
  "already-closed": ["이미 닫힌 결정 기록입니다.", "This decision record was already closed."],
  changed: ["기록 내용이 바뀌었습니다. 새로 고친 내용을 확인해 주세요.", "The record changed. Review its latest details."],
  "out-of-scope": ["현재 보드의 관리 대상에서 제외된 기록입니다.", "This record is outside the board’s current scope."],
  unavailable: ["기록 상태를 확인할 수 없습니다. 보드를 새로 고쳐 주세요.", "Could not confirm the record’s status. Refresh the board."],
} as const;
const reasons: Record<TrackedReplyReason, readonly [string, string]> = {
  removed: ["이 카드는 원장에서 내려갔습니다. 이미 처리됐을 수 있으니 보드를 새로 고쳐 확인해 주세요.", "This card left the ledger. It may already be handled; refresh to check."],
  revised: ["카드 내용이 바뀌었습니다. 입력한 답은 그대로 두었습니다.", "The card changed. Your reply is kept."],
  conflict: ["이 카드에는 이미 다른 답이 기록됐거나 전송 확인 중입니다. 최근 결정 기록을 확인해 주세요.", "A different reply is already recorded or awaiting confirmation for this card. Check recent decision activity."],
  "earlier-unconfirmed": ["앞서 보낸 답이 아직 확인되지 않아 보내지 않았습니다. 그 답이 확인되거나 10분이 지나면 보낼 수 있습니다. 입력한 답은 그대로 두었습니다.", "An earlier reply to this card is not confirmed yet, so this one was not sent. You can send it once that reply is confirmed or 10 minutes have passed. Your reply is kept."],
  "owner-changed": ["운영 코디네이터가 바뀌었습니다. 새 운영 코디네이터를 확인한 뒤 보내 주세요.", "The ledger owner changed. Confirm the new owner before sending."],
  "recipient-changed": ["받는 곳이 바뀌었습니다. 최신 카드에서 받는 곳을 확인한 뒤 다시 보내 주세요.", "The recipient changed. Check it on the latest card and send again."],
  "recipient-closed": ["받는 세션이 종료되어 보내지 못했습니다.", "The recipient session has ended, so the reply was not sent."],
  "recipient-error": ["받는 세션이 오류 상태라 보내지 못했습니다.", "The recipient session is in an error state, so the reply was not sent."],
  "recipient-missing": ["받는 세션을 이 호스트에서 찾지 못해 보내지 못했습니다.", "The recipient session was not found on this host, so the reply was not sent."],
  "recipient-unchecked": ["받는 세션이 이 카드의 프로젝트와 같은 폴더인지 지금 확인하지 못해 보내지 않았습니다. 잠시 뒤 다시 보내 주세요.", "Could not check just now whether the recipient session opens this card's project folder, so the reply was not sent. Try again in a moment."],
  "queue-stopped": ["자동 전송이 중단됐습니다. 카드와 받는 세션을 확인해 주세요.", "Automatic delivery stopped. Check the card and its recipient."],
};
const blocks: Record<TrackedReplyBlock, readonly [string, string]> = {
  closed: ["작업 세션이 종료되어 원래 세션에는 보낼 수 없습니다.", "The work session has ended, so the reply cannot go to it."],
  error: ["작업 세션이 오류 상태라 원래 세션에는 보낼 수 없습니다.", "The work session is in an error state, so the reply cannot go to it."],
  missing: ["작업 세션을 이 호스트에서 찾지 못해 원래 세션에는 보낼 수 없습니다.", "The work session was not found on this host."],
  "other-project": ["작업 세션이 이 카드와 다른 프로젝트에 있어 바로 보낼 수 없습니다. 설정 → 다른 프로젝트의 세션 하나 연결에서 카드의 프로젝트로 연결하면 바로 보낼 수 있습니다.", "The work session belongs to another project. Use Settings → Link a session from another project to link it to this card’s project and reply directly."],
  "other-host": ["작업 세션이 다른 호스트에 있어 이 보드에서 보낼 수 없습니다.", "The work session is on another host and cannot receive replies from this board."],
  "no-session": ["카드에 작업 세션이 적혀 있지 않습니다.", "The card does not name a work session."],
  "owner-unverified": ["이 호스트에서 원장의 운영 코디네이터를 확인할 수 없습니다.", "The ledger owner could not be verified on this host."],
  "no-coordinator": ["보드 코디네이터가 지정되지 않았습니다.", "No board coordinator is assigned."],
};
const recipientBlocks: Partial<Record<TrackedReplyReason, TrackedReplyBlock>> = {
  "recipient-closed": "closed", "recipient-error": "error", "recipient-missing": "missing",
};
const wrap = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };

function Lines({ title, lines, theme, pullRepository }: { title: string; lines: readonly string[]; theme: Theme; pullRepository?: string }) {
  if (!lines.length) return null;
  return <View style={{ gap: 3 }}>
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{title}</Text>
    {lines.map((line, index) => <HistoryMarkdown key={index} theme={theme} source={line} pullRepository={pullRepository} />)}
  </View>;
}

// A small underlined text button for things the card keeps out of the way.
function TextButton({ label, accessibilityLabel, onPress, theme, expanded, disabled }: {
  label: string; accessibilityLabel: string; onPress: () => void; theme: Theme; expanded?: boolean; disabled?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} accessibilityState={{ expanded, disabled }} aria-expanded={expanded}
    disabled={disabled} onPress={onPress} style={{ alignSelf: "flex-start", paddingVertical: 4 }}>
    <Text style={{ color: theme.colors.foregroundMuted, textDecorationLine: "underline", fontSize: 12, opacity: disabled ? 0.6 : 1 }}>{label}</Text>
  </Pressable>;
}

// Moves screen reader and keyboard focus to a new question. On the apps the screen reader is told after the new
// question has laid out, since focus sent to a view that is still mounting is dropped.
function focusNode(node: View | null) {
  if (!node) return;
  if (Platform.OS === "web") { (node as unknown as { focus?: () => void }).focus?.(); return; }
  setTimeout(() => AccessibilityInfo.sendAccessibilityEvent(node, "focus"), 60);
}

// Keyed by card, not revision, so a display-only update keeps the draft, photos, current question and focus.
export function TrackedDecisionCard({ item, theme, links, route, blockedNote, onResolved, children, pull, renderClarification, keepsUnsent }: Props) {
  const { t } = useBoardLanguage();
  const resolve = useRpc(resolveTrackedDecision);
  const cancel = useRpc(cancelQueuedReply);
  const queue = item.queuedReply;
  const canReply = !item.historyUnavailable;
  const [expanded, setExpanded] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const [confirmedOwner, setConfirmedOwner] = useState(item.sourceCoordinatorId);
  // One draft for every question, changed only through the helpers in card-steps.ts.
  const [answers, setAnswers] = useState<AnswerDrafts>(emptyAnswers);
  const { selected, typed, skipped, writing } = answers;
  const [editedReply, setEditedReply] = useState<string | null>(null);
  const [more, setMore] = useState<Record<number, boolean>>({});
  // A card with several questions opens on its first question. There is no Answer button to press first.
  const [rawStep, setStep] = useState<Step>(() => openingStep(item.questions, [], canReply) ?? 0);
  // Counts the person's moves between questions, so focus follows even when the question number stays the same.
  const [moves, setMoves] = useState(0);
  const questionHead = useRef<View>(null);
  const [leadRemoved, setLeadRemoved] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [streak, setStreak] = useState<FailureStreak>(null);
  const result = outcome?.status ?? null;
  useEffect(()=>{
    if (queue && result==="queued") setOutcome(null);
  },[queue,result]);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasQuestionDraft, setHasQuestionDraft] = useState(false);
  const attachments = usePhotoDraft();
  const pending = useRef(false);
  const c = theme.colors;
  const isMerge = item.kind === "merge";
  const target = isMerge ? trackedPullTarget(item) : item.pullTarget;
  const pullRepository = item.pullRepository ?? item.pullTarget?.repo ?? item.mergeTarget?.repo;
  const headline = isMerge ? undefined : item.ask[0];
  const securityGate = mentionsSecurityGate(item);
  const choiceNotice = isMerge ? null : cardChoiceNotice(ledgerChoiceGaps(item));
  const articleChoice = item.questions.length === 1 && /(?:글|블로그|blog|article)/i.test(item.questions[0].text);
  const followupTitle = articleChoice ? t("글 작성 선택", "Article writing choice") : t("후속 질문", "Follow-up questions");
  const source = item.projectTitle || item.projectId;
  const named = (label: string) => ({ label, accessibilityLabel: item.title + " · " + label });
  const recordActions = !item.matchedSessionId || !!item.questions.length;
  // A receipt belongs to the revision it answered, so a newer revision of the same card opens again.
  const isClosed = closedRevision(outcome) === item.fingerprint;
  const { needsRefresh, awaitingRevision, stuck } = trackedRecovery(outcome, item.fingerprint, streak);
  const example = trackedReplyExample(item);
  const template = /<[^>]+>/.test(example);
  const suggestion = trackedSuggestion(item, t("확인했어요", "I checked this"));
  const freeReply = editedReply ?? "";
  const { freeEditor, carried, orphaned } = trackedDraftLayout(item, freeReply, attachments.photos);
  const questionText = item.questions.map((question, index) => typed[index] ?? question.options
    .filter(option => selected[index]?.includes(optionId(option)))
    .map(option => option.key + " · " + option.text).join(", "));
  const photoCount = (index: number) => attachments.photos.filter(photo => photo.questionIndex === index).length;
  const replies = questionText.map((value, index) => {
    if (skipped[index]) return "";
    const text = value.trim();
    const positions = attachments.photos.flatMap((photo, position) => photo.questionIndex === index ? [position + 1] : []);
    return [text, positions.length ? t("첨부 사진 ", "Attached photos ") + positions.join(", ") : ""].filter(Boolean).join(" · ");
  });
  const answered = replies.map((value, index) => !!value || !!skipped[index]);
  const outstanding = answered.some(done => !done);
  const hasPhotos = attachments.photos.length > 0;
  const lead = trackedAnswerLead(item, replies, freeReply, hasPhotos);
  const answer = trackedAnswerText(item, replies, freeReply, leadRemoved ? "" : lead);
  const followupOnly = isMerge && item.questions.length > 0;
  const owned = usesSourceCoordinator(item);
  const coordinatorCard = item.where === "manager" || item.where === "human";
  const recipientId = route?.recipientId ?? null;
  const fallbackId = route?.fallbackId ?? null;
  const redirected = redirectAwaitsCheck(outcome, fallbackId);
  const blocked = route?.blocked;
  const ownerChanged = item.sourceCoordinatorId !== confirmedOwner;
  const changedOwner = owned && ownerChanged;
  const fallbackOwnerChanged = item.sourceCoordinatorId !== undefined && ownerChanged;
  const fallbackName = item.sourceCoordinatorId !== undefined ? t("운영 코디네이터", "ledger owner") : t("코디네이터", "coordinator");
  const sendLabel = owned
    ? followupOnly ? t("운영 코디네이터에 후속 답장 보내기", "Send follow-up reply to ledger owner") : t("운영 코디네이터에 답장 보내기", "Send reply to ledger owner")
    : item.where === "session"
    ? followupOnly ? t("작업 세션에 후속 답장 보내기", "Send follow-up reply to work session") : t("작업 세션에 답장 보내기", "Send reply to work session")
    : followupOnly ? t("코디네이터에 후속 답장 보내기", "Send follow-up reply to coordinator") : t("코디네이터에 답장 보내기", "Send reply to coordinator");
  const hasAnswer = Boolean(answer || hasPhotos);
  const tooLong = answer.length > 4000;
  const hasDraft = hasQuestionDraft || hasPhotos || !!editedReply?.trim() || questionText.some(value => !!value.trim());
  const hasAnswerDraft = hasPhotos || !!editedReply?.trim() || questionText.some(value => !!value.trim()) || Object.values(skipped).some(Boolean);
  const basis = trackedReplyBasis(item, trackedBasisRecipient(item, route, redirected));
  const [confirmedBasis, setConfirmedBasis] = useState(basis);
  useEffect(() => { if (!hasAnswerDraft) setConfirmedBasis(basis); }, [hasAnswerDraft, basis]);
  const basisChanged = hasAnswerDraft && basis !== confirmedBasis;
  const answerDisabled = busy || attachments.blocked || !hasAnswer || outstanding || tooLong || basisChanged || awaitingRevision || orphaned.length > 0;
  const sendReply = { disabled: !canReply || !recipientId || redirected || !recordActions || answerDisabled || changedOwner || !!blockedNote, onPress: () => void acknowledge("send") };
  const offer = trackedReplyOffer(route, redirected, hasAnswerDraft || hasQuestionDraft);
  const offersFallback = offer.fallback;
  const unreachable = !offer.form;
  const stepped = usesSteps(item.questions, canReply);
  const step = clampStep(rawStep, item.questions.length);
  const stepping = stepped && step !== "summary";
  const inputFocus = useDecisionInteraction(canReply && !queue && !isClosed && !needsRefresh &&
    (hasDraft || editedReply !== null || Object.values(typed).some(value => value !== undefined) ||
      attachments.blocked || busy || Object.values(skipped).some(Boolean)));
  const picks = recommendedChoices(item, index => answered[index]);
  const allPicks = stepped ? recommendAllPicks(item.questions, answered) : null;
  const askLines = isMerge ? [] : item.ask.filter(line => line !== item.title);
  const askFolds = foldsAsk(askLines);
  const steps = visibleSteps(item.steps, stepsOpen);
  const otherSide = trackedChipSide(item.where, route, { owner: !!links.owner, source: links.source?.kind });
  // The evidence keeps the session links the header does not show, including one that can no longer take replies.
  const evidenceSide = otherSide === "owner" ? "source" : otherSide === "source" ? "owner" : undefined;
  const evidenceLinks = !!(evidenceSide ? (evidenceSide === "owner" ? links.owner : links.source) : links.owner || links.source);

  useEffect(() => { if (moves) focusNode(questionHead.current); }, [moves]);

  function go(next: Step) { setStep(next); setMoves(count => count + 1); }
  function moveAfter(index: number, action: "choose" | "skip" | "unskip") {
    const next = stepAfterAnswer(stepped, item.questions[index], answered, index, action);
    if (next !== null) go(next);
  }
  function choose(index: number, choice: number, multi: boolean) {
    const id = optionId(item.questions[index].options[choice]);
    setAnswers(draft => chooseAnswer(draft, index, id, multi));
    moveAfter(index, "choose");
  }
  function skip(index: number) {
    const skipping = !skipped[index];
    setAnswers(draft => skipQuestion(draft, index));
    moveAfter(index, skipping ? "skip" : "unskip");
  }
  function chooseRecommended(fill: Record<number, string[]>, toSummary: boolean) {
    setAnswers(draft => applyPicks(draft, fill));
    if (toSummary) go("summary");
  }
  function clearDraft() {
    attachments.clear(); setEditedReply(null); setAnswers(emptyAnswers); setMore({}); setLeadRemoved(false);
    setStep(openingStep(item.questions, [], canReply) ?? 0);
  }
  async function refreshRecord() {
    if (pending.current || !outcome) return;
    pending.current = true; setBusy(true);
    try { await onResolved({ status: outcome.status, reason: outcome.reason }); setRefreshFailed(false); setOutcome(null); }
    catch { setRefreshFailed(true); }
    finally { pending.current = false; setBusy(false); }
  }
  async function cancelWaiting() {
    if (!queue || pending.current) return;
    pending.current=true; setBusy(true);
    try {
      const {canceled}=await cancel({source:item.source,id:item.id,projectId:item.projectId,fingerprint:item.fingerprint,messageId:queue.messageId});
      setOutcome(canceled ? null : { status: "changed", fingerprint: item.fingerprint }); setStreak(null);
      await onResolved({ status: canceled ? "queued" : "changed" });
    } catch { setRefreshFailed(true); }
    finally { pending.current=false; setBusy(false); }
  }
  async function acknowledge(mode: ResolutionMode) {
    const to = mode === "send" ? recipientId : fallbackId;
    if (!to || (mode === "send" ? changedOwner : fallbackOwnerChanged)) return;
    const text = answer;
    if (!canReply || queue || pending.current || attachments.blocksSubmit() || isClosed || needsRefresh || outstanding ||
      tooLong || basisChanged || awaitingRevision || orphaned.length > 0) return;
    if (!text && !hasPhotos) return;
    pending.current = true; setBusy(true);
    const fingerprint = item.fingerprint;
    const requested = trackedRetryFingerprint(outcome, fingerprint, text, to);
    let response: { status: Resolution; reason?: TrackedReplyReason; revision?: string; recipientId?: string };
    try {
      const images = attachments.latest.current.map(photo => photo.image);
      response = await resolve({ source: item.source, projectId: item.projectId, id: item.id, fingerprint: requested,
        ...(text ? { answer: text } : {}), ...(images.length ? { images } : {}),
        ...(item.questions.length ? { questionIndexes: replies.flatMap((reply, index) => reply ? [index] : []) } : {}),
        recipientId: to, ...(mode === "fallback" ? { route: "coordinator" as const } : {}) });
      if (response.status === "sent" || response.status === "closed" || response.status === "already-closed") clearDraft();
    } catch { response = { status: "unconfirmed" }; }
    const took = response.recipientId ?? to;
    const attempt: TrackedOutcome = { ...response, requested, mode, ...(text.trim() ? { answer: text.trim() } : {}), ...(took ? { recipientId: took } : {}) };
    setOutcome({ ...attempt, fingerprint });
    setStreak(previous => nextFailureStreak(previous, response, to));
    try { await onResolved(attempt); } catch { setRefreshFailed(true); }
    finally { pending.current = false; setBusy(false); }
  }
  function noticeText() {
    if (!outcome || (outcome.status === "queued" && queue)) return null;
    const status = outcome.status;
    // An answer to an earlier revision went through, and the board still lists the card as it is now.
    if (closedRevision(outcome) && !isClosed) return status === "sent"
      ? t("앞서 보낸 답은 전달됐습니다. 그 뒤 카드 내용이 바뀌어 이 카드는 아직 열려 있습니다.", "Your earlier reply was delivered. The card has changed since, so it stays open.")
      : t("앞서 한 처리는 기록됐습니다. 그 뒤 카드 내용이 바뀌어 이 카드는 아직 열려 있습니다.", "Your earlier action was recorded. The card has changed since, so it stays open.");
    if ((status === "sent" || status === "closed" || status === "already-closed") && !isClosed) return null;
    if (status !== "changed") return t(messages[status][0], messages[status][1]);
    const reason = outcome.reason;
    if (!reason) return t(messages.changed[0], messages.changed[1]);
    if (reason === "revised" && awaitingRevision) return t("카드 내용이 바뀌어 최신 내용을 불러오는 중입니다. 입력한 답은 그대로 둡니다.", "The card changed. Loading the latest version; your reply is kept.");
    if (reason === "revised" && !basisChanged) return t("카드의 근거·위험·긴급도 같은 설명만 바뀌었습니다. 입력한 답을 그대로 다시 보낼 수 있습니다.", "Only details such as the card's evidence, risks, or urgency changed. You can send your reply as written.");
    // The recipient line below already explains a session that cannot receive.
    if (recipientBlocks[reason] && recipientBlocks[reason] === blocked) return null;
    return t(reasons[reason][0], reasons[reason][1]);
  }
  function routeText() {
    const answerThere = t("위 세션을 열어 그곳에서 답해 주세요.", "Open the session above and answer there.");
    if (!blocked) return t("이 카드에는 답을 받을 세션이 정해지지 않아 보드에서 보낼 수 없습니다.", "This card names no session to take a reply, so the board cannot send one.");
    if (coordinatorCard && (blocked === "closed" || blocked === "error")) {
      const name = owned ? t("운영 코디네이터", "The ledger owner’s") : t("코디네이터", "The coordinator");
      return blocked === "closed" ? t(name + " 세션이 종료되어 보낼 수 없습니다.", name + " session has ended, so the reply cannot be sent.")
        : t(name + " 세션이 오류 상태라 보낼 수 없습니다.", name + " session is in an error state, so the reply cannot be sent.");
    }
    const next = fallbackId && !blockedNote ? t(fallbackName + "에게 대신 보낼 수 있습니다.", "You can send it to the " + fallbackName + " instead.")
      : otherSide ? answerThere : "";
    return [t(blocks[blocked][0], blocks[blocked][1]), next].filter(Boolean).join(" ");
  }
  function nextStep() {
    const reason = outcome?.reason;
    return t("새로 고친 뒤에도 같은 이유로 보내지 못했습니다.", "This failed again for the same reason after refreshing.") + " " + (reason === "revised"
      ? t("카드가 계속 바뀌고 있거나 보드 목록이 아직 최신이 아닙니다. 세션을 열어 직접 답하거나 잠시 뒤 다시 보내 주세요.", "The card keeps changing or the board has not caught up. Answer in the session directly, or try again shortly.")
      : reason === "conflict" ? t("최근 결정 기록에서 이미 기록된 답을 확인해 주세요.", "Check the reply already recorded in recent decision activity.")
      : reason === "earlier-unconfirmed" || reason === "recipient-unchecked" ? t("잠시 뒤 다시 보내거나 세션을 열어 직접 답해 주세요.", "Try again in a moment, or answer in the session directly.")
      : reason === "removed" ? t("세션을 열어 이 카드가 이미 처리됐는지 확인해 주세요.", "Open the session to check whether this card was already handled.")
      : t("받는 세션을 열어 상태를 확인하거나 그 세션에 직접 답해 주세요.", "Open the receiving session to check it or answer there directly."));
  }
  const ownerLabel = item.sourceCoordinatorId !== undefined ? t("운영 코디네이터 세션 열기", "Open ledger owner session") : t("코디네이터 세션 열기", "Open coordinator session");
  const localSession = links.source?.kind === "local" ? links.source : undefined;
  const openSession = coordinatorCard || outcome?.mode === "fallback"
    ? links.owner && { open: links.owner.open, label: ownerLabel }
    : localSession && { open: localSession.open, label: t("작업 세션 열기", "Open work session") };
  const notice = noticeText();
  const unsent = !keepsUnsent && needsRefresh && outcome?.answer;
  const total = item.questions.length;
  const draftOf = (index: number) => ({ selected: selected[index], typed: typed[index], skipped: skipped[index], photos: photoCount(index) });
  const showForm = !queue && !isClosed && !needsRefresh;

  function renderQuestion(index: number) {
    const question = item.questions[index];
    const hasOptions = question.options.length > 0;
    const showInput = canReply && !skipped[index] && (!stepped || !hasOptions || writing[index] || typed[index] !== undefined);
    // Photos or a skip keep the extras open, so what the reply carries stays in view.
    const extrasHeld = photoCount(index) > 0 || !!skipped[index];
    const extrasOpen = !!more[index] || extrasHeld;
    const photo = photoPlacement(stepped, showInput, extrasOpen);
    // While answering one question at a time, the send shortcut moves to the next question. Sending waits for the summary.
    const input = <DecisionReplyInput {...inputFocus} send={stepping ? { disabled: busy || !answered[index], onPress: () => go(nextOpenStep(answered, index)) } : sendReply}
      theme={theme} value={questionText[index]} disabled={busy} maxLength={4000}
      accessibilityLabel={item.title + " · " + question.text + " · " + t("답장 내용", "Reply text")}
      onChangeText={text => setAnswers(draft => typeAnswer(draft, index, text))}
      placeholder={hasOptions ? t("선택하거나 직접 답을 입력하세요", "Choose an option or write your reply") : t("내 답을 입력하세요", "Write your reply")} />;
    const skipButton = canReply && <View style={wrap}><Button theme={theme} label={skipped[index] ? t("건너뛰기 취소", "Undo skip") : t("이 질문 건너뛰기", "Skip this question")}
      accessibilityLabel={item.title + " · " + question.text + " · " + t("건너뛰기", "Skip")} selected={!!skipped[index]}
      disabled={busy || attachments.reading || attachments.errors.has(index) || attachments.photos.some(photo => photo.questionIndex === index)} onPress={() => skip(index)} /></View>;
    return <View key={index} style={{ gap: 6 }}>
      {stepped
        ? <View ref={questionHead} tabIndex={-1} accessible accessibilityRole="header" accessibilityLiveRegion="polite" style={{ gap: 4 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{t(`질문 ${index + 1}/${total}`, `Question ${index + 1} of ${total}`)}</Text>
          <HistoryMarkdown theme={theme} source={question.text} pullRepository={pullRepository} heading />
        </View>
        : <HistoryMarkdown theme={theme} source={question.text} pullRepository={pullRepository} heading />}
      {canReply && hasOptions && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {question.multi ? t("여러 개 선택", "Choose any that apply") : t("하나 선택", "Choose one")}
      </Text>}
      {question.options.map((option, choice) => {
        const checked = selected[index]?.includes(optionId(option)) ?? false;
        const title = option.key + " · " + option.text;
        return <Pressable key={choice} accessibilityRole={question.multi ? "checkbox" : "radio"}
          accessibilityLabel={item.title + " · " + question.text + " · " + title}
          accessibilityState={{ checked, disabled: busy || !canReply }} aria-checked={checked} disabled={busy || !canReply}
          onPress={() => choose(index, choice, question.multi)}
          style={{ gap: 4, padding: 8, borderWidth: 1, borderRadius: 7, borderColor: checked ? c.accent : c.border, backgroundColor: checked ? c.surface2 : c.surface0 }}>
          <Text style={{ color: c.foreground, fontWeight: checked ? "700" : "500" }}>
            {checked ? "✓ " : ""}{title}{option.recommended ? " · " + t("추천", "Recommended") : ""}
          </Text>
          {expanded && !!option.note && <Text style={{ color: c.foregroundMuted }}>{option.note}</Text>}
          {expanded && ([ [t("고르면", "Outcome"), option.does], [t("장점", "Benefits"), option.pros], [t("대가", "Trade-offs"), option.cons] ] as const)
            .map(([label, text]) => text ? <Text key={label} style={{ color: c.foregroundMuted, fontSize: 12 }}>{label} · {text}</Text> : null)}
        </Pressable>;
      })}
      {stepped && canReply && hasOptions && !showInput && !skipped[index] && <Pressable accessibilityRole="button"
        accessibilityLabel={item.title + " · " + question.text + " · " + t("다르게(직접 적기)", "Something else (write it)")}
        disabled={busy} onPress={() => setAnswers(draft => startWriting(draft, index))}
        style={{ padding: 8, borderWidth: 1, borderStyle: "dashed", borderRadius: 7, borderColor: c.border }}>
        <Text style={{ color: c.foregroundMuted }}>{t("다르게(직접 적기)", "Something else (write it)")}</Text>
      </Pressable>}
      {!stepped && <>
        {canReply && !skipped[index] && <PhotoComposer theme={theme} disabled={busy} draft={attachments} questionIndex={index}>{input}</PhotoComposer>}
        {skipButton}
      </>}
      {stepped && <>
        {photo.wrapField && <PhotoComposer theme={theme} disabled={busy} draft={attachments} questionIndex={index} controls={photo.fieldControls}>{input}</PhotoComposer>}
        {canReply && !extrasHeld && <TextButton theme={theme} expanded={extrasOpen} label={extrasOpen ? t("접기", "Less") : t("더 보기", "More")}
          accessibilityLabel={item.title + " · " + question.text + " · " + (extrasOpen ? t("사진·건너뛰기 접기", "Hide photos and skip") : t("사진·건너뛰기 더 보기", "Photos and skip"))}
          onPress={() => setMore(previous => ({ ...previous, [index]: !extrasOpen }))} />}
        {canReply && extrasOpen && <View style={{ ...wrap, alignItems: "flex-start" }}>
          {photo.extrasComposer && !skipped[index] && <PhotoComposer theme={theme} disabled={busy} draft={attachments} questionIndex={index}><></></PhotoComposer>}
          {skipButton}
        </View>}
        <View style={{ ...wrap, alignItems: "center" }}>
          {index > 0 && <Button theme={theme} {...named(t("이전", "Previous"))} disabled={busy} onPress={() => go(index - 1)} />}
          {(!advancesOnChoice(question) || answered[index]) && <Button theme={theme} {...named(t("다음", "Next"))} selected={answered[index]}
            disabled={busy || !answered[index]} onPress={() => go(nextOpenStep(answered, index))} />}
        </View>
      </>}
    </View>;
  }

  function progressDots(current: Step) {
    return <View style={{ ...wrap, alignItems: "center", gap: 4 }}>
      {item.questions.map((_, index) => {
        const here = current === index;
        return <Pressable key={index} accessibilityRole="button" accessibilityState={{ selected: here }} disabled={busy}
          accessibilityLabel={item.title + " · " + t(`질문 ${index + 1}로 이동`, `Go to question ${index + 1}`) + (answered[index] ? " · " + t("답함", "answered") : "")}
          onPress={() => go(index)} hitSlop={6} style={{ padding: 3 }}>
          <View style={{ width: here ? 10 : 8, height: here ? 10 : 8, borderRadius: 5, borderWidth: 1,
            borderColor: here || answered[index] ? c.accent : c.border, backgroundColor: answered[index] ? c.accent : "transparent" }} />
        </Pressable>;
      })}
    </View>;
  }

  return <View style={{ gap: 7 }}>
    <CardHeader theme={theme} text={[source || t("보드 공통", "Board-wide"), ...recordHeaderParts(item, t)].join(" · ")}>
      {otherSide && <TrackedSessionChips title={item.title} theme={theme} links={links} side={otherSide} role />}
    </CardHeader>
    <HistoryMarkdown theme={theme} source={isMerge ? t("PR 병합", "PR merge") : item.title} pullRepository={pullRepository} heading />
    {isMerge && (pull || (target
      ? <TrackedPullStatus repo={target.repo} number={target.number} projectId={item.projectId} theme={theme} securityGate={securityGate} />
      : <Text selectable style={{color:c.foregroundMuted}}>{t("PR 링크와 병합 상태 미확인", "Pull request link and merge status unavailable")}</Text>))}
    {!isMerge && target && <TrackedPullStatus repo={target.repo} number={target.number} projectId={item.projectId} theme={theme} reference />}
    {!!askLines.length && <View style={{ gap: 3 }}>
      {(askOpen ? askLines : askLines.slice(0, 1)).map((line, index) =>
        <HistoryMarkdown key={index} theme={theme} source={line} pullRepository={pullRepository} preview={askFolds && !askOpen} />)}
      {askFolds && <TextButton theme={theme} expanded={askOpen} label={askOpen ? t("접기", "Less") : t("더 보기", "More")}
        accessibilityLabel={item.title + " · " + (askOpen ? t("요청 접기", "Show less of the request") : t("요청 더 보기", "Show the whole request"))}
        onPress={() => setAskOpen(open => !open)} />}
    </View>}
    {choiceNotice && <Text accessibilityLiveRegion="polite" selectable style={{ color: c.statusWarning, fontSize: 13 }}>{t(...choiceNotice.notice)}</Text>}
    {canReply && children}
    {!isMerge && !!item.recommend.filter(line => line !== headline).length && <View style={{ ...wrap, alignItems: "baseline", flexWrap: "nowrap" }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "600", flexShrink: 0 }}>{t("추천", "Recommendation")}</Text>
      <View style={{ flexShrink: 1 }}><HistoryMarkdown theme={theme} pullRepository={pullRepository} source={item.recommend.filter(line => line !== headline)[0]} preview lines={1} /></View>
    </View>}
    {!!steps.shown.length && <View style={{ gap: 3 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{t("진행 단계", "Steps")}</Text>
      {steps.shown.map((line, index) => <View key={index} style={{ flexDirection: "row", gap: 6 }}>
        <Text style={{ color: c.foregroundMuted, fontVariant: ["tabular-nums"], lineHeight: 21 }}>{index + 1}.</Text>
        <View style={{ flexShrink: 1, flexGrow: 1 }}><HistoryMarkdown theme={theme} source={stepText(line, index)} pullRepository={pullRepository} /></View>
      </View>)}
      {(steps.more > 0 || stepsOpen) && <TextButton theme={theme} expanded={stepsOpen}
        label={stepsOpen ? t("단계 접기", "Show fewer steps") : t(`단계 ${steps.more}개 모두 보기`, `Show all ${steps.more} steps`)}
        accessibilityLabel={item.title + " · " + (stepsOpen ? t("단계 접기", "Show fewer steps") : t(`단계 ${steps.more}개 모두 보기`, `Show all ${steps.more} steps`))}
        onPress={() => setStepsOpen(open => !open)} />}
    </View>}
    {!canReply && <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>{ledgerHistoryUnavailableText(t)}</Text>}
    {queue && <QueuedAnswer key={queue.messageId} queue={queue} theme={theme}
      card={{kind:"ledger",source:item.source,id:item.id,projectId:item.projectId,fingerprint:item.fingerprint}}
      onRefresh={()=>onResolved({status:"queued"})} onCancel={cancelWaiting} />}
    {showForm && canReply && recordActions && unreachable && <Text style={{color:c.foregroundMuted,fontSize:12}}>{routeText()}</Text>}
    {showForm && !unreachable && <View style={{ gap: 8 }}>
      {isMerge && !!item.questions.length && <Text accessibilityRole="header" style={{color:c.foreground, borderTopWidth:1, borderTopColor:c.border, paddingTop:10, fontSize:16, fontWeight:"600"}}>{followupTitle}</Text>}
      {stepped && canReply && allPicks && <View style={wrap}>
        <Button theme={theme} disabled={busy} {...named(t("추천대로 모두 고르기", "Choose all recommendations"))} onPress={() => chooseRecommended(allPicks, true)} />
      </View>}
      {stepped && canReply && progressDots(step)}
      {!stepped && canReply && Object.keys(picks).length > 0 && <View style={wrap}><Button theme={theme} disabled={busy} {...named(t("추천 선택지 고르기", "Choose recommended options"))}
        onPress={() => chooseRecommended(picks, false)} /></View>}
      {stepped ? step !== "summary" && renderQuestion(step) : item.questions.map((_, index) => renderQuestion(index))}
      {stepped && step === "summary" && <View style={{ gap: 4 }}>
        <View ref={questionHead} tabIndex={-1} accessible accessibilityRole="header" accessibilityLiveRegion="polite">
          <Text style={{ color: c.foreground, fontWeight: "600" }}>{t("답 확인", "Review your answers")}</Text>
        </View>
        {item.questions.map((question, index) => <Pressable key={index} accessibilityRole="button" disabled={busy}
          accessibilityLabel={item.title + " · " + answerSummary(index, question, draftOf(index), t) + " · " + t("고치기", "Edit")}
          onPress={() => go(index)} style={{ paddingVertical: 5, paddingHorizontal: 8, borderRadius: 6, backgroundColor: c.surface0 }}>
          <Text numberOfLines={1} style={{ color: answered[index] ? c.foreground : c.statusWarning, fontSize: 13 }}>{answerSummary(index, question, draftOf(index), t)}</Text>
        </Pressable>)}
      </View>}
      {canReply && (freeEditor || carried) && <>
        {carried && <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>
          {t("질문이 생기기 전에 쓴 답입니다. 질문의 답과 함께 보내니 고치거나 빼 주세요.", "You wrote this before the card had questions. It is sent with your answers, so edit or remove it.")}
        </Text>}
        <PhotoComposer theme={theme} disabled={busy} draft={attachments}>
          <DecisionReplyInput {...inputFocus} send={stepping ? { disabled: true, onPress: () => {} } : sendReply} theme={theme}
            accessibilityLabel={item.title + " · " + (carried ? t("질문이 생기기 전에 쓴 답", "Reply written before the questions") : t("답장 내용", "Reply text"))}
            value={freeReply} disabled={busy} maxLength={4000} onChangeText={value => setEditedReply(value)}
            placeholder={example ? t("예시 · ", "Example · ") + example : t("내 답을 입력하세요", "Write your reply")} />
        </PhotoComposer>
        {carried && <View style={wrap}><Button theme={theme} disabled={busy} {...named(t("이 답 빼기", "Remove this reply"))}
          onPress={() => {
            setEditedReply(null);
            for (const photo of attachments.latest.current) if (photo.questionIndex === undefined) attachments.remove(photo.id);
          }} /></View>}
        {(!!suggestion || template) && !freeReply.trim() && <View style={{ ...wrap, alignItems: "center" }}>
          {!!suggestion && <Pressable accessibilityRole="button" disabled={busy} accessibilityLabel={item.title + " · " + t("추천 답 넣기", "Use recommendation") + " · " + suggestion}
            onPress={() => setEditedReply(suggestion)}
            style={({ pressed }) => ({ maxWidth: "100%", paddingHorizontal: 9, paddingVertical: 4, borderRadius: 12, borderWidth: 1, borderColor: c.accent,
              backgroundColor: pressed ? c.surface2 : c.surface0, opacity: busy ? 0.6 : 1 })}>
            <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12 }}>{t("추천", "Suggested")} · {suggestion}</Text>
          </Pressable>}
          {template && <Button theme={theme} disabled={busy} label={t("답장 양식 불러오기", "Load reply template")}
            onPress={() => setEditedReply(example)} />}
        </View>}
      </>}
      {canReply && tooLong && <Text style={{ color: c.statusWarning }}>{t("답을 4,000자 이내로 줄여 주세요.", "Shorten the answer to 4,000 characters.")}</Text>}
      {canReply && orphaned.length > 0 && <View style={{ gap: 5 }}>
        <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>
          {t("질문이 바뀌어 붙일 곳이 없어진 사진이 " + orphaned.length + "장 있습니다. 이 사진을 빼야 보낼 수 있습니다.",
            orphaned.length + (orphaned.length === 1 ? " photo belongs" : " photos belong") + " to a question that no longer exists. Remove them to send.")}
        </Text>
        <View style={wrap}><Button theme={theme} disabled={busy} {...named(t("그 사진 빼기", "Remove those photos"))}
          onPress={() => { for (const photo of orphaned) attachments.remove(photo.id); }} /></View>
      </View>}
      {canReply && basisChanged && <View style={{ gap: 5 }}>
        <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>{t("카드의 제목·요청·추천이나 질문·선택지, 받는 곳이 바뀌었습니다. 입력한 답은 그대로 두었으니 바뀐 내용을 확인한 뒤 보내 주세요.", "The card's title, request, recommendation, questions, options, or recipient changed. Your reply is kept; review the changes before sending.")}</Text>
        <View style={wrap}><Button theme={theme} {...named(t("바뀐 내용 확인했어요", "I reviewed the changes"))} disabled={busy}
          onPress={() => { setConfirmedBasis(basis); setOutcome(null); }} /></View>
      </View>}
      {canReply && (!stepped || step === "summary") && <View style={{ gap: 6 }}>
        {owned && !links.owner && item.sourceCoordinatorId && <Text selectable style={{color:c.foregroundMuted,fontSize:12}}>
          {t("원장 소유 세션", "Ledger owner session")} · {item.sourceCoordinatorId}
        </Text>}
        {!recipientId && !item.matchedSessionId && <Text style={{color:c.foregroundMuted,fontSize:12}}>{routeText()}</Text>}
        {((changedOwner && recipientId) || (fallbackOwnerChanged && offersFallback)) &&
          <Button theme={theme} label={t("변경된 운영 코디네이터 확인", "Confirm new ledger owner")} onPress={() => setConfirmedOwner(item.sourceCoordinatorId)} />}
        {outstanding && <Text style={{ color: c.foregroundMuted }}>{t("각 질문에 답하거나 건너뛰기를 선택하세요.", "Answer or explicitly skip each question.")}</Text>}
        {!!lead && recordActions && <View style={{ ...wrap, alignItems: "center" }}>
          <Text selectable style={{ color: leadRemoved ? c.foregroundMuted : c.foreground, fontSize: 12, flexShrink: 1 }}>
            {(leadRemoved ? t("첫 줄 없이 보냄", "Sent without the first line") : t("첫 줄로 함께 보냄", "Sent as the first line")) + " · " + lead}
          </Text>
          <Button theme={theme} disabled={busy} {...named(leadRemoved ? t("첫 줄 다시 넣기", "Restore first line") : t("첫 줄 빼기", "Remove first line"))}
            onPress={() => setLeadRemoved(removed => !removed)} />
        </View>}
        {blockedNote && (recipientId || fallbackId) && <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning, fontSize: 12 }}>{blockedNote}</Text>}
        {recordActions && <View style={wrap}>
          {offer.send && <SendButton theme={theme} {...named(sendLabel)} send={sendReply} selected={!sendReply.disabled} />}
          {offersFallback && <Button theme={theme} {...named(t(fallbackName + "에게 대신 보내기", "Send to " + fallbackName + " instead"))}
            selected={!answerDisabled && !fallbackOwnerChanged && !blockedNote} disabled={answerDisabled || fallbackOwnerChanged || !!blockedNote}
            onPress={() => void acknowledge("fallback")} />}
        </View>}
      </View>}
    </View>}
    {canReply && showForm && renderClarification && <View style={{ ...wrap, alignItems: "center" }}>{renderClarification(setHasQuestionDraft, "ask")}</View>}
    <TextButton theme={theme} expanded={expanded} label={expanded ? t("근거·이력 접기", "Hide evidence and history") : t("근거·이력 보기", "Evidence and history")}
      accessibilityLabel={named(expanded ? t("결정 상세 접기", "Hide decision details") : t("결정 상세 보기", "View decision details")).accessibilityLabel}
      onPress={() => setExpanded(value => !value)} />
    {expanded && <View style={{ gap: 8, padding: 8, borderRadius: 7, backgroundColor: c.surface0 }}>
      {evidenceLinks && <View style={{ ...wrap, alignItems: "center" }}><TrackedSessionChips title={item.title} theme={theme} links={links} side={evidenceSide} /></View>}
      {links.owner && item.sourceCoordinatorId && <Text selectable style={{color:c.foregroundMuted,fontSize:12}}>
        {t("운영 코디네이터 세션 ID","Operating coordinator session ID")} · {item.sourceCoordinatorId}
      </Text>}
      {!!item.since && <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {t("기록 시각", "Recorded at")} · {item.since}
      </Text>}
      {isMerge && <>
        <Lines theme={theme} pullRepository={pullRepository} title={t("기록 당시 제목", "Original record title")} lines={[item.title]} />
        <Lines theme={theme} pullRepository={pullRepository} title={t("기록 당시 추천", "Original recommendation")} lines={item.recommend} />
        {item.howToAnswer && <Lines theme={theme} pullRepository={pullRepository} title={t("기록 당시 답장 예시", "Original example reply")} lines={[item.howToAnswer]} />}
        <Lines theme={theme} pullRepository={pullRepository} title={t("기록 당시 요청", "Original request")} lines={item.ask} />
      </>}
      {!isMerge && <Lines theme={theme} pullRepository={pullRepository} title={t("추천", "Recommendation")} lines={item.recommend.filter(line => line !== headline)} />}
      <Lines theme={theme} pullRepository={pullRepository} title={t("근거", "Evidence")} lines={item.why} />
      <Lines theme={theme} pullRepository={pullRepository} title={t("위험", "Risks")} lines={item.risk} />
      {(!renderClarification || !canReply || !showForm) && !!item.qa.length && <View style={{ gap: 5 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("이전 문답", "Question history")}</Text>
        {item.qa.map((entry, i) => <View key={i} style={{ gap: 3 }}>
          <Text selectable style={{ color: c.foreground }}>{[t("질문", "Question"), entry.askedAt, entry.q].filter(Boolean).join(" · ")}</Text>
          <Text selectable style={{ color: c.foregroundMuted }}>{entry.a ? [t("답", "Answer"), entry.answeredAt, entry.a].filter(Boolean).join(" · ") : t("답변 대기", "Awaiting reply")}</Text>
        </View>)}
      </View>}
      {canReply && showForm && renderClarification?.(undefined, "history")}
      <Lines theme={theme} pullRepository={pullRepository} title={t("이전 답변", "Previous replies")} lines={item.replyHistory.map(entry => [entry.at, entry.text].filter(Boolean).join(" · "))} />
    </View>}
    {notice && <Text accessibilityLiveRegion="polite" style={{ color: isClosed ? c.statusSuccess : c.statusWarning }}>{notice}</Text>}
    {unsent && <View style={{ gap: 3, padding: 8, borderRadius: 7, backgroundColor: c.surface0 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("보내지 못한 답", "Unsent reply")}</Text>
      <Text selectable style={{ color: c.foreground }}>{unsent}</Text>
    </View>}
    {stuck && <View style={{ gap: 5 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>{nextStep()}</Text>
      {openSession && <View style={wrap}><Button theme={theme} {...named(openSession.label)} onPress={openSession.open} /></View>}
    </View>}
    {(needsRefresh || awaitingRevision) && !stuck && <View style={wrap}><Button theme={theme} {...named(t("결정 기록 새로 고침", "Refresh decision record"))}
      disabled={busy} onPress={() => void refreshRecord()} /></View>}
    {refreshFailed && <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>{t("최신 목록을 다시 불러오지 못했습니다. 보드를 새로 고쳐 주세요.", "Could not reload the list. Refresh the board.")}</Text>}
  </View>;
}
