import { TextInput } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { useWindowDimensions, View } from "react-native";
import { Button, type Theme } from "./controls";
import { isLongReply } from "./decision-reply-state";
import { useBoardLanguage } from "./language";

type ReplyInputProps = {
  theme: Theme;
  value: string;
  onChangeText: (value: string) => void;
  accessibilityLabel: string;
  placeholder: string;
  maxLength: number;
  disabled: boolean;
  onFocus: () => void;
  onBlur: () => void;
  reviewRequired?: boolean;
  onReview?: () => void;
};

export function DecisionReplyInput({
  theme, value, onChangeText, accessibilityLabel, placeholder, maxLength, disabled,
  onFocus, onBlur, reviewRequired = false, onReview,
}: ReplyInputProps) {
  const { t } = useBoardLanguage();
  const { height } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  const long = isLongReply(value);
  const showFull = long && expanded && !reviewRequired;
  const toggleLabel = showFull ? t("입력창 접기", "Collapse editor") : t("답장 전문 보기", "View full reply");
  const c = theme.colors;
  return <View style={{ gap: 4 }}>
    <TextInput value={value} onChangeText={onChangeText} multiline editable={!disabled} maxLength={maxLength}
      accessibilityLabel={accessibilityLabel} placeholder={placeholder} placeholderTextColor={c.foregroundMuted}
      onFocus={onFocus} onBlur={onBlur}
      style={{ minHeight: 56, height: showFull ? Math.max(168, Math.min(480, height * 0.48)) : undefined,
        padding: 8, color: c.foreground, textAlignVertical: "top", backgroundColor: c.surface0,
        borderColor: c.border, borderWidth: 1, borderRadius: 7 }} />
    {long && <View style={{ alignSelf: "flex-start" }}>
      <Button theme={theme} label={toggleLabel} accessibilityLabel={accessibilityLabel + " · " + toggleLabel}
        expanded={showFull} disabled={disabled} onPress={() => {
          setExpanded(!showFull);
          if (!showFull) onReview?.();
        }} />
    </View>}
  </View>;
}
