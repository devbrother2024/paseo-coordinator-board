import { AutoGrowInput } from "./auto-grow-input";
import type { SendAction } from "./send-input";
import { View } from "react-native";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

type ReplyInputProps = {
  send: SendAction;
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
  onOverflowChange?: (overflows: boolean | undefined) => void;
};

export function DecisionReplyInput({
  theme, value, onChangeText, accessibilityLabel, placeholder, maxLength, disabled, send,
  onFocus, onBlur, reviewRequired = false, onReview, onOverflowChange,
}: ReplyInputProps) {
  const { t } = useBoardLanguage();
  const c = theme.colors;
  // The input grows with the reply. Only a suggested reply too tall for it (it scrolls inside) waits for one press that says it was read.
  const confirmLabel = t("답장 전문 확인", "Confirm full reply");
  return <View style={{ gap: 4 }}>
    <AutoGrowInput send={send} onOverflowChange={onOverflowChange} value={value} onChangeText={onChangeText} multiline editable={!disabled} maxLength={maxLength}
      accessibilityLabel={accessibilityLabel} placeholder={placeholder} placeholderTextColor={c.foregroundMuted}
      onFocus={onFocus} onBlur={onBlur}
      style={{ minHeight: 56, padding: 8, color: c.foreground, textAlignVertical: "top", backgroundColor: c.surface0,
        borderColor: c.border, borderWidth: 1, borderRadius: 7 }} />
    {reviewRequired && <View style={{ alignSelf: "flex-start" }}>
      <Button theme={theme} label={confirmLabel} accessibilityLabel={accessibilityLabel + " · " + confirmLabel}
        disabled={disabled} onPress={() => onReview?.()} />
    </View>}
  </View>;
}
