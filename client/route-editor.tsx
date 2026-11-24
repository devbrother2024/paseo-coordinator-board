import { Modal } from "@getpaseo/plugin/client/ui";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Text, View } from "react-native";
import type { Grade, RouteChoice } from "../shared/dispatch";
import type { Operations } from "../shared/operations";
import { Button, type Theme } from "./controls";
import { useBoardLanguage, type Translate } from "./language";
import { routeEfforts } from "./model-choices";
import { ModelPicker } from "./model-picker";
import { koreanText } from "./route-options";
import {
  addCandidate, canAdd, canRemove, dismissFailure, editAnnouncement, editableCandidates, expireEdits, lostToAnotherChange, moveFirst, moveUp, nextExpiry,
  removeCandidate, saveConflicted, saveFailed, saveStarted, saveSucceeded, sameList, setEffort, undoIssue, undoTarget, type RoutingEdits, type RowEdit,
} from "./routing-edit";
import { gradeLabel, modeLabel, routeLabel, routingOverview, type RoutingRow } from "./routing-overview";

export function routeName(route: RouteChoice | null, t: Translate = koreanText) {
  return route ? [route.provider, route.model, route.effort].filter(Boolean).join(" / ") : t("사용 가능한 후보 없음", "No available candidate");
}
export const wrap = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };

// The latest stored revision comes back with a refusal, so a change that lost to another screen can be told apart.
export type RoutingSave = { ok: true } | { ok: false; message: string; revision: number | null };
type Props = {
  data: Operations; theme: Theme; busy: boolean;
  save: (grade: Grade, candidates: RouteChoice[], revision: number) => Promise<RoutingSave>;
};

