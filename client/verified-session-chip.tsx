import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import { SessionChip, type SessionChipProps } from "./controls";
import { useBoardLanguage } from "./language";

export function VerifiedSessionChip({ verify, ...props }: SessionChipProps & { verify?: () => Promise<boolean> }) {
  const { t } = useBoardLanguage();
  const [state, setState] = useState<"ready" | "checking" | "failed">("ready");
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  if (!verify) return <SessionChip {...props} />;
  async function visit() {
    if (!verify || pending.current) return;
    pending.current = true;
    setState("checking");
    try {
      const available = await verify();
      if (active.current) {
        setState(available ? "ready" : "failed");
        if (available) props.onPress();
      }
    } catch {
      if (active.current) setState("failed");
    } finally { pending.current = false; }
  }
  return <View style={{maxWidth:"100%",gap:2}}>
    <SessionChip {...props} onPress={() => void visit()} />
    {state !== "ready" && <Text accessibilityLiveRegion="polite" style={{color:props.theme.colors.foregroundMuted,fontSize:12}}>{state === "checking"
      ? t("세션 확인 중…","Checking session…") : t("이 호스트에서 세션 연결을 확인하지 못했습니다.","Could not verify this session on its host.")}</Text>}
  </View>;
}
