import { useSettings } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { permissionAutoApprove, type AutoApprovalEntry } from "../shared/permission-auto-approve";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { approvalLine, autoApproveExplanation, autoApproveUnsupported } from "./permission-auto-approve";

// The switch is a host setting only a person changes here. The plugin server reads it and cannot write it.
export function PermissionAutoApproveSetting({ theme, view, onSaved }: {
  theme: Theme; view?: { supported: boolean; entries: AutoApprovalEntry[] }; onSaved: () => void;
}) {
  const { t, language } = useBoardLanguage();
  const c = theme.colors;
  const state = useSettings(permissionAutoApprove);
  const [conflict, setConflict] = useState(false);
  const [limit, setLimit] = useState(5);
  const on = state.status === "ready" && state.values.readOnlyShell;
  const save = async (value: boolean) => {
    if (state.status !== "ready" || state.saving) return;
    setConflict(false);
    if (await state.save({ readOnlyShell: value }, state.revision)) onSaved();
    else {
      setConflict(true);
      await state.reload();
    }
  };
  const entries = view?.entries ?? [];
  const title = t("읽기 전용 명령만 자동 승인", "Auto-approve read-only commands only");
  return <View style={{ gap: 8 }}>
    <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }}>{t("권한 요청 자동 승인", "Permission auto-approval")}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
      <Button theme={theme} toggle selected={on} disabled={state.status !== "ready" || state.saving}
        label={title + " · " + (on ? t("켜짐", "On") : t("꺼짐", "Off"))} accessibilityLabel={title} onPress={() => void save(!on)} />
    </View>
    <Text style={{ color: c.foregroundMuted }}>{autoApproveExplanation(t)}</Text>
    {view && !view.supported && <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>{autoApproveUnsupported(t)}</Text>}
    {(conflict || state.saveError || state.status === "error" || state.status === "invalid") && <View style={{ gap: 6, alignItems: "flex-start" }}>
      <Text accessibilityLiveRegion="polite" style={{ color: c.statusDanger }}>{t("설정을 다시 읽은 뒤 바꿔 주세요.", "Reload the setting and change it again.")}</Text>
      <Button theme={theme} label={t("다시 읽기", "Reload setting")} onPress={() => { setConflict(false); void state.reload(); }} />
    </View>}
    <Text style={{ color: c.foreground, fontWeight: "600" }}>{t(`최근 자동 승인 · ${entries.length}건`, `Recent auto-approvals · ${entries.length}`)}</Text>
    {!entries.length && <Text style={{ color: c.foregroundMuted }}>{t("자동 승인한 요청이 없습니다.", "No request has been auto-approved.")}</Text>}
    {entries.slice(0, limit).map(entry => <View key={JSON.stringify([entry.session, entry.request])}
      style={{ gap: 3, padding: 8, borderRadius: 7, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0 }}>
      <Text selectable style={{ color: c.foreground }}>{entry.title}</Text>
      <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{approvalLine(entry, t, language, Date.now())}</Text>
      <Text selectable style={{ color: c.foregroundMuted, fontSize: 12, fontFamily: "monospace" }}>{entry.command}</Text>
    </View>)}
    {entries.length > limit && <View style={{ alignItems: "flex-start" }}>
      <Button theme={theme} label={t("이전 기록 더 보기", "Show earlier records")} onPress={() => setLimit(count => count + 10)} />
    </View>}
  </View>;
}
