import { useDecisionInteraction } from "./decision-editing";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Text, TextInput, View } from "react-native";
import { confirmPullRequestMerge, previewPullRequestMerge, readPullLifecycle, setProjectRepository, type MergeMethod, type MergePreview, type MergeReason, type MergeResult, type PullRequestView } from "../shared/prs";
import { Button, SessionChip, type Theme } from "./controls";
import { GitHubPullLink } from "./github-pull-link";
import { mergeNotificationLabel } from "./merge-notification";
import { useBoardLanguage, type Translate } from "./language";
import { githubStatusWords, needsRunningConfirmation, pullStatusWords, unknownStatusWords } from "../shared/pull-judgments";
import { findRemoteWorkSessionState, type RemoteWorkSession, type WorkSessionHost, type WorkSessionStates } from "./tracked-session-targets";
import { confirmAfterLookup, mergeConfirmation, pullSessionNote, remoteSessionView, type RemoteAnswer } from "./pull-work-session";
import { afterConfirm, announceBoardMerge, onBoardMerge, reopenPreview, reopensAfterMerge } from "./merge-flow";
import type { MergeWaitReason } from "../shared/merge-card-place";
import { mergeHoldWords, type MergeHold } from "../shared/merge-hold";

type PullRequest = PullRequestView["items"][number];

export type MergeNotice = { projectId: string; target: string; status: MergeResult["status"]; reason?: MergeReason; mergeSha?: string | null; notification?: MergeResult["notification"] };
const wrap = { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 };

const resultWords = {
  merged: ["병합을 확인했습니다.", "Merge confirmed."],
  "already-merged": ["이미 병합된 PR입니다.", "This pull request has already merged."],
  changed: ["최신 정보로 병합 미리보기를 다시 여세요.", "Open a new preview to review the latest state."],
  blocked: ["현재 병합할 수 없습니다. GitHub에서 상태를 확인하세요.", "Merge is currently blocked. Check the pull request on GitHub."],
  unconfirmed: ["병합 결과를 확인하지 못했습니다. GitHub에서 현재 상태를 확인하세요.", "Merge result unknown. Check the current state on GitHub."],
} as const;

function reasonText(reason: MergeReason | undefined, t: Translate) {
  if (!reason) return null;
  const reasons: Partial<Record<MergeReason, readonly [string, string]>> = {
    ...githubStatusWords,
    changed: ["검토한 뒤 PR이 바뀜", "The PR changed after the review"],
    outdated: ["검토한 뒤 병합 정보가 바뀜", "Merge details changed after the review"],
    closed: ["닫힌 PR", "Pull request closed"],
    queue: ["GitHub 병합 대기열 사용", "The repository uses a merge queue"],
    permission: ["GitHub 병합 권한 확인 필요", "Check GitHub merge permissions"],
    "no-method": ["저장소에서 허용한 병합 방식 없음", "No allowed merge method"],
    expired: ["병합 미리보기 만료", "Preview expired"],
    scope: ["관리 프로젝트의 저장소 연결이 변경됨", "The managed project's repository mapping changed"],
    unavailable: ["GitHub 상태 조회 불가", "Could not read GitHub state"],
  };
  const words = reasons[reason];
  if (words && reason !== "ready" && reason !== "blocked") return t(words[0], words[1]);
  return null;
}

export function MergeFeedback({ notice, theme }: { notice: MergeNotice; theme: Theme }) {
  const { t } = useBoardLanguage();
  const words = resultWords[notice.status];
  const reason = reasonText(notice.reason, t);
  const delivery = mergeNotificationLabel(notice.notification, t);
  const deliveryColor = notice.notification?.status === "unavailable" || notice.notification?.status === "unconfirmed"
    ? theme.colors.statusWarning : theme.colors.foregroundMuted;
  return <Text accessibilityLiveRegion="polite" selectable style={{ color: ["merged", "already-merged"].includes(notice.status) ? theme.colors.statusSuccess : theme.colors.statusWarning }}>
    {[notice.target, t(words[0], words[1]), reason, notice.mergeSha?.slice(0, 12)].filter(Boolean).join(" · ")}
    {delivery && <Text style={{ color: deliveryColor }}>{" · "}{delivery}</Text>}
  </Text>;
}

