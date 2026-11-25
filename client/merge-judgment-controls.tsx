import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { mergeJudgmentSettings, setMergeJudgment } from "../shared/prs";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

export function MergeJudgmentControls({ theme }: { theme: Theme }) {
  const { t } = useBoardLanguage();
  const read = useRpc(mergeJudgmentSettings);
  const write = useRpc(setMergeJudgment);
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
    <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }}>{t("코디네이터가 확인한 PR만 병합 카드로", "Merge cards only for PRs the coordinator checked")}</Text>
    <Text style={{ color: c.foregroundMuted }}>{t("켜면 GitHub에서 병합할 수 있는 PR도 코디네이터가 현재 커밋을 확인해 준비됨으로 판단해야 내 결정에 뜹니다. 새 커밋이 올라오면 다시 확인합니다. 코디네이터를 지정하지 않은 동안에는 GitHub 상태만으로 띄우되, 현재 커밋에 준비되지 않았다는 판단이 있으면 진행 칸에 둡니다. 끄면 GitHub 상태만으로 띄웁니다.", "When on, a PR that GitHub can merge appears in My decisions only after the coordinator checks its current commit and judges it ready. New commits need another check. With no coordinator, GitHub status decides unless the current commit has a verdict other than ready. When off, GitHub status alone decides.")}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap" }}>
      {failed ? <Button theme={theme} label={t("설정 다시 읽기", "Reload setting")} disabled={busy} onPress={() => void refresh()} />
        : <Button theme={theme} label={enabled === null ? t("설정 조회 중…", "Loading setting…") : enabled ? t("코디네이터 확인 켜짐 · 끄기", "Coordinator check on · Turn off") : t("코디네이터 확인 꺼짐 · 켜기", "Coordinator check off · Turn on")}
          selected={enabled === true} disabled={busy || enabled === null} onPress={() => void refresh(!enabled)} />}
    </View>
  </View>;
}
