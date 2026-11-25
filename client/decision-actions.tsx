import { useDecisionInteraction } from "./decision-editing";
import { useRpc } from "@getpaseo/plugin/client";
import { useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { sendDecision, type DecisionInput } from "../shared/decision-actions";
import { requestRecommendation } from "../shared/recommendation";
import { HistoryMarkdown } from "./history-markdown";
import { DecisionReplyInput } from "./decision-reply";
import { SendButton } from "./send-input";
import { sessionReplyDraft } from "./decision-reply-state";
import { decisionSummary, questionFolds as titleFolds, questionParts } from "./decision-summary";
import { Button, CardHeader, SessionChip, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import type { Card } from "./model";
import { PhotoComposer, usePhotoDraft } from "./photo-composer";
import { QuestionContext } from "./question-context";
import { choiceRequest, decisionChoiceNotice } from "./choice-display";
import { foldsAsk } from "./card-steps";

type Action = DecisionInput["action"];
type CoordinationDraft = { text: string; recipientId: string };
export type DecisionReceipt = { projectId: string; sessionId: string; version: string; source: string; project: string; recipient: string | null; recipientId: string; action: Action; answer?: string };
const wrap = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };
const korean = { reply: "답장", question: "질문", coordinate: "조율 요청" };
const english = { reply: "reply", question: "question", coordinate: "coordination request" };

export function ReceiptText({ receipt, theme }: { receipt: DecisionReceipt; theme: Theme }) {
  const { t } = useBoardLanguage();
  const name = receipt.recipient || t("코디네이터 세션", "coordinator session");
  const kind = receipt.action;
  return <Text accessibilityLiveRegion="polite" selectable style={{ color: theme.colors.statusSuccess }}>
    {receipt.project} · {receipt.source} · {t(`${name}에 ${korean[kind]}을 보냈습니다.`, `Sent a ${english[kind]} to ${name}.`)}
  </Text>;
}

export function DecisionActions({ card, theme, hostLabel, coordinator, coordinatorTitle, open, onSent, receipt, clarification: renderClarification, pendingRequests, priorityLabel, embedded = false }: {
  card: Card; theme: Theme; hostLabel?: string; coordinator: string | null; coordinatorTitle?: string; open?: (id: string) => void;
  onSent: (result: DecisionReceipt) => void; receipt?: DecisionReceipt; pendingRequests?: ReactNode; priorityLabel?: string; embedded?: boolean;
  // The question box. Its earlier questions and answers show with the card's evidence.
  clarification?: (part: "ask" | "history") => ReactNode;
}) {
  const { t, language } = useBoardLanguage();
  const { session } = card;
  const decision = session.decision;
  const c = theme.colors;
  const send = useRpc(sendDecision);
  const askRecommendation = useRpc(requestRecommendation);
  const [showMethods, setShowMethods] = useState(false);
  const [reviewedReply, setReviewedReply] = useState<string | null>(null);
  const [showEvidence, setShowEvidence] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [questionOpen, setQuestionOpen] = useState(false);
  const [titleHeights, setTitleHeights] = useState<{ fullHeight?: number; shownHeight?: number }>({});
  const [requestedFrom, setRequestedFrom] = useState<string | null>(null);
  const recommendationKey = useRef({ recipient: "", key: "" });
  const [selection, setSelection] = useState<number | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [coordination, setCoordination] = useState<CoordinationDraft | null>(null);
  const replyPhotos = usePhotoDraft();
  const editorPhotos = usePhotoDraft();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<[string, string] | null>(null);
  const pending = useRef(false);
  const retry = useRef({ payload: "", key: "" });
  const delivered = useRef("");
  const chosen = selection === null ? null : decision?.options?.[selection];
  const proposed = chosen?.reply || (decision?.needsInput ? undefined : decision?.recommendation);
  const reply = sessionReplyDraft(proposed, draft, reviewedReply, !!replyPhotos.photos.length);
  const sendReply = { disabled: busy || replyPhotos.blocked || !reply.canSend, onPress: () => void submit("reply", reply.text, session.id, replyPhotos) };
  const inputFocus = useDecisionInteraction(!!coordination || (draft !== null && draft !== (proposed ?? "")) ||
    selection !== null || !!reviewedReply || busy || replyPhotos.blocked || !!replyPhotos.photos.length ||
    editorPhotos.blocked || !!editorPhotos.photos.length);
  const { headline, formal, evidence } = decisionSummary(card, t);
  // The header keeps the project and how long the card has waited. The session and host move to the evidence.
  const marker = [session.projectTitle, priorityLabel].filter(Boolean).join(" · ");
  const origin = [session.title, hostLabel && t(`실행 호스트 · ${hostLabel}`, `Host · ${hostLabel}`), session.sourceProjectTitle && t(`원래 소속 ${session.sourceProjectTitle}`, `From ${session.sourceProjectTitle}`)].filter(Boolean).join(" · ");
  const clarification = renderClarification?.("ask");
  const named = (label: string) => ({ label, accessibilityLabel: `${session.title} · ${label}` });

  function selectReply(index: number | null) {
    setSelection(index); setDraft(null); setReviewedReply(null); setShowMethods(false); setError(null);
  }
  async function submit(action: Action, text: string, recipientId: string, attachments?: ReturnType<typeof usePhotoDraft>) {
    const photos = attachments?.latest.current ?? [];
    if (!decision || formal || (!text.trim() && !photos.length) || pending.current || attachments?.blocksSubmit()) return;
    if (recipientId !== (action === "coordinate" ? coordinator : session.id)) {
      setError(["받는 세션이 바뀌었습니다. 대상을 다시 선택해 주세요.", "The recipient changed. Choose the recipient again."]); return;
    }
    const input = { projectId: session.projectId, sessionId: session.id, version: decision.version, action, recipientId, text };
    const payload = JSON.stringify([input, photos.map(photo => photo.id)]);
    if (delivered.current === payload) { setError(["이 카드에서 같은 내용을 이미 보냈습니다.", "You already sent this message from this card."]); return; }
    if (retry.current.payload !== payload) retry.current = { payload, key: "decision-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) };
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await send({ ...input, requestKey: retry.current.key, ...(photos.length ? { images: photos.map(photo => photo.image) } : {}) });
      if (!result.ok || result.recipientId !== recipientId) {
        setError(["영수증의 수신자를 확인할 수 없습니다. 원래 세션을 확인해 주세요.", "The receipt does not confirm the recipient. Check the original session."]); return;
      }
      delivered.current = payload; attachments?.clear(); setCoordination(null);
      if (action === "reply") setDraft("");
      onSent({ projectId: session.projectId, sessionId: session.id, version: decision.version, recipientId: result.recipientId,
        project: session.projectTitle, source: session.title, recipient: action === "coordinate" ? coordinatorTitle || recipientId : session.title, action, answer: text.trim() || undefined });
    } catch {
      setError(["전송을 확인하지 못했습니다. 최신 카드와 받는 세션을 확인한 뒤 다시 시도해 주세요.",
        "Delivery was not confirmed. Check the latest card and recipient before retrying."]);
    } finally { pending.current = false; setBusy(false); }
  }
  async function requestAdvice() {
    if (!decision || formal || !coordinator || decision.recommendation || decision.needsInput || pending.current || requestedFrom === coordinator) return;
    if (recommendationKey.current.recipient !== coordinator) {
      recommendationKey.current = { recipient: coordinator, key: "advice-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2) };
    }
    pending.current = true; setBusy(true); setError(null);
    try {
      const result = await askRecommendation({ projectId: session.projectId, sessionId: session.id,
        version: decision.version, coordinator, language, requestKey: recommendationKey.current.key });
      if (!result.ok || result.recipientId !== coordinator) throw Error();
      setRequestedFrom(coordinator);
    } catch {
      setError(["추천 요청을 확인하지 못했습니다. 최신 카드와 코디네이터를 확인해 주세요.",
        "Could not confirm the recommendation request. Check the current card and coordinator."]);
    } finally { pending.current = false; setBusy(false); }
  }

  const targetChanged = !!coordination && coordination.recipientId !== coordinator;
  const sendCoordination = {
    disabled: busy || editorPhotos.blocked || targetChanged || (!coordination?.text.trim() && !editorPhotos.photos.length),
    onPress: () => { if (coordination) void submit("coordinate", coordination.text, coordination.recipientId, editorPhotos); },
  };
  const canCoordinate = !!coordinator && coordinator !== session.id;
  const choiceNotice = formal ? null : decisionChoiceNotice(decision);
  // A coordinator card that names options without carrying them goes back to the coordinator through the usual request box.
  const completion = decision?.source === "coordinator" && canCoordinate ? choiceRequest(choiceNotice, true) : null;
  const canRestore = !!decision?.recommendation && !decision.needsInput && (selection !== null || draft !== null);
  const sourceExcerpts = evidence.filter(text => text !== headline);
  const needsInputText = !proposed && !!decision?.needsInput && decision.needsInput !== headline ? decision.needsInput : "";
  const needsInputFolds = foldsAsk([needsInputText]);
  // A question the board found in the session's message shows its request sentence as the title, like a ledger card.
  const split = !formal && decision?.source === "conversation";
  const parts = split ? questionParts(headline) : { lead: "", title: headline, body: "" };
  const bodyFolds = foldsAsk([parts.body]);
  // The title keeps two lines. When that cuts it off, it opens with the body.
  const questionFolds = titleFolds({ bodyFolds, ...(split ? titleHeights : {}) });
  const measureTitle = (key: "fullHeight" | "shownHeight") => (event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    setTitleHeights(prior => prior[key] === height ? prior : { ...prior, [key]: height });
  };
  const context = [parts.lead, decision?.contextMarkdown].filter(Boolean).join("\n\n") || undefined;
  const adviceSent = !!coordinator && requestedFrom === coordinator;
  const disclose = (label: string, expanded: boolean, onPress: () => void) =>
    <Pressable accessibilityRole="button" accessibilityLabel={named(label).accessibilityLabel} accessibilityState={{ expanded }}
      style={{ paddingVertical: 6, paddingHorizontal: 3 }} onPress={onPress}>
      <Text style={{ color: c.foregroundMuted, fontSize: 13, textDecorationLine: "underline" }}>{label}</Text>
    </Pressable>;
  return <View style={{ gap: 7, ...(embedded && { paddingTop: 10, borderTopWidth: 1, borderColor: c.border }) }}>
    <CardHeader theme={theme} text={marker}>
      {open && <SessionChip theme={theme} label={t("작업 세션 열기", "Open work session")} accessibilityLabel={named(t("작업 세션 열기", "Open work session")).accessibilityLabel} onPress={() => open(session.id)} />}
    </CardHeader>
    {split ? <View>
      {/* The full title, laid out unseen at the same width, tells whether two lines cut it off. */}
      <View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ position: "absolute", left: 0, right: 0, top: 0, opacity: 0 }} onLayout={measureTitle("fullHeight")}>
        <HistoryMarkdown theme={theme} source={parts.title} heading />
      </View>
      {/* While open the title is shown in full, so keep the height measured with two lines. */}
      <View onLayout={questionOpen ? undefined : measureTitle("shownHeight")}>
        <HistoryMarkdown theme={theme} source={parts.title} heading preview={!questionOpen} />
      </View>
    </View> : <HistoryMarkdown theme={theme} source={parts.title} heading />}
    {(!!parts.body || questionFolds) && <View style={{ alignItems: "flex-start", gap: 2 }}>
      {!!parts.body && <HistoryMarkdown theme={theme} source={parts.body} preview={bodyFolds && !questionOpen} />}
      {questionFolds && disclose(questionOpen ? t("접기", "Less") : t("더 보기", "More"), questionOpen, () => setQuestionOpen(v => !v))}
    </View>}
    {!formal && decision && <QuestionContext theme={theme} title={session.title} choices={decision.choices} context={context} notice={choiceNotice} />}
    {completion && !coordination && <View style={wrap}>
      <Button theme={theme} {...named(t(...completion.label))} disabled={busy || replyPhotos.reading}
        onPress={() => { setError(null); setCoordination({ recipientId: coordinator!, text: t(...completion.text) }); }} />
    </View>}
    {formal || !decision ? formal && (pendingRequests ?? <Text style={{ color: c.foregroundMuted }}>
      {t("승인 요청은 작업 세션에서 확인해 주세요.", "Review the approval request in the work session.")}
    </Text>) : <>

      {!coordination && <>
        {!!needsInputText && <View style={{ alignItems: "flex-start", gap: 2 }}>
          <HistoryMarkdown theme={theme} source={needsInputText} preview={needsInputFolds && !askOpen} />
          {needsInputFolds && disclose(askOpen ? t("접기", "Less") : t("더 보기", "More"), askOpen, () => setAskOpen(v => !v))}
        </View>}
        {!!decision.options?.length && <View style={wrap}>{decision.options.map((option, index) =>
          <Button key={index} theme={theme} label={option.label} selected={selection === index}
            accessibilityLabel={named(t("선택", "Choose") + " · " + option.label).accessibilityLabel} disabled={busy}
            onPress={() => selectReply(index)} />)}</View>}
        <PhotoComposer theme={theme} draft={replyPhotos} disabled={busy}>
          <DecisionReplyInput {...inputFocus} send={sendReply} theme={theme} value={reply.text} onChangeText={setDraft}
            accessibilityLabel={named(t("답장 내용", "Reply text")).accessibilityLabel}
            placeholder={t("작업 세션에 보낼 답을 입력하세요", "Write a reply to the work session")}
            maxLength={24000} disabled={busy} reviewRequired={reply.needsReview} onReview={() => setReviewedReply(proposed ?? null)} />
        </PhotoComposer>
        <View style={{ ...wrap, alignItems: "center" }}>
          <SendButton theme={theme} {...named(t("작업 세션에 답장 보내기", "Send reply to work session"))} send={sendReply} selected={!sendReply.disabled} />
          {clarification}
        </View>
        <View style={{ ...wrap, alignItems: "center" }}>
          {!proposed && !decision.needsInput && coordinator && (adviceSent
            ? <Text accessibilityLiveRegion="polite" style={{ color: c.statusSuccess }}>{t("추천 요청됨 · 코디네이터 답변 대기", "Recommendation requested · Awaiting coordinator")}</Text>
            : <Button theme={theme} {...named(t("코디네이터에 추천 요청", "Ask coordinator for a recommendation"))} disabled={busy} onPress={() => void requestAdvice()} />)}
          {(canRestore || canCoordinate) && disclose(showMethods ? t("다른 방법 접기", "Hide alternatives") : t("다른 방법", "Other actions"), showMethods, () => setShowMethods(v => !v))}
        </View>
        {showMethods && <View style={wrap}>
          {canRestore && <Button theme={theme} {...named(t("추천 답장으로 돌아가기", "Restore suggested reply"))} disabled={busy} onPress={() => selectReply(null)} />}
          {canCoordinate && <Button theme={theme} {...named(t("코디네이터에 조율 요청", "Ask coordinator to coordinate"))} disabled={busy || replyPhotos.reading}
            onPress={() => { setError(null); setCoordination({ recipientId: coordinator, text: "" }); }} />}
        </View>}
      </>}
      {coordination && <View style={{ gap: 7 }}>
        <Text style={{ color: c.foregroundMuted }}>{t("받는 곳", "Recipient")} · {targetChanged ? coordination.recipientId : coordinatorTitle || coordinator}</Text>
        {targetChanged && <Text style={{ color: c.statusWarning }}>{t("코디네이터가 교체되었습니다. 취소하고 새 수신자를 확인해 주세요.", "The coordinator changed. Cancel and check the new recipient.")}</Text>}
        <PhotoComposer theme={theme} disabled={busy || targetChanged} draft={editorPhotos}>
          <DecisionReplyInput {...inputFocus} send={sendCoordination} theme={theme} accessibilityLabel={named(t("조율 요청 내용", "Coordination request text")).accessibilityLabel}
            placeholder={t("조율 요청 내용을 입력하세요", "Write your coordination request")} value={coordination.text}
            disabled={busy || targetChanged} maxLength={24000} onChangeText={text => setCoordination({ ...coordination, text })} />
        </PhotoComposer>
        <View style={wrap}>
          <SendButton theme={theme} {...named(busy ? t("전송 중…", "Sending…") : t("코디네이터에 조율 요청 보내기", "Send request to coordinator"))} send={sendCoordination} />
          <Button theme={theme} {...named(t("취소", "Cancel"))} disabled={busy || editorPhotos.reading} onPress={() => { setCoordination(null); setError(null); editorPhotos.clear(); }} />
        </View>
      </View>}
    </>}
    {(formal || !decision || coordination) && clarification}
    <View style={{ alignItems: "flex-start", gap: 4 }}>
      {disclose(showEvidence ? t("근거·이력 접기", "Hide evidence and history") : t("근거·이력 보기", "Evidence and history"), showEvidence, () => setShowEvidence(v => !v))}
      {showEvidence && !!origin && <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("작업 세션", "Work session")} · {origin}</Text>}
      {showEvidence && decision?.recommendationReason && <View style={{ gap: 3 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("추천 이유", "Reason for recommendation")}</Text>
        <HistoryMarkdown theme={theme} source={decision.recommendationReason} />
      </View>}
      {showEvidence && sourceExcerpts.map(text => <HistoryMarkdown key={text} theme={theme} source={text} muted />)}
      {showEvidence && renderClarification?.("history")}
    </View>
    {receipt && <ReceiptText receipt={receipt} theme={theme} />}
    {!!error && <Text accessibilityLiveRegion="polite" selectable style={{ color: c.statusDanger }}>{t(...error)}</Text>}
  </View>;
}
