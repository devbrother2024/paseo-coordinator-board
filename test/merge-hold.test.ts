import { expect, test } from "bun:test";
import { asksBeforeMerge, heldMergeRecord, kanbanPull, linkedHosts, mergeHoldDetails, mergeHolds, seenElsewhere, mergeHoldWords, mergeRecordLinks, snapshotHoldSessions } from "../shared/merge-hold";
import { decisionCount } from "../shared/decision-count";
import { decidesNow, placeMergeCards, pullDecidesNow } from "../shared/merge-card-place";
import type { PullRequestItem } from "../shared/prs";
import { pullColumn } from "../shared/pull-judgments";
import type { SessionRow } from "../shared/contract";
import type { TrackedDecision } from "../shared/tracked-decisions";

const pr = (extra: Partial<PullRequestItem> = {}): PullRequestItem => ({
  repo: "org/example", number: 7, title: "Sample", url: "https://github.com/org/example/pull/7", headSha: "a".repeat(40),
  headRepo: "org/example", headBranch: "feat/sample", projectIds: ["project"], lane: "review", reason: "ready", gate: "judged",
  updatedAt: "2026-11-24T00:00:00Z", ...extra,
});
const onBranch = { kind: "branch" as const, repo: "org/example", branch: "feat/sample" };
const nextUnit = { kind: "branch" as const, repo: "org/example", branch: "feat/sample-next" };
const session = (running: boolean, extra: Record<string, unknown> = {}) => ({ id: "work", projectId: "project", running, workspacePull: onBranch, ...extra });
const key = "org/example#7";
const owned = (id = "owner") => pr({ judgment: { verdict: "ready", reason: "Done", at: "2026-11-24T01:00:00.000Z", ownerSessionId: id } });
const link = (extra: Record<string, unknown> = {}) => ({ repo: "org/example", number: 7, projectId: "project", id: "ledger-work", ...extra });

test("a session running on the PR's head branch keeps the merge card in project progress", () => {
  expect(mergeHolds([pr()], { sessions: [session(true)] }).get(key)).toBe("running");
  expect(mergeHolds([pr()], { sessions: [session(true, { workspacePull: { kind: "pr", repo: "org/example", number: 7 } })] }).get(key)).toBe("running");
});

test("an idle work session lets the merge card into My decisions", () => {
  expect(mergeHolds([pr()], { sessions: [session(false)] }).has(key)).toBe(false);
  expect(mergeHolds([owned()], { sessions: [session(false, { id: "owner" })] }).has(key)).toBe(false);
});

test("an unrelated session in another project or on another branch does not touch the PR", () => {
  expect(mergeHolds([pr()], { sessions: [session(true, { projectId: "other" })] }).has(key)).toBe(false);
  expect(mergeHolds([pr()], { sessions: [session(true, { workspacePull: nextUnit })] }).has(key)).toBe(false);
});

test("the coordinator's named owner holds the card only while it works on the PR branch", () => {
  expect(mergeHolds([owned()], { sessions: [session(true, { id: "owner" })] }).get(key)).toBe("running");
  // The same session moved on to the next unit on another branch: the card stays with one line.
  expect(mergeHolds([owned()], { sessions: [session(true, { id: "owner", workspacePull: nextUnit })] }).get(key)).toBe("elsewhere");
  expect(mergeHolds([owned()], { sessions: [session(true, { id: "owner", workspacePull: { kind: "pr", repo: "org/example", number: 8 } })] }).get(key)).toBe("elsewhere");
  // Its branch is unknown: the card stays with a warning.
  expect(mergeHolds([owned()], { sessions: [session(true, { id: "owner", workspacePull: undefined })] }).get(key)).toBe("branch-unknown");
});

test("a branch workspace cannot be compared when GitHub did not report the head branch", () => {
  expect(mergeHolds([owned()].map(p => ({ ...p, headBranch: undefined })), { sessions: [session(true, { id: "owner" })] }).get(key)).toBe("branch-unknown");
});

