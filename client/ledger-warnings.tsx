import { useState } from "react";
import { Text, View } from "react-native";
import type { LedgerDiagnostics } from "../shared/ledger-diagnostics";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { ledgerFallbackText, ledgerIssueText, ledgerMoreText } from "./ledger-diagnostics";

// A small mark beside the decision count. Details opens the full explanation on its own line below.
export function LedgerWarnings({ diagnostics, theme }: { diagnostics?: LedgerDiagnostics; theme: Theme }) {
  const { t } = useBoardLanguage();
  const [expanded, setExpanded] = useState(false);
  const c = theme.colors;
  const shown = !diagnostics ? [] : expanded ? diagnostics.issues : diagnostics.issues.slice(0, 2);
  const remaining = diagnostics ? diagnostics.count - shown.length : 0;
  const mark = diagnostics?.count
    ? t(`! 읽지 못한 기록 ${diagnostics.count}건`, `! ${diagnostics.count} unreadable ${diagnostics.count === 1 ? "record" : "records"}`)
    : t("! 일부 기록을 읽지 못함", "! Some records unreadable");
  return <>
    <Text accessibilityLiveRegion="polite" accessibilityLabel={ledgerFallbackText(t)} style={{ color: c.statusWarning, fontSize: 12 }}>{mark}</Text>
    <Button theme={theme} expanded={expanded} label={expanded ? t("접기", "Collapse") : t("자세히", "Details")}
      accessibilityLabel={(expanded ? t("접기", "Collapse") : t("자세히", "Details")) + " · " + t("읽지 못한 결정 기록", "Unreadable decision records")}
      onPress={() => setExpanded(value => !value)} />
    {expanded && <View style={{ width: "100%", gap: 6 }}>
      <Text style={{ color: c.statusWarning }}>{ledgerFallbackText(t)}</Text>
      {shown.map((issue, index) => {
        const { summary, detail } = ledgerIssueText(issue, t);
        return <View key={index} style={{ gap: 2 }}>
          <Text selectable style={{ color: c.statusWarning }}>{summary}</Text>
          <Text selectable style={{ color: c.foregroundMuted, fontSize: 13 }}>{detail}</Text>
        </View>;
      })}
      {remaining > 0 && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{ledgerMoreText(remaining, t)}</Text>}
    </View>}
  </>;
}
