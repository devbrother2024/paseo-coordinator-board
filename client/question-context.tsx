import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Choice } from "../shared/question-choices";
import { previewMarkdown, type ChoiceNotice } from "./choice-display";
import type { Theme } from "./controls";
import { HistoryMarkdown } from "./history-markdown";
import { useBoardLanguage } from "./language";

/** The options a question names and the text the session wrote before asking, under the question title. */
export function QuestionContext({ theme, title, choices, context, notice, pullRepository }: {
  theme: Theme; title: string; choices?: readonly Choice[]; context?: string; notice?: ChoiceNotice | null; pullRepository?: string;
}) {
  const { t } = useBoardLanguage();
  const [open, setOpen] = useState(false);
  const c = theme.colors;
  if (!choices?.length && !context && !notice) return null;
  const preview = context ? previewMarkdown(context) : null;
  const label = { color: c.foregroundMuted, fontSize: 12, fontWeight: "600" as const };
  return <View style={{ gap: 6 }}>
    {!!choices?.length && <View style={{ gap: 4 }}>
      <Text style={label}>{t("선택지", "Options")}</Text>
      {choices.map(choice => <View key={choice.label} style={{ padding: 8, borderRadius: 7, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0 }}>
        <HistoryMarkdown theme={theme} source={choice.markdown} pullRepository={pullRepository} />
      </View>)}
    </View>}
    {notice && <Text accessibilityLiveRegion="polite" selectable style={{ color: c.statusWarning, fontSize: 13 }}>{t(...notice.notice)}</Text>}
    {preview && <View style={{ gap: 3 }}>
      <Text style={label}>{t("앞 내용", "Earlier in the message")}</Text>
      <HistoryMarkdown theme={theme} source={open ? context! : preview.preview} fallbackSource={context} pullRepository={pullRepository} muted />
      {preview.more && <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }}
        accessibilityLabel={title + " · " + (open ? t("앞 내용 접기", "Show less of the earlier text") : t("앞 내용 더 보기", "Show more of the earlier text"))}
        style={{ alignSelf: "flex-start", paddingVertical: 4 }} onPress={() => setOpen(value => !value)}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, textDecorationLine: "underline" }}>{open ? t("접기", "Show less") : t("더 보기", "Show more")}</Text>
      </Pressable>}
    </View>}
  </View>;
}
