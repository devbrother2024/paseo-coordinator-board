import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { listSentRequests, type SentRequest } from "../shared/sent-requests";
import { Button, SessionChip, type Theme } from "./controls";
import { HistoryMarkdown } from "./history-markdown";
import { useBoardLanguage } from "./language";
import { AttachedPhoto } from "./session-photos";

type CardProps = { request: SentRequest; current: boolean; theme: Theme; open?: (id: string) => void };

function SentRequestCard({ request, current, theme, open }: CardProps) {
  const { t, language } = useBoardLanguage();
  const colors = theme.colors;
  const [full, setFull] = useState(false);
  const [photoIndex, setPhotoIndex] = useState<number | null>(null);
  const long = request.text.length > 160 || request.text.split("\n").length > 3;
  const status = {
    pending: t("전송 미확인", "Delivery unconfirmed"), sent: t("전송됨", "Sent"), delivered: t("전달됨", "Delivered"),
  }[request.status];
  const date = new Date(request.at).toLocaleString(language === "ko" ? "ko-KR" : "en-US",
    { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const [session, openLabel] = current
    ? [t("받은 코디네이터 세션", "Receiving coordinator session"), t("받은 코디네이터 세션 열기", "Open the receiving coordinator session")]
    : [t("받은 이전 코디네이터 세션", "Earlier receiving coordinator"), t("요청을 받은 이전 코디네이터 세션 열기", "Open the earlier coordinator session that received this request")];
  return <View style={{ gap: 5, padding: 9, borderRadius: 7, backgroundColor: colors.surface0, borderWidth: 1, borderColor: colors.border }}>
    <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>{status} · {date}</Text>
    {open && <SessionChip theme={theme} label={session} accessibilityLabel={openLabel} onPress={() => open(request.coordinatorId)} />}
    {!!request.text && <HistoryMarkdown theme={theme} source={request.text} preview={long && !full} />}
    {long && <Button theme={theme} expanded={full} label={full ? t("접기", "Show less") : t("내용 펼치기", "Read more")} onPress={() => setFull(value => !value)} />}
    {request.photoCount > 0 && <View style={{ gap: 4 }}>
      <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
        {t(`첨부 사진 ${request.photoCount}장`, `${request.photoCount} attached photo${request.photoCount === 1 ? "" : "s"}`)}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>{Array.from({ length: request.photoCount }, (_, index) =>
        <Button key={index} theme={theme} label={t(`사진 ${index + 1}`, `Photo ${index + 1}`)} expanded={photoIndex === index}
          onPress={() => setPhotoIndex(value => value === index ? null : index)} />)}</View>
      {photoIndex !== null && <AttachedPhoto key={photoIndex} sessionId={request.coordinatorId} messageId={request.messageId} index={photoIndex} theme={theme} />}
    </View>}
  </View>;
}

// `refreshKey` changes after each send, so the newest request and its delivery state show up.
export function SentRequestHistory({ theme, coordinator, open, refreshKey }: {
  theme: Theme; coordinator: string; open?: (id: string) => void; refreshKey: number;
}) {
  const { t } = useBoardLanguage();
  const list = useRpc(listSentRequests);
  const reader = useRef(list);
  reader.current = list;
  const [requests, setRequests] = useState<SentRequest[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [limit, setLimit] = useState(1);
  useEffect(() => {
    let current = true;
    void reader.current({}).then(result => { if (current) setRequests(result.requests); }).catch(() => {});
    return () => { current = false; };
  }, [refreshKey, expanded]);
  if (!requests.length) return null;
  return <View style={{ gap: 6 }}>
    <Button theme={theme} expanded={expanded} onPress={() => setExpanded(value => !value)} accessibilityLabel={t("보낸 요청", "Sent requests")}
      label={t(`보낸 요청 · ${requests.length}건`, `Sent requests · ${requests.length}`) + (expanded ? " ▴" : " ▾")} />
    {expanded && requests.slice(0, limit).map(request => <SentRequestCard key={request.coordinatorId + "/" + request.messageId}
      request={request} current={request.coordinatorId === coordinator} theme={theme} open={open} />)}
    {expanded && requests.length > limit && <Button theme={theme} label={t("이전 요청 더 보기", "Show earlier requests")} onPress={() => setLimit(n => n + 10)} />}
  </View>;
}
