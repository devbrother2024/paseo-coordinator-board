import { useState } from "react";
import { Text, View } from "react-native";
import type { CoordinatorReach } from "../shared/coordinator-reach";
import { Button, type Theme } from "./controls";
import { reachNotice, type ReachRole } from "./coordinator-reach";
import { useBoardLanguage } from "./language";

// Why a session cannot be reached, with the same two actions wherever it is shown:
// the banner at the top of the board and under a session chip that would open an empty screen.
export function ReachExplanation({ reach, role = "coordinator", theme, onReplace, banner = false }: {
  reach: CoordinatorReach | null | undefined; role?: ReachRole; theme: Theme; onReplace?: () => void; banner?: boolean;
}) {
  const { t } = useBoardLanguage();
  const [guide, setGuide] = useState(false);
  const notice = reachNotice(reach, t, role);
  if (!notice) return null;
  const c = theme.colors;
  return <View accessibilityRole={banner ? "alert" : undefined} accessibilityLiveRegion="polite"
    style={banner ? { gap: 8, padding: 12, borderWidth: 1, borderColor: c.statusWarning, borderRadius: 10, backgroundColor: c.surface1 } : { gap: 6, maxWidth: "100%" }}>
    <Text selectable style={{ color: banner ? c.statusWarning : c.foreground, fontWeight: "600", fontSize: banner ? 15 : 13 }}>{notice.title}</Text>
    <Text selectable style={{ color: banner ? c.foreground : c.foregroundMuted, fontSize: banner ? 14 : 12 }}>{notice.effect}</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {/* A check that failed is no reason to nudge someone into replacing a healthy coordinator. */}
      {onReplace && <Button theme={theme} selected={banner && reach?.state !== "unknown"} label={t("새 코디네이터로 교체", "Replace coordinator")} onPress={onReplace} />}
      <Button theme={theme} expanded={guide} label={guide ? t("복구 방법 닫기", "Hide recovery steps") : t("복구 방법 보기", "Show recovery steps")} onPress={() => setGuide(!guide)} />
    </View>
    {guide && notice.steps.map((step, index) => <Text key={index} selectable style={{ color: c.foreground, fontSize: banner ? 14 : 12 }}>{index + 1}. {step}</Text>)}
  </View>;
}