export function RouteEditor({ data, theme, busy, save }: Props) {
  const { t } = useBoardLanguage();
  const [open, setOpen] = useState<Grade | null>(null);
  const [adding, setAdding] = useState<Grade | null>(null);
  const [edits, setEdits] = useState<RoutingEdits>({});
  const [width, setWidth] = useState(0);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // Notes and undo offers leave on their own.
  useEffect(() => {
    const at = nextExpiry(edits);
    if (at === null) return;
    const timer = setTimeout(() => setEdits(current => expireEdits(current, Date.now())), Math.max(0, at - Date.now()) + 20);
    return () => clearTimeout(timer);
  }, [edits]);
  const c = theme.colors;
  const compact = width > 0 && width < 640;
  const rows = routingOverview(data, t);

  async function commit(grade: Grade, candidates: RouteChoice[], undo = false) {
    if (busy || edits[grade]?.saving) return;
    const previous = data.routing[grade] ?? [];
    if (sameList(candidates, previous)) return;
    const revision = data.revision;
    // A grade that followed remaining usage stops doing so once it has a saved order.
    const leftUsage = !undo && !!candidates.length && rows.find(row => row.grade === grade)?.mode === "usage";
    setEdits(current => saveStarted(current, grade));
    const result = await save(grade, candidates, revision);
    if (!live.current) return;
    const now = Date.now();
    const outcome = (current: RoutingEdits) => result.ok ? saveSucceeded(current, grade, undo ? null : previous, now, leftUsage)
      : lostToAnotherChange(revision, result.revision) ? saveConflicted(current, grade, now) : saveFailed(current, grade, candidates, result.message);
    setEdits(outcome);
    // The row shows the same words. A screen reader that does not follow live regions is told directly.
    const words = editAnnouncement(outcome({})[grade], gradeLabel(grade, t), t);
    if (words) AccessibilityInfo.announceForAccessibility?.(words);
  }
  // Changing an unsaved grade saves the board's own candidates with that one change applied.
  const change = (grade: Grade, next: RouteChoice[]) => {
    if (!sameList(next, editableCandidates(data, grade))) void commit(grade, next);
  };

  return <View style={{ gap: 10 }} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    <Text style={{ fontSize: 12, color: c.foregroundMuted }}>{t("적용 범위 · 보드 기본", "Applies to · Board default")}</Text>
    <View role={compact ? undefined : "table"} style={{ gap: compact ? 8 : 0, borderWidth: compact ? 0 : 1, borderColor: c.border, borderRadius: 8, overflow: "hidden" }}>
      {!compact && <View role="row" style={{ flexDirection: "row", gap: 10, paddingHorizontal: 10, paddingVertical: 7, backgroundColor: c.surface0 }}>
        {[[t("등급", "Grade"), columns.grade], [t("쓰는 일", "Used for"), columns.purpose], [t("지금 쓰는 모델", "Model in use"), columns.model],
          [t("정한 방식", "Decided by"), columns.mode], [t("예비", "Fallbacks"), columns.fallbacks]].map(([title, style]) =>
          <Text key={title as string} role="columnheader" style={{ ...(style as object), color: c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{title as string}</Text>)}
        <View style={columns.action} />
      </View>}
      {rows.map(row => <GradeRow key={row.grade} row={row} data={data} theme={theme} compact={compact} busy={busy}
        open={open === row.grade} adding={adding === row.grade} edit={edits[row.grade]} usageRouting={!!data.usageRouting}
        undoBlocked={edits[row.grade]?.undo ? undoIssue(data, row.grade, edits[row.grade]!.undo!.previous, t) : null}
        onToggle={() => { setOpen(open === row.grade ? null : row.grade); setAdding(null); }}
        onAdding={value => setAdding(value ? row.grade : null)}
        onChange={next => change(row.grade, next)}
        onReset={() => void commit(row.grade, [])}
        onUndo={() => { const target = undoTarget(edits, row.grade, Date.now()); if (target) void commit(row.grade, target, true); }}
        onRetry={() => { const failed = edits[row.grade]?.failed; if (failed) void commit(row.grade, failed.candidates); }}
        onDismiss={() => setEdits(current => dismissFailure(current, row.grade))} />)}
    </View>
  </View>;
}

const columns = {
  grade: { width: 96 }, purpose: { flex: 1.3, minWidth: 0 }, model: { flex: 1.5, minWidth: 0 }, mode: { width: 108 }, fallbacks: { width: 64 }, action: { width: 84 },
} as const;

type RowProps = {
  row: RoutingRow; data: Operations; theme: Theme; compact: boolean; busy: boolean; open: boolean; adding: boolean; edit: RowEdit | undefined;
  usageRouting: boolean; undoBlocked: string | null;
  onToggle: () => void; onAdding: (value: boolean) => void; onChange: (next: RouteChoice[]) => void;
  onReset: () => void; onUndo: () => void; onRetry: () => void; onDismiss: () => void;
};

function GradeRow({ row, data, theme, compact, busy, open, adding, edit, usageRouting, undoBlocked, onToggle, onAdding, onChange, onReset, onUndo, onRetry, onDismiss }: RowProps) {
  const { t } = useBoardLanguage();
  const c = theme.colors;
  const locked = busy || !!edit?.saving;
  const list = row.candidates.map(candidate => candidate.route);
  const model = <Text selectable style={{ color: row.active ? c.foreground : c.statusWarning, fontWeight: "600" }}>{routeLabel(row.active, t)}</Text>;
  const toggle = <Button theme={theme} expanded={open} label={open ? t("닫기", "Close") : t("바꾸기", "Change")}
    accessibilityLabel={row.label + " · " + (open ? t("닫기", "Close") : t("바꾸기", "Change"))} onPress={onToggle} />;
  const fallbacks = t(`예비 ${row.fallbacks}`, `${row.fallbacks} fallback${row.fallbacks === 1 ? "" : "s"}`);
  return <View role={compact ? undefined : "row"} style={compact
    ? { gap: 6, padding: 10, borderWidth: 1, borderColor: c.border, borderRadius: 8, backgroundColor: c.surface0 }
    : { gap: 6, paddingHorizontal: 10, paddingVertical: 8, borderTopWidth: 1, borderTopColor: c.border }}>
    {compact ? <>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontWeight: "700" }}>{row.label}</Text>
        {toggle}
      </View>
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{row.purpose}</Text>
      {model}
      <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{modeLabel(row.mode, t)} · {fallbacks}</Text>
    </> : <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
      <Text style={{ ...columns.grade, color: c.foreground, fontWeight: "700" }}>{row.label}</Text>
      <Text style={{ ...columns.purpose, color: c.foregroundMuted, fontSize: 12 }}>{row.purpose}</Text>
      <View style={columns.model}>{model}</View>
      <Text style={{ ...columns.mode, color: c.foregroundMuted, fontSize: 12 }}>{modeLabel(row.mode, t)}</Text>
      <Text accessibilityLabel={fallbacks} style={{ ...columns.fallbacks, color: c.foregroundMuted, fontSize: 12 }}>{row.fallbacks}</Text>
      <View style={{ ...columns.action, alignItems: "flex-end" }}>{toggle}</View>
    </View>}
    {row.notice && <Text selectable style={{ color: c.statusWarning, fontSize: 12 }}>{row.notice}</Text>}
    <SaveStatus edit={edit} label={row.label} theme={theme} busy={busy} undoBlocked={undoBlocked} onUndo={onUndo} onRetry={onRetry} onDismiss={onDismiss} onReset={onReset} />
    {open && <View style={{ gap: 8, padding: compact ? 0 : 10, paddingTop: compact ? 4 : 10, borderRadius: 7, backgroundColor: compact ? undefined : c.surface0 }}>
      {row.grade === "M" && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {t("바꿔도 지금 코디네이터는 그대로 일합니다. 다음에 코디네이터를 만들거나 교체할 때 적용됩니다.", "The current coordinator keeps working. This applies the next time a coordinator is created or replaced.")}
      </Text>}
      {row.mode === "custom" && usageRouting && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {t("이 등급은 직접 정한 순서로 고릅니다. 사용량 자동 선택은 적용되지 않습니다.", "This grade follows the order saved here. Usage-based selection does not apply to it.")}
      </Text>}
      {row.mode !== "custom" && !!list.length && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {t("보드가 고른 순서입니다. 여기서 바꾸면 이 등급은 직접 지정으로 저장됩니다.", "This is the board's own order. A change here saves this grade as custom.")}
      </Text>}
      {row.candidates.map((candidate, index) => <View key={JSON.stringify(candidate.route)}
        style={{ ...wrap, alignItems: "center", paddingVertical: 4, borderTopWidth: index ? 1 : 0, borderTopColor: c.border }}>
        <Text selectable style={{ flexGrow: 1, flexShrink: 1, flexBasis: compact ? "100%" : 260, color: candidate.issue ? c.foregroundMuted : c.foreground }}>
          <Text style={{ fontWeight: "600" }}>{t(`${index + 1}순위`, `Priority ${index + 1}`)}</Text>
          {" · " + candidate.route.provider + " / " + candidate.route.model}
          {candidate.active ? " · " + t("사용 중", "In use") : ""}{candidate.issue ? " · " + candidate.issue : ""}
        </Text>
        {candidate.efforts.length > 1 && <View accessibilityLabel={t("추론 강도", "Reasoning effort")} style={{ ...wrap, alignItems: "center" }}>
          {candidate.efforts.map(effort => <Button key={effort ?? "default"} theme={theme} disabled={locked} selected={effort === candidate.route.effort}
            label={effort ?? t("기본 강도", "Default effort")}
            accessibilityLabel={candidate.route.model + " · " + t("추론 강도", "Reasoning effort") + " · " + (effort ?? t("실행기 기본", "Provider default"))}
            onPress={() => onChange(setEffort(list, index, effort))} />)}
        </View>}
        <View style={{ ...wrap, alignItems: "center" }}>
          {index > 1 && <Button theme={theme} disabled={locked} label={t("맨 위로", "Move to top")}
            accessibilityLabel={candidate.route.model + " · " + t("맨 위로", "Move to top")} onPress={() => onChange(moveFirst(list, index))} />}
          {index > 0 && <Button theme={theme} disabled={locked} label={t("위로", "Move up")}
            accessibilityLabel={candidate.route.model + " · " + t("위로", "Move up")} onPress={() => onChange(moveUp(list, index))} />}
          {canRemove(list, row.mode === "custom") && <Button theme={theme} disabled={locked} label={t("빼기", "Remove")}
            accessibilityLabel={candidate.route.model + " · " + t("빼기", "Remove")} onPress={() => onChange(removeCandidate(list, index))} />}
        </View>
      </View>)}
      <View style={wrap}>
        <Button theme={theme} expanded={adding} disabled={locked} label={adding ? t("후보 추가 닫기", "Close add candidate") : t("+ 후보 추가", "+ Add candidate")}
          accessibilityLabel={row.label + " · " + (adding ? t("후보 추가 닫기", "Close add candidate") : t("후보 추가", "Add candidate"))} onPress={() => onAdding(!adding)} />
        {row.mode === "custom" && <Button theme={theme} disabled={locked} label={t("추천으로 되돌리기", "Back to recommended")}
          accessibilityLabel={row.label + " · " + t("추천으로 되돌리기", "Back to recommended")} onPress={onReset} />}
      </View>
      {adding && (compact
        // The host's sheet owns the safe area, the close gesture and keyboard positioning.
        ? <Modal title={row.label + " · " + t("후보 추가", "Add candidate")} open onOpenChange={next => { if (!next) onAdding(false); }}>
          <Modal.Content>
            <AddCandidate data={data} grade={row.grade} list={list} theme={theme} locked={locked}
              onAdd={(route, place) => { onAdding(false); onChange(addCandidate(list, route, place)); }} />
          </Modal.Content>
        </Modal>
        : <AddCandidate data={data} grade={row.grade} list={list} theme={theme} locked={locked}
          onAdd={(route, place) => { onAdding(false); onChange(addCandidate(list, route, place)); }} />)}
    </View>}
  </View>;
}