export type WorkSessionLink = { id: string; key: string; label: string; open: () => void; running: boolean };
// states: shared reads for this board refresh. fresh: asks the host again, used when a merge is confirmed.
export type RemotePullSession = RemoteWorkSession & { states: WorkSessionStates; fresh: WorkSessionStates; open: (host: string, id: string) => void };

// A work session on another host is shown only after a real lookup finds it there.
// Each board refresh brings a new lookup. The chip keeps the last answer, but the running check waits for the new one.
function useRemotePullSession(source: RemotePullSession | undefined) {
  const [found, setFound] = useState<RemoteAnswer<{ host: WorkSessionHost; running: boolean }, WorkSessionStates>>();
  const key = source && JSON.stringify([source.id, source.hosts.map(host => host.serverId)]);
  useEffect(() => {
    if (!source || !key) return;
    let active = true;
    const lookup = source.states;
    void findRemoteWorkSessionState(source, lookup).then(state => { if (active) setFound({ key, lookup, at: Date.now(), state: state ?? null }); });
    return () => { active = false; };
  }, [key, source?.states]);
  if (!source || !key) return null;
  // At Confirm merge the cached answer may be older than the preview, so ask the host again.
  // The new answer also updates the running check, so a session that started running asks once more.
  const lookup = source.states;
  const latest = () => findRemoteWorkSessionState(source, source.fresh).then(state => {
    setFound({ key, lookup, at: Date.now(), state: state ?? null });
    return state ?? null;
  });
  return { ...remoteSessionView(found, key, source.states, Date.now()), latest };
}

type Lifecycle = ReturnType<typeof readPullLifecycle.output.parse>["state"];
type LifecycleWhy = ReturnType<typeof readPullLifecycle.output.parse>["why"] | "unmapped";
const referenceStates = { OPEN: ["열림", "Open"], DRAFT: ["초안", "Draft"], MERGED: ["병합됨", "Merged"], CLOSED: ["닫힘", "Closed"] } as const;
export function TrackedPullStatus({repo, number, projectId, theme, securityGate = false, reference = false}: {repo:string; number:number; projectId:string|null; theme:Theme; securityGate?:boolean; reference?:boolean}) {
  const {t} = useBoardLanguage();
  const lookup = useRpc(readPullLifecycle);
  const [state, setState] = useState<Lifecycle | null>(null);
  const [why, setWhy] = useState<LifecycleWhy>();
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setState(null);
    async function refresh() {
      let current: Lifecycle = "UNKNOWN";
      let reason: LifecycleWhy = projectId ? "lookup-failed" : "unmapped";
      if (projectId) {
        try {
          const read = await lookup({repo, number, projectId, ...(reference ? {reference: true} : {})});
          current = read.state; reason = read.why;
        } catch { /* Show the link when GitHub is unavailable. */ }
      }
      if (!active) return;
      setState(current); setWhy(reason);
      if (projectId && current !== "MERGED") timer = setTimeout(() => void refresh(), 60_000);
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [repo, number, projectId, lookup, reference]);
  const referenceWords = state && state !== "UNKNOWN" ? referenceStates[state] : null;
  const message = reference ? (referenceWords ? t(referenceWords[0], referenceWords[1]) : null)
    : state === "MERGED" ? t("병합 완료", "Merged")
    : state === "CLOSED" ? t("병합 없이 닫힘", "Closed without merging")
    : state === "OPEN" && securityGate ? t("열린 PR · 보안 게이트 통과 여부 확인 필요", "Open · Security gate unverified")
    : state === "OPEN" ? t("열린 PR · 병합 조건 미확인", "Open · Merge requirements unverified")
    : state === "UNKNOWN" ? t(...unknownStatusWords(why))
    : t("GitHub 상태 확인 중…", "Checking GitHub status…");
  return <View style={{...wrap, alignItems:"baseline"}}>
    <GitHubPullLink repo={repo} number={number} theme={theme} />
    {message && <Text selectable accessibilityLiveRegion="polite" style={{color:state === "MERGED" ? theme.colors.statusSuccess : theme.colors.foregroundMuted}}>{message}</Text>}
  </View>;
}

