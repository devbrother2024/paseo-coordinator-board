import { useState } from "react";
import { Text, View } from "react-native";
import type { LedgerDiagnostics } from "../shared/ledger-diagnostics";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { ledgerFallbackText, ledgerIssueText, ledgerMoreText } from "./ledger-diagnostics";

export function LedgerWarnings({ diagnostics, theme }: { diagnostics?: LedgerDiagnostics; theme: Theme }) {
  const { t } = useBoardLanguage();
  const [expanded, setExpanded] = useState(false);
  const c = theme.colors;
  if (!diagnostics) {
    return <Text accessibilityLiveRegion="polite" style={{ color: c.statusWarning }}>{ledgerFallbackText(t)}</Text>;
  }
  const shown = expanded ? diagnostics.issues : diagnostics.issues.slice(0, 2);
  const remaining = diagnostics.count - shown.length;
  return <View style={{ gap: 6 }}>
    <View accessibilityLiveRegion="polite" style={{ gap: 6 }}>
      {shown.map((issue, index) => {
        const { summary, detail } = ledgerIssueText(issue, t);
        return <View key={index} style={{ gap: 2 }}>
          <Text selectable style={{ color: c.statusWarning }}>{summary}</Text>
          {expanded && <Text selectable style={{ color: c.foregroundMuted, fontSize: 13 }}>{detail}</Text>}
        </View>;
      })}
      {remaining > 0 && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
        {ledgerMoreText(remaining, t)}
      </Text>}
    </View>
    <View style={{ alignItems: "flex-start" }}>
      <Button theme={theme} expanded={expanded} label={expanded ? t("접기", "Collapse") : t("자세히", "Details")}
        onPress={() => setExpanded(value => !value)} />
    </View>
  </View>;
}
