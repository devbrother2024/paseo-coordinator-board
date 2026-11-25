import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { Pressable, Text, View, type TextStyle, type ViewProps } from "react-native";
import type { ReactNode } from "react";

export type Theme = PluginScreenProps["theme"];
const buttonFrame = { borderRadius: 7, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1 };
const buttonText = { fontSize: 13, fontWeight: "500" as const };
const tabularText: TextStyle = { fontVariant: ["tabular-nums"] };

export function ButtonLabelMeasure({ label, tabularNumbers, onLayout }: { label: string; tabularNumbers?: boolean; onLayout: ViewProps["onLayout"] }) {
  return <View onLayout={onLayout} style={buttonFrame}>
    <Text numberOfLines={1} style={[buttonText, tabularNumbers && tabularText]}>{label}</Text>
  </View>;
}

export function Button({ label, accessibilityLabel, describedBy, onPress, theme, selected = false, disabled = false, toggle = false, expanded, singleLine, tabularNumbers }: {
  label: string; accessibilityLabel?: string; describedBy?: string; onPress: () => void; theme: Theme; selected?: boolean; disabled?: boolean; toggle?: boolean; expanded?: boolean; singleLine?: boolean; tabularNumbers?: boolean;
}) {
  const c = theme.colors;
  return (
    <Pressable accessibilityRole={toggle ? "checkbox" : "button"} aria-checked={toggle ? selected : undefined} aria-expanded={expanded} aria-describedby={describedBy} accessibilityLabel={accessibilityLabel ?? label} accessibilityState={toggle ? { disabled, checked:selected } : { disabled, selected, expanded }} disabled={disabled} onPress={onPress}
      style={({ pressed }) => ({ ...buttonFrame, opacity: disabled || pressed ? 0.6 : 1, borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.accent : c.surface0 })}>
      <Text numberOfLines={singleLine ? 1 : undefined} style={[buttonText, tabularNumbers && tabularText, { color: selected ? c.accentForeground : c.foreground }]}>{label}</Text>
    </Pressable>
  );
}

/** The first line of a decision card: where it comes from, how long it has waited, and a chip that opens its session. */
export function CardHeader({ text, theme, children }: { text: string; theme: Theme; children?: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
    <Text selectable style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1 }}>{text}</Text>
    {children}
  </View>;
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
