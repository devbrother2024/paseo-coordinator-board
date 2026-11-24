import { useState } from "react";
import { TextInput } from "@getpaseo/plugin/client/ui";
import { Pressable, Text, View } from "react-native";
import type { Grade, RouteChoice } from "../shared/dispatch";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { modelChoices, pickedRoute, type ModelDirectory } from "./model-choices";

// Search and pick one model for a grade. Used to replace the coordinator and to add a routing candidate.
export function ModelPicker({ data, grade, theme, taken, selected, disabled = false, onPick }: {
  data: ModelDirectory; grade: Grade; theme: Theme; taken?: readonly RouteChoice[];
  selected?: Pick<RouteChoice, "provider" | "model"> | null; disabled?: boolean; onPick: (route: RouteChoice) => void;
}) {
  const { t } = useBoardLanguage();
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(8);
  const c = theme.colors;
  const view = modelChoices(data, grade, query, t, taken);
  let shown = 0;
  return <View style={{ gap: 6 }}>
    <TextInput accessibilityLabel={t("모델 검색", "Search models")} placeholder={t("실행기 또는 모델 검색", "Search providers or models")}
      style={{ color: c.foreground, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0, borderRadius: 6, padding: 8 }}
      placeholderTextColor={c.foregroundMuted} value={query} onChangeText={value => { setQuery(value); setLimit(8); }} />
    {view.hint && <Text style={{ color: c.foregroundMuted }}>{view.hint}</Text>}
    {view.groups.map(group => {
      const rows = group.rows.slice(0, Math.max(0, limit - shown));
      shown += rows.length;
      if (!rows.length) return null;
      return <View key={group.provider} style={{ gap: 6 }}>
        {view.titled && <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingTop: 4 }}>
          <Text accessibilityRole="header" style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{group.label}</Text>
          {group.headroom !== null && <>
            <View accessible accessibilityRole="progressbar" accessibilityLabel={t(group.label + " 남은 사용량", group.label + " remaining usage")}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={group.headroom}
              style={{ width: 72, height: 5, overflow: "hidden", borderRadius: 3, backgroundColor: c.surface2 }}>
              <View style={{ height: "100%", width: `${group.headroom}%`, borderRadius: 3, backgroundColor: group.headroom <= 10 ? c.statusWarning : c.accent }} />
            </View>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t(`${Math.round(group.headroom)}% 남음`, `${Math.round(group.headroom)}% left`)}</Text>
          </>}
        </View>}
        {rows.map(row => {
          const chosen = selected?.provider === row.provider && selected.model === row.model;
          const name = view.titled ? row.label : row.provider + " / " + row.model;
          // The coordinator's row names the model for the next one. The session running now may use another.
          const tags = [row.recommended && t("추천", "Recommended"),
            row.current && (grade === "M" ? t("다음 교체에 씀", "Used for the next replacement") : t("사용 중", "In use"))].filter(Boolean).join(" · ");
          return <Pressable key={row.model} accessibilityRole="button"
            accessibilityLabel={[row.provider + " / " + row.model, tags, row.disabled].filter(Boolean).join(" · ")}
            accessibilityState={{ disabled: !!row.disabled || disabled, selected: chosen }} disabled={!!row.disabled || disabled}
            onPress={() => { const route = pickedRoute(data, grade, row.provider, row.model); if (route) onPick(route); }}
            style={({ pressed }) => ({ gap: 2, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderRadius: 7,
              borderColor: chosen ? c.accent : c.border, backgroundColor: chosen ? c.accent : c.surface0, opacity: row.disabled ? 0.5 : pressed ? 0.6 : 1 })}>
            <Text style={{ color: chosen ? c.accentForeground : c.foreground, fontSize: 13, fontWeight: "500" }}>{name}{tags ? " · " + tags : ""}</Text>
            {row.disabled && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{row.disabled}</Text>}
          </Pressable>;
        })}
      </View>;
    })}
    {view.count > limit && <View style={{ flexDirection: "row" }}><Button theme={theme} label={t("모델 더 보기", "Show more models")} onPress={() => setLimit(limit + 12)} /></View>}
    {view.unavailable.map(item => <Text key={item.provider} style={{ color: c.foregroundMuted, fontSize: 12, opacity: 0.7 }}>{item.label} · {item.reason}</Text>)}
  </View>;
}
