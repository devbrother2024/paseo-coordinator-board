import { useMemo, useState, type ReactNode } from "react";
import { View, Pressable, Text, ScrollView } from "react-native";
import { Button, SessionChip, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { columnWidth, COLUMN_GAP } from "./lane-width";
import type { PullRequestItem } from "../shared/prs";
import { pullColumn } from "../shared/pull-judgments";
import type { TrackedDecision } from "../shared/tracked-decisions";
import { factStatus, laneLabel, noteLabel, sessionDetail, type Card, type Lane } from "./model";
import type { ReplyEntry } from "../shared/reply-history";
import type { HistoryLinks } from "./history-sessions";
import { KANBAN_ORDER, type FollowupKind } from "./reply-followup";
import { ReplyFollowupCard } from "./reply-followup-card";
import { TrackedSessionChips, type TrackedSessionLinks } from "./tracked-session-chips";
import { plainDecisionTitle } from "./decision-summary";
import { HistoryMarkdown } from "./history-markdown";
import { assignmentReasons } from "../shared/host-assignment";
import { QuestionContext } from "./question-context";
import { decisionChoiceNotice } from "./choice-display";
import { waitedLabel } from "../shared/review-wait";
type ColumnKind = Lane;
type Actions = { sessionHostLabel?: string; onOpen?: (id:string) => void; onEdit:(id:string) => void };

function accent(lane: ColumnKind, theme: Theme) {
  const c = theme.colors;
  if (lane === "human") return c.statusWarning;
  if (lane === "running") return c.accent;
  if (lane === "done") return c.statusSuccess;
  return c.foregroundMuted;
}

function CoordinatorPending({ theme }: { theme: Theme }) {
  const [open, setOpen] = useState(false);
  const { t } = useBoardLanguage();
  const c = theme.colors;
  return <View style={{ gap: 3 }}>
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(value => !value)}
      accessibilityLabel={t("코디네이터 미처리 · 설명 보기", "Not handled by the coordinator · Show explanation")}
      style={{ alignSelf: "flex-start", paddingHorizontal: 7, paddingVertical: 2, borderRadius: 10, borderWidth: 1, borderColor: c.statusWarning }}>
      <Text style={{ color: c.statusWarning, fontSize: 12, fontWeight: "600" }}>{t("코디네이터 미처리", "Not handled by coordinator")}</Text>
    </Pressable>
    {open && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
      {t("코디네이터가 아직 이 세션을 처리하지 않았습니다. 멈춘 이유가 풀렸는지 확인하거나 원장에 올려야 합니다.",
        "The coordinator has not handled this session yet. Check whether the reason it stopped has cleared, or raise it in the ledger.")}
    </Text>}
  </View>;
}

