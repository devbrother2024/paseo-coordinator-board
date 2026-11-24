import { useMemo } from "react";
import { Text, View } from "react-native";
import type { ReplyEntry } from "../shared/reply-history";
import type { Theme } from "./controls";
import { plainDecisionTitle } from "./decision-summary";
import type { HistorySession } from "./history-sessions";
import { useBoardLanguage } from "./language";
import { elapsedLabel, recipientLink, type FollowupKind } from "./reply-followup";
import { VerifiedSessionChip } from "./verified-session-chip";

type Props = {
  entry: ReplyEntry; kind: FollowupKind; links: HistorySession[]; now: number; theme: Theme;
  open?: (id: string) => void; openRemote?: (host: string, id: string) => void;
};

// A reply waiting in the review lane. It only opens the session; it never sends anything.
export function ReplyFollowupCard({ entry, kind, links, now, theme, open, openRemote }: Props) {
  const { t, language } = useBoardLanguage();
  const c = theme.colors;
  const title = useMemo(() => plainDecisionTitle(entry.title), [entry.title]);
  const answer = useMemo(() => entry.answer?.replace(/\s+/g, " ").trim(), [entry.answer]);
  const status = kind === "unsent"
    ? t("보내지 못함 · 카드 또는 수신 상태 확인 필요", "Not sent · review the card or recipient")
    : entry.status === "pending" ? t("답 보냄 · 전송 확인 중", "Reply sent · confirming delivery")
    : t("답 보냄 · 결과 기다림", "Reply sent · awaiting result");
  const at = Date.parse(entry.at);
  const date = new Date(at).toLocaleString(language === "ko" ? "ko-KR" : "en-US",
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const recipient = recipientLink(links);
  const host = recipient?.host;
  const navigate = !recipient ? undefined : host ? openRemote && (() => openRemote(host, recipient.id)) : open && (() => open(recipient.id));
  const name = recipient && (recipient.title || recipient.id);
  const role = recipient?.role === "received" ? t("받은 세션", "Recipient session") : t("전송 대상", "Intended recipient");
  return <View style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0, gap: 5 }}>
    <Text selectable style={{ color: c.foreground, fontSize: 14, fontWeight: "600" }}>{title}</Text>
    <Text style={{ color: kind === "unsent" ? c.statusWarning : c.foregroundMuted, fontSize: 12 }}>{status}</Text>
    {!!answer && <Text selectable numberOfLines={2} style={{ color: c.foreground, fontSize: 13 }}>{answer}</Text>}
    <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{date} · {elapsedLabel(now - at, t)}</Text>
    {recipient && navigate && (recipient.available || recipient.verify)
      ? <VerifiedSessionChip theme={theme} label={`${role} · ${name}`} accessibilityLabel={t(`${role} 열기 · ${name}`, `Open ${role} · ${name}`)}
          onPress={navigate} verify={recipient.available ? undefined : recipient.verify} />
      : recipient && <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{role} · {name}</Text>}
  </View>;
}
