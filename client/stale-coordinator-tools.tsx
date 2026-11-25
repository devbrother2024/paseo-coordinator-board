import { Text, View } from "react-native";
import type { CoordinatorTools } from "../shared/coordinator-tools";
import { Button, type Theme } from "./controls";
import { staleToolsNotice } from "./coordinator-tools";
import { useBoardLanguage } from "./language";

// The notice at the top of the board when the coordinator's conversation holds tool definitions older
// than this board works with. Opening the session comes first; replacing it is the last resort.
export function StaleCoordinatorTools({ tools, theme, onReplace, onOpen }: {
  tools: CoordinatorTools | undefined; theme: Theme; onReplace?: () => void; onOpen?: () => void;
}) {
  const { t } = useBoardLanguage();
  const notice = staleToolsNotice(tools, t);
  if (!notice) return null;
  const c = theme.colors;
  return <View accessibilityRole="alert" accessibilityLiveRegion="polite"
    style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: c.statusWarning, borderRadius: 10, backgroundColor: c.surface1 }}>
    <Text selectable style={{ color: c.statusWarning, fontWeight: "600", fontSize: 15 }}>{notice.title}</Text>
    <Text selectable style={{ color: c.foreground, fontSize: 14 }}>{notice.effect}</Text>
    {notice.steps.map((step, index) => <Text key={index} selectable style={{ color: c.foreground, fontSize: 14 }}>{index + 1}. {step}</Text>)}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {onOpen && <Button theme={theme} selected label={t("코디네이터 세션 열기", "Open coordinator session")} onPress={onOpen} />}
      {onReplace && <Button theme={theme} label={t("새 세션으로 교체", "Replace with a new session")} onPress={onReplace} />}
    </View>
  </View>;
}