function CardView({ card, theme, onOpen, onEdit, sessionHostLabel }: { card: Card; theme: Theme } & Actions) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useBoardLanguage();
  const { session, note } = card;
  const c = theme.colors;
  const fact = session.boardFact;
  const question = session.decision?.question;
  const displayedQuestion = session.decision?.source === "permission" && question ? sessionDetail(question, t)
    : session.decision?.questionMarkdown ?? question;
  const detailIsQuestion = !!question && (question === session.detail || session.detail.endsWith(" · " + question));
  const runtime = [session.provider, session.model === session.provider ? null : session.model].filter(Boolean).join(" / ");
  const resting = card.lane === "review" || card.lane === "idle";
  const waited = resting ? waitedLabel(session.waitingSince, Date.now(), t) : "";
  const noteTitle = note && note.kind !== "clear" ? [note.origin === "agent" ? t("세션 보고", "Session report") : null, noteLabel(note.kind, t)].filter(Boolean).join(" · ") : null;
  return (
    <View style={{ padding: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface0, gap: 6 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
        accessibilityLabel={t(`${session.title} · ${expanded ? "상세 접기" : "상세 보기"}`, `${session.title} · ${expanded ? "Hide details" : "View details"}`)}
        onPress={() => setExpanded(value => !value)} style={{ gap: 3 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={{ color: c.foreground, fontSize: 14, fontWeight: "600", flex: 1 }}>{session.title}</Text>
          <Text accessible={false} style={{ color: c.foregroundMuted }}>{expanded ? "▴" : "▾"}</Text>
        </View>
        <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {card.lane === "human" ? t("내 답을 기다리는 중", "Waiting for my decision")
            : session.detail ? sessionDetail(session.detail, t) : laneLabel(card.lane, t)}
        </Text>
        {resting && (!!waited || !!session.lastSummary) && <Text numberOfLines={expanded ? undefined : 2} style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {[waited, session.lastSummary].filter(Boolean).join(" · ")}
        </Text>}
        {!!sessionHostLabel && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
          {t("실행 호스트", "Host")} · {session.assignment?.label ?? sessionHostLabel}
          {session.assignment ? " · " + t(...assignmentReasons[session.assignment.reason]) : ""}
        </Text>}
      </Pressable>
      {onOpen && <SessionChip theme={theme} label={t("세션", "Session")} accessibilityLabel={t(`세션 열기 · ${session.title}`, `Open session · ${session.title}`)} onPress={() => onOpen(session.id)} />}
      {card.lane === "review" && session.needsCoordinator && <CoordinatorPending theme={theme} />}
      {fact && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
        {fact.current ? "" : t("이전 · ", "Previous · ")}{factStatus(fact, t)}
      </Text>}
      {expanded && <>
        {fact && <View style={{ gap: 3 }}>
          <Text selectable style={{ color: c.foreground }}>{fact.answer}</Text>
          <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("확인 근거", "Source")} · {fact.source}</Text>
        </View>}
        <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>{[session.sourceProjectTitle && t(`원래 소속 ${session.sourceProjectTitle}`, `From ${session.sourceProjectTitle}`), session.workspaceTitle, runtime].filter(Boolean).join(" · ")}</Text>
        {!!session.detail && !detailIsQuestion && <HistoryMarkdown theme={theme} source={sessionDetail(session.detail, t)} muted />}
        {!!displayedQuestion && note?.text !== question && <HistoryMarkdown theme={theme} source={displayedQuestion} />}
        {session.decision && session.decision.source !== "permission" && <QuestionContext theme={theme} title={session.title}
          choices={session.decision.choices} context={session.decision.contextMarkdown} notice={decisionChoiceNotice(session.decision)} />}
        {card.lane === "review" && !!session.lastMessage && <View style={{ gap: 3 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {session.lastMessageTruncated ? t("세션의 마지막 글 · 앞부분 생략", "Last message from the session · Beginning omitted") : t("세션의 마지막 글", "Last message from the session")}
          </Text>
          <HistoryMarkdown theme={theme} source={session.lastMessage} />
        </View>}
        {noteTitle && note && <View style={{ gap: 3 }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{noteTitle}</Text>
          <HistoryMarkdown theme={theme} source={note.text} />
        </View>}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 5 }}>
          <Button theme={theme} label={noteTitle ? t("기록 편집", "Edit note") : t("기록 추가", "Add note")} accessibilityLabel={t(`기록 편집 · ${session.title}`, `Edit note · ${session.title}`)} onPress={() => onEdit(session.id)} />
        </View>
      </>}
    </View>
  );
}

type Entry = {key:string; content: ReactNode};

function RecordPreview({item,theme,render,links}: {item:TrackedDecision;theme:Theme;render:(item:TrackedDecision)=>ReactNode;links:TrackedSessionLinks}) {
  const [expanded,setExpanded] = useState(false);
  const {t} = useBoardLanguage();
  const title = useMemo(() => plainDecisionTitle(item.title), [item.title]);
  return <View style={{gap:4}}>
    <Button theme={theme} label={expanded ? t("결정 카드 접기","Hide decision card") : title}
      accessibilityLabel={t(`결정 카드 · ${title}`,`Decision card · ${title}`)} onPress={()=>setExpanded(v=>!v)} />
    {!expanded && (links.owner || links.source) && <View style={{flexDirection:"row",flexWrap:"wrap",gap:6}}>
      <TrackedSessionChips theme={theme} title={title} links={links} />
    </View>}
    {expanded && render(item)}
  </View>;
}

function Column({lane,entries,theme}: {lane:ColumnKind;entries:Entry[];theme:Theme}) {
  const {t} = useBoardLanguage();
  const [limit,setLimit] = useState(4);
  const c=theme.colors;
  return <View style={{padding:8,borderRadius:8,backgroundColor:c.surface1,borderColor:c.border,borderWidth:1,gap:7}}>
    <View style={{flexDirection:"row",alignItems:"center",gap:6}}>
      <View style={{width:7,height:7,borderRadius:4,backgroundColor:accent(lane,theme)}} />
      <Text accessibilityRole="header" style={{color:c.foreground,flex:1,fontWeight:"600"}}>{laneLabel(lane,t)}</Text>
      <Text style={{color:c.foregroundMuted}}>{entries.length}</Text>
    </View>
    {lane === "review" && <Text style={{color:c.foregroundMuted,fontSize:12}}>
      {t("일을 마치고 쉬는 세션, 고칠 것이 있는 PR, 내가 답한 뒤 결과를 기다리는 카드입니다. 결정이 필요하면 코디네이터가 '내 결정'으로 올립니다.",
        "Sessions that finished and are resting, pull requests with something to fix, and answers waiting for a result. If a decision is needed, the coordinator moves it to My decisions.")}
    </Text>}
    {entries.slice(0,limit).map(entry=><View key={entry.key}>{entry.content}</View>)}
    {entries.length>limit && <Button theme={theme} label={t(`결정·작업 ${entries.length-limit}개 더 보기`,`Show ${entries.length-limit} more items`)} onPress={()=>setLimit(n=>n+10)} />}
  </View>;
}

export type Followup = {entry:ReplyEntry; kind:FollowupKind};
type Props = Actions & {projectId:string; title:string; followups?:Followup[]; now:number; historyLinks:HistoryLinks; openRemote?:(host:string,id:string)=>void; decisions:number; cards:Card[]; records:TrackedDecision[]; requests:PullRequestItem[];
  renderRecord:(item:TrackedDecision)=>ReactNode; theme:Theme; compact:boolean; recordLinks:(item:TrackedDecision)=>TrackedSessionLinks; renderPull:(pr:PullRequestItem,projectId:string)=>ReactNode};

export function Project({projectId,title,decisions,cards,records,followups=[],now,historyLinks,openRemote,requests,renderRecord,theme,compact,recordLinks,renderPull,...actions}:Props) {
  const {t} = useBoardLanguage();
  const [width,setWidth] = useState(0);
  const groups:Record<ColumnKind,Entry[]> = {running:[],review:[],human:[],idle:[],done:[],unknown:[]};
  for(const item of records) {
    const since = Date.parse(item.since ?? "");
    const answered = item.replyHistory.some(reply => Date.parse(reply.at ?? "") >= since);
    const lane = answered && !item.matchedSessionId ? "review" : "human";
    groups[lane].push({key:"decision:"+item.key,content:<RecordPreview item={item} theme={theme} render={renderRecord} links={recordLinks(item)} />});
  }
  for(const card of cards) {
    if(card.lane==="human" && records.some(item=>item.matchedSessionId===card.session.id)) continue;
    groups[card.lane].push({key:"session:"+card.session.id,content:<CardView card={card} theme={theme} {...actions} />});
  }
  for(const pr of requests) {
    if(records.some(item=>item.matchedPull?.repo===pr.repo && item.matchedPull.number===pr.number)) continue;
    const lane = pullColumn(pr);
    groups[lane].push({key:pr.url,content:renderPull(pr,projectId)});
  }
  for(const {entry,kind} of followups) groups.review.push({key:"reply:"+entry.key,content:<ReplyFollowupCard entry={entry} kind={kind}
    links={historyLinks(entry)} now={now} theme={theme} open={actions.onOpen} openRemote={openRemote} />});
  const lanes=KANBAN_ORDER.filter(lane=>groups[lane].length);
  const stacked = width ? width<490 : compact;
  const running=cards.filter(card=>card.lane==="running").length;
  const columns=lanes.map(lane=><View key={lane} style={stacked ? {width:"100%"} : {width:columnWidth(width,lanes.length)}}>
    <Column lane={lane} entries={groups[lane]} theme={theme} />
  </View>);
  return <View style={{gap:8}} onLayout={e=>setWidth(e.nativeEvent.layout.width)}>
    <Text accessibilityRole="header" style={{fontSize:18,fontWeight:"600",color:theme.colors.foreground}}>{title}</Text>
    <Text style={{fontSize:13,color:theme.colors.foregroundMuted}}>
      {t(`세션 ${cards.length}개 · 진행 중인 세션 ${running}개 · 내 결정 ${decisions}건`,`Sessions ${cards.length} · Running sessions ${running} · My decisions ${decisions}`)}
    </Text>
    {stacked ? <View style={{gap:COLUMN_GAP}}>{columns}</View> :
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{gap:COLUMN_GAP,paddingBottom:5,alignItems:"flex-start"}}>{columns}</ScrollView>}
  </View>;
}