test("the session a ledger merge card names follows the same branch rule, and the card waits with its PR", () => {
  const record = { kind: "merge" as const, mergeTarget: { repo: "org/example", number: 7 }, projectId: "project", sessionId: "ledger-work" };
  const links = mergeRecordLinks([record]);
  expect(links).toEqual([link()]);
  const same = mergeHolds([pr({ gate: "ledger" })], { sessions: [session(true, { id: "ledger-work" })], links });
  expect(same.get(key)).toBe("running");
  expect(heldMergeRecord(record, same)).toBe(true);
  expect(heldMergeRecord({ ...record, kind: "check" }, same)).toBe(false);
  expect(heldMergeRecord({ ...record, mergeTarget: { repo: "org/example", number: 8 } }, same)).toBe(false);
  const other = mergeHolds([pr({ gate: "ledger" })], { sessions: [session(true, { id: "ledger-work", workspacePull: nextUnit })], links });
  expect(other.get(key)).toBe("elsewhere");
  expect(heldMergeRecord(record, other)).toBe(false);
  expect(mergeRecordLinks([{ ...record, kind: "check" }])).toEqual([]);
});

test("a ledger card for another project does not lend its session to the PR", () => {
  expect(mergeHolds([pr()], { sessions: [session(true, { id: "ledger-work", workspacePull: undefined })], links: [link({ projectId: "other" })] }).has(key)).toBe(false);
});

test("a session running on the PR branch on another host holds the PR", () => {
  expect(mergeHolds([pr()], { sessions: [], peers: { rows: [session(true, { id: "remote" })], read: new Set(["host-b"]) } }).get(key)).toBe("running");
});

test("an unread host warns only on PRs linked to a session on that host", () => {
  // host-c was read; host-b was not (still loading or failed).
  const read = new Set(["host-c"]);
  expect(mergeHolds([pr()], { sessions: [], peers: { rows: [], read }, links: [link({ hosts: ["host-b"] })] }).get(key)).toBe("unverified");
  // Linked to a session on another, readable host that is not running.
  expect(mergeHolds([pr()], { sessions: [], peers: { rows: [], read }, links: [link({ hosts: ["host-c"] })] }).has(key)).toBe(false);
  // Linked only to sessions on this host, or not linked at all.
  expect(mergeHolds([pr()], { sessions: [session(false, { id: "ledger-work" })], peers: { rows: [], read }, links: [link()] }).has(key)).toBe(false);
  expect(mergeHolds([pr()], { sessions: [], peers: { rows: [], read } }).has(key)).toBe(false);
  // A session known to run on the branch still wins.
  expect(mergeHolds([pr()], { sessions: [session(true)], peers: { rows: [], read }, links: [link({ hosts: ["host-b"] })] }).get(key)).toBe("running");
});

test("an owner the coordinator named on an unread host warns on its PR", () => {
  const remoteOwner = pr({ judgment: { verdict: "ready", reason: "Done", at: "2026-11-24T01:00:00.000Z", ownerSessionId: "owner", ownerSessionHost: "host-b" } });
  expect(mergeHolds([remoteOwner], { sessions: [], peers: { rows: [], read: new Set() } }).get(key)).toBe("unverified");
  expect(mergeHolds([remoteOwner], { sessions: [], peers: { rows: [], read: new Set(["host-b"]) } }).has(key)).toBe(false);
  expect(mergeHolds([remoteOwner], { sessions: [], peers: { rows: [session(true, { id: "owner", workspacePull: nextUnit })], read: new Set(["host-b"]) } }).get(key)).toBe("elsewhere");
});

test("only PRs that would be merge cards are considered", () => {
  expect(mergeHolds([pr({ lane: "progress", gate: "awaiting" })], { sessions: [session(true)] }).size).toBe(0);
  expect(mergeHolds([pr({ lane: "progress", reason: "checks-failed", gate: undefined })], { sessions: [session(true)] }).size).toBe(0);
});

test("the same rule applies when merge cards follow GitHub status only", () => {
  expect(mergeHolds([pr({ gate: "github" })], { sessions: [session(true)] }).get(key)).toBe("running");
});

