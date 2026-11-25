import { Text, View } from "react-native";
import { coordinatorWaitLabel, isLongCoordinatorWait, type CoordinatorWaitReason } from "../shared/coordinator-wait";
import { waitedLabel } from "../shared/review-wait";
import { SessionChip, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

export function CoordinatorWaitStatus({ reason, since, now, open, theme }: {
  reason: CoordinatorWaitReason; since?: string; now: number; open?: () => void; theme: Theme;
}) {
  const { t } = useBoardLanguage();
  const long = isLongCoordinatorWait(since, now);
  const waited = long ? waitedLabel(since, now, t) : "";
  const openLabel = t("코디네이터 열기", "Open coordinator");
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 4 }}>
    <Text style={{ flexShrink: 1, color: long ? theme.colors.statusWarning : theme.colors.foreground, fontSize: 12,
      fontWeight: long ? "700" : "500" }}>
      {coordinatorWaitLabel(reason, t)}{waited ? " · " + waited : ""}
    </Text>
    {long && open && <SessionChip theme={theme} label={openLabel} accessibilityLabel={openLabel} onPress={open} />}
  </View>;
}