// A ledger merge card whose PR the board could not read waits in project progress with the reason.
export function WaitingMergeRow({repo, number, title, why, theme}: {repo:string; number:number; title:string; why:MergeWaitReason; theme:Theme}) {
  const {t} = useBoardLanguage();
  const c = theme.colors;
  return <View style={{gap:4}}>
    <View style={{...wrap, alignItems:"baseline"}}>
      <GitHubPullLink repo={repo} number={number} theme={theme} />
      <Text selectable style={{color:c.foregroundMuted, fontSize:12}}>· {t(...unknownStatusWords(why))}</Text>
    </View>
    <Text selectable style={{color:c.foreground, fontSize:14}}>{title}</Text>
    <Text style={{color:c.foregroundMuted, fontSize:12}}>{t("GitHub에서 병합 준비가 확인되면 내 결정에 올라옵니다.", "This moves to My decisions once GitHub confirms the PR is ready.")}</Text>
  </View>;
}

export function PullRequestCard({ pr, projectId, theme, decision = false, showDivider = true, securityGate = false, openCoordinator, workSessions, remoteSession, onResult, clarification, priorityLabel, hold, remoteElsewhere = false }: {
  pr: PullRequest; projectId: string; theme: Theme; workSessions: WorkSessionLink[]; remoteSession?: RemotePullSession; hold?: MergeHold; remoteElsewhere?: boolean; decision?: boolean; showDivider?: boolean; securityGate?: boolean; openCoordinator?: () => void; onResult: (notice: MergeNotice) => void; clarification?: ReactNode; priorityLabel?: string;
}) {
  const { t } = useBoardLanguage();
  const c = theme.colors;
  const read = useRpc(previewPullRequestMerge);
  const merge = useRpc(confirmPullRequestMerge);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [method, setMethod] = useState<MergeMethod | null>(null);
  const [notice, setNotice] = useState<MergeNotice | null>(null);
  const [lookupError, setLookupError] = useState(false);
  const [busy, setBusy] = useState<"read" | "merge" | null>(null);
  const [runningPrompt, setRunningPrompt] = useState(false);
  // Shown above a preview the board read again on its own, and the recheck button after a stop.
  const [reopened, setReopened] = useState<readonly [string, string] | null>(null);
  const [recheck, setRecheck] = useState(false);
  const locked = useRef(false);
  // The person chose to review the merge while a work session was running.
  const acknowledgedRunning = useRef(false);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const target = pr.repo + " #" + pr.number;
  const named = (label: string) => ({label, accessibilityLabel: target + " · " + label});
  const ready = !securityGate && !!projectId && pr.lane === "review" && pr.reason === "ready" && notice?.status !== "merged" && notice?.status !== "already-merged";
  useDecisionInteraction(!!busy || runningPrompt || (ready && !!preview));
  const words = pullStatusWords(pr);
  const lookup = useRemotePullSession(remoteSession);
  const remote = lookup?.shown;
  const policy = mergeConfirmation({ hold, lane: pr.lane, localRunning: needsRunningConfirmation(workSessions), remoteElsewhere,
    ...(lookup ? { remote: { pending: lookup.pending, running: !!remote?.running } } : {}) });
  const gate = policy.gate;
  const status = securityGate && pr.reason === "ready" ? t("열린 PR · 보안 게이트 통과 여부 확인 필요", "Open · Security gate unverified")
    : policy.status === "held" ? t(mergeHoldWords.running[0], mergeHoldWords.running[1]) : t(words[0], words[1]);
  const working = ready && gate === "confirm";
  const sessionNote = pullSessionNote(workSessions.length, remoteSession ? { checking: remote === undefined, found: !!remote } : undefined);
  const remoteLabel = remote && [t("작업 세션", "Work session"), remote.host.label, ...(remote.running ? [t("진행 중", "Running")] : [])].join(" · ");
  const args = { projectId, repo: pr.repo, number: pr.number };

  async function inspect(confirmedRunning = false) {
    if (locked.current || !ready || gate === "wait") return;
    // A running work session may still push. Ask once more before showing the merge preview.
    if (working && !confirmedRunning) { setRunningPrompt(true); return; }
    acknowledgedRunning.current = working && confirmedRunning;
    setRunningPrompt(false);
    locked.current = true; setBusy("read"); setNotice(null); setLookupError(false); setRecheck(false); setReopened(null);
    try {
      const next = await read({ ...args, ...(pr.headSha ? { expectedHeadSha: pr.headSha } : {}) });
      if (next.status === "ready" && next.token && next.methods.length) {
        setPreview(next); setMethod(next.defaultMethod && next.methods.includes(next.defaultMethod) ? next.defaultMethod : null);
      } else {
        const feedback: MergeNotice = { projectId, target, status: next.status === "merged" ? "already-merged" : "blocked", reason: next.reason };
        setNotice(feedback); onResult(feedback);
      }
    } catch { setLookupError(true); }
    finally { locked.current = false; setBusy(null); }
  }
  // Read the preview again in place. Merging still waits for the person to press Confirm merge.
  async function reopen(previousBase: string | undefined) {
    if (locked.current) return;
    locked.current = true; setBusy("read"); setNotice(null); setLookupError(false); setRecheck(false); setReopened(null);
    try {
      const outcome = await reopenPreview({
        read: () => read({ ...args, ...(pr.headSha ? { expectedHeadSha: pr.headSha } : {}) }),
        delay: ms => new Promise(resolve => setTimeout(resolve, ms)),
        alive: () => alive.current,
      }, previousBase);
      if (outcome.kind === "show") {
        const next = outcome.preview;
        setPreview(next); setMethod(next.defaultMethod && next.methods.includes(next.defaultMethod) ? next.defaultMethod : null);
        setReopened(outcome.words);
      } else if (outcome.kind === "stop") {
        const next = outcome.preview;
        const feedback: MergeNotice = { projectId, target, status: next.status === "merged" ? "already-merged" : "blocked", reason: next.reason };
        setNotice(feedback); setRecheck(next.status !== "merged"); onResult(feedback);
      }
    } catch { setLookupError(true); }
    finally { locked.current = false; setBusy(null); }
  }
  const reopenRef = useRef(reopen);
  reopenRef.current = reopen;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  // Another PR in the same repository merged on the board, so this open preview may be out of date.
  useEffect(() => onBoardMerge((repo, number) => {
    const open = previewRef.current;
    if (!open || !reopensAfterMerge({ repo, number }, pr, true, locked.current)) return;
    setPreview(null); setMethod(null);
    void reopenRef.current(open.baseSha);
  }), [pr.repo, pr.number]);
  async function confirm() {
    if (locked.current || !ready || !preview?.token || !method || !preview.methods.includes(method)) return;
    locked.current = true; setBusy("merge"); setReopened(null);
    // A remote work session may have started running since the preview opened. Wait for its newest answer.
    if (lookup && confirmAfterLookup(await lookup.latest(), acknowledgedRunning.current || policy.remoteExempt) === "ask") {
      locked.current = false; setBusy(null); setPreview(null); setMethod(null); setRunningPrompt(true);
      return;
    }
    const previousBase = preview.baseSha;
    let feedback: MergeNotice;
    try {
      const result = await merge({ ...args, token: preview.token, method });
      feedback = { projectId, target, ...result };
    } catch { feedback = { projectId, target, status: "unconfirmed" }; }
    finally { locked.current = false; setBusy(null); setPreview(null); setMethod(null); }
    const step = afterConfirm({ status: feedback.status, reason: feedback.reason ?? "unconfirmed" });
    if (step === "reopen") { await reopen(previousBase); return; }
    if (feedback.status === "merged") announceBoardMerge(pr.repo, pr.number);
    setNotice(feedback); setRecheck(step === "recheck"); onResult(feedback);
  }
  return <View style={[{gap: 6}, showDivider && {borderTopColor: c.border, borderTopWidth: 1, paddingVertical: 8}]}>
    <View style={{ ...wrap, alignItems: "baseline" }}>
      <GitHubPullLink repo={pr.repo} number={pr.number} theme={theme} />
      <Text selectable style={{ color: c.foregroundMuted, fontSize: 12 }}>· {[status, priorityLabel].filter(Boolean).join(" · ")}</Text>
      {workSessions.map(link => <SessionChip key={link.key} label={link.label} theme={theme}
        accessibilityLabel={target + " · " + link.label} onPress={link.open} />)}
      {remoteSession && remote && remoteLabel && <SessionChip label={remoteLabel} theme={theme}
        accessibilityLabel={t(`${target} · ${remote.host.label}의 작업 세션 열기`, `${target} · Open work session on ${remote.host.label}`)}
        onPress={() => remoteSession.open(remote.host.serverId, remoteSession.id)} />}
      {sessionNote === "checking" && <Text style={{color:c.foregroundMuted,fontSize:12}}>{t("작업 세션 확인 중…", "Checking work session…")}</Text>}
      {sessionNote === "unverified" && <Text style={{color:c.foregroundMuted,fontSize:12}}>{t("작업 세션 미확인", "No verified work session")}</Text>}
      {decision && openCoordinator && <SessionChip theme={theme} label={t("코디네이터 세션", "Coordinator session")} accessibilityLabel={named(t("코디네이터 세션 열기", "Open coordinator session")).accessibilityLabel} onPress={openCoordinator} />}
    </View>
    <Text selectable style={{color: c.foreground, fontSize: 15, fontWeight: "600"}}>{preview?.title || pr.title}</Text>
    {decision && pr.gate === "judged" && pr.judgment && <Text selectable style={{color: c.foregroundMuted, fontSize: 13}}>
      {t("코디네이터 확인", "Coordinator check")} · {pr.judgment.reason}
    </Text>}
    {ready && policy.note && <Text accessibilityLiveRegion="polite" style={{color: c.foregroundMuted, fontSize: 13}}>
      {t(mergeHoldWords[policy.note][0], mergeHoldWords[policy.note][1])}
    </Text>}
    {working && <Text accessibilityLiveRegion="polite" style={{color: c.statusWarning, fontSize: 13}}>
      {policy.warning && policy.warning !== "running" ? t(mergeHoldWords[policy.warning][0], mergeHoldWords[policy.warning][1]) : t("작업 세션이 아직 진행 중입니다.", "A work session is still running.")}
    </Text>}
    {runningPrompt && working && !preview && <View style={{gap: 7, padding: 10, borderWidth: 1, borderRadius: 7, borderColor: c.statusWarning, backgroundColor: c.surface0}}>
      <Text style={{color: c.foreground}}>{policy.prompt === "unknown"
        ? t("작업 세션이 아직 진행 중이면 병합한 뒤에 올라올 변경이 빠질 수 있습니다. 그래도 병합 정보를 볼까요?",
          "If a work session is still running, merging now can leave out changes it is still making. Review the merge anyway?")
        : t("작업 세션이 끝나기 전에 병합하면 그 뒤에 올라올 변경이 빠질 수 있습니다. 그래도 병합 정보를 볼까요?",
          "Merging before the work session finishes can leave out changes it is still making. Review the merge anyway?")}</Text>
      <View style={wrap}>
        <Button theme={theme} {...named(t("그래도 병합 검토", "Review merge anyway"))} disabled={!!busy} onPress={() => void inspect(true)} />
        <Button theme={theme} {...named(t("취소", "Cancel"))} disabled={!!busy} onPress={() => setRunningPrompt(false)} />
      </View>
    </View>}
    {preview && ready && reopened && <Text accessibilityLiveRegion="polite" style={{color: c.foregroundMuted, fontSize: 13}}>{t(reopened[0], reopened[1])}</Text>}
    {preview && ready && <View style={{gap: 7, padding: 10, borderWidth: 1, borderRadius: 7, borderColor: c.border, backgroundColor: c.surface0}}>
      <Text selectable style={{color: c.foreground, fontWeight: "600"}}>{preview.baseRef} ← {preview.headRef}</Text>
      <Text selectable style={{color: c.foregroundMuted, fontSize: 12}}>{t("검토한 HEAD", "Reviewed HEAD")} · {preview.headSha}</Text>
      <Text selectable style={{color: c.foregroundMuted, fontSize: 12}}>{t("대상 브랜치 SHA", "Base SHA")} · {preview.baseSha}</Text>
      <Text selectable style={{color: c.foreground}}>{t("검사 상태", "Checks")} · {preview.checks ? t(`${preview.checks}건 완료`, `${preview.checks} completed`) : t("보고된 검사 없음", "No reported checks")}</Text>
      {openCoordinator && <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>
        {t("병합되면 코디네이터에 후속 작업을 요청합니다.", "After the merge, the board asks the coordinator to follow up.")}
      </Text>}
      <Text style={{color: c.foreground, fontWeight: "600"}}>{t("병합 방식", "Merge method")}</Text>
      <View style={wrap}>{preview.methods.map(option => <Button key={option} theme={theme} {...named(option)} selected={method === option} disabled={!!busy} onPress={() => setMethod(option)} />)}</View>
      <View style={wrap}>
        <Button theme={theme} {...named(busy === "merge" ? t("병합 확인 중…", "Confirming merge…") : t("병합 확정", "Confirm merge"))} selected disabled={!method || !!busy} onPress={() => void confirm()} />
        <Button theme={theme} {...named(t("취소", "Cancel"))} disabled={!!busy} onPress={() => { setPreview(null); setMethod(null); }} />
      </View>
    </View>}
    {((ready && !preview) || clarification) && <View style={wrap}>
      {ready && !preview && !runningPrompt && <Button theme={theme} {...named(busy === "read" ? t("병합 정보 조회 중…", "Loading merge details…") : recheck ? t("최신 정보로 다시 확인", "Check the latest again") : t("보드에서 병합", "Merge on board"))} selected={decision} disabled={!!busy || gate === "wait"} onPress={() => void inspect()} />}
      {clarification}
    </View>}
    {lookupError && <Text accessibilityLiveRegion="polite" style={{color:c.statusWarning}}>{t("병합 정보를 불러오지 못했습니다. 다시 조회하거나 GitHub에서 확인하세요.", "Could not load merge details. Try again or open GitHub.")}</Text>}
    {notice && notice.status !== "merged" && notice.status !== "already-merged" && <MergeFeedback notice={notice} theme={theme} />}
  </View>;
}