// Pick a model, adjust the effort it supports, then add it first or as a fallback.
function AddCandidate({ data, grade, list, theme, locked, onAdd }: {
  data: Operations; grade: Grade; list: RouteChoice[]; theme: Theme; locked: boolean; onAdd: (route: RouteChoice, place: "first" | "last") => void;
}) {
  const { t } = useBoardLanguage();
  const [picked, setPicked] = useState<RouteChoice | null>(null);
  const c = theme.colors;
  const efforts = picked ? routeEfforts(data, picked) : [];
  const full = !!picked && !canAdd(list, picked);
  // The picked model and its buttons stay above the list, so they are in view on a small screen.
  return <View style={{ gap: 8 }}>
    {picked && <View style={{ gap: 6, padding: 10, borderWidth: 1, borderColor: c.accent, borderRadius: 7 }}>
      <Text selectable style={{ color: c.foreground }}>{t("고른 모델", "Picked model")} · {picked.provider} / {picked.model}</Text>
      {efforts.length > 1 && <View style={{ ...wrap, alignItems: "center" }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("추론 강도", "Reasoning effort")}</Text>
        {efforts.map(effort => <Button key={effort ?? "default"} theme={theme} disabled={locked} selected={effort === picked.effort}
          label={effort ?? t("기본 강도", "Default effort")} onPress={() => setPicked({ ...picked, effort })} />)}
      </View>}
      {full && <Text style={{ color: c.statusWarning, fontSize: 12 }}>{t("후보는 12개까지 둘 수 있습니다. 먼저 하나를 빼 주세요.", "A grade holds up to 12 candidates. Remove one first.")}</Text>}
      <View style={wrap}>
        <Button theme={theme} selected={!locked && !full} disabled={locked || full} label={t("1순위로 추가", "Add as priority 1")} onPress={() => onAdd(picked, "first")} />
        {!!list.length && <Button theme={theme} disabled={locked || full} label={t("예비 후보로 추가", "Add as fallback")} onPress={() => onAdd(picked, "last")} />}
        <Button theme={theme} label={t("선택 취소", "Clear selection")} onPress={() => setPicked(null)} />
      </View>
    </View>}
    <ModelPicker data={data} grade={grade} theme={theme} taken={list} selected={picked} disabled={locked} onPick={setPicked} />
  </View>;
}

