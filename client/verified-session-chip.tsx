import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { CoordinatorReach } from "../shared/coordinator-reach";
import { SessionChip, type SessionChipProps, type Theme } from "./controls";
import { chipOutcome, chipPlan, type ReachRole } from "./coordinator-reach";
import { useBoardLanguage } from "./language";
import { ReachExplanation } from "./reach-explanation";

// What the board knows or can find out about a session before opening it.
export type SessionGate = { known?: CoordinatorReach; check?: () => Promise<CoordinatorReach>; role: ReachRole; onReplace?: () => void };

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
    if (plan === "explain") return setBlocked(blocked ? null : gate!.known!);
    if (plan === "open") return props.onPress();
    pending.current = true;
    setState("checking");
    setBlocked(null);
    try {
      const reach: CoordinatorReach = gate?.check ? await gate.check() : { state: await verify!() ? "ok" : "unknown" };
      if (!active.current) return;
      const outcome = chipOutcome(reach);
      setState(outcome === "unverified" ? "failed" : "ready");
      if (outcome === "open") props.onPress();
      if (outcome === "explain") setBlocked(reach);
    } catch {
      if (active.current) setState("failed");
    } finally { pending.current = false; }
  }
  // An explanation takes its own line so the chips beside it keep their place.
  return <View style={{maxWidth:"100%",gap:blocked ? 6 : 2,...(blocked ? {width:"100%"} : {})}}>
    <SessionChip {...props} onPress={() => void visit()} />
    {state !== "ready" && <Text accessibilityLiveRegion="polite" style={{color:props.theme.colors.foregroundMuted,fontSize:12}}>{state === "checking"
      ? t("세션 확인 중…","Checking session…") : t("이 호스트에서 세션 연결을 확인하지 못했습니다.","Could not verify this session on its host.")}</Text>}
    {blocked && gate && <ReachExplanation reach={blocked} role={gate.role} theme={props.theme as Theme} onReplace={gate.onReplace} />}
  </View>;
}
