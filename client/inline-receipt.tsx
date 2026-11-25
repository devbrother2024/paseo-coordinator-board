import { Pressable, Text, View } from "react-native";
import { SessionChip, type Theme } from "./controls";
import { mergeNotificationLabel } from "./merge-notification";
import type { InlineReceipt } from "./decision-receipts";
import { useBoardLanguage } from "./language";

const statusLabel = {
  merged: ["병합 완료", "Merged"],
  "already-merged": ["이미 병합됨", "Already merged"],
  sent: ["답장 보냄", "Reply sent"],
  "already-closed": ["이미 처리됨", "Already handled"],
  unsent: ["보내지 못한 답", "Reply not sent"],
} as const;

export function InlineDecisionReceipt({ receipt, theme, onOpen, onDismiss }: {
  receipt: InlineReceipt; theme: Theme; onOpen?: (id: string) => void; onDismiss: () => void;
}) {
  const { t } = useBoardLanguage();
  const c = theme.colors;
  const words = statusLabel[receipt.status];
  const delivery = mergeNotificationLabel(receipt.notification, t);
  const recipientId = receipt.status === "sent" && receipt.recipientId;
  const unsent = receipt.status === "unsent";
  const openLabel = t("받은 세션 열기", "Open receiving session");
  return <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingVertical: 5 }}>
    <View accessibilityLiveRegion="polite" style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0, gap: 2 }}>
      <Text selectable style={{ color: c.foreground, fontSize: 14 }}>
        <Text style={{ color: unsent ? c.statusWarning : c.statusSuccess, fontWeight: "600" }}>{unsent ? "!" : "✓"} {t(words[0], words[1])}</Text>
        {"  "}{receipt.title}
      </Text>
      {(!!receipt.detail || !!delivery) && <Text selectable numberOfLines={unsent ? undefined : delivery ? 2 : 1} style={{ color: unsent ? c.foreground : c.foregroundMuted, fontSize: 12 }}>
        {[delivery, receipt.detail].filter(Boolean).join(" · ")}
      </Text>}
    </View>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
      {recipientId && onOpen && <SessionChip theme={theme} label={openLabel} accessibilityLabel={receipt.title + " · " + openLabel}
        onPress={() => onOpen(recipientId)} />}
      <Pressable accessibilityRole="button" accessibilityLabel={t("결과 숨기기", "Hide result") + " · " + receipt.title} onPress={onDismiss}
        style={({ pressed }) => ({ padding: 8, opacity: pressed ? 0.65 : 1 })}>
        <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{t("숨기기", "Hide")}</Text>
      </Pressable>
    </View>
  </View>;
}