test("a session on an offline or hidden host warns on its PR, because the board never reads that host", () => {
  // The board read host-b only. host-off is offline, so it is not among the hosts the board polls at all.
  const read = new Set(["host-b"]);
  const remoteOwner = pr({ judgment: { verdict: "ready", reason: "Done", at: "2026-11-24T01:00:00.000Z", ownerSessionId: "owner", ownerSessionHost: "host-off" } });
  expect(mergeHolds([remoteOwner], { sessions: [], peers: { rows: [], read } }).get(key)).toBe("unverified");
  expect(mergeHolds([pr()], { sessions: [], peers: { rows: [], read }, links: [link({ hosts: ["host-off"] })] }).get(key)).toBe("unverified");
  // Without host data (the decision count), nothing is claimed about other hosts.
  expect(mergeHolds([remoteOwner], { sessions: [] }).has(key)).toBe(false);
});

test("a ledger card keeps pointing at a host the board cannot reach now", () => {
  const here = { hostId: "here", hostLabel: "Desk" };
  expect(linkedHosts({ kind: "remote", hosts: [{ serverId: "host-b" }, { serverId: "host-c" }] }, undefined, here)).toEqual(["host-b", "host-c"]);
  expect(linkedHosts({ kind: "unavailable" }, "host-off", here)).toEqual(["host-off"]);
  expect(linkedHosts({ kind: "unavailable" }, "here", here)).toBeUndefined();
  expect(linkedHosts({ kind: "unavailable" }, "desk", here)).toBeUndefined();
  expect(linkedHosts({ kind: "unavailable" }, null, here)).toBeUndefined();
  expect(linkedHosts({ kind: "local" }, "host-off", here)).toBeUndefined();
});

test("the elsewhere exemption covers only the session seen on another branch", () => {
  // The local ledger session works on the next unit elsewhere; the coordinator's remote owner was not seen at all.
  const both = pr({ judgment: { verdict: "ready", reason: "Done", at: "2026-11-24T01:00:00.000Z", ownerSessionId: "remote-owner", ownerSessionHost: "host-b" } });
  const detail = mergeHoldDetails([both], { sessions: [session(true, { id: "ledger-work", workspacePull: nextUnit })],
    peers: { rows: [], read: new Set(["host-b"]) }, links: [link()] }).get(key);
  expect(detail?.hold).toBe("elsewhere");
  expect([...detail!.elsewhere]).toEqual(["ledger-work"]);
  expect(detail!.elsewhere.has("remote-owner")).toBe(false);
});

test("only an unknown branch or an unread host asks once more before the merge preview", () => {
  expect(asksBeforeMerge("branch-unknown")).toBe(true);
  expect(asksBeforeMerge("unverified")).toBe(true);
  expect(asksBeforeMerge("elsewhere")).toBe(false);
  expect(asksBeforeMerge(undefined)).toBe(false);
});

test("the words come in both languages", () => {
  expect(mergeHoldWords.running).toEqual(["작업 세션 진행 중 · 끝나면 병합 카드로 올라옵니다", "Work session running · Moves to a merge card when it finishes"]);
  expect(mergeHoldWords.elsewhere[0]).toBe("작업 세션이 다른 일을 진행 중입니다.");
  expect(mergeHoldWords.unverified[0]).toBe("작업 세션 상태를 확인하지 못했습니다.");
  for (const words of Object.values(mergeHoldWords)) expect(words[1].length).toBeGreaterThan(0);
});

test("a held PR row lands in the kanban's running column", () => {
  for (const gate of ["judged", "ledger", "github"] as const) expect(pullColumn({ ...pr({ gate }), lane: "progress" })).toBe("running");
});

const row = (lane: SessionRow["lane"], extra: Partial<SessionRow> = {}) => ({
  id: "work", projectId: "project", title: "Work", lane, status: lane === "running" ? "running" : "idle", workspacePull: onBranch, ...extra,
}) as SessionRow;

test("snapshot rows map to running states", () => {
  expect(snapshotHoldSessions([row("running"), row("idle", { id: "rest" })]).map(s => s.running)).toEqual([true, false]);
});

