import { useSettings } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { DEFAULT_STALE_HOURS, reviewWaitSetting } from "../shared/review-wait";

const choices = [6, 12, 24, 48] as const;

export function ReviewWaitSetting({ theme, onSaved }: { theme: Theme; onSaved: () => void }) {
  const { t } = useBoardLanguage();
  const state = useSettings(reviewWaitSetting);
  const [conflict, setConflict] = useState(false);
  const current = state.status === "ready" ? state.values.staleHours : DEFAULT_STALE_HOURS;
  const save = async (hours: number) => {
    if (state.status !== "ready" || state.saving || hours === current) return;
    setConflict(false);
    if (await state.save({ staleHours: hours }, state.revision)) onSaved();
    else {
      setConflict(true);
      await state.reload();
    }
  };
  return <View style={{ gap: 8 }}>
    <Text accessibilityRole="header" style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "600" }}>{t("코디네이터 미처리 표시", "Not handled by coordinator")}</Text>
    <Text style={{ color: theme.colors.foregroundMuted }}>
      {t("확인 대기 세션이 이 시간 넘게 쉬고, 원장 카드도 코디네이터의 메시지나 판단도 없으면 카드에 표시합니다. 코디네이터가 없으면 표시하지 않습니다.",
        "Flags a session in Awaiting review that has rested longer than this with no ledger card and no message or assessment from the coordinator. Without a coordinator, nothing is flagged.")}
    </Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {(choices.includes(current as typeof choices[number]) ? choices : [...choices, current].sort((a, b) => a - b)).map(hours =>
        <Button theme={theme} key={hours} label={t(`${hours}시간`, `${hours} h`)} selected={hours === current}
          disabled={state.status !== "ready" || state.saving} onPress={() => void save(hours)} />)}
    </View>
    {(conflict || state.saveError || state.status === "error" || state.status === "invalid") && <View style={{ gap: 6 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusDanger }}>{t("설정을 다시 읽은 뒤 골라 주세요.", "Reload the setting and choose again.")}</Text>
      <Button theme={theme} label={t("다시 읽기", "Reload setting")} onPress={() => { setConflict(false); void state.reload(); }} />
    </View>}
  </View>;
}
