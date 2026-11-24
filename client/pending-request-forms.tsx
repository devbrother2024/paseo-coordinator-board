import { getPaseoClient } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { Button, type Theme } from "./controls";
import { useDecisionInteraction } from "./decision-editing";
import { HistoryMarkdown } from "./history-markdown";
import { useBoardLanguage } from "./language";
import {
  actionLabel, actionResponse, answerResponse, buildAnswers, canSubmit, createResponder, dismissResponse, emptyDraft,
  outcomeText, requestName, requestView, showsTextInput, toggleOption, waitingLine, writeOther,
  type Outcome, type PendingRequest, type PermissionResponse, type PlanAction, type Question,
} from "./pending-requests";

const wrap = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };
// What the board shows for a request that left the card: answered here, or found already handled.
// The text sent to the session is never built from this.
export type AnsweredRequest = { title: string; detail: string; handled: boolean };
type Send = (response: PermissionResponse, detail: string) => void;
type Responder = ReturnType<typeof createResponder>;
type Result = { line: string; outcome: Outcome; detail: string };

export function PendingRequests({ hostId, sessionId, sessionTitle, version, theme, open, onAnswered, onRefresh }: {
  hostId: string; sessionId: string; sessionTitle: string; version?: string; theme: Theme;
  open?: (id: string) => void; onAnswered?: (result: AnsweredRequest) => void; onRefresh: () => void;
}) {
  const { t } = useBoardLanguage();
  const c = theme.colors;
  const [requests, setRequests] = useState<PendingRequest[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Record<string, Result>>({});
  const reading = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // One responder for the life of this card, so a request it answered is never sent twice.
  const link = useRef<{ key: string; agent: ReturnType<ReturnType<typeof getPaseoClient>["agents"]["ref"]>; responder: Responder } | null>(null);
  function connect() {
    const key = JSON.stringify([hostId, sessionId]);
    if (link.current?.key !== key) {
      const agent = getPaseoClient(hostId).agents.ref(sessionId);
      link.current = { key, agent, responder: createResponder(agent) };
    }
    return link.current;
  }

  async function load() {
    const token = ++reading.current;
    setFailed(false);
    try {
      const result = await connect().agent.refresh();
      if (mounted.current && token === reading.current) setRequests(result?.agent.pendingPermissions ?? []);
    } catch {
      if (mounted.current && token === reading.current) setFailed(true);
    }
  }
  useEffect(() => { void load(); return () => { reading.current++; }; }, [hostId, sessionId, version]);

  // Runs only from a button the person pressed. Nothing here answers on its own.
  async function settle(request: PendingRequest, detail: string, work: (responder: Responder) => Promise<Outcome>) {
    const line = requestName(request, t);
    setBusy(true);
    let outcome: Outcome;
    try { outcome = await work(connect().responder); } catch { outcome = "failed"; }
    // A second press while one response is in flight changes nothing, including the busy state.
    if (!mounted.current || outcome === "busy") return;
    setBusy(false);
    setResults(previous => ({ ...previous, [request.id]: { line, outcome, detail } }));
    if (outcome === "failed") return;
    if (outcome === "sent" || outcome === "handled") onAnswered?.({ title: line, detail: outcome === "sent" ? detail : "", handled: outcome === "handled" });
    void load();
    onRefresh();
  }

  const openSession = open && <Button theme={theme} label={t("작업 세션 열기", "Open work session")}
    accessibilityLabel={sessionTitle + " · " + t("작업 세션 열기", "Open work session")} onPress={() => open(sessionId)} />;
  const settled = Object.entries(results).filter(([id, result]) =>
    (result.outcome === "sent" || result.outcome === "handled") && !requests?.some(request => request.id === id));
  if (failed) return <View style={{ gap: 6 }}>
    <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>{t("요청 내용을 읽지 못했습니다. 작업 세션에서 확인해 주세요.", "Could not load the request. Review it in the work session.")}</Text>
    <View style={wrap}><Button theme={theme} label={t("요청 다시 읽기", "Reload request")} onPress={() => void load()} />{openSession}</View>
  </View>;
  if (!requests) return <Text style={{ color: c.foregroundMuted }}>{t("요청 내용을 읽는 중…", "Loading the request…")}</Text>;
  return <View style={{ gap: 10 }}>
    {settled.map(([id, result]) => <Text key={id} accessibilityLiveRegion="polite" selectable
      style={{ color: result.outcome === "sent" ? c.statusSuccess : c.foregroundMuted }}>{result.line} · {outcomeText(result.outcome, t)}</Text>)}
    {!requests.length && !settled.length && <Text style={{ color: c.foregroundMuted }}>
      {t("승인 요청은 작업 세션에서 확인해 주세요.", "Review the approval request in the work session.")}
    </Text>}
    {requests.map((request, index) => <View key={request.id} style={{ gap: 7, ...(index > 0 && { paddingTop: 10, borderTopWidth: 1, borderColor: c.border }) }}>
      <RequestForm request={request} theme={theme} sessionTitle={sessionTitle} busy={busy} outcome={results[request.id]?.outcome}
        openSession={openSession} onSend={(response, detail) => void settle(request, detail, responder => responder.respond(request.id, response))}
        onCheck={() => void settle(request, results[request.id]?.detail ?? "", responder => responder.check(request.id))} />
    </View>)}
  </View>;
}

function RequestForm({ request, theme, sessionTitle, busy, outcome, openSession, onSend, onCheck }: {
  request: PendingRequest; theme: Theme; sessionTitle: string; busy: boolean; outcome?: Outcome; openSession: ReactNode; onSend: Send; onCheck: () => void;
}) {
  const { t } = useBoardLanguage();
  const c = theme.colors;
  const view = useMemo(() => requestView(request), [request]);
  // A response that went out is not sent again. Checking again only reads whether the session took it.
  const locked = busy || outcome === "sent" || outcome === "handled" || outcome === "unconfirmed";
  const status = outcome && outcome !== "busy" && <View style={{ gap: 6 }}>
    <Text accessibilityLiveRegion="polite" selectable style={{ color: outcome === "sent" ? c.statusSuccess : outcome === "failed" ? c.statusDanger : c.statusWarning }}>{outcomeText(outcome, t)}</Text>
    {outcome === "unconfirmed" && <View style={wrap}>
      <Button theme={theme} label={t("다시 확인", "Check again")} accessibilityLabel={sessionTitle + " · " + t("응답 처리 다시 확인", "Check the response again")}
        disabled={busy} onPress={onCheck} />
      {openSession}
    </View>}
  </View>;
  return <>
    {view.mode !== "question" && <Text selectable style={{ color: c.foregroundMuted, fontSize: 13 }}>{waitingLine(request, t)}</Text>}
    {view.mode === "question" && <QuestionForm key={request.id} request={request} questions={view.questions} theme={theme} sessionTitle={sessionTitle} locked={locked} busy={busy} onSend={onSend} />}
    {view.mode === "plan" && <PlanForm plan={view.plan} actions={view.actions} theme={theme} sessionTitle={sessionTitle} locked={locked} onSend={onSend} />}
    {view.mode === "session" && <>
      <Text style={{ color: c.foregroundMuted }}>{t("이 요청은 내용을 꼼꼼히 봐야 해서 작업 세션에서 답합니다.", "This request needs a close look, so answer it in the work session.")}</Text>
      <View style={wrap}>{openSession}</View>
    </>}
    {status}
  </>;
}

function QuestionForm({ request, questions, theme, sessionTitle, locked, busy, onSend }: {
  request: PendingRequest; questions: Question[]; theme: Theme; sessionTitle: string; locked: boolean; busy: boolean; onSend: Send;
}) {
  const { t } = useBoardLanguage();
  const c = theme.colors;
  const [draft, setDraft] = useState(() => emptyDraft(questions));
  const edited = draft.selected.some(list => list.length) || draft.other.some(Boolean);
  const focus = useDecisionInteraction(edited || busy);
  const ready = canSubmit(questions, draft);
  return <View style={{ gap: 10 }}>
    {questions.map((question, index) => <View key={question.header} style={{ gap: 6 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{[question.header, question.multiSelect && t("여러 개 선택 가능", "Select all that apply")].filter(Boolean).join(" · ")}</Text>
      <Text selectable accessibilityRole="header" style={{ color: c.foreground, fontSize: 14, fontWeight: "600", lineHeight: 21 }}>{question.question}</Text>
      <View accessibilityRole={question.multiSelect ? undefined : "radiogroup"} accessibilityLabel={question.question} style={{ gap: 6 }}>
        {question.options.map((option, position) => {
          const checked = draft.selected[index].includes(position);
          return <Pressable key={position} accessibilityRole={question.multiSelect ? "checkbox" : "radio"} aria-checked={checked}
            accessibilityLabel={[question.header, option.label, option.description].filter(Boolean).join(" · ")}
            accessibilityState={{ checked, disabled: locked }} disabled={locked}
            onPress={() => setDraft(current => toggleOption(questions, current, index, position))}
            style={({ pressed }) => ({ flexDirection: "row", gap: 8, padding: 8, borderWidth: 1, borderRadius: 7, opacity: locked || pressed ? 0.6 : 1,
              borderColor: checked ? c.accent : c.border, backgroundColor: c.surface0 })}>
            <Text style={{ color: checked ? c.accent : c.foregroundMuted, fontSize: 14, lineHeight: 20 }}>{question.multiSelect ? (checked ? "☑" : "☐") : (checked ? "◉" : "○")}</Text>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text style={{ color: c.foreground, fontSize: 14, lineHeight: 20, fontWeight: checked ? "600" : "400" }}>{option.label}</Text>
              {!!option.description && <Text style={{ color: c.foregroundMuted, fontSize: 13, lineHeight: 19 }}>{option.description}</Text>}
              {!!option.preview && <Text selectable style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 18 }}>{option.preview}</Text>}
            </View>
          </Pressable>;
        })}
      </View>
      {showsTextInput(question) && <TextInput {...focus} value={draft.other[index]} editable={!locked} multiline maxLength={4000}
        onChangeText={value => setDraft(current => writeOther(questions, current, index, value))}
        accessibilityLabel={question.header + " · " + (question.options.length ? t("기타 직접 입력", "Other, type your own answer") : t("답 입력", "Type your answer"))}
        placeholder={question.placeholder ?? (question.options.length ? t("기타: 직접 입력", "Other: type your own answer") : t("답을 입력하세요", "Type your answer"))}
        placeholderTextColor={c.foregroundMuted}
        style={{ minHeight: 40, padding: 8, color: c.foreground, textAlignVertical: "top", backgroundColor: c.surface0, borderColor: c.border, borderWidth: 1, borderRadius: 7 }} />}
    </View>)}
    <View style={{ ...wrap, alignItems: "center" }}>
      <Button theme={theme} label={busy ? t("보내는 중…", "Sending…") : t("답 제출", "Submit answer")} selected={ready && !locked}
        accessibilityLabel={sessionTitle + " · " + t("질문에 답 제출", "Submit answer to the question")} disabled={locked || !ready}
        onPress={() => onSend(answerResponse(request, questions, draft), Object.values(buildAnswers(questions, draft)).filter(Boolean).join(" · "))} />
      <Button theme={theme} label={t("답하지 않고 닫기", "Dismiss without answering")}
        accessibilityLabel={sessionTitle + " · " + t("질문에 답하지 않고 닫기", "Dismiss the question without answering")} disabled={locked}
        onPress={() => onSend(dismissResponse(request, questions, draft), t("답하지 않고 닫음", "Dismissed without answering"))} />
    </View>
    {!ready && !locked && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{questions.length > 1
      ? t("모든 질문에 답하면 제출할 수 있습니다.", "Answer every question to submit.") : t("선택하거나 입력하면 제출할 수 있습니다.", "Choose or type an answer to submit.")}</Text>}
  </View>;
}

function PlanForm({ plan, actions, theme, sessionTitle, locked, onSend }: {
  plan: string; actions: PlanAction[]; theme: Theme; sessionTitle: string; locked: boolean; onSend: Send;
}) {
  const { t } = useBoardLanguage();
  const c = theme.colors;
  const [shown, setShown] = useState(false);
  const label = shown ? t("계획 접기", "Hide plan") : t("계획 전문 보기", "View full plan");
  return <View style={{ gap: 8 }}>
    {shown ? <View style={{ padding: 8, borderWidth: 1, borderColor: c.border, borderRadius: 7, backgroundColor: c.surface0 }}><HistoryMarkdown theme={theme} source={plan} /></View>
      : <HistoryMarkdown theme={theme} source={plan} preview muted />}
    <View style={wrap}>
      <Button theme={theme} label={label} accessibilityLabel={sessionTitle + " · " + label} expanded={shown} onPress={() => setShown(!shown)} />
    </View>
    <View style={wrap}>
      {actions.map(action => <Button key={action.id} theme={theme} label={actionLabel(action, t)}
        accessibilityLabel={sessionTitle + " · " + actionLabel(action, t)} disabled={locked}
        onPress={() => onSend(actionResponse(action), actionLabel(action, t))} />)}
    </View>
  </View>;
}
