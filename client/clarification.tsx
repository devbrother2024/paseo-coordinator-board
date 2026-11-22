import { useDecisionInteraction } from "./decision-editing";
import { useRpc } from "@getpaseo/plugin/client";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { askClarification, clarificationKey, type ClarificationCard, type ClarificationEntry } from "../shared/clarifications";
import type { TrackedDecision } from "../shared/tracked-decisions";
import { Button, type Theme } from "./controls";
import { HistoryMarkdown } from "./history-markdown";
import { useBoardLanguage } from "./language";
import { PhotoComposer, usePhotoDraft } from "./photo-composer";

type Props = {
  card: ClarificationCard | null; title: string; theme: Theme; recipientId: string | null; recipientTitle?: string;
  entries: ClarificationEntry[]; prior?: TrackedDecision["qa"]; onRefresh: () => void; onDraftChange?: (active:boolean) => void;
};

export function Clarification({card,title,theme,recipientId,recipientTitle,entries,prior = [],onRefresh,onDraftChange}:Props) {
  const {t} = useBoardLanguage();
  const ask = useRpc(askClarification);
  const photos = usePhotoDraft();
  const [expanded, setExpanded] = useState(false);
  const [draftTarget, setDraftTarget] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [sent, setSent] = useState<ClarificationEntry[]>([]);
  const [visibleCount, setVisibleCount] = useState(3);
  const sending = useRef(false);
  const retry = useRef({signature:"",key:""});
  const c = theme.colors;
  const label = (ko:string,en:string) => title + " · " + t(ko,en);
  const key = card ? clarificationKey(card) : "";
  const saved = entries.filter(entry => entry.cardKey === key);
  const history = [...saved,...sent.filter(entry => !saved.some(row => row.messageId === entry.messageId))].sort((a,b) => a.at.localeCompare(b.at));
  const hidden = Math.max(0,prior.length+history.length-visibleCount);
  const hasDraft = !!text.trim() || photos.photos.length > 0;
  const editing = hasDraft || photos.reading || busy;
  useDecisionInteraction(expanded || editing);
  useEffect(() => { onDraftChange?.(editing); }, [editing,onDraftChange]);
  // The conversation stays on the ledger card, while each new question binds its current source revision.
  const target = JSON.stringify([card,recipientId]);
  const changed = draftTarget !== target;
  function toggle() {
    if (sending.current || photos.readPending.current) return;
    if (!expanded && !hasDraft) setDraftTarget(target);
    setExpanded(!expanded);
  }
  async function submit() {
    if (!card || !recipientId || changed || sending.current || photos.readPending.current) return;
    const attachments = photos.latest.current;
    const question = text.trim();
    if (!question && !attachments.length) return;
    const signature = JSON.stringify([target,question,attachments.map(p => p.id)]);
    if (retry.current.signature !== signature) retry.current = {signature,key:"ask-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2)};
    sending.current = true; setBusy(true); setError(false);
    try {
      const result = await ask({card,recipientId,question,requestKey:retry.current.key,
        ...(attachments.length ? {images:attachments.map(p => p.image)} : {})});
      if (!result.ok || result.recipientId !== recipientId) throw Error("unconfirmed");
      setSent(previous => [...previous,{cardKey:key,messageId:result.messageId,recipientId,question,at:new Date().toISOString(),status:"sent",imageCount:attachments.length || undefined}]);
      retry.current = {signature:"",key:""}; setText(""); photos.clear(); setExpanded(false);
    } catch { setError(true); }
    finally { sending.current = false; setBusy(false); onRefresh(); }
  }
  return <>
    <Button theme={theme} label={t("질문하기", "Ask a question")} accessibilityLabel={label("질문하기", "Ask a question")}
      expanded={expanded} disabled={busy || photos.reading} onPress={toggle} />
    {expanded && <View style={{width:"100%",gap:6}}>
      {!card || !recipientId ? <Text style={{color:c.foregroundMuted}}>{t("질문을 보낼 세션을 확인할 수 없습니다.", "No verified session is available for this question.")}</Text> : <>
        <Text selectable style={{color:c.foregroundMuted,fontSize:12}}>{t("질문 받을 세션", "Question recipient")} · {recipientTitle || recipientId}</Text>
        {changed && <Button theme={theme} label={t("바뀐 질문과 수신자 확인", "Confirm updated question and recipient")}
          onPress={() => { setDraftTarget(target); setError(false); }} />}
        <PhotoComposer theme={theme} disabled={busy || changed} draft={photos}><TextInput multiline maxLength={4000} editable={!busy}
          accessibilityLabel={label("질문 내용", "Question text")} value={text} onChangeText={setText}
          placeholder={t("결정하기 전에 궁금한 점을 적어 주세요", "What would you like to ask before deciding?")} placeholderTextColor={c.foregroundMuted}
          style={{minHeight:48,color:c.foreground,backgroundColor:c.surface0,padding:8,borderWidth:1,borderColor:c.border,borderRadius:7}} /></PhotoComposer>
        {error && <Text accessibilityLiveRegion="polite" style={{color:c.statusWarning}}>{t("질문 전송을 확인하지 못했습니다. 같은 내용으로 다시 시도해 주세요.","Question delivery is unconfirmed. Retry with the same question.")}</Text>}
        <View style={{alignItems:"flex-start"}}><Button theme={theme} label={t("질문 보내기", "Send question")} accessibilityLabel={label("질문 보내기", "Send question")}
          disabled={busy || photos.reading || changed || !hasDraft} selected onPress={() => void submit()} /></View>
      </>}
    </View>}
    {(history.length > 0 || prior.length > 0) && <View style={{width:"100%",gap:7,padding:8,borderRadius:6,backgroundColor:c.surface0}}>
      <Text accessibilityRole="header" style={{color:c.foreground,fontWeight:"600"}}>{t("문답","Questions and answers")}</Text>
      {hidden > 0 && <Button theme={theme} label={t(`이전 문답 더 보기 · ${hidden}건`, `Show earlier questions · ${hidden}`)} onPress={() => setVisibleCount(count => count + 5)} />}
      {prior.slice(hidden).map((row,index) => <View key={index+hidden} style={{gap:2}}>
        <HistoryMarkdown theme={theme} source={"Q. " + row.q} />
        {row.a ? <HistoryMarkdown theme={theme} source={"A. " + row.a} /> : <Text style={{color:c.foregroundMuted}}>{t("답변 대기","Awaiting reply")}</Text>}
      </View>)}
      {history.slice(Math.max(0,hidden-prior.length)).map(entry => <View key={entry.messageId} style={{gap:2}}>
        {!!entry.question && <HistoryMarkdown theme={theme} source={"Q. " + entry.question} />}
        {!!entry.imageCount && <Text style={{color:c.foregroundMuted,fontSize:12}}>{t(`질문에 첨부한 사진 ${entry.imageCount}장`, `${entry.imageCount} photo(s) attached to question`)}</Text>}
        {entry.response ? <HistoryMarkdown theme={theme} source={"A. " + entry.response} />
          : <Text accessibilityLiveRegion="polite" style={{color:c.foregroundMuted}}>{entry.status === "pending" ? t("전송 확인 중","Confirming delivery") : t("답변 대기","Awaiting reply")}</Text>}
      </View>)}
    </View>}
  </>;
}
