import { defineSettings } from "@getpaseo/plugin";
import { useSettings } from "@getpaseo/plugin/client";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { z } from "zod";
import { Button, ButtonLabelMeasure, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { visibleProjectFilters, type ProjectFilter } from "./project-filters";

const gap = 6;

const preference = defineSettings({
  id: "project-filter-view", scope: "device", version: 1,
  schema: z.object({ expanded: z.boolean().default(false) }),
});

type Props = {
  groups: ProjectFilter[];
  selected: ReadonlySet<string | null>;
  total: number;
  clear: () => void;
  toggle: (group: ProjectFilter) => void;
  theme: Theme;
};

export function ProjectFilterBar({ groups, selected, total, clear, toggle, theme }: Props) {
  const { t } = useBoardLanguage();
  const saved = useSettings(preference);
  const [temporary, setTemporary] = useState<boolean | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [rowWidth, setRowWidth] = useState(0);
  const [widths, setWidths] = useState<Record<string, number>>({});
  const chipLabel = (group: ProjectFilter) => `${group.label} · ${group.count}`;
  const allLabel = t(`전체 ${total}`, `All ${total}`);
  const collapseLabel = t("접기 ▴", "Collapse ▴");
  const expandLabel = t("펼치기 ▾", "Expand ▾");
  const toggleLabels = [collapseLabel, expandLabel, `+${groups.length} ▾`];
  const labels = [...new Set([allLabel, ...groups.map(chipLabel), ...toggleLabels])];
  const measured = saved.status !== "loading" && rowWidth > 0 && labels.every(label => widths[label] > 0);
  const toggleWidth = measured ? Math.ceil(Math.max(...toggleLabels.map(label => widths[label]))) : 0;
  const layout = measured ? visibleProjectFilters(groups, selected, {
    rowWidth, allWidth: widths[allLabel], toggleWidth, gap, chipWidth: group => widths[chipLabel(group)],
  }) : null;
  const expanded = !!layout?.showToggle && (temporary ?? (saved.status === "ready" && saved.values.expanded));

  async function setExpanded(next: boolean) {
    setTemporary(next);
    setSaveFailed(false);
    if (saved.status === "ready" && await saved.save({ expanded: next }, saved.revision)) {
      setTemporary(null);
    } else {
      setSaveFailed(true);
      await saved.reload();
    }
  }

  const label = t("프로젝트 필터", "Project filters");
  const all = <Button theme={theme} label={allLabel} singleLine selected={!selected.size} onPress={clear} />;
  const hiddenCount = layout?.hiddenCount ?? 0;
  const chips = (expanded ? layout?.ordered : layout?.collapsed)?.map(group => <View key={JSON.stringify(group.ids)} style={expanded ? { maxWidth: "100%" } : undefined}>
    <Button theme={theme} toggle singleLine={!expanded} selected={group.ids.some(id => selected.has(id))}
      label={chipLabel(group)} onPress={() => toggle(group)} />
  </View>);

  if (!groups.length) return null;
  return <View style={{ gap: 5 }} accessibilityLabel={label}>
    <View onLayout={event => setRowWidth(event.nativeEvent.layout.width)} style={{ flexDirection: "row", alignItems: "flex-start", gap }}>
      {expanded ? <View style={{ flex: 1, minWidth: 0, flexDirection: "row", flexWrap: "wrap", gap }}>{all}{chips}</View>
        : <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap }}>
          {all}
          {!!chips?.length && <ScrollView horizontal style={{ flexGrow: 0, flexShrink: 1, minWidth: 0 }}
            contentContainerStyle={{ alignItems: "center", gap }}>{chips}</ScrollView>}
        </View>}
      {layout?.showToggle && <View style={{ width: toggleWidth, flexShrink: 0 }}>
        <Button theme={theme} expanded={expanded} singleLine tabularNumbers disabled={saved.saving}
          label={expanded ? collapseLabel : hiddenCount ? `+${hiddenCount} ▾` : expandLabel}
          accessibilityLabel={expanded ? t("프로젝트 필터 접기", "Collapse project filters") : t("프로젝트 필터 펼치기", "Expand project filters")}
          onPress={() => void setExpanded(!expanded)} />
      </View>}
    </View>
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden
      style={{ position: "absolute", top: 0, left: 0, right: 0, height: 0, overflow: "hidden", alignItems: "flex-start" }}>
      {labels.map(value => <ButtonLabelMeasure key={value} label={value} tabularNumbers={toggleLabels.includes(value)}
        onLayout={event => {
          const { width } = event.nativeEvent.layout;
          setWidths(previous => previous[value] === width ? previous : { ...previous, [value]: width });
        }} />)}
    </View>
    {saveFailed && <Text accessibilityLiveRegion="polite" style={{ color: theme.colors.statusWarning }}>
      {t("필터 열림 상태를 이 기기에 저장하지 못했습니다.", "Could not save the filter view on this device.")}
    </Text>}
  </View>;
}
