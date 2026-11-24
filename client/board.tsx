import type { BoardReadiness } from "../shared/readiness";
import { historySessionLinks, type HistoryLinks } from "./history-sessions";
import { ReplyHistory } from "./reply-history";
import { followupKind, hostWideVisible } from "./reply-followup";
import { createRemoteWorkSessionLookup, trackedSessionOwner, trackedWorkSession } from "./tracked-session-targets";
import type { TrackedSessionLinks } from "./tracked-session-chips";
import { TrackedDecisionCard } from "./tracked-decisions";
import { closedRevision } from "./tracked-reply-draft";
import { mentionsSecurityGate, trackedCoverage, trackedReplyRoute, usesSourceCoordinator, pullKey, type TrackedDecision } from "../shared/tracked-decisions";
import { projectFolderMap } from "../shared/project-folders";
import { MergeFeedback, PullRequestCard, PullRequestSettings, type MergeNotice, type WorkSessionLink } from "./pull-requests";
import { pullRowKey, recordActionKey, sessionRowKey, unsentActionKey, withReceiptPositions, type CompletedAction, type InlineReceipt } from "./decision-receipts";
import { rankDecisionRows, priorityLabel } from "./decision-priority";
import { DecisionEditingRow, keepEditingPositions, useDecisionEditing } from "./decision-editing";
import { InlineDecisionReceipt } from "./inline-receipt";
import { latestMergeNotification } from "./merge-notification";
import { decisionSummary } from "./decision-summary";
import { matchesWorkspace } from "../shared/workspace-pull";
import { ownerRunning } from "../shared/pull-judgments";
import type { PullRequestItem } from "../shared/prs";
import { getPaseoClient, type PluginScreenProps } from "@getpaseo/plugin/client";
import { remoteScope, readRemoteHistorySession } from "./remote-sessions";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ScrollView, Text, View } from "react-native";
import { DecisionActions, type DecisionReceipt } from "./decision-actions";
import { PendingRequests } from "./pending-request-forms";
import { Clarification } from "./clarification";
import { cardChoiceNotice, choiceRequest, decisionChoiceNotice, type ChoiceNotice } from "./choice-display";
import { ledgerChoiceGaps } from "../shared/choice-gaps";
import { clarificationKey, clarificationRecipient, sessionClarificationCard, trackedClarificationCard, type ClarificationCard } from "../shared/clarifications";
import { SessionLinks } from "./session-links";
import { useRemoteRunning, RemoteRunning } from "./remote-running";
import { BoardHosts } from "./hosts";
import { OperationsPanel } from "./operations";
import { ReachExplanation } from "./reach-explanation";
import { CoordinatorReplaceLoader } from "./coordinator-replace";
import { blocksReplies, opensSession, readSessionReach } from "../shared/coordinator-reach";
import { Button, type Theme } from "./controls";
import { Project } from "./project-kanban";
import { SessionProgress } from "./session-progress";
import { BoardLanguageSetting, useBoardLanguage } from "./language";
import { projectCards, type Card, type Snapshot } from "./model";
import { groupProjects, selectedProjectIds, toggleProjectFilter, type ProjectFilter } from "./project-filters";
import { ProjectFilterBar } from "./project-filter-bar";
import { shouldRefreshDigest } from "./digest-freshness";
import { DigestFeedback, useDigestRequest } from "./digest-request";
import { LedgerWarnings } from "./ledger-warnings";

type Actions = { sessionHostLabel?: string; coordinator?: string | null; onCoordinator?: (id: string | null) => void; changing?: boolean; onOpen?: (id: string) => void; onEdit: (id: string) => void };

export type BoardViewProps = Actions & {
  theme: Theme; layout: PluginScreenProps["layout"]; hostLabel: string; hostId?: string; onOpenHostSession?: (serverId: string, agentId: string) => void;
  readiness?: BoardReadiness | null; snapshot: Snapshot | null; error: string | null; loading: boolean; updatedAt: Date | null;
  onRefresh: () => void; onProject?: (id: string, enabled: boolean) => void;
};

