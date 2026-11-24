import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { factReplySettings, setFactAutoReply } from "../shared/board-facts";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

export function FactReplyControls({ theme }: { theme: Theme }) {
  const { t } = useBoardLanguage();
  const read = useRpc(factReplySettings);
  const write = useRpc(setFactAutoReply);
  const get = useRef(read);
  get.current = read;
  const mounted = useRef(false);
  const pending = useRef(false);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  async function refresh(next?: boolean) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      if (next !== undefined) await write({ enabled: next });
      const settings = await get.current({});
      if (mounted.current) { setEnabled(settings.enabled); setFailed(false); }
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);
  const c = theme.colors;
  return <View style={{ gap: 8, padding: 14, borderRadius: 10, backgroundColor: c.surface1 }}>
    <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }}>{t("사실 질문 자동 답장", "Automatic replies to factual questions")}</Text>
    <Text style={{ color: c.foregroundMuted }}>{t("다이제스트를 요청하면 코디네이터가 보드에서 확인한 프로젝트 소속이나 세션 상태를 작업 세션에 알려 줍니다.", "When you request a digest, the coordinator can tell the work session its verified project or status.")}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
      {failed ? <Button theme={theme} label={t("설정 다시 읽기", "Reload setting")} disabled={busy} onPress={() => void refresh()} />
        : <Button theme={theme} label={enabled === null ? t("설정 조회 중…", "Loading setting…") : enabled ? t("자동 답장 켜짐 · 끄기", "Automatic replies on · Turn off") : t("자동 답장 꺼짐 · 켜기", "Automatic replies off · Turn on")}
          selected={enabled === true} disabled={busy || enabled === null} onPress={() => void refresh(!enabled)} />}
    </View>
  </View>;
}
