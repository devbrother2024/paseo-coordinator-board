import { useRpc } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { dispatchHosts, saveDispatchHost, type DispatchHosts } from "../shared/dispatch-hosts";
import { hostPlatform, hostSessionLimit, platformLabels, taskPlatform, type TaskPlatform } from "../shared/host-assignment";
import { workPlacementText } from "../shared/operations";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";

const wrap = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6, alignItems: "center" as const };

export function useDispatchHosts(active: boolean, settings = false) {
  const fetch = useRpc(dispatchHosts);
  const request = useRef(fetch);
  request.current = fetch;
  const version = useRef(0);
  const [data, setData] = useState<DispatchHosts>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async () => {
    if (!active) return;
    const pending = ++version.current;
    setLoading(true);
    setFailed(false);
    try {
      const next = await request.current(settings ? { settings: true } : {});
      if (!next.hosts.some(host => host.local)) throw new Error("Host directory unavailable");
      if (pending === version.current) setData(next);
    } catch {
      if (pending === version.current) setFailed(true);
    } finally {
      if (pending === version.current) setLoading(false);
    }
  }, [active, settings]);
  useEffect(() => {
    void reload();
    return () => { version.current++; };
  }, [reload]);
  return { data, loading, failed, reload };
}

export function AssignmentRegistrationHelp({ theme }: { theme: Theme }) {
  const { t } = useBoardLanguage();
  const colors = theme.colors;
  return <View style={{ gap: 5 }}>
    <Text style={{ color: colors.foregroundMuted }}>{t(
      "배정할 기기는 이 보드의 Paseo 데몬에 등록해야 합니다. 보드가 설치된 기기에서 아래 명령으로 등록한 뒤 배정 연결을 새로 고쳐 주세요.",
      "Register each assignment host with this board’s Paseo daemon. Run this command on the board host, then refresh assignment connections.",
    )}</Text>
    <Text selectable style={{ color: colors.foreground }}>{`paseo host add <${t("연결 주소", "connection")}> --label <${t("호스트 이름", "host name")}>`}</Text>
    <ExternalLink href="https://paseo.sh/docs/cli#connected-hosts">
      <Text style={{ color: colors.accent }}>{t("Paseo 호스트 연결 안내", "Paseo host connection guide")}</Text>
    </ExternalLink>
  </View>;
}

export function DispatchHostEditor({ host, directory, theme, reload }: {
  host: DispatchHosts["hosts"][number]; directory: DispatchHosts; theme: Theme; reload: () => Promise<void>;
}) {
  const { t } = useBoardLanguage();
  const save = useRpc(saveDispatchHost);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [limit, setLimit] = useState(String(host.settings.limit ?? ""));
  const [projectId, setProjectId] = useState<string>();
  const wait = useRef(false);
  useEffect(() => { setLimit(String(host.settings.limit ?? "")); }, [host.settings.limit]);
  const c = theme.colors;
  const policy = host.settings;
  const value = limit.trim() ? hostSessionLimit.safeParse(Number(limit)) : { success: true as const, data: null };
  const selectedProject = directory.projects.find(project => project.id === projectId);
  const pinned = selectedProject ? policy.pairs[selectedProject.id] : undefined;
  const candidate = pinned && host.projects.find(project => project.id === pinned);

  async function update(settings: typeof policy) {
    if (wait.current) return;
    wait.current = true;
    setSaving(true);
    setFailed(false);
    try {
      await save({ serverId: host.id, expectedRevision: directory.revision, settings });
    } catch {
      setFailed(true);
    } finally {
      await reload();
      wait.current = false;
      setSaving(false);
    }
  }

  return <View style={{ gap: 7 }}>
    <View style={wrap}>
      <Text style={{ color: c.foregroundMuted }}>{host.online
        ? policy.enabled ? t("배정 가능", "Assignments enabled") : t("배정 꺼짐", "Assignments disabled")
        : t("배정 연결 끊김", "Assignment connection offline")}</Text>
      {host.resolved && <Button theme={theme} expanded={expanded} accessibilityLabel={host.label + " · " + t("배정 설정", "Assignment settings")}
        label={t("배정 설정", "Assignment settings")} onPress={() => setExpanded(open => !open)} />}
    </View>
    {expanded && <View style={{ gap: 7, borderLeftWidth: 2, borderColor: c.border, paddingLeft: 10 }}>
      <Button theme={theme} toggle selected={policy.enabled} disabled={saving} label={t("작업 배정 대상", "Accept assignments")}
        onPress={() => void update({ ...policy, enabled: !policy.enabled })} />
      <Text style={{ color: c.foreground, fontWeight: "600" }}>{t("운영체제", "Operating system")}</Text>
      <View style={wrap}>
        <Button theme={theme} selected={policy.platform === null} disabled={saving}
          label={t("자동", "Automatic") + " · " + (host.detected ? t(...platformLabels[host.detected]) : t("미확인", "Unknown"))}
          onPress={() => void update({ ...policy, platform: null })} />
        {hostPlatform.options.map(platform => <Button theme={theme} key={platform} label={t(...platformLabels[platform])}
          selected={policy.platform === platform} disabled={saving} onPress={() => void update({ ...policy, platform })} />)}
      </View>
      <View style={wrap}>
        <Text style={{ color: c.foreground }}>{t("동시 세션 상한", "Concurrent session limit")}</Text>
        <TextInput value={limit} onChangeText={setLimit} keyboardType="number-pad" editable={!saving} maxLength={16}
          accessibilityLabel={t("동시 세션 상한", "Concurrent session limit")} placeholder={t("제한 없음", "Unlimited")} placeholderTextColor={c.foregroundMuted}
          style={{ minWidth: 100, borderWidth: 1, borderRadius: 7, borderColor: c.border, color: c.foreground, padding: 7 }} />
        <Button theme={theme} label={t("상한 저장", "Save limit")} disabled={saving || !value.success || value.data === policy.limit}
          onPress={() => { if (value.success) void update({ ...policy, limit: value.data }); }} />
      </View>
      {!host.local && directory.projects.length > 0 && <>
        <Text style={{ color: c.foreground, fontWeight: "600" }}>{t("프로젝트 짝", "Project pairing")}</Text>
        <View style={wrap}>{directory.projects.map(project => <Button theme={theme} key={project.id} label={project.name}
          selected={project.id === projectId} onPress={() => setProjectId(project.id === projectId ? undefined : project.id)} />)}</View>
        {selectedProject && <>
          <Text style={{ color: c.foregroundMuted }}>
            {selectedProject.name} · {candidate ? candidate.name : pinned ? t("저장된 짝 확인 불가", "Saved match unavailable") : t("자동 연결", "Automatic matching")}
          </Text>
          <ScrollView style={{ maxHeight: 154 }} contentContainerStyle={wrap} keyboardShouldPersistTaps="handled">
            <Button theme={theme} selected={!pinned} disabled={saving || !pinned} label={t("자동 연결", "Automatic matching")}
              onPress={() => {
                const pairs = { ...policy.pairs };
                delete pairs[selectedProject.id];
                void update({ ...policy, pairs });
              }} />
            {host.projects.map(project => <Button theme={theme} key={project.id} label={project.name} selected={pinned === project.id} disabled={saving}
              onPress={() => void update({ ...policy, pairs: { ...policy.pairs, [selectedProject.id]: project.id } })} />)}
          </ScrollView>
        </>}
      </>}
      {failed && <Text accessibilityLiveRegion="polite" style={{ color: c.statusDanger }}>
        {t("배정 설정을 저장하지 못했습니다. 연결과 최신 설정을 확인해 주세요.", "Could not save assignment settings. Check the connection and current settings.")}
      </Text>}
    </View>}
  </View>;
}

