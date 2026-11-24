import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";
import { resolveRoute, type RouteChoice } from "../shared/dispatch";
import { operationState, setupCoordinator, type Operations } from "../shared/operations";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { offeredPick, replacementChoices, replacementEfforts, replacementMode, replacementRoute, replacementSelection } from "./replace-options";
import { routeName, wrap } from "./route-editor";
import { explainEmptyRoute } from "./route-options";

type Props = {
  theme: Theme; coordinator: string; data: Operations | null; loading: boolean; disabled?: boolean;
  reload: () => void; onReplaced: () => void; onClose?: () => void;
};

// Replace the coordinator, optionally with a model picked right here: pick, choose a model, confirm.
export function CoordinatorReplace({ theme, coordinator, data, loading, disabled = false, reload, onReplaced, onClose }: Props) {
  const { t } = useBoardLanguage();
  const setup = useRpc(setupCoordinator);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(8);
  const [picked, setPicked] = useState<RouteChoice | null>(null);
  const [remember, setRemember] = useState(true);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const live = useRef(true), pending = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { setConfirm(false); setPicked(null); setPicking(false); setRemember(true); }, [coordinator]);

  const c = theme.colors;
  const usual = data && resolveRoute("M", data.routing, data.catalog, false, data.usageRouting ? data.usage : undefined);
  const choice = offeredPick(data, picked);
  const target = choice ?? usual;
  const mode = data && target ? replacementMode(data, target.provider) : null;
  const blocked = disabled || busy || loading;
  const list = picking && data ? replacementChoices(data, query, t) : null;
  const rememberLabel = t("다음 교체에도 이 모델을 기본으로 사용", "Use this model as the default for later replacements");

  async function replace() {
    const plan = replacementSelection(choice, usual, remember);
    if (!plan || !mode || pending.current) return;
    pending.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await setup({ expectedCoordinator: coordinator, replace: true, expectedRoute: plan.route, expectedModeId: mode.id,
        ...(plan.selection ? { selection: plan.selection } : {}) });
      if (!live.current) return;
      setConfirm(false); setPicked(null); setPicking(false); setRemember(true);
      setNotice(result.pinFailed ? t("운영 세션을 연결했습니다. 사이드바 고정은 설정에서 다시 시도해 주세요.", "Coordinator connected. Retry sidebar pinning in Settings.")
        : result.defaultSaved === false ? t("운영 세션을 연결했습니다. 고른 모델을 기본값으로 저장하지는 못했습니다.", "Coordinator connected. The picked model could not be saved as the default.")
          : t("운영 세션을 연결했습니다.", "Coordinator session connected."));
      onReplaced();
      reload();
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  }

  return <View style={{ gap: 10, backgroundColor: c.surface1, padding: 14, borderRadius: 10 }}>
    <View style={{ ...wrap, alignItems: "center", justifyContent: "space-between" }}>
      <Text accessibilityRole="header" style={{ color: c.foreground, fontWeight: "600", fontSize: 17 }}>{t("운영 세션 교체", "Replace coordinator")}</Text>
      {onClose && <Button theme={theme} label={t("닫기", "Close")} onPress={onClose} />}
    </View>
    <View style={{ ...wrap, alignItems: "center" }}>
      <Text style={{ color: c.foregroundMuted }}>{t("새 코디네이터를 만들 때 쓸 모델", "Model for the next coordinator")}</Text>
      <Button theme={theme} expanded={picking} disabled={blocked || !data}
        label={loading ? t("조회 중…", "Loading…") : (picking ? t("모델 목록 닫기", "Close model list") : t("모델 고르기", "Choose model")) + " · " + routeName(target ?? null, t)}
        onPress={() => { setPicking(!picking); setQuery(""); setLimit(8); }} />
    </View>
    {!loading && target && <Text style={{ color: c.foregroundMuted }}>{mode ? t(`도구 권한 · ${mode.label}`, `Tool permissions · ${mode.label}`)
      : t("권한 모드를 확인할 수 없습니다. 설정에서 실행기·모델을 새로 고쳐 주세요.", "Permission mode unavailable. Refresh providers and models in Settings.")}</Text>}
    {!loading && data && !target && <Text style={{ color: c.foregroundMuted }}>{explainEmptyRoute(data, "M", t)}</Text>}
    {list && <View style={{ gap: 6 }}>
      <TextInput accessibilityLabel={t("모델 검색", "Search models")} placeholder={t("실행기 또는 모델 검색", "Search providers or models")}
        style={{ color: c.foreground, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0, borderRadius: 6, padding: 8 }}
        placeholderTextColor={c.foregroundMuted} value={query} onChangeText={value => { setQuery(value); setLimit(8); }} />
      {list.hint && <Text style={{ color: c.foregroundMuted }}>{list.hint}</Text>}
      {list.rows.slice(0, limit).map(row => {
        const selected = choice?.provider === row.provider && choice.model === row.model;
        const tags = [row.recommended && t("추천", "Recommended"), row.current && t("현재 기본값", "Current default")].filter(Boolean).join(" · ");
        return <Pressable key={JSON.stringify([row.provider, row.model])} accessibilityRole="button"
          accessibilityLabel={[row.label, tags, row.disabled].filter(Boolean).join(" · ")}
          accessibilityState={{ disabled: !!row.disabled || blocked, selected }} disabled={!!row.disabled || blocked}
          onPress={() => {
            const route = data && replacementRoute(data, row.provider, row.model);
            if (!route) return;
            setPicked(route); setPicking(false); setConfirm(true); setError(""); setNotice("");
          }}
          style={({ pressed }) => ({ gap: 2, paddingHorizontal: 10, paddingVertical: 7, borderWidth: 1, borderRadius: 7,
            borderColor: selected ? c.accent : c.border, backgroundColor: selected ? c.accent : c.surface0, opacity: row.disabled ? 0.5 : pressed ? 0.6 : 1 })}>
          <Text style={{ color: selected ? c.accentForeground : c.foreground, fontSize: 13, fontWeight: "500" }}>{row.label}{tags ? " · " + tags : ""}</Text>
          {row.disabled && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{row.disabled}</Text>}
        </Pressable>;
      })}
      {list.rows.length > limit && <View style={wrap}><Button theme={theme} label={t("모델 더 보기", "Show more models")} onPress={() => setLimit(limit + 12)} /></View>}
      {list.unavailable.map(item => <Text key={item.provider} style={{ color: c.foregroundMuted, fontSize: 12, opacity: 0.7 }}>{item.label} · {item.reason}</Text>)}
    </View>}
    {choice && data && replacementEfforts(data, choice).length > 1 && <View style={{ gap: 6 }}>
      <Text style={{ color: c.foreground }}>{t("추론 강도", "Reasoning effort")}</Text>
      <View style={wrap}>
        {replacementEfforts(data, choice).map(effort => <Button theme={theme} key={effort ?? "default"} disabled={blocked}
          label={effort ?? t("실행기 기본 강도", "Provider default")} selected={effort === choice.effort}
          onPress={() => setPicked({ ...choice, effort })} />)}
      </View>
    </View>}
    {confirm && target && <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>
      {t(`교체할 모델 · ${routeName(target, t)}`, `Replacing with ${routeName(target, t)}`)}{mode ? " · " + t(`도구 권한 · ${mode.label}`, `Tool permissions · ${mode.label}`) : ""}{"\n"}
      {t("새 운영 세션이 준비되면 담당자를 바꿉니다. 진행 중인 작업과 결정 카드는 유지됩니다.", "The new session takes over when ready. Current work and decisions stay on the board.")}
    </Text>}
    {confirm && choice && <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      <Switch accessibilityRole="switch" accessibilityLabel={rememberLabel} value={remember} disabled={blocked} onValueChange={setRemember}
        trackColor={{ false: c.border, true: c.accent }} thumbColor={remember ? c.accentForeground : c.foregroundMuted} />
      <Text onPress={blocked ? undefined : () => setRemember(!remember)} style={{ flexShrink: 1, color: c.foreground, fontSize: 13 }}>{rememberLabel}</Text>
    </View>}
    <View style={wrap}>
      {!confirm && <Button theme={theme} label={t("새 코디네이터로 교체…", "Replace coordinator…")} disabled={blocked || !target || !mode} onPress={() => setConfirm(true)} />}
      {confirm && <Button theme={theme} selected={!blocked && !!target && !!mode} disabled={blocked || !target || !mode}
        label={choice ? t("이 모델로 교체", "Replace with this model") : t("새 세션으로 교체", "Switch to new session")} onPress={() => void replace()} />}
      {confirm && <Button theme={theme} disabled={busy} label={choice ? t("선택 취소", "Clear selection") : t("교체 취소", "Cancel replacement")}
        onPress={() => { setConfirm(false); setPicked(null); }} />}
    </View>
    {!!error && <Text accessibilityLiveRegion="polite" selectable style={{ color: c.statusDanger }}>{error}</Text>}
    {!!notice && <Text accessibilityLiveRegion="polite" style={{ color: c.foreground }}>{notice}</Text>}
  </View>;
}

// The same box outside Settings, where the providers and models have not been loaded yet.
export function CoordinatorReplaceLoader(props: Omit<Props, "data" | "loading" | "reload">) {
  const fetchState = useRpc(operationState);
  const latest = useRef(fetchState);
  latest.current = fetchState;
  const generation = useRef(0);
  const { t } = useBoardLanguage();
  const [data, setData] = useState<Operations | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async () => {
    const token = ++generation.current;
    setLoading(true); setFailed(false);
    try {
      const result = await latest.current({});
      if (token === generation.current) setData(result);
    } catch {
      if (token === generation.current) setFailed(true);
    } finally {
      if (token === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
  return <View style={{ gap: 6 }}>
    <CoordinatorReplace {...props} data={data} loading={loading} reload={() => void load()} />
    {failed && <View style={{ ...wrap, alignItems: "center" }}>
      <Text accessibilityLiveRegion="polite" style={{ color: props.theme.colors.statusDanger }}>{t("실행기와 모델을 읽지 못했습니다.", "Could not load providers and models.")}</Text>
      <Button theme={props.theme} label={t("다시 조회", "Retry")} onPress={() => void load()} />
    </View>}
  </View>;
}
