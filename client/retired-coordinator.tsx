import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { archiveRetiredCoordinator, retiredCoordinatorState, type RetiredCoordinator } from "../shared/operations";
import { Button, SessionChip, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { wrap } from "./route-editor";

type Props = { theme: Theme; coordinator: string; open?: (id: string) => void };

// After a replacement the old coordinator stays. It is archived only when the person presses the button here.
export function RetiredCoordinator({ theme, coordinator, open }: Props) {
  const { t } = useBoardLanguage();
  const read = useRpc(retiredCoordinatorState), archive = useRpc(archiveRetiredCoordinator);
  const [retired, setRetired] = useState<RetiredCoordinator | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const generation = useRef(0), live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const load = useCallback(async () => {
    const token = ++generation.current;
    try {
      const result = await read({});
      if (live.current && token === generation.current) setRetired(result.retired);
    } catch {
      if (live.current && token === generation.current) setRetired(null);
    }
  }, [read]);
  useEffect(() => { setError(""); setNotice(""); void load(); }, [coordinator, load]);

  async function press(id: string) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await archive({ sessionId: id });
      if (live.current) setNotice(t("옛 코디네이터를 보관했습니다.", "Archived the previous coordinator."));
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (live.current) { setBusy(false); void load(); }
    }
  }

  const c = theme.colors;
  if (!retired) return notice ? <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>{notice}</Text> : null;
  const short = retired.id.slice(0, 8);
  const reason = retired.reason === "waiting"
    ? t("권한 요청을 기다리는 중이라 보관할 수 없습니다.", "Waiting on a permission request, so it cannot be archived.")
    : retired.reason === "running" ? t("아직 진행 중이라 보관할 수 없습니다. 끝난 뒤 다시 확인해 주세요.", "Still in progress, so it cannot be archived. Check again when it finishes.") : "";
  return <View style={{ gap: 6 }}>
    <Text style={{ color: c.foregroundMuted }}>{t("교체한 뒤에도 옛 세션은 그대로 둡니다. 새 코디네이터가 옛 기록을 읽은 뒤 보관하세요.",
      "The old session stays after a replacement. Archive it once the new coordinator has read its record.")}</Text>
    <View style={{ ...wrap, alignItems: "center" }}>
      <Text selectable style={{ color: c.foreground }}>{t(`옛 코디네이터 ${short}`, `Previous coordinator ${short}`)}</Text>
      {open && <SessionChip theme={theme} label={t("열기", "Open")} accessibilityLabel={t(`옛 코디네이터 ${retired.id} 열기`, `Open previous coordinator ${retired.id}`)}
        onPress={() => open(retired.id)} />}
      <Button theme={theme} label={busy ? t("보관 중…", "Archiving…") : t("보관", "Archive")} disabled={busy || !retired.archivable}
        onPress={() => void press(retired.id)} />
      {!retired.archivable && <Button theme={theme} label={t("다시 확인", "Check again")} disabled={busy} onPress={() => void load()} />}
    </View>
    {!!reason && <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted }}>{reason}</Text>}
    {!!error && <Text accessibilityLiveRegion="polite" selectable style={{ color: c.statusDanger }}>{error}</Text>}
  </View>;
}