export function PullRequestSettings({view, names, theme, refresh}: {view: PullRequestView; names: Map<string,string>; theme: Theme; refresh: () => void}) {
  const {t} = useBoardLanguage();
  const [expanded, setExpanded] = useState(false);
  return <View style={{gap:8}}>
    <Button theme={theme} label={expanded ? t("GitHub 저장소 설정 닫기", "Close GitHub repositories") : t("프로젝트별 GitHub 저장소", "GitHub repositories by project")} onPress={() => setExpanded(!expanded)} />
    {expanded && view.projects.map(project => <RepositorySetting key={JSON.stringify([project.projectId, project.mode, project.repo])} project={project} title={names.get(project.projectId) ?? project.projectId} theme={theme} refresh={refresh}/>)}
  </View>;
}

function RepositorySetting({project, title, theme, refresh}: {project: PullRequestView["projects"][number]; title:string; theme:Theme; refresh:()=>void}) {
  const {t} = useBoardLanguage();
  const setRepo = useRpc(setProjectRepository);
  const [repo, setText] = useState(project.repo ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const c = theme.colors;
  async function change(mode: "auto"|"off"|"manual") {
    if (pending) return;
    setPending(true);
    try {
      await setRepo({projectId:project.projectId, mode, ...(mode === "manual" ? {repo:repo.trim()} : {}), expectedMode:project.mode, expectedRepo:project.repo});
      setError(false); refresh();
    } catch { setError(true); } finally { setPending(false); }
  }
  const states = {ok:t("조회됨","Connected"), unmapped:t("저장소 연결 필요","Link a repository"), unavailable:project.failure ? t(...unknownStatusWords(project.failure)) : t("조회 실패 · 호스트의 gh 연결 확인","Lookup failed · Check gh on the host"), off:t("꺼짐","Off"), truncated:t("일부 PR만 표시","Showing a partial PR list")};
  return <View style={{gap:6,padding:10,backgroundColor:c.surface1,borderRadius:8}}>
    <Text selectable style={{color:c.foreground,fontWeight:"600"}}>{title}</Text>
    <Text selectable style={{color:c.foregroundMuted}}>{project.repo ? project.repo + " · " : ""}{states[project.status]}</Text>
    <TextInput accessibilityLabel={t(title+" GitHub 저장소",title+" GitHub repository")} placeholder="owner/repository" autoCapitalize="none" autoCorrect={false}
      value={repo} onChangeText={setText} placeholderTextColor={c.foregroundMuted} style={{color:c.foreground,borderColor:c.border,borderWidth:1,borderRadius:6,padding:7}}/>
    <View style={{flexDirection:"row",flexWrap:"wrap",gap:5}}>
      <Button theme={theme} label={t("저장소 연결", "Link repository")} disabled={pending || !repo.trim()} onPress={() => void change("manual")} />
      <Button theme={theme} selected={project.mode==="auto"} disabled={pending || project.mode==="auto"} label={t("자동 감지","Auto-detect")} onPress={() => void change("auto")}/>
      <Button theme={theme} selected={project.mode==="off"} disabled={pending || project.mode==="off"} label={t("PR 조회 끄기","Turn off PR lookup")} onPress={() => void change("off")}/>
    </View>
    {error && <Text accessibilityLiveRegion="polite" style={{color:c.statusDanger}}>{t("저장소 이름과 최신 프로젝트 설정을 확인해 주세요.","Check the repository name and refresh this project's settings.")}</Text>}
  </View>;
}
