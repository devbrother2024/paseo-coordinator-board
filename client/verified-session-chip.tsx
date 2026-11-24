import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { CoordinatorReach } from "../shared/coordinator-reach";
import { SessionChip, type SessionChipProps } from "./controls";
import { chipOutcome, chipPlan } from "./coordinator-reach";
import { useBoardLanguage } from "./language";
import { ReachExplanation } from "./reach-explanation";

// For a session the board already holds a state for, `known` decides and `onBlocked` points to where that state
// is explained. For a session outside the active list, `check` looks it up before opening.
export type SessionGate = { known?: CoordinatorReach; onBlocked?: () => void; check?: () => Promise<CoordinatorReach> };

export function VerifiedSessionChip({ verify, gate, ...props }: SessionChipProps & { verify?: () => Promise<boolean>; gate?: SessionGate }) {
  const { t } = useBoardLanguage();
  const [state, setState] = useState<"ready" | "checking" | "failed">("ready");
  const [blocked, setBlocked] = useState<CoordinatorReach | null>(null);
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  if (!verify && !gate) return <SessionChip {...props} />;
  async function visit() {
    if (pending.current) return;
    const plan = chipPlan(gate?.known, !!gate?.check || !!verify);
    if (plan === "blocked") return gate?.onBlocked?.();
    if (plan === "open") return props.onPress();
    pending.current = true;
    setState("checking");
    setBlocked(null);
    try {
      if (gate?.check) {
        const reach = await gate.check().catch((): CoordinatorReach => ({ state: "unknown" }));
        if (!active.current) return;
        setState("ready");
        if (chipOutcome(reach) === "open") props.onPress();
        else setBlocked(reach);
      } else {
        const available = await verify!();
        if (!active.current) return;
        setState(available ? "ready" : "failed");
        if (available) props.onPress();
      }
    } catch {
      if (active.current) setState("failed");
    } finally { pending.current = false; }
  }
  // An explanation takes its own line so the chips beside it keep their place.
  return <View style={{maxWidth:"100%",gap:blocked ? 6 : 2,...(blocked ? {width:"100%"} : {})}}>
    <SessionChip {...props} onPress={() => void visit()} />
    {state !== "ready" && <Text accessibilityLiveRegion="polite" style={{color:props.theme.colors.foregroundMuted,fontSize:12}}>{state === "checking"
      ? t("세션 확인 중…","Checking session…") : t("이 호스트에서 세션 연결을 확인하지 못했습니다.","Could not verify this session on its host.")}</Text>}
    {blocked && <ReachExplanation reach={blocked} role="owner" theme={props.theme} />}
  </View>;
}
