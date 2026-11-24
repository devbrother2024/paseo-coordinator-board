import { useState } from "react";
import { Switch, Text, View } from "react-native";
import type { ProviderEntry } from "../shared/dispatch";
import { recentUsage, type AccountUsage } from "../shared/usage-routing";
import { accountCards, type AccountCard as AccountCardData } from "./account-cards";
import type { Theme } from "./controls";
import { useBoardLanguage } from "./language";

function AccountCard({label,report,supplemental,issue,provider,busy,onInclude,theme}: AccountCardData & {busy:boolean;onInclude:(provider:string,included:boolean)=>void;theme:Theme}) {
  const {t,language} = useBoardLanguage();
  const c = theme.colors;
  const locale = language === "ko" ? "ko-KR" : "en-US";
  const date = (stamp:string) => new Date(stamp).toLocaleString(locale,{month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
  const number = (n:number) => n.toLocaleString(locale,{maximumFractionDigits:2});
  const rows = report?.status === "available" ? [
    ...report.windows.map(w => ({name:w.label,value:w.remainingPct === null ? null : number(w.remainingPct)+"%",pct:w.remainingPct,reset:w.resetsAt})),
    ...report.balances.map(b => ({
      name:b.label, value:b.remaining === null ? null : number(b.remaining)+(b.limit !== null && b.limit > 0 ? " / "+number(b.limit) : "")+" "+b.unit,
      pct:b.remaining !== null && b.limit !== null && b.limit > 0 ? Math.max(0,Math.min(100,100*b.remaining/b.limit)) : null, reset:b.resetsAt,
    })),
  ] : [];
  const stale = report && !recentUsage(report);
  return <View style={{gap:7,padding:10,borderWidth:1,borderColor:c.border,borderRadius:8,backgroundColor:c.surface0}}>
    <Text selectable style={{color:c.foreground,fontWeight:"600"}}>{[label,report?.plan].filter(Boolean).join(" · ")}</Text>
    {provider && <View style={{gap:3}}>
      <View style={{flexDirection:"row",alignItems:"center",gap:8}}>
        <Switch accessibilityRole="switch" value={provider.included} disabled={busy} onValueChange={value => onInclude(provider.id,value)}
          accessibilityLabel={t(`${label} · 자동 배정에 사용`,`Use ${label} for automatic assignment`)}
          trackColor={{false:c.border,true:c.accent}} thumbColor={provider.included ? c.accentForeground : c.foregroundMuted} />
        <Text style={{flexShrink:1,fontSize:13,color:provider.included ? c.foreground : c.foregroundMuted}}>
          {provider.included ? t("자동 배정에 사용","Used for automatic assignment") : t("자동 배정에서 꺼짐","Off for automatic assignment")}
        </Text>
      </View>
      {provider.shared && <Text style={{fontSize:12,color:c.foregroundMuted}}>{t(`${provider.label}의 계정은 함께 켜지고 꺼집니다. 보드는 실행기에 배정하고, 어느 계정을 쓸지는 실행기가 정합니다.`,
        `Accounts under ${provider.label} turn on and off together. The board assigns to the provider, and the provider decides which account runs.`)}</Text>}
    </View>}
    {rows.map((row,i) => {
      const expired = !!row.reset && Date.parse(row.reset) <= Date.now();
      const pct = expired ? null : row.pct;
      const value = expired ? t("초기화 후 조회 대기","Awaiting new reading") : row.value ?? t("미확인","Unknown");
      return <View key={i} style={{gap:4}}>
        <View style={{flexDirection:"row",gap:8,alignItems:"baseline",justifyContent:"space-between",flexWrap:"wrap"}}>
          <Text style={{fontSize:13,color:c.foregroundMuted}}>{row.name}</Text>
          <Text selectable style={{fontSize:13,fontWeight:"600",color:c.foreground}}>{!expired && row.value !== null ? t(value+" 남음",value+" left") : value}</Text>
        </View>
        {pct !== null && <View accessible accessibilityRole="progressbar" accessibilityLabel={t(row.name+" 잔여량",row.name+" remaining")}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-valuetext={value} style={{height:6,overflow:"hidden",borderRadius:3,backgroundColor:c.surface2}}>
          <View style={{height:"100%",width:`${pct}%`,borderRadius:3,backgroundColor:stale ? c.foregroundMuted : pct<=10 ? c.statusWarning : c.accent}} />
        </View>}
        {row.reset && !expired && <Text style={{fontSize:12,color:c.foregroundMuted}}>{t(date(row.reset)+" 초기화","Resets "+date(row.reset))}</Text>}
      </View>;
    })}
    {!rows.length && <Text style={{fontSize:13,color:c.foregroundMuted}}>{!report ? t("연결된 사용량 보고서가 없습니다.","No connected usage report.")
      : report.status === "error" ? t("사용량 조회에 실패했습니다.","Usage lookup failed.")
      : t("제공된 잔여량 수치가 없습니다.","No remaining quota reported.")}</Text>}
    {issue && <Text style={{fontSize:12,color:c.foregroundMuted}}>{issue === "login" ? t("Paseo 사용량 조회에 다시 로그인이 필요합니다.","Sign in again for Paseo usage reports.")
      : t("Paseo 사용량 조회 요청 한도에 도달했습니다.","Paseo usage lookup is rate-limited.")}</Text>}
    {report && (supplemental || report.fetchedAt) && <Text style={{fontSize:12,color:c.foregroundMuted}}>{[
      supplemental && t("호스트 추가 보고 · 표시 전용","Host report · display only"),
      report.fetchedAt && (stale ? t("이전 측정","Last known reading") : t("조회","Checked"))+" "+date(report.fetchedAt),
    ].filter(Boolean).join(" · ")}</Text>}
  </View>;
}

// Accounts with their remaining usage. Each account's switch decides whether the board assigns work to it,
// and the switch above them decides whether remaining usage orders the accounts that are on.
export function UsageRouting({providers,reports,supplemental=[],busy,usage,onInclude,theme}:{
  providers:ProviderEntry[]; reports:AccountUsage[]; supplemental?:AccountUsage[]; busy:boolean;
  usage:{enabled:boolean;ready:boolean;onToggle:()=>void}; onInclude:(provider:string,included:boolean)=>void; theme:Theme;
}) {
  const {t} = useBoardLanguage();
  const c = theme.colors;
  const [width,setWidth] = useState(0);
  const {cards,allOff} = accountCards(providers,reports,supplemental);
  const ordering = t("사용량으로 순서 정하기","Order by remaining usage");
  return <View style={{gap:9,padding:12,borderRadius:8,backgroundColor:c.surface1}}>
    <Text accessibilityRole="header" style={{color:c.foreground,fontWeight:"600"}}>{t("계정과 사용량","Accounts and usage")}</Text>
    <View style={{gap:4}}>
      <View style={{flexDirection:"row",alignItems:"center",gap:8}}>
        <Switch accessibilityRole="switch" accessibilityLabel={ordering} value={usage.enabled} disabled={busy || !usage.ready} onValueChange={usage.onToggle}
          trackColor={{false:c.border,true:c.accent}} thumbColor={usage.enabled ? c.accentForeground : c.foregroundMuted} />
        <Text style={{flexShrink:1,color:c.foreground,fontWeight:"600",fontSize:13}}>{ordering}</Text>
      </View>
      <Text style={{fontSize:12,color:c.foregroundMuted}}>{t("켜면 추천을 쓰는 등급에서, 켜 둔 계정 가운데 공통 한도의 남은 사용량이 가장 많은 쪽을 먼저 고릅니다. 직접 지정한 등급은 저장한 순서를 따릅니다.",
        "When on, grades on the recommendation pick the account with the most remaining usage among those turned on that share a limit. Custom grades follow their saved order.")}</Text>
    </View>
    {allOff && <Text accessibilityLiveRegion="polite" style={{color:c.statusWarning}}>{t("모든 계정이 자동 배정에서 꺼져 있어 보드가 작업을 배정할 수 없습니다. 쓸 계정을 하나 이상 켜 주세요.",
      "Every account is turned off for automatic assignment, so the board cannot assign work. Turn on at least one account.")}</Text>}
    <View onLayout={e=>setWidth(e.nativeEvent.layout.width)} style={{flexDirection:"row",flexWrap:"wrap",gap:8,alignItems:"flex-start"}}>
      {cards.map((card,i)=><View key={card.id+":"+i} style={{width:width>=580 ? Math.floor((width-8)/2) : "100%"}}>
        <AccountCard {...card} theme={theme} busy={busy} onInclude={onInclude} />
      </View>)}
    </View>
    {!cards.length && <Text style={{color:c.foregroundMuted}}>{t("호스트에 사용량 보고서가 없습니다.","This host has no usage reports.")}</Text>}
    {!!cards.length && <Text style={{fontSize:12,color:c.foregroundMuted}}>{t("끈 계정에는 보드가 작업을 배정하지 않습니다. 추천과 사용량 기준 선택에서 빠지고, 직접 지정한 목록에 남아 있으면 건너뜁니다. 새로 발견한 실행기는 켜진 채로 들어옵니다.",
      "The board assigns no work to an account that is turned off. It is left out of the recommendation and of usage-based selection, and skipped where a custom list still holds it. Newly discovered providers start turned on.")}</Text>}
  </View>;
}
