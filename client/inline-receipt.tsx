import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { SessionChip, type Theme } from "./controls";
import { mergeNotificationLabel } from "./merge-notification";
import { receiptDetails, sentTimeLabel, type InlineReceipt } from "./decision-receipts";
import type { ReplyEntry } from "../shared/reply-history";
import { useBoardLanguage } from "./language";

const statusLabel = {
  merged: ["병합 완료", "Merged"],
  "already-merged": ["이미 병합됨", "Already merged"],
  sent: ["답장 보냄", "Reply sent"],
  "already-closed": ["이미 처리됨", "Already handled"],
  unsent: ["보내지 못한 답", "Reply not sent"],
} as const;

// A sent reply stays as a folded card: status, title and time, opening to what was sent. Other results show one line.
export function InlineDecisionReceipt({ receipt, theme, onOpen, onDismiss, entry, recipient }: {
  receipt: InlineReceipt; theme: Theme; onOpen?: (id: string) => void; onDismiss: () => void; entry?: ReplyEntry; recipient?: string;
}) {
  const { t, language } = useBoardLanguage();
  const [open, setOpen] = useState(false);
  const c = theme.colors;
  const words = statusLabel[receipt.status];
  const delivery = mergeNotificationLabel(receipt.notification, t);
  const recipientId = receipt.status === "sent" && receipt.recipientId;
  const unsent = receipt.status === "unsent";
  const openLabel = t("받은 세션 열기", "Open receiving session");
  const folds = receipt.status === "sent";
  const time = folds ? sentTimeLabel(receipt.sentAt, Date.now(), language) : "";
  const details = folds ? receiptDetails(receipt, entry, recipient, t) : [];
  const toggle = open ? t("보낸 내용 접기", "Hide what was sent") : t("보낸 내용 보기", "Show what was sent");
  const line = <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8, paddingVertical: 5 }}>
    <View accessibilityLiveRegion="polite" style={{ flexGrow: 1, flexShrink: 1, flexBasis: 200, minWidth: 0, gap: 2 }}>
      <Text selectable style={{ color: c.foreground, fontSize: 14 }}>
        <Text style={{ color: unsent ? c.statusWarning : c.statusSuccess, fontWeight: "600" }}>{unsent ? "!" : "✓"} {t(words[0], words[1])}</Text>
        {"  "}{receipt.title}
        {!!time && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{"  "}{time}</Text>}
      </Text>
      {!folds && (!!receipt.detail || !!delivery) && <Text selectable numberOfLines={unsent ? undefined : delivery ? 2 : 1} style={{ color: unsent ? c.foreground : c.foregroundMuted, fontSize: 12 }}>
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
  if (!folds || !details.length) return line;
  return <View style={{ gap: 4 }}>
    {line}
    <Pressable accessibilityRole="button" accessibilityLabel={toggle + " · " + receipt.title} accessibilityState={{ expanded: open }} aria-expanded={open}
      onPress={() => setOpen(value => !value)} style={{ alignSelf: "flex-start", paddingVertical: 4 }}>
      <Text style={{ color: c.foregroundMuted, textDecorationLine: "underline", fontSize: 12 }}>{toggle}</Text>
    </Pressable>
    {open && <View style={{ gap: 6, padding: 8, borderRadius: 7, backgroundColor: c.surface0 }}>
      {details.map(detail => <View key={detail.label} style={{ gap: 2 }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{detail.label}</Text>
        <Text selectable style={{ color: c.foreground, fontSize: 13 }}>{detail.text}</Text>
      </View>)}
    </View>}
  </View>;
}