export function BoardView({ snapshot, readiness, theme, layout, hostLabel, hostId, onOpenHostSession, error, loading, updatedAt, onRefresh, onProject, ...actions }: BoardViewProps) {
  const { t, language } = useBoardLanguage();
  const { human, projects } = useMemo(() => snapshot ? projectCards(snapshot) : { human: [], projects: [] }, [snapshot]);
  const activeProjects = useMemo(() => snapshot?.projects.filter(p => !p.missing) ?? [], [snapshot?.projects]);
  const projectGroups = useMemo(() => groupProjects(activeProjects), [activeProjects]);
  const pullRequests = snapshot?.pullRequests;
  const readyPrs = pullRequests?.items.filter(pr => pr.lane === "review") ?? [];
  const records = useMemo(() => {
    const priority = (urgency: string | null | undefined) => ["now","today","week"].includes(urgency ?? "") ? ["now","today","week"].indexOf(urgency!) : 3;
    return [...snapshot?.trackedDecisions?.items ?? []].sort((a,b) => priority(a.urgency) - priority(b.urgency) ||
      (a.where === "human" ? 0 : 1) - (b.where === "human" ? 0 : 1) || (a.since ?? "~").localeCompare(b.since ?? "~"));
  }, [snapshot?.trackedDecisions]);
  const folders = useMemo(() => projectFolderMap(snapshot?.projects ?? []), [snapshot?.projects]);
  const [inlineReceipts, setInlineReceipts] = useState<InlineReceipt[]>([]);
  const completed = new Set(inlineReceipts.map(receipt => receipt.actionKey));
  const names = new Map(snapshot?.projects.map(project => [project.id, project.title]));
  const displayed = new Map(projects.map(project => [project.id, project]));
  for (const pr of pullRequests?.items ?? []) for (const id of pr.projectIds) {
    if (!displayed.has(id)) displayed.set(id, {id,title:names.get(id) ?? id,cards:[]});
  }
  function decisionsFor(inScope:(id:string|null)=>boolean) {
    const visibleRecords=records.filter(item=>inScope(item.projectId) && !completed.has(recordActionKey(item)));
    const covered=trackedCoverage(visibleRecords);
    return {
      records:visibleRecords,
      sessions:human.filter(card=>inScope(card.session.projectId) && !completed.has(sessionRowKey(card)) && !covered.sessionIds.has(card.session.id)),
      prs:readyPrs.filter(pr=>pr.projectIds.some(inScope) && !completed.has(pullRowKey(pr)) && !covered.pullKeys.has(pullKey(pr.repo,pr.number))),
    };
  }
  const allPending = decisionsFor(() => true);
  const total = allPending.prs.length + allPending.records.length + allPending.sessions.length;
  const byProject=new Map<string|null,number>();
  const projectIds=new Set<string|null>(activeProjects.filter(p=>p.selected).map(p=>p.id));
  for (const item of records) {
    projectIds.add(item.projectId);
    if (item.projectId && !displayed.has(item.projectId)) displayed.set(item.projectId,{id:item.projectId,title:names.get(item.projectId) ?? item.projectTitle ?? item.projectId,cards:[]});
  }
  const [settings, setSettings] = useState(false);
  const {groups: peers, hosts: peerHosts, loading: peersLoading} = useRemoteRunning({id:hostId ?? "",label:hostLabel}, activeProjects, pullRequests?.projects ?? [], !!hostId && !settings);
  const peerKey = JSON.stringify(peerHosts.map(host => host.serverId));
  const lookupWorkSession = useMemo(() => createRemoteWorkSessionLookup(getPaseoClient), [hostId, updatedAt, peerKey]);
  const historyRepos = useMemo(() => new Map(pullRequests?.projects.flatMap(p =>
    p.repo && p.mode !== "off" ? [[p.projectId,p.repo] as const] : [])), [pullRequests?.projects]);
  const historyScope = useMemo(() => remoteScope(activeProjects,pullRequests?.projects ?? []), [activeProjects,pullRequests?.projects]);
  const scopeKey = JSON.stringify([hostId, historyScope, peers.map(p=>p.host.serverId).sort()]);
  const currentHistoryScope = useRef(scopeKey);
  currentHistoryScope.current = scopeKey;
  const historyLinks:HistoryLinks = entry => historySessionLinks(entry, {
    hostId, sessions:snapshot?.sessions ?? [], peers, repos:historyRepos,
    verifyRemote:(host,id,project) => readRemoteHistorySession(getPaseoClient(host),id,project,historyScope,()=>currentHistoryScope.current===scopeKey),
  });
  const history = snapshot?.replyHistory ?? [];
  useEffect(() => {
    const stored = new Map(snapshot?.replyHistory?.flatMap(entry => entry.pullMerge?.status === "merged" && entry.pullMerge.notification
      ? [[JSON.stringify([entry.projectId, pullRowKey(entry.pullMerge)]), entry.pullMerge.notification] as const] : []));
    if (!stored.size) return;
    setInlineReceipts(previous => {
      const next = previous.map(receipt => {
        if (receipt.status !== "merged") return receipt;
        const notification = latestMergeNotification(receipt.notification, stored.get(JSON.stringify([receipt.mergeProjectId, receipt.actionKey])));
        return notification === receipt.notification ? receipt : { ...receipt, notification };
      });
      return next.some((receipt, index) => receipt !== previous[index]) ? next : previous;
    });
  }, [snapshot?.replyHistory, inlineReceipts.length]);
  const now = Date.now();
  // Only replies still waiting on a session's result appear in the project kanban.
  const followups = history.flatMap(entry => {
    const kind = followupKind(entry, historyLinks(entry), now);
    return kind ? [{entry, kind}] : [];
  });
  for (const {entry} of followups) {
    projectIds.add(entry.projectId);
    if (entry.projectId && !displayed.has(entry.projectId)) displayed.set(entry.projectId,{id:entry.projectId,title:names.get(entry.projectId) ?? entry.projectId,cards:[]});
  }
  if (inlineReceipts.some(receipt => !receipt.hidden && receipt.projectIds.includes(null))) projectIds.add(null);
  for (const id of projectIds) {
    const list=decisionsFor(projectId=>projectId===id);
    byProject.set(id,list.records.length+list.sessions.length+list.prs.length);
  }
  const filterGroups: ProjectFilter[] = projectGroups.map(group => {
    if (group.ids.length === 1) return { ...group, count: byProject.get(group.ids[0]) ?? 0 };
    const list = decisionsFor(id => group.ids.includes(id));
    return { ...group, count: list.records.length + list.sessions.length + list.prs.length };
  });
  if (byProject.has(null)) filterGroups.push({ ids: [null], label: t("공통", "Host-wide"), count: byProject.get(null) ?? 0 });
  const [chosenProjects,setChosenProjects]=useState<(string|null)[]>([]);
  const filters = selectedProjectIds(filterGroups, chosenProjects);
  const inFilter = (id: string | null) => !filters.size || filters.has(id);
  const visibleProjects = [...displayed.values()].filter(project => inFilter(project.id));
  const hostWideRecords = records.filter(item=>item.projectId === null);
  const hostWideFollowups = followups.filter(item=>item.entry.projectId === null);
  const showHostWide = inFilter(null) && hostWideVisible({records:hostWideRecords.length, followups:hostWideFollowups.length});
  const {records:filteredRecords,sessions:filteredSessions,prs:filteredPrs}=decisionsFor(inFilter);
  const filteredTotal=filteredRecords.length+filteredSessions.length+filteredPrs.length;
  const filteredHistory=history.filter(entry=>inFilter(entry.projectId));
  const [historyOpen,setHistoryOpen]=useState<boolean|null>(null);
  const filterNames = new Map(filterGroups.flatMap(group => group.ids.map(id => [id, group.label] as const)));
  const projectName=(id:string|null)=>filterNames.get(id) ?? displayed.get(id ?? "")?.title ?? id ?? t("공통","Host-wide");
  const incomplete = snapshot?.trackedDecisions && ["partial","unavailable","invalid"].includes(snapshot.trackedDecisions.status);
  const visiblePeers = peers.map(group => ({...group, rows: group.rows.filter(row => inFilter(row.projectId))}));
  const [showError, setShowError] = useState(false);
  const [manage, setManage] = useState(false);
  const [pickSession, setPickSession] = useState(false);
  const configured = snapshot ? activeProjects.some(p => p.selected) : readiness?.configured;
  const pickingProjects = !configured || (!settings && !snapshot?.coordinator);
  const coordinatorId = snapshot ? snapshot.coordinator : readiness?.coordinator;
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const coordinatorAction = { pending, busy, setBusy };
  const lastDigest = snapshot?.lastDigestAt;
  const digest = useDigestRequest(coordinatorId ?? null, !!configured, coordinatorAction, onRefresh, lastDigest);
  const operationsReady = !!snapshot || !!(readiness?.configured && readiness.coordinator && !settings);
  const reach = snapshot?.coordinatorReach;
  // Opening a session in an archived workspace shows an empty screen. The banner explains instead.
  const coordinatorOpens = !reach || opensSession(reach.state);
  const openCoordinator = coordinatorId && actions.onOpen && coordinatorOpens ? () => actions.onOpen?.(coordinatorId) : undefined;
  const scroll = useRef<ScrollView>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const showBanner = () => scroll.current?.scrollTo({ y: 0, animated: true });
  function startReplace() {
    // Settings already ends with the replacement box. On the board it opens under the banner.
    if (settings) return scroll.current?.scrollToEnd({ animated: true });
    setReplaceOpen(true);
    showBanner();
  }
  // Cards point to the banner instead of repeating it.
  const unreachableNote = reach && blocksReplies(reach.state)
    ? t("코디네이터에 연결할 수 없음 · 위 안내 참고", "Coordinator unreachable · See the notice above") : undefined;
  const [digestLimit, setDigestLimit] = useState(5);
  const [mergeNotice, setMergeNotice] = useState<MergeNotice | null>(null);

  const [receipts, setReceipts] = useState<DecisionReceipt[]>([]);
  const matches = (r: DecisionReceipt, card: Card) => r.projectId === card.session.projectId && r.sessionId === card.session.id && r.version === card.session.decision?.version;
  const showDigestRefresh = shouldRefreshDigest(lastDigest, allPending.sessions, coordinatorId ?? null, now);
  const ranked = rankDecisionRows({ prs: filteredPrs, records: filteredRecords, sessions: filteredSessions }, now);
  const rankedKeys = ranked.map(row => row.key);
  const { positions, onEditing } = useDecisionEditing(rankedKeys);
  const shownKeys = keepEditingPositions(rankedKeys, positions).slice(0, digestLimit);
  const remaining = ranked.length - shownKeys.length;
  const scopedReceipts = inlineReceipts.filter(receipt => receipt.projectIds.some(id => byProject.has(id) && inFilter(id)));
  const showHistory = historyOpen ?? (filteredTotal === 0 && !scopedReceipts.some(receipt => !receipt.hidden));
  const orderedKeys = withReceiptPositions(shownKeys, scopedReceipts);
  function remember(action: CompletedAction) {
    // The callback captures the order at the time the person pressed the button.
    setInlineReceipts(previous => previous.some(entry => entry.actionKey === action.actionKey && entry.rowKey === action.rowKey)
      ? previous : [...previous, { ...action, order: orderedKeys }]);
  }
  function questionFor(card: ClarificationCard | null, title: string, prior?: TrackedDecision["qa"], onDraftChange?: (active:boolean) => void, ownerId?: string | null, notice?: ChoiceNotice | null) {
    if (!snapshot) return null;
    const recipientId = card ? clarificationRecipient(card, snapshot) : null;
    const recipientTitle = ownerId && ownerId === recipientId ? t("운영 코디네이터", "Ledger owner") + " · " + ownerId
      : snapshot.sessions.find(row => row.id === recipientId)?.title;
    const toCoordinator = !!recipientId && (recipientId === snapshot.coordinator || recipientId === ownerId);
    return <Clarification key={card ? clarificationKey(card) : title} title={title} card={card} theme={theme} suggestion={choiceRequest(notice ?? null, toCoordinator)}
      recipientId={recipientId} recipientTitle={recipientTitle} entries={snapshot.clarifications ?? []} prior={prior} onRefresh={onRefresh} onDraftChange={onDraftChange} />;
  }
  const renderDecision = (card: Card, embedded = false, rowKey?: string, priority?: string) => <DecisionActions key={JSON.stringify([card.session.projectId, card.session.id, card.session.decision?.version])}
          clarification={!embedded && questionFor(sessionClarificationCard(card.session,card.note),card.session.title,undefined,undefined,undefined,
            card.session.decision?.source === "conversation" ? decisionChoiceNotice(card.session.decision) : null)}
          embedded={embedded} priorityLabel={priority} card={card} hostLabel={hostLabel} theme={theme} coordinator={snapshot!.coordinator} coordinatorTitle={snapshot!.sessions.find(s => s.id === snapshot!.coordinator)?.title}
          open={actions.onOpen} receipt={receipts.find(r => matches(r, card))}
          pendingRequests={card.session.nativePending && hostId ? <PendingRequests key={JSON.stringify([hostId, card.session.id])} hostId={hostId}
            sessionId={card.session.id} sessionTitle={card.session.title} version={card.session.permissionVersion} theme={theme} open={actions.onOpen} onRefresh={onRefresh}
            onAnswered={result => {
              if (rowKey) remember({ rowKey, actionKey: sessionRowKey(card), projectIds: [card.session.projectId], status: result.handled ? "already-closed" : "sent", recipientId: card.session.id,
                title: card.session.title + " · " + result.title, detail: result.detail || undefined });
            }} /> : undefined}
          onSent={result => {
            if (rowKey && result.action === "reply") remember({
              rowKey, actionKey: sessionRowKey(card), projectIds: [result.projectId], status: "sent", recipientId: result.recipientId,
              title: decisionSummary(card, t).headline, detail: result.answer || result.recipient || undefined,
            });
            setReceipts(prior => [result, ...prior.filter(r => !(r.projectId === result.projectId && r.sessionId === result.sessionId))].slice(0, 20));
            onRefresh();
          }} />;
  function recordLinks(item: TrackedDecision, showSource = true): TrackedSessionLinks {
    if (!snapshot) return {};
    const ownerId = trackedSessionOwner(item, snapshot.coordinator);
    const open = actions.onOpen;
    const listed = snapshot.sessions.some(session => session.id === ownerId);
    const owner = ownerId && open && (ownerId === snapshot.coordinator || listed || hostId) ? {
      id: ownerId,
      open: () => open(ownerId),
      // The coordinator's state comes with the snapshot. A listed session opens as it is. Only an owner
      // outside the active list is looked up first, so an archived one explains itself.
      gate: ownerId === snapshot.coordinator ? { known: snapshot.coordinatorReach, onBlocked: showBanner }
        : !listed && hostId ? { check: () => readSessionReach(getPaseoClient(hostId), ownerId) } : undefined,
    } : undefined;
    const target = showSource ? trackedWorkSession(item, {
      hostId, hostLabel, sessions: snapshot.sessions, hosts: peerHosts, folders,
    }) : undefined;
    if (target?.kind === "local" && owner?.id === target.id) return { owner };
    if (target?.kind === "local" && open) return { owner, source: { kind: "local", open: () => open(target.id) } };
    if (target?.kind === "remote" && onOpenHostSession) {
      return { owner, source: { ...target, lookup: lookupWorkSession, open: onOpenHostSession } };
    }
    return { owner, source: target && { kind: "unavailable" } };
  }
  function renderPull(pr:PullRequestItem, projectId:string, decision=false, securityGate=false, embedded=false, rowKey?: string, scope: (string | null)[] = pr.projectIds, priority?: string) {
    const workSessions:WorkSessionLink[] = [];
    for (const s of snapshot?.sessions ?? []) {
      if (!inFilter(s.projectId) || !pr.projectIds.includes(s.projectId) || !actions.onOpen || !matchesWorkspace(pr,s.workspacePull)) continue;
      const state = s.status === "closed" ? t("대화 종료","Closed") : s.lane === "running" ? t("진행 중","Running") : s.status === "idle" ? t("대기","Idle") : t("상태 확인 필요","Check status");
      workSessions.push({key:JSON.stringify([hostId,s.id]),label:[s.title,hostLabel,state].join(" · "),open:()=>actions.onOpen!(s.id),running:s.lane === "running"});
    }
    if (onOpenHostSession) for (const {host,rows} of peers) for (const s of rows) {
      if (!inFilter(s.projectId) || !pr.projectIds.includes(s.projectId) || !matchesWorkspace(pr,s.workspacePull)) continue;
      workSessions.push({key:JSON.stringify([host.serverId,s.sessionId]),label:[s.title || t("작업 세션","Work session"),host.label,t("진행 중","Running")].join(" · "),open:()=>onOpenHostSession(host.serverId,s.sessionId),running:true});
    }
    // The coordinator can name the work session that owns the PR when no workspace matches it.
    const owner = pr.judgment?.ownerSessionId && snapshot?.sessions.find(s => s.id === pr.judgment?.ownerSessionId);
    if (owner && actions.onOpen && !workSessions.some(link => link.key === JSON.stringify([hostId,owner.id]))) {
      const running = ownerRunning(pr, [owner]);
      workSessions.push({key:JSON.stringify([hostId,owner.id]),label:[owner.title,hostLabel,running ? t("진행 중","Running") : t("작업 세션","Work session")].join(" · "),
        open:()=>actions.onOpen!(owner.id),running});
    }
    return <PullRequestCard key={JSON.stringify([pr.url,projectId])} pr={pr} projectId={projectId} theme={theme} priorityLabel={priority} workSessions={workSessions}
      clarification={decision && !embedded && questionFor({kind:"pull",projectId,repo:pr.repo,number:pr.number,updatedAt:pr.updatedAt},pr.repo + " #" + pr.number)}
      decision={decision} showDivider={!decision || embedded} securityGate={securityGate} openCoordinator={openCoordinator} onResult={notice => {
        const { status } = notice;
        const merged = status === "merged" || status === "already-merged";
        if (rowKey && merged) {
          remember({ rowKey, actionKey: pullRowKey(pr), projectIds: scope, status,
            title: pr.title, detail: notice.target, mergeProjectId: projectId, notification: notice.notification });
        }
        setMergeNotice(rowKey && merged ? null : notice);
        onRefresh();
      }} />;
  }
  const renderRecord = (item: TrackedDecision, rowKey?: string, priority?: string) => {
          const native = human.find(card => card.session.id === item.matchedSessionId);
          const pr = item.kind === "merge" && item.mergeTarget && pullRequests?.items.find(pr =>
            pr.repo === item.mergeTarget?.repo && pr.number === item.mergeTarget.number &&
            (!item.projectId || pr.projectIds.includes(item.projectId)) && (pr.reason !== "ready" || item.matchedPull));
          const route = native && !item.questions.length ? undefined : trackedReplyRoute(item,snapshot!.coordinator,snapshot!.sessions,folders);
          // A card offers its fallback only when it has no recipient.
          const reaches = route?.recipientId ?? route?.fallbackId;
          return <TrackedDecisionCard links={recordLinks(item, !native)} key={item.key} item={item} theme={theme} priorityLabel={priority}
            renderClarification={onDraftChange => questionFor(trackedClarificationCard(item,snapshot!.sessions),item.title,item.qa,onDraftChange,usesSourceCoordinator(item) ? item.sourceCoordinatorId : undefined,
              item.kind === "merge" ? null : cardChoiceNotice(ledgerChoiceGaps(item)))}
            pull={rowKey && item.mergeTarget && scopedReceipts.some(receipt => receipt.rowKey === rowKey && receipt.actionKey === pullRowKey(item.mergeTarget!)) ? <></>
              : pr && renderPull(pr, pr.projectIds.includes(item.projectId ?? "") ? item.projectId! : pr.projectIds[0], true, mentionsSecurityGate(item), true, rowKey, [item.projectId])}
            route={route} keepsUnsent={!!rowKey}
            blockedNote={reaches && reaches === snapshot!.coordinator ? unreachableNote : undefined}
            onResolved={outcome=>{
              const {status,reason,mode,answer,recipientId}=outcome;
              if (rowKey && mode && (status === "sent" || status === "closed" || status === "already-closed")) {
                remember({ rowKey, actionKey: recordActionKey({key: item.key, fingerprint: closedRevision(outcome) ?? item.fingerprint}), projectIds: [item.projectId],
                  status: status === "closed" ? (mode === "save" ? "saved" : "reviewed") : status,
                  recipientId: status === "sent" ? recipientId : undefined,
                  title: item.title, detail: answer || item.projectTitle || projectName(item.projectId) });
              }
              if (rowKey && mode && answer && (reason === "removed" || reason === "conflict")) {
                remember({ rowKey, actionKey: unsentActionKey(item), projectIds: [item.projectId], status: "unsent", title: item.title, detail: answer });
              }
              onRefresh();
            }}>
            {native && (!rowKey || !completed.has(sessionRowKey(native))) && renderDecision(native,true,rowKey)}
          </TrackedDecisionCard>;
        };
  const rowsByKey = new Map(ranked.map(row => [row.key, row]));
  const activeRows = new Map<string, ReactNode>();
  shownKeys.forEach((key, position) => {
    const row = rowsByKey.get(key)!;
    const label = priorityLabel(row, t, now);
    let content: ReactNode;
    switch (row.kind) {
      case "pull":
        content = renderPull(row.pr, row.pr.projectIds.find(inFilter) ?? row.pr.projectIds[0], true, false, false, key, row.pr.projectIds, label);
        break;
      case "record":
        content = renderRecord(row.item, key, label);
        break;
      case "session":
        content = renderDecision(row.card, false, key, label);
        break;
    }
    activeRows.set(key, <DecisionEditingRow rowKey={key} position={position} onEditing={onEditing}>{content}</DecisionEditingRow>);
  });
  const c = theme.colors;
  return (
    <ScrollView ref={scroll} style={{ flex: 1, backgroundColor: c.surface0 }} contentContainerStyle={{ gap: 20, padding: layout.compact ? 12 : 22 }}>
      <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
        <View style={{ flex: 1, minWidth: 140, gap: 3 }}>
          <Text style={{ color: c.foreground, fontSize: 22, fontWeight: "700" }} accessibilityRole="header">{settings ? t("코디네이터 보드 설정", "Coordinator board settings") : t("세션별 코디네이터 보드", "Session coordinator board")}</Text>
          {error ? <Text accessibilityRole="button" accessibilityLiveRegion="polite" onPress={() => setShowError(open => !open)}
            style={{ color: c.statusDanger, fontSize: 13, textDecorationLine: "underline" }}>
            {snapshot ? t("갱신 실패 · 이전 결과 표시 · 오류 상세", "Refresh failed · Showing last result · Details") : t("조회 실패 · 오류 상세", "Could not load sessions · Details")}
          </Text> : <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{[hostLabel, updatedAt ? (language === "ko" ? `${updatedAt.toLocaleTimeString("ko-KR")} 갱신` : `Updated ${updatedAt.toLocaleTimeString("en-US")}`) : t("세션 조회 중…", "Loading sessions…")].filter(Boolean).join(" · ")}</Text>}
        </View>
        {!settings && <Button theme={theme} label={loading ? t("조회 중…", "Refreshing…") : t("새로 고침", "Refresh")} onPress={onRefresh} disabled={loading} />}
        <Button theme={theme} label={settings ? t("보드로 돌아가기", "Back to board") : t("설정", "Settings")} onPress={() => {
          setSettings(!settings); setManage(false); setPickSession(false);
        }} />
      </View>
      {configured && <ReachExplanation banner reach={reach} theme={theme} onReplace={startReplace} />}
      {replaceOpen && !settings && configured && coordinatorId && <CoordinatorReplaceLoader theme={theme} coordinator={coordinatorId} disabled={busy}
        onReplaced={onRefresh} onClose={() => setReplaceOpen(false)} />}
      {!settings && configured && <ProjectFilterBar theme={theme} groups={filterGroups} selected={filters} total={total}
        clear={() => setChosenProjects([])} toggle={group => setChosenProjects(previous => toggleProjectFilter(filterGroups, previous, group))} />}
      {!!error && showError && <Text selectable style={{ color: c.statusDanger }}>{error}</Text>}
      {settings && <BoardLanguageSetting theme={theme} />}
      {!!error && settings && <Button theme={theme} label={t("세션 다시 조회", "Retry session lookup")} disabled={loading} onPress={onRefresh} />}
      {snapshot && onProject && (pickingProjects || settings) && <View style={{ gap: 7 }}>
        {!pickingProjects
          ? <Button theme={theme} label={manage ? t("프로젝트 관리 닫기", "Close project selection") : t("보드에서 관리할 프로젝트 선택", "Choose projects to manage")} onPress={() => setManage(!manage)} />
          : <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "600" }}>{t("다이제스트에서 관리할 프로젝트 선택", "Select projects for your digest")}</Text>}
        {(pickingProjects || manage) && <>
          <Text style={{ color: c.foregroundMuted }}>{t("선택한 프로젝트의 최근 대화를 읽어 내 결정을 찾습니다. 코디네이터를 지정하면 그 세션도 선택한 프로젝트의 발췌를 볼 수 있습니다.", "The board reads recent conversations in selected projects to find decisions. The assigned coordinator can also read excerpts from those projects.")}</Text>
          {snapshot.projects.map(p => {
            const title = p.title + (activeProjects.some(x => x.id !== p.id && x.title === p.title) ? " · " + (p.path || p.id) : "");
            const label = p.missing
              ? `${title} · ${t("Paseo에서 사라짐 · 목록에서 빼기", "Missing from Paseo · Remove from list")}`
              : `${p.selected ? t("관리에서 제외", "Remove") : t("추가", "Add")} · ${title}${p.temporary ? " · " + t("임시 폴더", "Temporary folder") : ""}`;
            return <Button key={p.id} theme={theme} selected={p.selected} disabled={actions.changing}
              label={label} onPress={() => onProject(p.id, !p.selected)} />;
          })}
          {snapshot.projects.filter(p => p.operating).map(p => {
            const inactive = p.operatingActive === false;
            return <Text key={p.id} accessibilityLiveRegion="polite" style={{ color: inactive ? c.foregroundMuted : c.statusWarning }}>
              {inactive
                ? t(`‘${p.title}’은 현재 쓰지 않는 운영 폴더입니다. 이 프로젝트를 제거해도 현재 코디네이터 연결에는 영향이 없습니다.`,
                  `“${p.title}” is an unused operations folder. Removing it will not disconnect the current coordinator.`)
                : t(`‘${p.title}’은 코디네이터 운영에 사용 중입니다. 제거하면 워크스페이스가 보관되어 요청과 답장이 전달되지 않습니다. Paseo 프로젝트 목록에 그대로 두세요.`,
                  `“${p.title}” is in use for coordinator operations. Removing it archives the workspace and stops requests and replies. Keep it in your Paseo project list.`)}
            </Text>;
          })}
        </>}
      </View>}
      {settings && snapshot && configured && <SessionLinks projects={activeProjects} theme={theme} onChange={onRefresh} />}
      {settings && pullRequests && !!configured && <PullRequestSettings view={pullRequests} names={names} theme={theme} refresh={onRefresh} />}
      {settings && hostId && <>
        <BoardHosts current={{ id: hostId, label: hostLabel }} settings theme={theme} open={onOpenHostSession} />
        <BoardHosts current={{ id: hostId, label: hostLabel }} settings={false} theme={theme} open={onOpenHostSession} />
      </>}
      <OperationsPanel settings={operationsReady && settings} theme={theme} coordinator={operationsReady ? coordinatorId ?? null : null} configured={operationsReady && !!configured}
        refreshBoard={onRefresh} openCoordinator={coordinatorOpens ? actions.onOpen : undefined} action={coordinatorAction} digest={digest} />
      {settings && snapshot && actions.onCoordinator && <View style={{ gap: 8 }}>
        <Button theme={theme} label={pickSession ? t("기존 세션 목록 닫기", "Close session list") : t("기존 세션에서 코디네이터 지정", "Choose an existing coordinator session")} onPress={() => setPickSession(!pickSession)} />
        {pickSession && <>
          {snapshot.coordinator && <Button theme={theme} disabled={actions.changing} label={t("현재 코디네이터 지정 해제", "Clear current coordinator")} onPress={() => actions.onCoordinator?.(null)} />}
          {snapshot.sessions.filter(s => s.id !== snapshot.coordinator).map(s => <Button key={s.id} theme={theme} disabled={actions.changing}
            label={`${s.projectTitle} · ${s.title} · ${t("지정", "Assign")}`} onPress={() => actions.onCoordinator?.(s.id)} />)}
          {!snapshot.sessions.length && <Text style={{ color: c.foregroundMuted }}>{t("관리할 프로젝트를 선택하면 지정할 수 있는 세션이 표시됩니다.", "Select a project to see its available sessions.")}</Text>}
        </>}
      </View>}
      {!settings && !snapshot && !error && !!readiness?.decisionTitles?.length && <View style={{ gap: 6 }}>
        <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "700" }}>{t("내 결정", "My decisions")}</Text>
        {readiness.decisionTitles.map((title, index) => <Text key={index} numberOfLines={2} style={{ color: c.foreground }}>{title}</Text>)}
        <Text style={{ color: c.foregroundMuted }}>{t("세션과 PR 상태를 확인하고 있어요.", "Checking session and PR status…")}</Text>
      </View>}
      {!settings && snapshot && configured && <View style={{ gap: layout.compact ? 12 : 16 }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <Text accessibilityRole="header" style={{ color: c.foreground, fontSize: 17, fontWeight: "700" }}>{filters.size ? t(`내 결정 · ${filteredTotal}건 / 전체 ${total}건`, `My decisions · ${filteredTotal} of ${total}`) : t(`내 결정 · ${total}건`, `My decisions · ${total}`)}</Text>
          {lastDigest && <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {t("최근 다이제스트", "Last digest")} · {new Date(lastDigest).toLocaleString(language === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
          </Text>}
          {showDigestRefresh && <Button theme={theme}
            label={digest.waiting ? t("요청함", "Requested") : t("다시 모으기", "Refresh digest")}
            disabled={busy || digest.waiting} onPress={() => void digest.request(true)} />}
        </View>
        {showDigestRefresh && <DigestFeedback theme={theme} feedback={digest.feedback} />}
        {incomplete && <LedgerWarnings diagnostics={snapshot.trackedDecisions?.diagnostics} theme={theme} />}
        {filters.size > 0 && !filteredTotal && total > 0 && !incomplete && <Text style={{color:c.foregroundMuted}}>{t("선택한 프로젝트에 결정할 일이 없습니다.","No decisions in the selected projects.")}</Text>}
        {total === 0 && !incomplete && <Text style={{ color: c.foregroundMuted }}>{t("지금 결정할 일이 없습니다.", "No decisions are waiting for you.")}</Text>}
        {mergeNotice && inFilter(mergeNotice.projectId) && snapshot.projects.some(p => p.selected && p.id === mergeNotice.projectId) && (mergeNotice.status === "merged" || mergeNotice.status === "already-merged" ||
          !readyPrs.some(pr => pr.repo + " #" + pr.number === mergeNotice.target)) && <MergeFeedback notice={mergeNotice} theme={theme} />}
        {orderedKeys.map(key => <View key={key} role="article" style={{ gap: 8, padding: layout.compact ? 12 : 16, backgroundColor: c.surface1, borderWidth: 1, borderColor: c.border, borderRadius: 10 }}>
          {scopedReceipts.filter(receipt => receipt.rowKey === key && !receipt.hidden).map(receipt =>
            <InlineDecisionReceipt key={receipt.actionKey} receipt={receipt} theme={theme} onOpen={actions.onOpen} onDismiss={() =>
              setInlineReceipts(prior => prior.map(entry => entry === receipt ? { ...entry, hidden: true } : entry))} />)}
          {activeRows.get(key)}
        </View>)}
        {remaining > 0 && <Button theme={theme} label={t(`결정 ${remaining}건 더 보기`, `Show ${remaining} more decisions`)} onPress={() => setDigestLimit(total)} />}
      </View>}
      {!settings && configured && filteredHistory.length>0 && <View>
        <ReplyHistory links={historyLinks} openRemote={onOpenHostSession} entries={filteredHistory} theme={theme} open={actions.onOpen} expanded={showHistory} onToggle={()=>setHistoryOpen(!showHistory)} />
      </View>}
      {!settings && snapshot && !configured && !snapshot.projects.length && <Text style={{ color: c.foregroundMuted }}>{t("표시할 세션이 없습니다. 워크스페이스에서 세션을 시작하면 여기에 나타납니다.", "Start a session in a workspace to see it here.")}</Text>}
      {!settings && configured && snapshot && <SessionProgress theme={theme} cards={visibleProjects.flatMap(project => project.cards)}
        peers={visiblePeers} peersLoading={peersLoading} hostLabel={hostLabel} projectName={projectName} open={actions.onOpen} openRemote={onOpenHostSession}>
        {!visibleProjects.length && !showHostWide && <Text style={{ color: c.foregroundMuted }}>{t("표시할 세션이 없습니다.", "No sessions to show.")}</Text>}
        {showHostWide && <Project historyLinks={historyLinks} openRemote={onOpenHostSession} projectId="" title={t("공통","Host-wide")} cards={[]} requests={[]} followups={hostWideFollowups} now={now}
          records={hostWideRecords} decisions={byProject.get(null) ?? 0} renderRecord={renderRecord} renderPull={renderPull}
          recordLinks={recordLinks} compact={layout.compact} theme={theme} {...actions} />}
        {visibleProjects.map((p) => <Project historyLinks={historyLinks} openRemote={onOpenHostSession} projectId={p.id} followups={followups.filter(item=>item.entry.projectId===p.id)} now={now} records={records.filter(r => r.projectId === p.id)} renderRecord={renderRecord} decisions={byProject.get(p.id) ?? 0} sessionHostLabel={hostLabel} renderPull={renderPull} recordLinks={recordLinks} requests={pullRequests?.items.filter(pr => pr.projectIds.includes(p.id)) ?? []} key={p.id} title={p.title} cards={p.cards} compact={layout.compact} theme={theme} {...actions} />)}
        <RemoteRunning groups={visiblePeers} projects={activeProjects} open={onOpenHostSession} theme={theme} />
      </SessionProgress>}
    </ScrollView>
  );
}
