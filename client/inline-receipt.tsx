import { Pressable, Text, View } from "react-native";
import type { Theme } from "./controls";
import { mergeNotificationLabel } from "./merge-notification";
import type { InlineReceipt } from "./decision-receipts";
import { useBoardLanguage } from "./language";

const statusLabel = {
  merged: ["병합 완료", "Merged"],
  "already-merged": ["이미 병합됨", "Already merged"],
  sent: ["답장 보냄", "Reply sent"],
  saved: ["보드에 저장함", "Saved on board"],
  reviewed: ["확인했어요", "Reviewed"],
  "already-closed": ["이미 처리됨", "Already handled"],
} as const;

export function InlineDecisionReceipt({ receipt, theme, onDismiss }: {
  receipt: InlineReceipt; theme: Theme; onDismiss: () => void;
}) {
  const { t } = useBoardLanguage();
  const c = theme.colors;
  const words = statusLabel[receipt.status];
  const delivery = mergeNotificationLabel(receipt.notification, t);
  return <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 5 }}>
    <View accessibilityLiveRegion="polite" style={{ flex: 1, gap: 2 }}>
      <Text selectable style={{ color: c.foreground, fontSize: 14 }}>
        <Text style={{ color: c.statusSuccess, fontWeight: "600" }}>✓ {t(words[0], words[1])}</Text>
        {"  "}{receipt.title}
      </Text>
      {(!!receipt.detail || !!delivery) && <Text selectable numberOfLines={delivery ? 2 : 1} style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {[delivery, receipt.detail].filter(Boolean).join(" · ")}
      </Text>}
    </View>
    <Pressable accessibilityRole="button" accessibilityLabel={t("결과 숨기기", "Hide result") + " · " + receipt.title} onPress={onDismiss}
      style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.65 : 1 })}>
      <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{t("숨기기", "Hide")}</Text>
    </Pressable>
  </View>;
}
