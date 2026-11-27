import { useRpc } from "@getpaseo/plugin/client";
import { AutoGrowInput } from "./auto-grow-input";
import { SendButton } from "./send-input";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
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
import { MergeJudgmentControls } from "./merge-judgment-controls";
import { CoordinatorPinControls } from "./coordinator-pin";
import { CoordinatorReplace } from "./coordinator-replace";
import { RetiredCoordinator } from "./retired-coordinator";
import { RouteEditor, routeName, wrap, type RoutingSave } from "./route-editor";
import { useBoardLanguage } from "./language";
import { projectFilterNames } from "./model";
import { explainEmptyRoute, projectRoutingSettings } from "./route-options";
import { DigestFeedback, type CoordinatorAction, type DigestRequest } from "./digest-request";
import { SentRequestHistory } from "./sent-requests";
import { WorkPlacement } from "./dispatch-hosts";
import type { TaskPlatform } from "../shared/host-assignment";

type Props = {
  theme: Theme;
  settings: boolean;
  coordinator: string | null;
  configured: boolean;
  projectMembershipKey: string | null;
  scopeChanging?: boolean;
  refreshBoard: () => void;
  openCoordinator?: (id: string) => void;
  action: CoordinatorAction;
  digest: DigestRequest;
};

export function OperationsPanel({ theme, settings, coordinator, configured, projectMembershipKey, scopeChanging, refreshBoard, openCoordinator, action: { pending, busy, setBusy }, digest }: Props) {
  const { t, language, languageReady } = useBoardLanguage();
  const fetchState = useRpc(operationState),
    setup = useRpc(setupCoordinator),
    includeProvider = useRpc(setProviderInclusion),
    saveWorkerMode = useRpc(setWorkerMode),
    changeUsageRouting = useRpc(setUsageRouting),
    savePolicy = useRpc(updateRouting);
  const [selectedProject, setProject] = useState<string | null>(null);
  const view = settings ? "settings" : configured && !coordinator ? "setup" : null;
  const membership = settings && !scopeChanging ? projectMembershipKey : null;
  const readScope = useMemo(() => {
    if (!view || (view === "settings" && membership === null)) return null;
    return { view, membership };
  }, [view, membership]);
  const [read, setRead] = useState<{ scope: NonNullable<typeof readScope>; data: Operations | null; loading: boolean } | null>(null);
  const data = read?.scope === readScope ? read.data : null;
  const loading = !!readScope && (read?.scope !== readScope || read.loading);
  const sendWork = useRpc(requestWork);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [text, setText] = useState("");
  const [sendAttempts, setSendAttempts] = useState(0);
  const [platform, setPlatform] = useState<TaskPlatform>();
  const [host, setHost] = useState<string>();
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
  const activeSettings = useRef({ readScope, selectedProject });
  activeSettings.current = { readScope, selectedProject };
  const refresh = useCallback(async (clearError = true) => {
    if (!live.current || !readScope || activeSettings.current.readScope !== readScope) return;
    const token = ++generation.current;
    const matches = () => live.current && token === generation.current && activeSettings.current.readScope === readScope;
    setRead(previous => ({ scope: readScope, data: previous?.scope === readScope ? previous.data : null, loading: true }));
    try {
      // An older daemon may still accept only the original empty input.
      const result = readScope.view === "setup" ? await fetchRef.current({ view: "setup" }).catch(error => {
        if (!/unrecognized[_ ]keys?|invalid (?:rpc )?input|unexpected key/i.test(String(error))) throw error;
        return fetchRef.current({});
      }) : await fetchRef.current({});
      if (matches()) {
        setRead({ scope: readScope, data: result, loading: false });
        if (clearError) setError("");
      }
      return result;
    } catch (e) {
      if (matches()) {
        setRead({ scope: readScope, data: null, loading: false });
        setFeedbackArea("provider");
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  }, [readScope]);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);
  useEffect(() => {
    if (readScope) void refresh();
  }, [readScope, refresh]);
  useEffect(() => {
    delivery.current = { payload: "", key: "" };
    setPlatform(undefined);
    setHost(undefined);
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
    if (!settingsAreCurrent()) return { ok: false, message: t("배정 설정이 바뀌었습니다. 새로 고쳐 주세요.", "Routing settings changed. Refresh and try again."), revision: null };
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
    const payload = JSON.stringify([coordinator, message, images.map(photo => photo.id), platform, host]);
    if (delivery.current.payload !== payload) delivery.current = {
      payload,
      key: "board-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2),
    };
    const receipt = await act(
      async () => {
        const result = await sendWork({ coordinator, requestKey: delivery.current.key, text: message, platform, host,
          ...(images.length > 0 && { images: images.map(photo => photo.image) }) });
        if (!result.ok) throw Error(t("전송을 확인하지 못했습니다. 다시 시도해 주세요.", "Delivery was not confirmed. Please retry."));
        return result;
      },
      images.length
        ? t(`사진 ${images.length}장과 함께 코디네이터에게 요청을 보냈습니다.`, `Sent the request to the coordinator with ${images.length} photo${images.length === 1 ? "" : "s"}.`)
        : t("첨부 없이 코디네이터에게 요청을 보냈습니다.", "Sent the request to the coordinator without attachments."),
    );
    if (live.current) setSendAttempts(n => n + 1);
    if (receipt && live.current) {
      delivery.current = { payload: "", key: "" };
      setText("");
      setPlatform(undefined);
      setHost(undefined);
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
    if (!model || !mode || !configured || !languageReady || loading || activeSettings.current.readScope !== readScope) return;
    void act(
      () => setup({ expectedCoordinator: coordinator, replace: !!coordinator, expectedRoute: model, expectedModeId: mode.id, language }),
      t("운영 세션을 연결했습니다.", "Coordinator session connected."),
    ).then((result) => {
      if (result && live.current) {
        if (result.pinFailed) setNotice(t("운영 세션을 연결했습니다. 사이드바 고정은 설정에서 다시 시도해 주세요.", "Coordinator connected. Retry sidebar pinning in Settings."));
      }
    });
  }

  const projects = data?.projectRouting ? data.routingProjects ?? [] : [];
  const projectNames = projectFilterNames(projects);
  const projectId = selectedProject;
  const projectUnavailable = !!data && projectId !== null && !projectNames.has(projectId);
  const routingSettings = data && !projectUnavailable ? projectRoutingSettings(data, projectId) : null;
  const projectExclusions = routingSettings?.projectExclusions;
  const canEditProviders = !projectId || projectExclusions !== undefined;
  const settingsDisabled = busy || loading;
  const renderedGeneration = generation.current;
  function settingsAreCurrent() {
    return !!routingSettings && !settingsDisabled && renderedGeneration === generation.current
      && activeSettings.current.readScope === readScope && activeSettings.current.selectedProject === projectId;
  }
  if (settings) return <View style={{ gap: 14 }}>
    <FactReplyControls theme={theme} />
    <MergeJudgmentControls theme={theme} />
    <CoordinatorPinControls theme={theme} coordinator={coordinator} />
    {data && (projects.length > 0 || projectUnavailable) && <View style={section}>
      <Text accessibilityRole="header" style={heading}>{t("배정 설정 범위", "Routing scope")}</Text>
      <View style={wrap}>
        <Button theme={theme} label={t("보드 기본값", "Board defaults")} selected={!projectId} disabled={settingsDisabled} onPress={() => setProject(null)} />
        {projects.map(p => (
          <Button key={p.id} theme={theme}
            label={projectNames.get(p.id) ?? p.title}
            selected={projectId === p.id} disabled={settingsDisabled} onPress={() => setProject(p.id)} />
        ))}
      </View>
      {projectUnavailable && <Text accessibilityLiveRegion="polite" style={{ color: muted }}>{t(
        "이 프로젝트의 배정 설정을 사용할 수 없습니다. 다른 배정 범위를 선택해 주세요.",
        "Routing settings for this project are unavailable. Choose a routing scope.",
      )}</Text>}
    </View>}
    <View style={section}>
      <View style={{ ...wrap, alignItems: "center", justifyContent: "space-between" }}>
        <Text accessibilityRole="header" style={heading}>{t("Paseo 실행기", "Paseo providers")}</Text>
        <Button theme={theme} label={loading ? t("실행기 조회 중…", "Loading providers\u2026") : t("실행기·모델 새로 고침", "Refresh providers and models")} disabled={!readScope || settingsDisabled} onPress={() => void refresh()} />
      </View>
      {!readScope && <Text style={{ color: muted }}>{t("프로젝트 목록을 확인하고 있습니다.", "Waiting for the managed project list.")}</Text>}
      {routingSettings && <Text style={{ color: muted }}>{!canEditProviders
        ? t("이 호스트에서는 보드 기본값에서 실행기 설정을 바꿀 수 있습니다.", "To change providers on this host, select Board defaults.")
        : projectExclusions
          ? t("이 프로젝트의 A~D 작업은 보드의 실행기 설정을 따릅니다. 이 프로젝트에서만 실행기를 제외할 수 있습니다.", "This project inherits the board's providers for worker grades A through D. You can exclude providers for this project.")
          : t("이 설정은 호스트 전체에 적용됩니다. 새로 발견한 실행기는 기본으로 포함됩니다.", "These settings apply across the host. New providers are included by default.")}</Text>}
      {canEditProviders && data && routingSettings && <ProviderSettings theme={theme} providers={data.providers} catalog={routingSettings.data.catalog} busy={settingsDisabled}
        projectExclusions={projectExclusions} overrides={data.workerModeOverrides}
        setMode={async (provider, modeId) => {
          if (!settingsAreCurrent() || projectId) return;
          const result = await act(() => saveWorkerMode({ provider, modeId, expectedRevision: data.revision }),
            t("다음 작업 세션의 권한을 저장했습니다.", "Saved permissions for new worker sessions."), "provider");
          if (live.current) await refresh(!!result);
        }}
        change={async (provider, included) => {
          if (!settingsAreCurrent()) return;
          const result = await act(
            () => includeProvider({ provider, included, expectedRevision: data.revision, ...(projectId && projectExclusions && { projectId }) }),
            projectExclusions
              ? included ? t("이 실행기는 이제 보드 기본값을 따릅니다.", "This provider now follows the board default.")
                : t("이 프로젝트의 새 작업 배정에서 실행기를 제외했습니다.", "Provider excluded from new assignments in this project.")
              : included ? t("이 실행기를 보드 배정에 포함했습니다.", "Provider included in board routing.")
                : t("이 실행기를 보드 배정에서 제외했습니다.", "Provider excluded from board routing."),
            "provider",
          );
          if (live.current) await refresh(!!result);
        }} />}
      {feedbackArea === "provider" && feedback}
    </View>
    {!projectId && data && <UsageRouting theme={theme} providers={data.providers} reports={data.usage ?? []} supplemental={data.displayUsage} busy={settingsDisabled}
      usage={{ enabled: data.usageRouting ?? false, ready: !!data.usage, onToggle: () => void (async () => {
        if (!settingsAreCurrent()) return;
        const result = await act(() => changeUsageRouting({enabled:!data.usageRouting,expectedRevision:data.revision}), t("사용량으로 순서를 정하는 설정을 저장했습니다.","Saved the usage ordering preference."), "accounts");
        if (live.current) await refresh(!!result);
      })() }}
      onInclude={async (provider, included) => {
        if (!settingsAreCurrent()) return;
        const result = await act(() => includeProvider({ provider, included, expectedRevision: data.revision }),
          included ? t("이 계정을 자동 배정에 사용합니다.", "This account is used for automatic assignment.") : t("이 계정을 자동 배정에서 껐습니다.", "This account is off for automatic assignment."), "accounts");
        if (live.current) await refresh(!!result);
      }} />}
    {feedbackArea === "accounts" && feedback}
    <View style={section}>
      <Text accessibilityRole="header" style={heading}>{t("모델 배정", "Model routing")}</Text>
      <Text style={{ color: muted }}>{t("어떤 일에 어떤 모델을 쓰는지 한눈에 보고, 그 줄에서 바로 바꿉니다. 바꾼 내용은 바로 저장되어 다음 배정부터 적용됩니다.", "See which model each kind of work uses and change it on its row. Changes are saved at once and apply from the next assignment.")}</Text>
      {routingSettings && <RouteEditor key={JSON.stringify(projectId)} data={routingSettings.data} projectId={projectId}
        theme={theme} busy={settingsDisabled} save={(grade, candidates, expectedRevision) => {
          if (!projectId) return saveRouting({ grade, candidates, expectedRevision });
          if (grade !== "M") return saveRouting({ grade, candidates, expectedRevision, projectId });
          return Promise.resolve({ ok: false, message: t("코디네이터 모델은 보드 설정에서 바꿔 주세요.", "Change the coordinator model in board settings."), revision: null });
        }} />}
      {feedbackArea === "routing" && feedback}
    </View>
    {configured && coordinator && <CoordinatorReplace theme={theme} coordinator={coordinator} data={data} loading={loading} disabled={busy}
      reload={() => void refresh()} onReplaced={refreshBoard}
      extraAction={replacing => <Button theme={theme} label={t("다이제스트 요청", "Request digest")}
        disabled={busy || replacing || photoDraft.reading}
        onPress={() => { if (!photoDraft.readPending.current) void digest.request(); }} />}
      footer={<>
        <RetiredCoordinator theme={theme} coordinator={coordinator} open={openCoordinator} />
        <DigestFeedback theme={theme} feedback={digest.feedback} />
      </>} />}
  </View>;

  return <View style={section}>
    <View style={{ ...wrap, alignItems: "center" }}>
      <Text accessibilityRole="header" style={heading}>{t("코디네이터", "Coordinator")}</Text>
      {coordinator && openCoordinator && <SessionChip theme={theme} label={t("코디네이터 세션", "Coordinator session")} accessibilityLabel={t("코디네이터 세션 열기", "Open coordinator session")} onPress={() => openCoordinator(coordinator)} />}
    </View>
    {coordinator ? <>
      <Text style={{ color, fontWeight: "600" }}>{t("코디네이터에게 맡길 일", "Request for the coordinator")}</Text>
      <PhotoComposer theme={theme} disabled={busy} draft={photoDraft} text={text} showHint
        openSession={openCoordinator ? () => openCoordinator(coordinator) : undefined}>
        <AutoGrowInput send={sendRequest} accessibilityLabel={t("코디네이터에게 맡길 일", "Request for the coordinator")} placeholder={t("예: 초안 작성과 자료 검증을 나눠 맡겨 주세요", "Example: Assign the first draft and source checks separately.")} value={text}
          placeholderTextColor={muted} style={{ minHeight: 64,
            padding: 10, textAlignVertical: "top", color,
            backgroundColor: theme.colors.surface0, borderColor: inputFocused ? theme.colors.accent : muted, borderWidth: 2, borderRadius: 7 }}
          onFocus={() => setInputFocused(true)} onBlur={() => setInputFocused(false)}
          editable={!busy} multiline maxLength={24000} onChangeText={setText} />
      </PhotoComposer>
      <WorkPlacement theme={theme} platform={platform} host={host} setPlatform={setPlatform} setHost={setHost} disabled={busy} />
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
    {coordinator && <SentRequestHistory theme={theme} coordinator={coordinator} open={openCoordinator} refreshKey={sendAttempts} />}
  </View>;
}
