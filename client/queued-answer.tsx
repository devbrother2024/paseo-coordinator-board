import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { canResumeHeldReply, manageQueuedAnswer, parallelWait, type QueueAction, type QueueRef, type QueueView } from "../shared/busy-delivery";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

export function QueuedAnswer({queue, card, theme, onRefresh, onCancel}:{
  queue:QueueView; card:QueueRef; theme:Theme; onRefresh:()=>void|Promise<void>; onCancel?:()=>void|Promise<void>;
}) {
  const {t} = useBoardLanguage();
  const manage = useRpc(manageQueuedAnswer);
  const [notice,setNotice] = useState("");
  const pending = useRef(false);
  const [busy,setBusy] = useState(false);
  const elapsed = queue.at && Math.max(0,Math.floor((Date.now()-Date.parse(queue.at))/60000));
  async function apply(action:QueueAction["action"]) {
    if (pending.current) return;
    pending.current=true; setBusy(true); setNotice("");
    try {
      if (action==="cancel" && onCancel) { await onCancel(); return; }
      const {status}=await manage({card,messageId:queue.messageId,action,coordinatorId:queue.coordinatorId});
      if (status==="unconfirmed") setNotice(t("요청 도착 여부를 코디네이터에서 확인해 주세요.","Check with the coordinator whether the request arrived."));
      if (status==="unavailable") setNotice(t("코디네이터가 지금 요청을 받을 수 없습니다.","The coordinator is unavailable."));
      if (status==="changed") setNotice(t("카드가 바뀌었습니다. 최신 상태를 확인해 주세요.","The card changed. Check its current state."));
      await onRefresh();
    } catch { setNotice(t("결과를 확인할 수 없습니다. 보드를 새로 고쳐 주세요.","Could not confirm the result. Refresh the board.")); }
    finally { pending.current=false; setBusy(false); }
  }
  const canResume = canResumeHeldReply(queue);
  const label=queue.parallel==="held" && queue.originState==="ended" ? t("보류 · 원래 세션 끝남","On hold · Original session ended")
    : queue.parallel==="held" && queue.originState==="unknown" ? t("보류 · 원래 세션 상태를 확인할 수 없습니다.","On hold · Original session status unavailable.")
    : queue.stopped ? t("자동 전송 중단 · 최신 카드를 확인해 주세요.","Delivery stopped · Check the latest card.")
    : queue.parallel==="held" ? t("병렬 검토 중 · 코디네이터의 결과를 확인한 뒤 원래 예약을 취소하거나 재개하세요.",
      "Parallel review · Check the coordinator’s result, then cancel or resume the original reply.")
    : t("세션이 준비되면 자동으로 보냅니다.","Sends when the session is ready.");
  return <View style={{gap:6,padding:10,borderRadius:7,backgroundColor:theme.colors.surface0}}>
    <Text accessibilityLiveRegion="polite" style={{color:theme.colors.foreground,fontWeight:"600"}}>
      {typeof elapsed==="number" ? t(`대기 ${elapsed}분`,`Queued ${elapsed} min`) : t("전송 대기","Queued")} · {label}
    </Text>
    {!!queue.answer && <Text selectable style={{color:theme.colors.foreground}}>{queue.answer}</Text>}
    {!!queue.imageCount && <Text style={{color:theme.colors.foregroundMuted}}>{t(`첨부 사진 ${queue.imageCount}장`,`Attached photos · ${queue.imageCount}`)}</Text>}
    {canResume && <Text style={{color:theme.colors.statusWarning}}>{t(
      "코디네이터가 새 세션에 맡겼다면 재개할 때 같은 답이 두 번 처리됩니다. 코디네이터의 결과를 확인한 뒤 재개하세요.",
      "If the coordinator assigned this to another session, resuming will process the same reply twice. Check the coordinator’s result before resuming.")}</Text>}
    <View style={{flexDirection:"row",flexWrap:"wrap",gap:6}}>
      {queue.offer && <Button theme={theme} label={t("병렬 세션으로 맡기기","Request a parallel session")} disabled={busy || !queue.coordinatorId} onPress={()=>void apply("parallel")} />}
      {canResume && <Button theme={theme} label={t("원래 전송 재개","Resume original reply")} disabled={busy} onPress={()=>void apply("resume")} />}
      <Button theme={theme} label={t("전송 대기 취소","Cancel queued reply")} disabled={busy} onPress={()=>void apply("cancel")} />
    </View>
    {queue.offer && !queue.coordinatorId && <Text style={{color:theme.colors.foregroundMuted}}>{t("요청을 받을 코디네이터를 확인해 주세요.","Check which coordinator can receive the request.")}</Text>}
    {!!notice && <Text accessibilityLiveRegion="polite" style={{color:theme.colors.statusWarning}}>{notice}</Text>}
  </View>;
}

export function ParallelWaitSetting({theme,onSaved}:{theme:Theme;onSaved:()=>void}) {
  const {t}=useBoardLanguage();
  const settings=useSettings(parallelWait);
  const [failed,setFailed]=useState(false);
  async function save(minutes:number) {
    if (settings.status!=="ready") return;
    const ok=await settings.save({minutes},settings.revision);
    setFailed(!ok);
    if (ok) onSaved(); else await settings.reload();
  }
  return <View style={{gap:6}}>
    <Text accessibilityRole="header" style={{color:theme.colors.foreground,fontWeight:"600"}}>{t("병렬 세션 버튼을 표시할 대기 시간","Wait before offering a parallel session")}</Text>
    <View style={{flexDirection:"row",flexWrap:"wrap",gap:6}}>{[5,10,20,30].map(n=>
      <Button key={n} theme={theme} label={t(`${n}분`,`${n} min`)} selected={settings.status==="ready" && settings.values.minutes===n}
        disabled={settings.status!=="ready" || settings.saving} onPress={()=>void save(n)} />)}</View>
    {failed && <Text accessibilityLiveRegion="polite" style={{color:theme.colors.statusWarning}}>{t("설정을 다시 확인해 주세요.","Check the setting and try again.")}</Text>}
  </View>;
}
