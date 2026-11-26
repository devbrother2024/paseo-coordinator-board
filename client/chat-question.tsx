import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useComposers } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import { applyBlockChoice, blockPicks, blockQuestionLabel } from "../shared/question-block";
import type { ChatQuestion } from "../shared/chat-question";
import { withRequest } from "./card-input";
import { Button } from "./controls";
import { HistoryMarkdown } from "./history-markdown";
import { BoardLanguageProvider, useBoardLanguage } from "./language";

type Props = PluginTimelineItemProps<ChatQuestion>;

// A session message that ended in a question block, drawn in the session's own conversation: the text, then each
// question with its options. Choosing an option writes its line into the session's input, as on the board card; the
// input's text says what is chosen, and nothing is sent until the person sends it.
function Body({ agentId, item, theme }: Props) {
  const { t } = useBoardLanguage();
  const c = theme.colors;
  const { text, block } = item.data;
  const composer = useComposers({ agentId })[0];
  const prompt = composer?.prompt ?? "";
  const picks = composer ? blockPicks(prompt, block) : {};
  const fill = (next: string) => {
    if (!composer) return;
    composer.setPrompt(next);
    void composer.focus().catch(() => {});
  };
  return <View style={{ gap: 12 }}>
    {!!text && <HistoryMarkdown theme={theme} source={text} />}
    <View style={{ gap: 10, padding: 12, borderWidth: 1, borderRadius: 10, borderColor: c.border, backgroundColor: c.surface1 }}>
      {block.questions.map((question, index) => {
        const label = blockQuestionLabel(question);
        return <View key={index} style={{ gap: 6 }}>
          <HistoryMarkdown theme={theme} source={label} heading />
          {!!question.options.length && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {question.multi ? t("여러 개 선택", "Choose any that apply") : t("하나 선택", "Choose one")}
          </Text>}
          {question.options.map(option => {
            const checked = picks[index]?.includes(option.key) ?? false;
            const title = option.key + " · " + option.text;
            return <Pressable key={option.key} accessibilityRole={question.multi ? "checkbox" : "radio"}
              accessibilityLabel={label + " · " + title} accessibilityState={{ checked, disabled: !composer }} aria-checked={checked}
              disabled={!composer} onPress={() => fill(applyBlockChoice(prompt, block, index, option.key))}
              style={{ gap: 4, padding: 8, borderWidth: 1, borderRadius: 7, borderColor: checked ? c.accent : c.border, backgroundColor: checked ? c.surface2 : c.surface0 }}>
              <Text style={{ color: c.foreground, fontWeight: checked ? "700" : "500" }}>
                {checked ? "✓ " : ""}{title}{option.recommended ? " · " + t("추천", "Recommended") : ""}
              </Text>
              {([[t("고르면", "Outcome"), option.does], [t("장점", "Benefits"), option.pros], [t("대가", "Trade-offs"), option.cons]] as const)
                .map(([name, detail]) => detail ? <Text key={name} style={{ color: c.foregroundMuted, fontSize: 12 }}>{name} · {detail}</Text> : null)}
            </Pressable>;
          })}
        </View>;
      })}
      {!!block.recommend && <View style={{ flexDirection: "row", gap: 6, alignItems: "baseline" }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "600", flexShrink: 0 }}>{t("추천", "Recommendation")}</Text>
        <View style={{ flexShrink: 1 }}><HistoryMarkdown theme={theme} source={block.recommend} /></View>
      </View>}
      {composer
        ? !!block.recommendedReply && !prompt.includes(block.recommendedReply) && <View style={{ flexDirection: "row" }}>
          <Button theme={theme} label={t("추천 답 넣기", "Use recommendation")} onPress={() => fill(withRequest(prompt, block.recommendedReply!))} />
        </View>
        : <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {t("이 세션이 열려 있을 때 선택지를 고를 수 있습니다. 보드 카드에서도 답할 수 있습니다.",
            "Options can be chosen while this session is open. You can also answer from the board card.")}
        </Text>}
    </View>
  </View>;
}

export function ChatQuestionMessage(props: Props) {
  return <BoardLanguageProvider><Body {...props} /></BoardLanguageProvider>;
}
