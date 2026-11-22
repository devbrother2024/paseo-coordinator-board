import { VerifiedSessionChip } from "./verified-session-chip";
import { SessionChip, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

export type TrackedSessionLinks = {
  owner?: { id: string; open: () => void; verify?: () => Promise<boolean> };
  source?: () => void;
};

export function TrackedSessionChips({ links, title, theme }: { links: TrackedSessionLinks; title: string; theme: Theme }) {
  const { t } = useBoardLanguage();
  const { owner, source } = links;
  return <>
    {owner && <VerifiedSessionChip key={owner.id} theme={theme} label={t("운영 코디네이터", "Operating coordinator")}
      accessibilityLabel={title + " · " + t("운영 코디네이터 세션 열기", "Open operating coordinator session")}
      onPress={owner.open} verify={owner.verify} />}
    {source && <SessionChip theme={theme} label={owner ? t("원래 작업 세션", "Source work session") : t("연결 세션", "Linked session")}
      accessibilityLabel={title + " · " + (owner ? t("원래 작업 세션 열기", "Open source work session") : t("연결된 세션 열기", "Open linked session"))} onPress={source} />}
  </>;
}
