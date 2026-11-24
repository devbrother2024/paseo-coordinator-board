import { useRpc, type PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useState } from "react";
import { Image, Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { boardPhotoMessageSchema, readSessionPhoto } from "../shared/session-photos";
import { MAX_WORK_IMAGES } from "../shared/work-images";
import { Button, type Theme } from "./controls";
import { BoardLanguageProvider, useBoardLanguage } from "./language";

type MessageProps = PluginTimelineItemProps<z.infer<typeof boardPhotoMessageSchema>>;

export function AttachedPhoto({ sessionId, messageId, index, theme, onCount }: {
  sessionId: string; messageId: string; index: number; theme: Theme; onCount?: (count: number) => void;
}) {
  const { t } = useBoardLanguage();
  const read = useRpc(readSessionPhoto);
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let active = true;
    setFailed(false);
    setUri(null);
    void read({ sessionId, messageId, index }).then(({ image, count }) => {
      if (!active) return;
      onCount?.(Math.max(1, Math.min(MAX_WORK_IMAGES, count)));
      if (image) setUri(`data:${image.mimeType};base64,${image.data}`);
      else setFailed(true);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [read, sessionId, messageId, index, onCount, attempt]);

  const label = t(`첨부 사진 ${index + 1}`, `Attached photo ${index + 1}`);
  if (failed) return <View style={{ alignItems: "flex-start", gap: 4 }}>
    <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>
      {t(`${index + 1}번째 첨부 사진을 불러오지 못했습니다.`, `${label} is unavailable.`)}
    </Text>
    <Button theme={theme} label={t("다시 불러오기", "Retry loading")} onPress={() => setAttempt(n => n + 1)} />
  </View>;
  if (!uri) return <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted }}>
    {t(`${label} 불러오는 중…`, `Loading attached photo ${index + 1}…`)}
  </Text>;

  return <>
    <Pressable accessibilityRole="button" accessibilityLabel={t(`${label} 확대`, `Enlarge attached photo ${index + 1}`)}
      onPress={() => setExpanded(true)} style={{ borderRadius: 7, overflow: "hidden", backgroundColor: theme.colors.surface0 }}>
      <Image source={{ uri }} resizeMode="contain" onError={() => setFailed(true)}
        style={{ width: 136, height: 108 }} />
    </Pressable>
    {expanded && <Modal title={label} open onOpenChange={setExpanded}>
      <Modal.Content scrollable={false} contentContainerStyle={{ flex: 1, padding: 8 }}>
        <Image accessible accessibilityLabel={label} source={{ uri }} resizeMode="contain"
          style={{ width: "100%", flex: 1 }} onError={() => { setExpanded(false); setFailed(true); }} />
      </Modal.Content>
    </Modal>}
  </>;
}

function MessageBody({ agentId, item, theme }: MessageProps) {
  const [count, setCount] = useState(1);
  return <View style={{ alignSelf: "flex-end", maxWidth: "95%", padding: 12, gap: 8, borderRadius: 12, backgroundColor: theme.colors.surface2 }}>
    {item.data.text.length > 0 && <Text selectable style={{ color: theme.colors.foreground, lineHeight: 21 }}>{item.data.text}</Text>}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
      {Array.from({ length: count }, (_, index) => <AttachedPhoto key={index} sessionId={agentId}
        messageId={item.data.messageId} index={index} theme={theme} onCount={index === 0 ? setCount : undefined} />)}
    </View>
  </View>;
}

export function SessionPhotoMessage(props: MessageProps) {
  return <BoardLanguageProvider>
    <MessageBody key={JSON.stringify([props.host.id, props.agentId, props.item.data.messageId])} {...props} />
  </BoardLanguageProvider>;
}
