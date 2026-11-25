import { useEffect, useState } from "react";
import { Text } from "react-native";
import { VerifiedSessionChip, type SessionGate } from "./verified-session-chip";
import { SessionChip, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { findRemoteWorkSession, type RemoteWorkSession, type WorkSessionHost, type WorkSessionLookup } from "./tracked-session-targets";

type RemoteLink = RemoteWorkSession & { lookup: WorkSessionLookup; open: (host: string, id: string) => void };
export type TrackedSessionLinks = {
  owner?: { id: string; open: () => void; gate?: SessionGate };
  source?: { kind: "local"; open: () => void } | RemoteLink | { kind: "unavailable" };
};

function WorkSessionUnavailable({ theme }: { theme: Theme }) {
  const { t } = useBoardLanguage();
  return <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
    {t("다른 기기 세션(연결 안 됨)", "Session on another host (not connected)")}
  </Text>;
}

function RemoteWorkSessionChip({ source, theme, title, label }: { source: RemoteLink; theme: Theme; title: string; label: string }) {
  const { t } = useBoardLanguage();
  const [host, setHost] = useState<WorkSessionHost | null>();
  // Session or candidate changes remount this chip. A new lookup refreshes it in place.
  useEffect(() => {
    let active = true;
    void findRemoteWorkSession(source, source.lookup).then(found => {
      if (active) setHost(found ?? null);
    });
    return () => { active = false; };
  }, [source.lookup]);
  if (host === null) return <WorkSessionUnavailable theme={theme} />;
  if (!host) return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{t("작업 세션 확인 중…", "Checking work session…")}</Text>;
  return <SessionChip theme={theme} label={label + " · " + host.label}
    accessibilityLabel={t(`${title} · ${host.label}의 작업 세션 열기`, `${title} · Open work session on ${host.label}`)}
    onPress={() => source.open(host.serverId, source.id)} />;
}

// `side` shows one chip. With `role`, the chip names what it opens: the coordinator or the work session that takes the
// card's reply. Without `side`, both chips appear (kanban previews).
export function TrackedSessionChips({ links, title, theme, side, role = false }: {
  links: TrackedSessionLinks; title: string; theme: Theme; side?: "owner" | "source"; role?: boolean;
}) {
  const { t } = useBoardLanguage();
  const owner = side === "source" ? undefined : links.owner;
  const source = side === "owner" ? undefined : links.source;
  const ownerLabel = role ? t("코디네이터 열기", "Open coordinator") : t("운영 코디네이터", "Operating coordinator");
  const sourceLabel = role ? t("작업 세션 열기", "Open work session")
    : links.owner ? t("원래 작업 세션", "Source work session") : source?.kind === "remote" ? t("작업 세션", "Work session") : t("연결 세션", "Linked session");
  return <>
    {owner && <VerifiedSessionChip key={owner.id} theme={theme} label={ownerLabel}
      accessibilityLabel={title + " · " + t("운영 코디네이터 세션 열기", "Open operating coordinator session")}
      onPress={owner.open} gate={owner.gate} />}
    {source?.kind === "local" && <SessionChip theme={theme} label={sourceLabel}
      accessibilityLabel={title + " · " + (role || links.owner ? t("원래 작업 세션 열기", "Open source work session") : t("연결된 세션 열기", "Open linked session"))} onPress={source.open} />}
    {source?.kind === "remote" && <RemoteWorkSessionChip key={JSON.stringify([source.id, source.hosts])} source={source}
      theme={theme} title={title} label={sourceLabel} />}
    {source?.kind === "unavailable" && <WorkSessionUnavailable theme={theme} />}
  </>;
}
