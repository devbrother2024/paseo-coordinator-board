import { useState } from "react";
import { Platform, ScrollView, Text, View } from "react-native";
import { permissionGroup, permissionHeading, type PermissionSummary } from "../shared/permission-summary";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

export function PermissionRequestSummary({ summary, theme }: { summary: PermissionSummary; theme: Theme }) {
  const { t } = useBoardLanguage();
  const [expanded, setExpanded] = useState(false);
  const c = theme.colors;
  const title = permissionHeading(summary, t);
  const destructive = summary.risk === "destructive" || summary.kind === "shell" && summary.groups.some(group => group.risk === "destructive");
  const warning = ["unknown", "execute", "sensitive-read", "outside-read"].includes(summary.risk);
  const color = destructive ? c.statusDanger : warning ? c.statusWarning : c.foreground;
  const label = expanded ? t("명령 전문 접기", "Hide full command") : t("명령 전문 보기", "View full command");
  const groupLimit = 12;
  return <View style={{ gap: 7, minWidth: 0 }}>
    <Text selectable accessibilityRole="header" style={{ color, fontWeight: "600", fontSize: 14, lineHeight: 20 }}>{title}</Text>
    {summary.readPathsUnresolved && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
      {t("심볼릭 링크 대상 미확인", "Symbolic link targets unverified")}
    </Text>}
    {summary.kind === "shell" && <>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
        {summary.groups.slice(0, groupLimit).map((group, index) =>
          <Text selectable key={index} style={{ color: c.foregroundMuted, fontSize: 12, lineHeight: 17, maxWidth: "100%", paddingHorizontal: 7, paddingVertical: 3,
            borderWidth: 1, borderColor: c.border, borderRadius: 5 }}>{permissionGroup(group, t)}</Text>)}
      </View>
      {summary.groups.length > groupLimit && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {t(`외 ${summary.groups.length - groupLimit}개 명령 묶음`, `${summary.groups.length - groupLimit} more command groups`)}
      </Text>}
      <View style={{ alignSelf: "flex-start" }}>
        <Button theme={theme} label={label} expanded={expanded} onPress={() => setExpanded(value => !value)} />
      </View>
      {expanded && <ScrollView horizontal keyboardShouldPersistTaps="handled"
        style={{ backgroundColor: c.surface0, borderWidth: 1, borderColor: c.border, borderRadius: 7, maxWidth: "100%" }}
        contentContainerStyle={{ padding: 8 }}>
        <Text selectable style={{ color: c.foreground, fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace", fontSize: 12, lineHeight: 18, fontWeight: "400" }}>{summary.command}</Text>
      </ScrollView>}
    </>}
  </View>;
}
