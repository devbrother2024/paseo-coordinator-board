import { useRpc } from "@getpaseo/plugin/client";
import { SendButton, SendTextInput } from "./send-input";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, useWindowDimensions, View } from "react-native";
import {
  operationState,
  requestWork,
  setupCoordinator,
  setProviderInclusion,
  setWorkerMode,
  updateRouting,
  type Operations,
} from "../shared/operations";
import { resolveRoute } from "../shared/dispatch";
import { Button, SessionChip, type Theme } from "./controls";
import { PhotoComposer, usePhotoDraft } from "./photo-composer";
import { setUsageRouting } from "../shared/usage-routing";
import { UsageRouting } from "./usage-routing";
import { ProviderSettings } from "./providers";
import { FactReplyControls } from "./fact-reply-controls";
import { CoordinatorPinControls } from "./coordinator-pin";
import { CoordinatorReplace } from "./coordinator-replace";
import { RouteEditor, routeName, wrap, type RoutingSave } from "./route-editor";
import { useBoardLanguage } from "./language";
import { explainEmptyRoute } from "./route-options";
import { DigestFeedback, type CoordinatorAction, type DigestRequest } from "./digest-request";

type Props = {
  theme: Theme;
  settings: boolean;
  coordinator: string | null;
  configured: boolean;
  refreshBoard: () => void;
  openCoordinator?: (id: string) => void;
  action: CoordinatorAction;
  digest: DigestRequest;
};