function SaveStatus({ edit, label, theme, busy, undoBlocked, onUndo, onRetry, onDismiss, onReset }: {
  edit: RowEdit | undefined; label: string; theme: Theme; busy: boolean; undoBlocked: string | null;
  onUndo: () => void; onRetry: () => void; onDismiss: () => void; onReset: () => void;
}) {
  const { t } = useBoardLanguage();
  const c = theme.colors;
  if (!edit) return null;
  const named = (action: string) => ({ label: action, accessibilityLabel: label + " · " + action });
  if (edit.saving) return <Text accessibilityLiveRegion="polite" style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("저장 중…", "Saving\u2026")}</Text>;
  if (edit.failed) return <View style={{ gap: 5 }}>
    <Text accessibilityLiveRegion="polite" selectable style={{ color: c.statusDanger, fontSize: 12 }}>{t("저장하지 못했습니다", "Could not save")} · {edit.failed.message}</Text>
    <View style={wrap}>
      <Button theme={theme} disabled={busy} {...named(t("다시 시도", "Retry"))} onPress={onRetry} />
      <Button theme={theme} {...named(t("바꾸려던 내용 버리기", "Discard this change"))} onPress={onDismiss} />
    </View>
  </View>;
  if (edit.note === "conflict") return <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning, fontSize: 12 }}>
    {t("다른 화면에서 배정이 먼저 바뀌어 최신 상태를 다시 불러왔습니다. 바꾸려던 내용은 저장되지 않았습니다.", "The routing changed on another screen first, so the latest state was loaded. Your change was not saved.")}
  </Text>;
  return <View style={{ gap: 5 }}>
    <View style={{ ...wrap, alignItems: "center" }}>
      <Text accessibilityLiveRegion="polite" style={{ color: c.statusSuccess, fontSize: 12 }}>{edit.note === "undone" ? t("되돌렸습니다", "Undone") : t("저장됨", "Saved")}</Text>
      {edit.undo && !undoBlocked && <Button theme={theme} disabled={busy} {...named(t("되돌리기", "Undo"))} onPress={onUndo} />}
    </View>
    {edit.undo && undoBlocked && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{undoBlocked}</Text>}
    {edit.leftUsage && <View style={{ ...wrap, alignItems: "center" }}>
      <Text accessibilityLiveRegion="polite" style={{ flexShrink: 1, color: c.statusWarning, fontSize: 12 }}>
        {t("이 등급은 이제 직접 정한 순서로 고릅니다(사용량 자동 선택 꺼짐).", "This grade now follows the order saved here (usage-based selection is off for it).")}
      </Text>
      <Button theme={theme} disabled={busy} {...named(t("추천으로 되돌리기", "Back to recommended"))} onPress={onReset} />
    </View>}
  </View>;
}
