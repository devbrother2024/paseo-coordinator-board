import { useBoardLanguage, type Translate } from "./language";
import { useState } from "react";
import { Text, View } from "react-native";
import { eligibleProvider, workerGradeSchema, recommendedWorkerMode, type CatalogModel } from "../shared/dispatch";
import type { Operations } from "../shared/operations";
import { Button, type Theme } from "./controls";

type Provider = Operations["providers"][number];

function catalogStatus(provider: Provider, t: Translate) {
  if (provider.status === "unavailable") return t("사용 불가", "Unavailable");
  if (provider.status === "error") return t("모델 조회 실패", "Model lookup failed");
  if (provider.status === "empty") return t("모델 없음", "No models");
  return provider.modelCount === null ? t("모델 수 미확인", "Model count unknown") : t(`모델 ${provider.modelCount}개`, `Models: ${provider.modelCount}`);
}

function roles(id: string, catalog: CatalogModel[], t: Translate) {
  const grades = workerGradeSchema.options.filter(grade => eligibleProvider(grade, id, false, catalog));
  const worker = grades.length === 4 ? "A~D" : grades.join("·");
  const scope = [t(`작업 ${worker}`, `Work ${worker}`)];
  if (eligibleProvider("M", id, false, catalog)) scope.push(t("운영 M", "Coordinator M"));
  if (eligibleProvider("D", id, true)) scope.push(t("필수 훅", "Required hooks"));
  return scope.join(" / ");
}

export function ProviderSettings({ providers, catalog, theme, busy, overrides, setMode }: {
  providers: Provider[]; catalog: CatalogModel[];
  theme: Theme;
  busy: boolean;
  overrides?: Record<string,string>;
  setMode: (provider: string, mode: string | null) => void;
}) {
  const { t } = useBoardLanguage();
  const [expanded, setExpanded] = useState(true);
  const [width, setWidth] = useState(0);
  const columns = Math.max(1, Math.floor((width + 8) / 260));
  const cardWidth = width > 0 ? Math.floor((width - 8 * (columns - 1)) / columns) : "100%";
  const c = theme.colors;
  if (!providers.length) return <Text style={{ color: c.foregroundMuted }}>{t("Paseo가 발견한 실행기가 없습니다. Paseo에서 실행기를 연결한 뒤 새로 고쳐 주세요.", "Paseo found no providers. Connect a provider in Paseo, then refresh.")}</Text>;
  const included = providers.filter(p => p.included);
  const ready = included.filter(p => p.available && p.status === "ready");
  return <View style={{ gap: 8 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
      <Text style={{ color: c.foregroundMuted }}>{t(`발견 ${providers.length}개 · 배정에 포함 ${included.length}개 · 모델 선택 가능 ${ready.length}개`, `Discovered ${providers.length} · Included ${included.length} · With models ${ready.length}`)}</Text>
      <Button theme={theme} label={expanded ? t("목록 접기", "Collapse list") : t("실행기 목록 펼치기", "Expand provider list")} onPress={() => setExpanded(!expanded)} />
    </View>
    {expanded && <View onLayout={event => setWidth(event.nativeEvent.layout.width)} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {providers.map(provider => <View key={provider.id} style={{
        width: cardWidth, padding: 10, gap: 5,
        borderWidth: 1, borderRadius: 8, borderColor: c.border, backgroundColor: c.surface0,
      }}>
        <Text selectable style={{ fontWeight: "600", color: c.foreground }}>{provider.label}</Text>
        <Text selectable style={{ fontSize: 12, color: c.foregroundMuted }}>{provider.id} · {catalogStatus(provider, t)}</Text>
        <Text style={{ fontSize: 12, color: c.foregroundMuted }}>{roles(provider.id, catalog, t)}</Text>
        {overrides && (provider.workerModes?.length || Object.hasOwn(overrides, provider.id) || recommendedWorkerMode(provider.id)) ? <WorkerPermissions
          provider={provider.id} modes={provider.workerModes} selected={Object.hasOwn(overrides, provider.id) ? overrides[provider.id] : undefined}
          theme={theme} busy={busy} save={setMode} /> : null}
        {!provider.included && <Text style={{ fontSize: 12, color: c.statusWarning }}>
          {t("자동 배정에서 꺼짐 · ‘계정과 사용량’에서 다시 켤 수 있습니다.", "Turned off for automatic assignment · Turn it back on under Accounts and usage.")}
        </Text>}
      </View>)}
    </View>}
  </View>;
}

function WorkerPermissions({provider, modes, selected, theme, busy, save}: {
  provider: string; modes: Provider["workerModes"]; selected?: string;
  theme: Theme; busy: boolean; save: (provider: string, mode: string | null) => void;
}) {
  const { t } = useBoardLanguage();
  const [open, setOpen] = useState(false);
  const current = selected ?? recommendedWorkerMode(provider);
  const label = modes?.find(m => m.id === current)?.label ?? current ?? t("실행기 기본", "Provider default");
  return <View style={{ gap: 5 }}>
    <Button theme={theme} label={t(`새 작업 세션 권한 · ${label}`, `New worker permissions · ${label}`)}
      onPress={() => setOpen(!open)} />
    {open && <>
      {current && !modes?.some(m => m.id === current) && <Text style={{color:theme.colors.foregroundMuted}}>{t("호스트에서 현재 선택을 확인할 수 없습니다.", "This host has not confirmed the selected mode.")}</Text>}
      <View style={{flexDirection:"row", flexWrap:"wrap", gap:5}}>
        {modes?.map(mode => <Button key={mode.id} theme={theme} label={mode.label} selected={current === mode.id} disabled={busy}
          onPress={() => save(provider, mode.id)} />)}
        {selected !== undefined && <Button theme={theme} label={t("권장 모드 복원","Restore recommended mode")} disabled={busy} onPress={() => save(provider, null)} />}
      </View>
      {provider === "codex" && modes?.some(m => m.id === "full-access") &&
        <Text style={{color:theme.colors.foregroundMuted}}>{t("Full Access를 고르면 새 Codex 작업자가 샌드박스 밖에서도 명령을 실행할 수 있습니다.", "Full Access lets new Codex workers run commands outside the sandbox.")}</Text>}
    </>}
  </View>;
}