export function OperationsPanel({ theme, settings, coordinator, configured, refreshBoard, openCoordinator, action: { pending, busy, setBusy }, digest }: Props) {
  const { t, language, languageReady } = useBoardLanguage();
  const fetchState = useRpc(operationState),
    setup = useRpc(setupCoordinator),
    includeProvider = useRpc(setProviderInclusion),
    saveWorkerMode = useRpc(setWorkerMode),
    changeUsageRouting = useRpc(setUsageRouting),
    savePolicy = useRpc(updateRouting);
  const sendWork = useRpc(requestWork);
  const [data, setData] = useState<Operations | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const [editorExpanded, setEditorExpanded] = useState(false);
  const { height: windowHeight } = useWindowDimensions();
  const photoDraft = usePhotoDraft();
  const hasRequest = Boolean(text.trim() || photoDraft.photos.length);
  const sendRequest = { disabled: busy || !configured || !hasRequest || photoDraft.blocked, onPress: () => void postWork() };
  const [inputFocused, setInputFocused] = useState(false);
  const [feedbackArea, setFeedbackArea] = useState<"provider" | "accounts" | "routing" | "coordinator">("provider");
  const live = useRef(false),
    generation = useRef(0);
  const delivery = useRef({ payload: "", key: "" });
  const fetchRef = useRef(fetchState);
  fetchRef.current = fetchState;
  const refresh = useCallback(async (clearError = true, setupPreview = false) => {
    const token = ++generation.current;
    setLoading(true);
    try {
      // An older daemon may still accept only the original empty input.
      const result = setupPreview ? await fetchRef.current({ view: "setup" }).catch(error => {
        if (!/unrecognized[_ ]keys?|invalid (?:rpc )?input|unexpected key/i.test(String(error))) throw error;
        return fetchRef.current({});
      }) : await fetchRef.current({});
      if (live.current && token === generation.current) {
        setData(result);
        if (clearError) setError("");
      }
      return result;
    } catch (e) {
      if (live.current && token === generation.current) {
        setFeedbackArea("provider");
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (live.current && token === generation.current) setLoading(false);
    }
  }, []);
  const needsModels = settings || (configured && !coordinator);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (needsModels) void refresh(true, !settings);
  }, [needsModels, settings, refresh]);
  useEffect(() => {
    delivery.current = { payload: "", key: "" };
  }, [coordinator]);
  useEffect(() => {
    setNotice("");
    setError("");
  }, [settings, language]);
  async function act<T>(fn: () => Promise<T>, done: string, area: typeof feedbackArea = "coordinator"): Promise<T | null> {
    if (pending.current) return null;
    pending.current = true;
    setBusy(true);
    setFeedbackArea(area);
    setError("");
    setNotice("");
    try {
      const value = await fn();
      if (live.current) {
        refreshBoard();
        setNotice(done);
      }
      return value;
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  // A routing change reports back to its own row. A refusal carries the latest stored revision so
  // the row can tell a lost race from a rejected candidate.
  async function saveRouting(input: Parameters<typeof savePolicy>[0]): Promise<RoutingSave> {
    if (pending.current) return { ok: false, message: t("다른 설정을 저장하는 중입니다. 잠시 뒤 다시 시도해 주세요.", "Another setting is being saved. Try again in a moment."), revision: input.expectedRevision };
    pending.current = true;
    setBusy(true);
    try {
      let failure: string | null = null;
      try { await savePolicy(input); } catch (e) { failure = e instanceof Error ? e.message : String(e); }
      const latest = live.current ? await refresh(false) : undefined;
      if (failure === null && live.current) refreshBoard();
      return failure === null ? { ok: true } : { ok: false, message: failure, revision: latest?.revision ?? null };
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function postWork() {
    if (!coordinator || pending.current || photoDraft.blocksSubmit()) return;
    const images = photoDraft.latest.current;
    const message = text.trim();
    if (!message && !images.length) return;
    const payload = JSON.stringify([coordinator, message, images.map(photo => photo.id)]);
    if (delivery.current.payload !== payload) delivery.current = {
      payload,
      key: "board-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2),
    };
    const receipt = await act(
      async () => {
        const result = await sendWork({ coordinator, requestKey: delivery.current.key, text: message,
          ...(images.length > 0 && { images: images.map(photo => photo.image) }) });
        if (!result.ok) throw Error(t("전송을 확인하지 못했습니다. 다시 시도해 주세요.", "Delivery was not confirmed. Please retry."));
        return result;
      },
      images.length
        ? t(`사진 ${images.length}장과 함께 코디네이터에게 요청을 보냈습니다.`, `Sent the request to the coordinator with ${images.length} photo${images.length === 1 ? "" : "s"}.`)
        : t("첨부 없이 코디네이터에게 요청을 보냈습니다.", "Sent the request to the coordinator without attachments."),
    );
    if (receipt && live.current) {
      delivery.current = { payload: "", key: "" };
      setText("");
      setEditorExpanded(false);
      photoDraft.clear();
    }
  }
  if (!settings && !configured && !coordinator) return null;
  const model = data && resolveRoute("M", data.routing, data.catalog, false, data.usageRouting ? data.usage : undefined);
  const mode = data?.coordinatorMode;
  const modeText = mode ? t(`도구 권한 · ${mode.label}`, `Tool permissions · ${mode.label}`) : t("권한 모드를 확인할 수 없습니다. 설정에서 실행기·모델을 새로 고쳐 주세요.", "Permission mode unavailable. Refresh providers and models in Settings.");
  const color = theme.colors.foreground;
  const muted = theme.colors.foregroundMuted;
  const section = { gap: 10, backgroundColor: theme.colors.surface1, padding: 14, borderRadius: 10 };
  const heading = { color, fontWeight: "600" as const, fontSize: 17 };
  const feedback = <>
    {!!error && <Text accessibilityLiveRegion="polite" selectable style={{ color: theme.colors.statusDanger }}>{error}</Text>}
    {!!notice && <Text accessibilityLiveRegion="polite" style={{ color }}>{notice}</Text>}
  </>;

  function connect() {
    if (!model || !mode || !configured || !languageReady) return;
    void act(
      () => setup({ expectedCoordinator: coordinator, replace: !!coordinator, expectedRoute: model, expectedModeId: mode.id, language }),
      t("운영 세션을 연결했습니다.", "Coordinator session connected."),
    ).then((result) => {
      if (result && live.current) {
        if (result.pinFailed) setNotice(t("운영 세션을 연결했습니다. 사이드바 고정은 설정에서 다시 시도해 주세요.", "Coordinator connected. Retry sidebar pinning in Settings."));
      }
    });
  }

  if (settings) return <View style={{ gap: 14 }}>
    <FactReplyControls theme={theme} />
    <CoordinatorPinControls theme={theme} coordinator={coordinator} />
    <View style={section}>
      <View style={{ ...wrap, alignItems: "center", justifyContent: "space-between" }}>
        <Text accessibilityRole="header" style={heading}>{t("Paseo 실행기", "Paseo providers")}</Text>
        <Button theme={theme} label={loading ? t("실행기 조회 중…", "Loading providers\u2026") : t("실행기·모델 새로 고침", "Refresh providers and models")} disabled={loading || busy} onPress={() => void refresh()} />
      </View>
      <Text style={{ color: muted }}>{t("새로 발견한 실행기는 기본으로 포함됩니다. 연결된 모델이 있는 실행기에 작업을 배정합니다.", "New providers are included by default. Providers with available models can receive assignments.")}</Text>
      {data && <ProviderSettings theme={theme} providers={data.providers} catalog={data.catalog} busy={busy || loading}
        overrides={data.workerModeOverrides}
        setMode={async (provider, modeId) => {
          const result = await act(() => saveWorkerMode({ provider, modeId, expectedRevision: data.revision }),
            t("다음 작업 세션의 권한을 저장했습니다.", "Saved permissions for new worker sessions."), "provider");
          if (live.current) await refresh(!!result);
        }}
        />}
      {feedbackArea === "provider" && feedback}
    </View>
    {data && <UsageRouting theme={theme} providers={data.providers} reports={data.usage ?? []} supplemental={data.displayUsage} busy={busy || loading}
      usage={{ enabled: data.usageRouting ?? false, ready: !!data.usage, onToggle: () => void (async () => {
        const result = await act(() => changeUsageRouting({enabled:!data.usageRouting,expectedRevision:data.revision}), t("사용량으로 순서를 정하는 설정을 저장했습니다.","Saved the usage ordering preference."), "accounts");
        if (live.current) await refresh(!!result);
      })() }}
      onInclude={async (provider, included) => {
        const result = await act(() => includeProvider({ provider, included, expectedRevision: data.revision }),
          included ? t("이 계정을 자동 배정에 사용합니다.", "This account is used for automatic assignment.") : t("이 계정을 자동 배정에서 껐습니다.", "This account is off for automatic assignment."), "accounts");
        if (live.current) await refresh(!!result);
      }} />}
    {feedbackArea === "accounts" && feedback}
    <View style={section}>
      <Text accessibilityRole="header" style={heading}>{t("모델 배정", "Model routing")}</Text>
      <Text style={{ color: muted }}>{t("어떤 일에 어떤 모델을 쓰는지 한눈에 보고, 그 줄에서 바로 바꿉니다. 바꾼 내용은 바로 저장되어 다음 배정부터 적용됩니다.", "See which model each kind of work uses and change it on its row. Changes are saved at once and apply from the next assignment.")}</Text>
      {data && <RouteEditor data={data} theme={theme} busy={busy || loading}
        save={(grade, candidates, expectedRevision) => saveRouting({ grade, candidates, expectedRevision })} />}
      {feedbackArea === "routing" && feedback}
    </View>
    {configured && coordinator && <CoordinatorReplace theme={theme} coordinator={coordinator} data={data} loading={loading} disabled={busy}
      reload={() => void refresh()} onReplaced={refreshBoard}
      extraAction={replacing => <Button theme={theme} label={t("다이제스트 요청", "Request digest")}
        disabled={busy || replacing || photoDraft.reading}
        onPress={() => { if (!photoDraft.readPending.current) void digest.request(); }} />}
      footer={<DigestFeedback theme={theme} feedback={digest.feedback} />} />}
  </View>;

  return <View style={section}>
    <View style={{ ...wrap, alignItems: "center" }}>
      <Text accessibilityRole="header" style={heading}>{t("코디네이터", "Coordinator")}</Text>
      {coordinator && openCoordinator && <SessionChip theme={theme} label={t("코디네이터 세션", "Coordinator session")} accessibilityLabel={t("코디네이터 세션 열기", "Open coordinator session")} onPress={() => openCoordinator(coordinator)} />}
    </View>
    {coordinator ? <>
      <View style={{ ...wrap, alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color, fontWeight: "600" }}>{t("코디네이터에게 맡길 일", "Request for the coordinator")}</Text>
        <Button theme={theme} expanded={editorExpanded}
          label={editorExpanded ? t("입력창 접기", "Collapse editor") : t("입력창 펼치기", "Expand editor")}
          onPress={() => setEditorExpanded(expanded => !expanded)} />
      </View>
      <PhotoComposer theme={theme} disabled={busy} draft={photoDraft} text={text} showHint
        openSession={openCoordinator ? () => openCoordinator(coordinator) : undefined}>
        <SendTextInput send={sendRequest} accessibilityLabel={t("코디네이터에게 맡길 일", "Request for the coordinator")} placeholder={t("예: 초안 작성과 자료 검증을 나눠 맡겨 주세요", "Example: Assign the first draft and source checks separately.")} value={text}
          placeholderTextColor={muted} style={{ minHeight: 64, height: editorExpanded ? Math.min(480, Math.max(160, Math.round(windowHeight * 0.48))) : undefined,
            padding: 10, textAlignVertical: "top", color,
            backgroundColor: theme.colors.surface0, borderColor: inputFocused ? theme.colors.accent : muted, borderWidth: 2, borderRadius: 7 }}
          onFocus={() => setInputFocused(true)} onBlur={() => setInputFocused(false)}
          editable={!busy} multiline maxLength={24000} onChangeText={setText} />
      </PhotoComposer>
      <View style={wrap}>
        <SendButton theme={theme} label={t("코디네이터에 요청 보내기", "Send to coordinator")} send={sendRequest} selected={!sendRequest.disabled} />
      </View>
      <Text style={{ color: muted }}>{!configured ? t("설정에서 관리할 프로젝트를 선택해 주세요.", "Choose a project to manage in Settings.") : t("작업 요청은 코디네이터에게 전달됩니다.", "Work requests go to the coordinator.")}</Text>
    </> : <>
      <Text style={{ color: muted }}>{loading ? t("사용할 수 있는 모델을 확인하고 있습니다.", "Checking available models\u2026") :
        model ? t(`연결된 모델로 운영 세션을 만듭니다 · ${routeName(model, t)}`, `Create a coordinator session with ${routeName(model, t)}`) :
        data ? explainEmptyRoute(data, "M", t) : t("설정에서 실행기와 모델을 새로 고쳐 주세요.", "Refresh providers and models in Settings.")}</Text>
      {!loading && model && <Text style={{ color: muted }}>{modeText}</Text>}
      <View style={wrap}><Button theme={theme} label={data?.routing.M ? t("저장한 모델로 시작", "Start with saved model") : t("추천 설정으로 시작", "Start with recommended settings")} disabled={busy || loading || !model || !mode || !languageReady} onPress={connect} /></View>
    </>}
    {feedback}
  </View>;
}