test("the decision count leaves out PRs and ledger merge cards held by a session on the PR branch", () => {
  const ledger = { key: "ledger", kind: "merge", mergeTarget: { repo: "org/example", number: 7 }, matchedPull: { repo: "org/example", number: 7 },
    projectId: "project", sessionId: "work" } as unknown as TrackedDecision;
  const pullRequests = { projects: [], items: [pr()] };
  expect(decisionCount({ sessions: [row("running")], notes: {}, pullRequests })).toBe(0);
  expect(decisionCount({ sessions: [row("idle")], notes: {}, pullRequests })).toBe(1);
  const trackedDecisions = { status: "ok", items: [ledger] } as never;
  const ledgerPulls = { projects: [], items: [pr({ gate: "ledger" })] };
  expect(decisionCount({ sessions: [row("running", { workspacePull: undefined })], notes: {}, pullRequests: ledgerPulls, trackedDecisions })).toBe(1);
  expect(decisionCount({ sessions: [row("running")], notes: {}, pullRequests: ledgerPulls, trackedDecisions })).toBe(0);
  expect(decisionCount({ sessions: [row("running", { workspacePull: nextUnit })], notes: {}, pullRequests: ledgerPulls, trackedDecisions })).toBe(1);
  expect(decisionCount({ sessions: [row("idle")], notes: {}, pullRequests: ledgerPulls, trackedDecisions })).toBe(1);
});

test("one placement decides ledger merge cards and PR rows for the board and the count alike", () => {
  const card = (key: string, number: number, matched = true) => ({ key, kind: "merge", mergeTarget: { repo: "org/example", number },
    ...(matched ? { matchedPull: { repo: "org/example", number } } : {}), projectId: "project", sessionId: key + "-work" }) as unknown as TrackedDecision;
  const running = card("running", 7), resting = card("resting", 8), notReady = card("not-ready", 9, false);
  const items = [pr({ gate: "ledger" }), pr({ number: 8, gate: "ledger", headBranch: "feat/other", url: "https://github.com/org/example/pull/8" }),
    pr({ number: 9, lane: "progress", reason: "checks-pending", gate: undefined, url: "https://github.com/org/example/pull/9" })];
  const view = { projects: [{ projectId: "project", repo: "org/example", mode: "auto" as const, status: "ok" as const }], items };
  const sessions = [row("running", { id: "running-work", workspacePull: undefined }), row("idle", { id: "resting-work", workspacePull: undefined })];
  // The ledger card's session works on the PR branch only when its workspace says so.
  const onPr = [{ ...sessions[0], workspacePull: onBranch }, sessions[1]];
  const holds = mergeHolds(items, { sessions: snapshotHoldSessions(onPr), links: mergeRecordLinks([running, resting, notReady]) });
  const placed = placeMergeCards([running, resting, notReady], view, holds);
  expect([...placed.held]).toEqual(["running"]);
  expect(placed.deciding.map(item => item.key)).toEqual(["resting"]);
  expect([...placed.waiting.keys()]).toEqual(["not-ready"]);
  expect(decidesNow(running, view, holds)).toBe(false);
  expect(decidesNow(resting, view, holds)).toBe(true);
  expect(items.filter(item => pullDecidesNow(item, holds)).map(item => item.number)).toEqual([8]);
  // The count sees the same: one ledger card (its PR row is covered by the card).
  const trackedDecisions = { status: "ok", items: [running, resting, notReady] } as never;
  expect(decisionCount({ sessions: onPr, notes: {}, pullRequests: view, trackedDecisions })).toBe(placed.deciding.length);
});

test("the board's small helpers: the remote exemption and the kanban row", () => {
  const details = mergeHoldDetails([owned()], { sessions: [session(true, { id: "owner", workspacePull: nextUnit })] });
  expect(seenElsewhere(details, pr(), "owner")).toBe(true);
  expect(seenElsewhere(details, pr(), "someone-else")).toBe(false);
  expect(seenElsewhere(details, pr(), undefined)).toBe(false);
  const holds = mergeHolds([pr()], { sessions: [session(true)] });
  expect(kanbanPull(pr(), holds).lane).toBe("progress");
  expect(kanbanPull(pr({ number: 8 }), holds).lane).toBe("review");
});
