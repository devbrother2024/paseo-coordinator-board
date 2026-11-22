import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Pressable, Text } from "react-native";

export type Theme = PluginScreenProps["theme"];
export function Button({ label, accessibilityLabel, describedBy, onPress, theme, selected = false, disabled = false, toggle = false, expanded }: {
  label: string; accessibilityLabel?: string; describedBy?: string; onPress: () => void; theme: Theme; selected?: boolean; disabled?: boolean; toggle?: boolean; expanded?: boolean;
}) {
  const c = theme.colors;
  return (
    <Pressable accessibilityRole={toggle ? "checkbox" : "button"} aria-checked={toggle ? selected : undefined} aria-expanded={expanded} aria-describedby={describedBy} accessibilityLabel={accessibilityLabel ?? label} accessibilityState={toggle ? { disabled, checked:selected } : { disabled, selected, expanded }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({ borderRadius: 7, paddingHorizontal: 10, paddingVertical: 7, opacity: disabled || pressed ? 0.6 : 1,
        borderWidth: 1, borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.accent : c.surface0 })}>
      <Text style={{ fontSize: 13, fontWeight: "500", color: selected ? c.accentForeground : c.foreground }}>{label}</Text>
    </Pressable>
  );
}

export type SessionChipProps = { label: string; accessibilityLabel: string; onPress: () => void; theme: Theme };

export function SessionChip({ label, accessibilityLabel, onPress, theme }: SessionChipProps) {
  const c = theme.colors;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress}
    style={({ pressed }) => ({ alignSelf: "flex-start", maxWidth: "100%", minHeight: 26, justifyContent: "center",
      paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: c.border, borderRadius: 12,
      backgroundColor: pressed ? c.surface2 : c.surface0 })}>
    <Text style={{ color: c.foreground, fontSize: 12 }}>{label} ›</Text>
  </Pressable>;
}
