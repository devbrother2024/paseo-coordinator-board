import { openExternalUrl } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Platform, Text } from "react-native";
import { pullUrl } from "../shared/prs";
import type { Theme } from "./controls";
import { useBoardLanguage } from "./language";

export function GitHubPullLink({ repo, number, theme, inline = false }: {
  repo: string; number: number; theme: Theme; inline?: boolean;
}) {
  const { t } = useBoardLanguage();
  const [failed, setFailed] = useState(false);
  const url = pullUrl(repo, number);
  const label = `${repo} #${number}`;
  return <>
    <Text accessibilityRole="link" accessibilityLabel={label + " · " + t("GitHub에서 보기", "View on GitHub")}
      {...(Platform.OS === "web" && { href: url, hrefAttrs: { target: "_blank", rel: "noopener noreferrer" } })}
      onPress={event => {
        event.preventDefault();
        void openExternalUrl(url).then(() => setFailed(false), () => setFailed(true));
      }}
      style={{ maxWidth: "100%", color: theme.colors.foreground, textDecorationLine: "underline", fontSize: inline ? undefined : 13 }}
    >{inline ? `#${number}` : label}</Text>
    {failed && <Text selectable style={{ color: theme.colors.foregroundMuted }}>{url}</Text>}
  </>;
}