export function WorkPlacement({ theme, platform, host, disabled, setPlatform, setHost }: {
  theme: Theme; platform?: TaskPlatform; host?: string; disabled: boolean;
  setPlatform: (value: TaskPlatform | undefined) => void; setHost: (value: string | undefined) => void;
}) {
  const { t } = useBoardLanguage();
  const [expanded, setExpanded] = useState(false);
  const { data, failed, loading, reload } = useDispatchHosts(true);
  const hasAssignmentHosts = data?.hosts.some(host => !host.local);
  // Keep an already selected constraint visible until the person clears it.
  if (!hasAssignmentHosts && !platform && !host) return null;
  const fields = workPlacementText(platform, host);
  return <View style={{ gap: 7 }}>
    <View style={wrap}>
      <Button theme={theme} expanded={expanded} label={t("배정 조건", "Assignment options")} onPress={() => setExpanded(open => !open)} />
      {!!fields && <Text style={{ color: theme.colors.foregroundMuted }}>
        {t("요청에 포함", "Included in request")} · {fields.replace("\n", " · ")}
      </Text>}
    </View>
    {expanded && <>
      <View style={wrap}>
        <Button theme={theme} label={t("코디네이터가 판단", "Coordinator chooses")} selected={!platform} disabled={disabled}
          onPress={() => setPlatform(undefined)} />
        {taskPlatform.options.map(value => <Button theme={theme} key={value} label={t(...platformLabels[value])} selected={platform === value}
          disabled={disabled} onPress={() => setPlatform(value)} />)}
      </View>
      {(hasAssignmentHosts || host) && <View style={wrap}>
        <Button theme={theme} label={t("호스트 자동 선택", "Choose host automatically")} selected={!host} disabled={disabled}
          onPress={() => setHost(undefined)} />
        {data?.hosts.filter(choice => choice.resolved).map(choice => <Button theme={theme} key={choice.id} label={choice.label + (choice.online
          ? "" : " · " + t("연결 끊김", "Offline"))} selected={host === choice.label} disabled={disabled}
          onPress={() => setHost(choice.label)} />)}
      </View>}
      {loading && <Text style={{ color: theme.colors.foregroundMuted }}>{t("배정 호스트 확인 중…", "Checking assignment hosts…")}</Text>}
      {failed && <Button theme={theme} label={t("배정 호스트 다시 읽기", "Retry assignment hosts")} onPress={() => void reload()} />}
    </>}
  </View>;
}
