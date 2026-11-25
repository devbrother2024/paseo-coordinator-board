import type { ReplyEntry } from "./shared/reply-history";
import { pullKey, trackedFallbackRecipient, trackedRecipient, trackedReplyRoute, usesSourceCoordinator, type TrackedReplyReason } from "./shared/tracked-decisions";
import { boardReadiness } from "./shared/readiness";
import { SnapshotReads } from "./server/snapshot-reads";
import { readProjectDecisionSources } from "./server/project-decision-sources";
import { TrackedDecisionStore } from "./server/tracked-decisions";
import { MergeNotifications, mergeHistoryKey } from "./server/merge-notifications";
import { closedMergeTarget, settledKey, settleMergeCards } from "./shared/merge-card-place";
import { ProjectPullRequests } from "./server/prs";
import { decisionCount } from "./shared/decision-count";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { homedir } from "node:os";
import { join } from "node:path";
import { boardDecisionCount, boardScope, boardSnapshot, reportingKey, saveNote, setReporting } from "./shared/contract";
import { canReceiveBoardInput, discoverSessions } from "./server/discovery";
import { projectFolderMap, type ProjectFolders } from "./shared/project-folders";
import { attachReportTool } from "./server/reporting";
import { ConversationReader, excerpt } from "./server/conversation";
import { isManagedCoordinator, pruneDispatchReceipts, setCoordinator, PreferenceStore } from "./server/preferences";
import { trackedReviewTool } from "./server/tracked-review";
import { attachCoordinatorTools } from "./server/coordinator";
import { createOperations } from "./server/operations";
import { hostVisibility } from "./shared/hosts";
import { decorateDecision, DecisionSender } from "./server/decisions";
import { sendDecision } from "./shared/decision-actions";
import { isCurrentMembership, managedSessions, registerSessionLinks, releaseUnmanagedCoordinator } from "./server/session-links";
import { registerRecommendation } from "./server/recommendation";
import { NoteStore } from "./server/notes";
import { askClarification, sourceQuestion } from "./shared/clarifications";
import { ClarificationSender, clarificationHistory, restoreClarifiedDecision } from "./server/clarifications";
import { BoardFacts } from "./server/board-facts";
import { ProjectRootReader } from "./server/project-root";
import { recordDigestCompletion } from "./server/digest";
import { coordinatorReach, operatingProjects } from "./server/coordinator-reach";
import { discoverBoardSessions } from "./server/board-sessions";
import { withAssignmentHost } from "./server/host-assignment";
import { judgedMergeCardOptions, judgePullTool, registerMergeJudgmentSettings } from "./server/pull-judgments";
import { applyPullJudgments } from "./shared/pull-judgments";
import { operatingDirectories, operatingDirectory } from "./server/operating-folders";
import { CoordinatorToolStamps, readCoordinatorTools } from "./server/coordinator-tools";
import { coveredSessionIds, decorateReviewWait, reviewWaitThreshold } from "./server/review-wait";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(hostVisibility);
  const staleHours = reviewWaitThreshold(server);
  const home = process.env.PASEO_HOME || join(homedir(), ".paseo");
  const dataDir = join(home, "plugin-data", "coordinator-board");
  const notes = new NoteStore(join(dataDir, "notes.json"));

  const prefs = new PreferenceStore(join(dataDir, "scope.json"));
  const toolStamps = new CoordinatorToolStamps(prefs);
  const reader = new ConversationReader();
  const projectRoots = new ProjectRootReader();
  const facts = new BoardFacts(prefs, notes, reader);
  facts.register(server);
  const operatingRoot = join(home, "plugin-workspaces");
  const operatingFolders = operatingDirectories(operatingRoot);
  const operations = createOperations(prefs, operatingRoot, facts, () => invalidateCount());
  operations.register(server);
  registerSessionLinks(server, prefs);
  const decisions = new DecisionSender(prefs, notes, reader);
  registerRecommendation(server, decisions);
  server.handle(sendDecision, async (input, { paseo }) => {
    const result = await decisions.send(paseo, input);
    invalidateCount();
    return result;
  });
  const prs = new ProjectPullRequests(prefs);
  const tracked = new TrackedDecisionStore(join(dataDir, "tracked-decisions.json"),
    selected => readProjectDecisionSources(join(dataDir, "tracked-sources.json"), selected));
  const mergeNotifications = new MergeNotifications(prefs,(target,coordinator)=>tracked.mergeRecipient(target,coordinator),
    (sdk,target)=>prs.mergeScope(sdk,target));
  server.handle(boardReadiness, async () => {
    const scope = prefs.read();
    return { configured: scope.projects.length > 0, coordinator: scope.coordinator, decisionTitles: tracked.previewTitles(new Set(scope.projects)) };
  });
  async function buildSnapshot(paseo: PluginHandlerContext["paseo"], refreshPulls=false) {
    // GitHub can take seconds even when Paseo already knows the current sessions.
    // Start both paths together, and consume both rejections via Promise.all.
    const catalogRead = paseo.projects.list();
    const [sessionView, fetched] = await Promise.all([
      (async () => {
        const [catalog, rows] = await Promise.all([catalogRead, discoverBoardSessions(paseo, prefs)]);
        return buildSessionView(paseo, catalog, rows);
      })(),
      catalogRead.then(({ projects }) => prs.read(paseo, { projects, refresh:refreshPulls })),
    ]);
    const { choices, sessions, evidence, coordinatorRow } = sessionView;
    const latest = prefs.read();
    const selected = new Set(latest.projects.filter(id => choices.has(id)));
    const activeScope = { ...latest, projects: [...selected] };
    // Loading the board should not wait on an idle check or a provider turn.
    if (Object.values(latest.pullMergeHistory).some(entry => entry.pullMerge.notification?.status === "queued")) {
      void mergeNotifications.resume(paseo).catch(() => console.warn("Could not resume queued merge notifications."));
    }
    const visible = sessions.filter(row => isCurrentMembership(row, activeScope));
    const visibleNotes = notes.visible(new Set(visible.map(s => s.id)));
    facts.decorate(visible, evidence, visibleNotes);
    for (const row of visible) {
      decorateDecision(row, visibleNotes[row.id], latest, evidence.get(row.id));
      restoreClarifiedDecision(row, visibleNotes[row.id], latest, evidence.get(row.id));
    }
    const pullRequests = {
      projects: fetched.projects.filter(p => selected.has(p.projectId)),
      items: fetched.items.map(pr => ({ ...pr, projectIds: pr.projectIds.filter(id => selected.has(id)) })).filter(pr => pr.projectIds.length),
    };
    const targets = new Map(visible.map(row => [row.id, row]));
    if (coordinatorRow && coordinatorRow.id === latest.coordinator) targets.set(coordinatorRow.id, coordinatorRow);
    for (const id of evidence.keys()) if (!targets.has(id)) evidence.delete(id);
    const {history = [], ...trackedDecisions} = tracked.read(selected, visible, pullRequests, evidence);
    // A merge card whose PR is confirmed merged or closed leaves My decisions at once. The ledger is not touched.
    const boardMerge = (repo: string, number: number) => {
      const entry = Object.hasOwn(latest.pullMergeHistory, mergeHistoryKey(repo, number)) ? latest.pullMergeHistory[mergeHistoryKey(repo, number)] : undefined;
      return entry ? { state: "MERGED" as const, at: entry.at } : undefined;
    };
    const closedTargets = trackedDecisions.items.flatMap(item => { const target = closedMergeTarget(item, pullRequests); return target ? [target] : []; });
    const settledCards = settleMergeCards(trackedDecisions.items, pullRequests,
      closedTargets.length ? prs.settledStates(paseo, closedTargets, boardMerge) : new Map());
    trackedDecisions.items = settledCards.items;
    // Review waits see only the cards that stay after settlement.
    decorateReviewWait(visible, evidence, { coordinator: latest.coordinator, now: Date.now(), thresholdHours: await staleHours(),
      covered: coveredSessionIds(trackedDecisions.items), judgments: latest.judgments });
    // Ledger matching above sees GitHub readiness. Only then may coordinator verdicts move merge cards.
    pullRequests.items = applyPullJudgments(pullRequests.items, {
      ...judgedMergeCardOptions(latest), judgments: latest.pullJudgments,
      ledgerPulls: new Set(trackedDecisions.items.flatMap(item => item.matchedPull ? [pullKey(item.matchedPull.repo, item.matchedPull.number)] : [])),
    });
    if (tracked.hasWaitingReplies()) {
      void resumeReplies({paseo}).catch(()=>console.warn("Could not check waiting board replies."));
    }
    const activity: ReplyEntry[] = [...history];
    const settledByPull = new Map<string, typeof settledCards.settled>();
    for (const card of settledCards.settled) {
      const pull = settledKey(card.repo, card.number);
      settledByPull.set(pull, [...settledByPull.get(pull) ?? [], card]);
    }
    for (const [key, receipt] of Object.entries(latest.pullMergeHistory)) {
      if (!selected.has(receipt.projectId)) continue;
      const pull = settledKey(receipt.pullMerge.repo, receipt.pullMerge.number);
      const card = settledByPull.get(pull)?.[0];
      // The board merged it, so its own record says that the ledger card is waiting to be cleared.
      if (card) settledByPull.delete(pull);
      activity.push({...receipt, key, status:"recorded", ...(card ? {pullSettled:{repo:card.repo, number:card.number, state:card.state}} : {})});
    }
    for (const card of [...settledByPull.values()].flat()) {
      activity.push({key:"settled:" + card.item.key, title:card.item.title, projectId:card.item.projectId, at:card.at, status:"recorded",
        pullSettled:{repo:card.repo, number:card.number, state:card.state}});
    }
    const updates = new Map<string,string>();
    for (const [id, receipt] of Object.entries(latest.decisionReceipts)) {
      const detail = receipt.activity;
      if (!detail?.projectId || !selected.has(detail.projectId) || (receipt.messageId && receipt.messageId !== id)) continue;
      const reply = detail.recipientId && receipt.status === "sent" ? evidence.get(detail.recipientId)?.replies?.get(id) : undefined;
      if (reply && reply !== receipt.response) updates.set(id, reply);
      activity.push({...detail, origin:detail.origin ?? {sessionId:receipt.sessionId, cardId:receipt.sessionId, revision:receipt.version, questions:[{id:receipt.version}]}, key:id, status:receipt.status, messageId:id, response:reply ?? receipt.response});
    }
    if (updates.size) prefs.change(current => {
      for (const [id,text] of updates) if (current.decisionReceipts[id]) current.decisionReceipts[id].response = text;
    });
    for (const entry of activity) {
      const id = entry.recipientId ?? entry.pullMerge?.notification?.recipientId;
      const target = id && targets.get(id);
      if (!target) { delete entry.response; continue; }
      entry.canOpen = true;
      entry.recipientTitle = target.title;
      entry.recipientState = target.lane === "running" ? "running" : target.status === "idle" || target.status === "closed" || target.status === "error" ? target.status : "unknown";
    }
    const replyHistory = activity.sort((a,b) => b.at.localeCompare(a.at));
    const clarifications = clarificationHistory(prefs, targets, evidence);
    const listedCoordinator = coordinatorRow?.id === latest.coordinator ? coordinatorRow : undefined;
    const projects = [...choices.values()];
    const reach = await coordinatorReach(paseo, latest, listedCoordinator, operatingRoot, projects, projectRoots);
    const coordinatorTools = await readCoordinatorTools(paseo, toolStamps, listedCoordinator);
    const inUseFolders = [latest.createdCoordinator?.id === latest.coordinator ? latest.createdCoordinator : undefined, latest.pendingCoordinator]
      .flatMap(record => record ? [operatingDirectory(operatingRoot, record.language)] : []);
    const operating = await operatingProjects(projects, operatingFolders, latest, listedCoordinator, projectRoots, inUseFolders);
    const knownProjects = projects.map(p => ({ ...p, selected: selected.has(p.id),
      ...(operating.has(p.id) ? { operating: true, operatingActive: operating.get(p.id) } : {}) }));
    const missingProjects = latest.projects.filter(id => !selected.has(id)).map(id => ({
      id, title: id, path: "", selected: true, missing: true as const, temporary: false,
    }));
    const notice = latest.assignmentNotice;
    return { sessions: visible, notes: visibleNotes, pullRequests, trackedDecisions, replyHistory, ...(clarifications.length ? { clarifications } : {}),
      ...(notice && selected.has(notice.projectId) && { assignmentNotice: notice }),
      projects: [...knownProjects, ...missingProjects], coordinator: latest.coordinator, lastDigestAt: latest.lastDigest?.at, ...(reach ? { coordinatorReach: reach } : {}),
      ...(coordinatorTools ? { coordinatorTools } : {}) };
  }
  async function buildSessionView(paseo: PluginHandlerContext["paseo"],
    catalog: Awaited<ReturnType<PluginHandlerContext["paseo"]["projects"]["list"]>>,
    rows: Awaited<ReturnType<typeof discoverSessions>>) {
    const known = new Map(catalog.projects.map(p => [p.projectId, {
      id: p.projectId, title: p.projectCustomName || p.projectDisplayName || p.projectId, path: p.projectRootPath || "",
    }]));
    for (const row of rows) {
      if (!row.serverId && !known.has(row.projectId)) known.set(row.projectId, { id: row.projectId, title: row.projectTitle, path: "" });
    }
    const saved = prefs.read();
    const scope = { ...saved, projects: saved.projects.filter(id => known.has(id)) };
    const titles = new Map([...known].map(([id, p]) => [id, p.title]));
    const sessions = managedSessions(rows, scope, titles);
    const projects = [...known.values()];
    const [evidence, roots] = await Promise.all([
      reader.decorate(paseo, sessions, scope),
      projectRoots.describe(projects, new Set(scope.projects)),
    ]);
    const choices = new Map(projects.map((project, i) => [project.id, { ...project, ...roots[i] }]));
    const coordinatorRow = rows.find(row => row.id === scope.coordinator && !row.serverId);
    if (coordinatorRow && !sessions.some(row => row.id === coordinatorRow.id)) {
      const observed = await reader.read(paseo, coordinatorRow).catch(() => null);
      if (observed) evidence.set(coordinatorRow.id, observed);
    }
    const clarifying = new Set(Object.values(scope.clarifications).flatMap(entry => {
      if (entry.status === "pending" && (entry.card.projectId === null ? scope.projects.length : scope.projects.includes(entry.card.projectId))) {
        return [entry.recipientId];
      }
      const original = sourceQuestion(entry.card);
      return original && entry.savedDecision && original.version !== scope.answers[original.sessionId]?.version
        ? [entry.recipientId] : [];
    }));
    // A running recipient may already have accepted a clarification, even
    // though the regular reader skips its timeline until the turn finishes.
    const recipients = coordinatorRow && isManagedCoordinator(scope, coordinatorRow.id) && !sessions.some(s => s.id === coordinatorRow.id)
      ? [...sessions, coordinatorRow] : sessions;
    for (const row of recipients) {
      if (!clarifying.has(row.id) || evidence.has(row.id) || row.nativePending || row.status === "closed") continue;
      try {
        const page = await withAssignmentHost(paseo, row.serverId, client =>
          client.agents.ref(row.id).timeline.refetch({ direction: "tail", projection: "projected", limit: 48 }));
        evidence.set(row.id, excerpt(page));
      } catch {
        // Fall back to Paseo's current state when the timeline is unavailable.
      }
    }
    return { choices, sessions, evidence, coordinatorRow };
  }
  const reads = new SnapshotReads<Awaited<ReturnType<typeof buildSnapshot>>>(() => {
    const { projects, sessionLinks, coordinator, projectRepositories } = prefs.read();
    return JSON.stringify([projects, sessionLinks, coordinator, projectRepositories]);
  }, decisionCount);
  const invalidateCount = () => reads.invalidate();
  const clarifications = new ClarificationSender(prefs, (sdk, card) => buildSnapshot(sdk, card.kind === "pull"), (card, view) => {
    const original = sourceQuestion(card);
    if (original) {
      const latest = notes.visible(new Set([original.sessionId]))[original.sessionId];
      if (latest?.revision !== view.notes[original.sessionId]?.revision) return false;
    }
    if (card.kind !== "tracked") return true;
    const scope = prefs.read();
    const records = tracked.read(new Set(scope.projects), [], { items: [], projects: [] });
    const sameCard = (item:{source:string;projectId:string|null;id:string;fingerprint:string}) =>
      item.source === card.source && item.projectId === card.projectId && item.id === card.id && item.fingerprint === card.fingerprint;
    const before = view.trackedDecisions?.items.find(sameCard);
    const now = records.items.find(sameCard);
    return !!before && !!now && !now.historyUnavailable && now.sourceCoordinatorId === before.sourceCoordinatorId;
  });
  server.handle(askClarification, async (input, { paseo }) => {
    try {
      return await clarifications.send(paseo, input);
    } finally {
      invalidateCount();
    }
  });
  prs.register(server, invalidateCount,mergeNotifications);
  registerMergeJudgmentSettings(server, prefs, invalidateCount);
  const onRecipientAvailable = async (event: {agent?: {id:string}}, context: PluginHandlerContext) => {
    if (!event.agent?.id) return;
    const id=event.agent.id;
    if (tracked.hasWaitingReplies(id)) {
      await resumeReplies(context,id);
      // The completion hook can precede the daemon's idle projection.
      if (tracked.hasWaitingReplies(id)) {
        await new Promise(resolve=>setTimeout(resolve,250));
        await resumeReplies(context,id);
      }
    }
    await mergeNotifications.resume(context.paseo,event.agent.id);
  };
  const removeMergeTurn = server.addHook("agent.turn.after", async (event, context) => {
    await Promise.all([
      onRecipientAvailable(event, context),
      recordDigestCompletion(prefs, context.paseo, event).catch(() => console.warn("Could not record the completed digest.")),
    ]);
  });
  const removeReplyClose = server.addHook("agent.close.after",async (event,ctx)=>{ if(event.agent?.id) await resumeReplies(ctx,event.agent.id); });
  const removeReplyArchive = server.addHook("agent.archive.after",async (event,ctx)=>{ if(event.agent?.id) await resumeReplies(ctx,event.agent.id); });
  const removeMergePermission = server.addHook("agent.permission.after",onRecipientAvailable);
  // The board's own same-folder judgment, read again when a reply goes out. Only selected projects get a key.
  // `unread` says a project's folder, or the project list itself, could not be read just now.
  async function currentFolders(paseo: PluginHandlerContext["paseo"]): Promise<{ folders: ProjectFolders; unread: (id: string | null) => boolean }> {
    try {
      const projects = (await paseo.projects.list()).projects.map(p => ({ id: p.projectId, path: p.projectRootPath || "" }));
      const roots = await projectRoots.describe(projects, new Set(prefs.read().projects));
      const unread = new Set(projects.filter((_, i) => roots[i].unread).map(project => project.id));
      return { folders: projectFolderMap(projects.map((project, i) => ({ ...project, ...roots[i] }))), unread: (id: string | null) => !!id && unread.has(id) };
    } catch {
      return { folders: {}, unread: () => true };
    }
  }
  // Looks for a reply the board sent in the recent conversation of the session that took it.
  async function arrived(handle: ReturnType<PluginHandlerContext["paseo"]["agents"]["ref"]>, messageId: string, matches: (text: string) => boolean) {
    const page=await handle.timeline.refetch({direction:"tail",projection:"projected",limit:128});
    return !page.error && !page.gap && !page.staleCursor && page.entries.some(({item:m})=>m.type==="user_message" &&
      (m.messageId===messageId || m.clientMessageId===messageId) && matches(m.text));
  }
  const resumeReplies = tracked.register(server, () => new Set(prefs.read().projects), invalidateCount, async (item,targetId,{paseo},route) => {
    let rows = await discoverSessions(paseo);
    // Only a card's own local session may sit in another project on the same folder.
    const {folders, unread} = item.where === "session" && item.sessionId && !item.sessionHost ? await currentFolders(paseo) : {folders: {}, unread: () => false};
    const fallback = route === "coordinator";
    const owned = fallback ? item.sourceCoordinatorId !== undefined : usesSourceCoordinator(item);
    const mismatch = (): TrackedReplyReason | null => {
      const scope = prefs.read();
      const managed = managedSessions(rows,scope);
      if (!scope.projects.length || (item.projectId && !scope.projects.includes(item.projectId))) return "recipient-changed";
      const expected = fallback ? trackedFallbackRecipient(item,scope.coordinator,managed) : trackedRecipient(item,scope.coordinator,managed,folders);
      if (expected !== targetId) {
        // An owner that is still the ledger's owner but no longer listed is missing, not replaced.
        if (owned) return item.sourceCoordinatorId === targetId ? "recipient-missing" : "owner-changed";
        if (expected) return "recipient-changed";
        // The card's own session in another project is not ruled out while either folder could not be read.
        const own = !fallback && targetId === item.sessionId ? managed.find(row => row.id === targetId) : undefined;
        return own && own.projectId !== item.projectId && (unread(own.projectId) || unread(item.projectId)) ? "recipient-unchecked" : "recipient-missing";
      }
      return !owned || managed.some(row => row.id === targetId) ||
        (isManagedCoordinator(scope,targetId) && targetId === scope.coordinator && rows.some(row => row.id === targetId)) ? null : "recipient-missing";
    };
    const current = () => mismatch() === null;
    const before = mismatch();
    if (before) return {blocked:before};
    const handle=paseo.agents.ref(targetId);
    if (owned) rows = await discoverSessions(paseo);
    const agent=(await handle.refresh())?.agent;
    if (!agent || agent.id!==targetId || agent.internal || agent.archivedAt) return {blocked:"recipient-missing"};
    if (agent.status==="closed" || agent.status==="error") return {blocked:agent.status==="closed" ? "recipient-closed" : "recipient-error"};
    const after = mismatch();
    if (after) return {blocked:after};
    return {
      stillCurrent:current,
      // A new redirected reply goes out only while the card's own session still cannot take it.
      redirectable:()=>{
        const scope = prefs.read();
        return !trackedReplyRoute(item,scope.coordinator,managedSessions(rows,scope),folders).recipientId;
      },
      send:async (answer,messageId,images)=>{
        await handle.send(answer,{messageId,activeTurnBehavior:"steer",...(images?.length ? {images} : {})});
      },
      accepted:(messageId,matches)=>arrived(handle,messageId,matches),
      ready:canReceiveBoardInput(agent,owned || fallback || targetId===prefs.read().coordinator),
    };
  }, ({paseo}) => ({
    arrived:(recipientId,messageId,matches)=>arrived(paseo.agents.ref(recipientId),messageId,matches),
    gone:async recipientId=>{
      const agent=(await paseo.agents.ref(recipientId).refresh())?.agent;
      return !agent || !!agent.archivedAt;
    },
  }));
  server.handle(boardSnapshot, (input, { paseo }) => reads.read(() => buildSnapshot(paseo), input.fresh));
  server.handle(boardDecisionCount, async (_input, { paseo }) => ({
    count: await reads.count(() => buildSnapshot(paseo)),
  }));
  server.handle(boardScope, async (change, { paseo }) => {
    const rows = await discoverSessions(paseo);
    if (change.kind === "project") {
      if (change.enabled && !rows.some(r => r.projectId === change.projectId)) {
        const catalog = await paseo.projects.list();
        if (!catalog.projects.some(p => p.projectId === change.projectId)) throw new Error("이 호스트에서 프로젝트를 찾을 수 없습니다.");
      }
      prefs.change(scope => {
        if (scope.projects.includes(change.projectId) !== change.enabled) delete scope.factCycle;
        scope.projects = scope.projects.filter(id => id !== change.projectId);
        if (change.enabled) scope.projects.push(change.projectId);
        else {
          pruneDispatchReceipts(scope);
          if (scope.assignmentNotice?.projectId === change.projectId) delete scope.assignmentNotice;
          for (const link of Object.values(scope.sessionLinks)) {
            if (link.targetProjectId === change.projectId) delete scope.sessionLinks[link.sessionId];
          }
          releaseUnmanagedCoordinator(rows, scope);
          for (const [id, d] of Object.entries(scope.judgments)) if (d.projectId === change.projectId) delete scope.judgments[id];
        }
        reader.retain(new Set(managedSessions(rows, scope).map(r => r.id)));
      });
    } else {
      prefs.change(scope => {
        if (change.sessionId && !managedSessions(rows, scope).some(r => r.id === change.sessionId)) throw new Error("관리할 프로젝트의 세션을 선택해 주세요.");
        setCoordinator(scope, change.sessionId);
      });
    }
    invalidateCount();
    return { ok: true };
  });
  server.handle(saveNote, async (input, { paseo }) => {
    const sessions = await discoverBoardSessions(paseo, prefs, new Set([input.sessionId]));
    if (!managedSessions(sessions, prefs.read()).some(session => session.id === input.sessionId)) {
      throw new Error("이 호스트에서 해당 세션을 찾지 못했습니다. 보드를 새로 고쳐 주세요.");
    }
    const outcome = notes.update(input);
    if (outcome.ok) invalidateCount();
    return outcome;
  });

  server.handle(setReporting, async ({ sessionId, enabled }, { paseo }) => {
    const sessions = await discoverSessions(paseo);
    if (!managedSessions(sessions, prefs.read()).some(session => session.id === sessionId)) throw new Error("세션을 찾지 못했습니다.");
    await paseo.agents.ref(sessionId).setMetadata({ [reportingKey]: enabled });
    invalidateCount();
    return { ok: true };
  });
  const removeReport = attachReportTool(server, notes);
  const reviewContext = async () => ({ thresholdHours: await staleHours(),
    covered: coveredSessionIds(tracked.read(new Set(prefs.read().projects), [], { items: [], projects: [] }).items) });
  const removeCoordinator = attachCoordinatorTools(server, prefs, reader, [...operations.tools, facts.tool, trackedReviewTool(prefs, tracked, prs, reader, invalidateCount), judgePullTool(prefs, prs, invalidateCount, undefined, {hints:(selected, id) => tracked.ownerHints(selected, id)})], toolStamps, reviewContext);
  return () => { removeMergeTurn(); removeMergePermission(); removeReplyClose(); removeReplyArchive(); removeCoordinator(); removeReport(); };
}
