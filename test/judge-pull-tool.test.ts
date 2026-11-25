import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreferenceStore } from "../server/preferences";
import { judgedMergeCardOptions, judgePullTool, registerMergeJudgmentSettings } from "../server/pull-judgments";
import { mergeJudgmentSettings, setMergeJudgment, type PullRequestItem } from "../shared/prs";
import { ownerHostCandidates, type OwnerHint } from "../server/remote-owner";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const head = "a".repeat(40);
const newer = "b".repeat(40);
const pull = (extra: Partial<PullRequestItem> = {}): PullRequestItem => ({
  repo: "example/book", number: 9, title: "Sample", url: "https://github.com/example/book/pull/9",
  headRepo: "example/book", headBranch: "topic", headSha: head,
  projectIds: ["book"], lane: "review", reason: "ready", updatedAt: "2026-11-24T00:00:00Z", ...extra,
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "judge-board-pull-"));
  scratch.push(dir);
  const prefs = new PreferenceStore(join(dir, "scope.json"));
  prefs.change(s => { s.projects = ["book"]; s.coordinator = "coord"; });
  const state = { cached: [pull()], fresh: [pull()], reads: [] as boolean[], invalidations: 0, worker: "running" };
  const page = (entries: unknown[]) => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });
  const sdk = {
    workspaces: { list: async () => page([]) },
    agents: {
      list: async () => page(["coord", "worker"].map(id => ({
        agent: { id, title: id, status: id === "worker" ? state.worker : "idle", updatedAt: "2026-11-24T00:01:00Z", pendingPermissions: [] },
        project: { projectKey: "book" },
        ...(id === "worker" ? { workspace: { id: "w", gitRuntime: { currentBranch: "topic", remoteUrl: "git@github.com:example/book.git" } } } : {}),
      }))),
    },
  };
  const reader = { read: async (_paseo: unknown, options: { refresh?: boolean } = {}) => {
    state.reads.push(!!options.refresh);
    return { items: options.refresh ? state.fresh : state.cached, projects: [] };
  } };
  const remote = { hints: [] as OwnerHint[], reads: [] as string[], repos: new Map<string, string[] | null>(),
    hosts: [{ id: "local-host", label: "This desk", local: true, resolved: true }, { id: "peer-a", label: "Review desk", local: false, resolved: true }] };
  const tool = judgePullTool(prefs, reader as never, () => { state.invalidations++; }, () => new Date("2026-11-24T02:00:00Z"), {
    hints: () => remote.hints,
    deps: () => ({ hosts: async () => remote.hosts, read: async (host, id) => { remote.reads.push(host + "/" + id); return remote.repos.get(host + "/" + id) ?? null; } }),
  });
  const run = async (input: Record<string, unknown> = {}, caller = "coord") =>
    (await tool.execute(tool.input.parse(input), { paseo: sdk, agent: { id: caller } } as never)).text;
  return { dir, prefs, state, run, remote };
}
const verdict = { repo: "example/book", number: 9, headSha: head, verdict: "needs-changes", reason: "Address the‮ review\ncomments" };

test("without input the coordinator lists open PRs with heads and verdicts", async () => {
  const f = fixture();
  const listed = JSON.parse(await f.run());
  expect(listed).toEqual([{ repo: "example/book", number: 9, title: "Sample", headSha: head, github: "ready", verdict: null, workSessions: expect.any(Array) }]);
  await f.run(verdict);
  expect(JSON.parse(await f.run())[0].verdict).toEqual({ verdict: "needs-changes", reason: "Address the review comments", current: true });
  f.state.cached = [pull({ headSha: newer })];
  expect(JSON.parse(await f.run())[0].verdict.current).toBe(false);
});

test("a verdict is stored against the PR head, sanitized and owner-only", async () => {
  const f = fixture();
  expect(await f.run(verdict)).toContain("project progress");
  const saved = f.prefs.read().pullJudgments["example/book#9"];
  expect(saved).toEqual({ repo: "example/book", number: 9, headSha: head, verdict: "needs-changes",
    reason: "Address the review comments", at: "2026-11-24T02:00:00.000Z", coordinator: "coord" });
  expect(f.state.invalidations).toBe(1);
  if (process.platform !== "win32") expect(statSync(join(f.dir, "scope.json")).mode & 0o777).toBe(0o600);
  await expect(f.run(verdict, "worker")).rejects.toThrow();
  expect(await f.run({ ...verdict, verdict: "ready", reason: "Checks pass and comments addressed", ownerSessionId: "worker" })).toContain("merge card");
  expect(f.prefs.read().pullJudgments["example/book#9"]).toMatchObject({ verdict: "ready", ownerSessionId: "worker" });
});

test("a verdict on another head is rejected after one fresh GitHub read", async () => {
  const f = fixture();
  f.state.cached = [pull({ headSha: newer })];
  f.state.fresh = [pull({ headSha: newer })];
  await expect(f.run(verdict)).rejects.toThrow(newer);
  expect(f.state.reads).toEqual([false, true]);
  expect(f.prefs.read().pullJudgments).toEqual({});
  // A push the cache has not seen yet is accepted once GitHub confirms it.
  f.state.cached = [pull()];
  f.state.reads = [];
  await f.run({ ...verdict, headSha: newer });
  expect(f.state.reads).toEqual([false, true]);
  expect(f.prefs.read().pullJudgments["example/book#9"].headSha).toBe(newer);
});

test("incomplete input, unknown PRs and unmanaged owners are rejected", async () => {
  const f = fixture();
  await expect(f.run({ repo: "example/book", number: 9 })).rejects.toThrow("Send repo");
  await expect(f.run({ ...verdict, number: 10 })).rejects.toThrow("not an open PR");
  await expect(f.run({ ...verdict, ownerSessionId: "stranger" })).rejects.toThrow("not a managed session");
  expect(() => f.run({ ...verdict, verdict: "merge" })).toThrow();
  expect(f.prefs.read().pullJudgments).toEqual({});
});

test("the setting defaults on, reports the coordinator, and turning it off invalidates the board", async () => {
  const f = fixture();
  expect(judgedMergeCardOptions(f.prefs.read())).toEqual({ enabled: true, coordinator: true });
  expect(judgedMergeCardOptions({ ...f.prefs.read(), coordinator: null })).toEqual({ enabled: true, coordinator: false });
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  let invalidated = 0;
  registerMergeJudgmentSettings({ handle: (rpc: { name: string }, fn: never) => handlers.set(rpc.name, fn) } as never, f.prefs, () => { invalidated++; });
  expect(await handlers.get(mergeJudgmentSettings.name)!({})).toEqual({ enabled: true });
  await handlers.get(setMergeJudgment.name)!({ enabled: false });
  expect(f.prefs.read().judgedMergeCards).toBe(false);
  expect(judgedMergeCardOptions(f.prefs.read()).enabled).toBe(false);
  expect(invalidated).toBe(1);
});

test("a work session on another host can own the PR once that host shows it in the PR's repository", async () => {
  const f = fixture();
  const owned = { ...verdict, verdict: "ready", reason: "Checks pass", ownerSessionId: "far-worker" };
  // No ledger card or assignment names a host: rejected with the reason.
  await expect(f.run(owned)).rejects.toThrow("다른 기기 세션을 확인하지 못했습니다");
  expect(f.remote.reads).toEqual([]);
  // A ledger card names the host, but the session is not there.
  f.remote.hints = [{ sessionHost: "review DESK", projectId: "book", mergeTarget: { repo: "example/book", number: 9 } }];
  await expect(f.run(owned)).rejects.toThrow("could not confirm it as a session on another host");
  // The host has it, but in another repository.
  f.remote.repos.set("peer-a/far-worker", ["example/other"]);
  await expect(f.run(owned)).rejects.toThrow("다른 기기 세션");
  f.remote.repos.set("peer-a/far-worker", ["example/book"]);
  expect(await f.run(owned)).toContain("merge card");
  expect(f.prefs.read().pullJudgments["example/book#9"]).toMatchObject({ ownerSessionId: "far-worker", ownerSessionHost: "peer-a" });
});

test("remote owner candidates come only from cards for this PR or project and from remote assignments", () => {
  const pull = { repo: "example/book", number: 9, projectIds: ["book"] };
  const hosts = [{ id: "local-host", label: "This desk", local: true, resolved: true }, { id: "peer-a", label: "Review desk", local: false, resolved: true },
    { id: "peer-b", label: "Review desk", local: false, resolved: true }, { id: "pending", label: "Pending", local: false, resolved: false }];
  const hint = (extra: Partial<OwnerHint>): OwnerHint => ({ sessionHost: "peer-a", projectId: "book", ...extra });
  expect(ownerHostCandidates("s", pull, [hint({})], {}, hosts)).toEqual(["peer-a"]);
  // A name two hosts share, this host, an unresolved host, another PR or another project gives nothing.
  for (const extra of [{ sessionHost: "review desk" }, { sessionHost: "This desk" }, { sessionHost: "pending" },
    { mergeTarget: { repo: "example/book", number: 10 } }, { projectId: "elsewhere" }]) {
    expect(ownerHostCandidates("s", pull, [hint(extra)], {}, hosts)).toEqual([]);
  }
  const receipt = (remote: boolean, projectId = "book") => ({ s: { fingerprint: "f".repeat(64), projectId, sourceProjectId: projectId, workspaceId: "w",
    location: { serverId: "peer-b", label: "Review desk", reason: "manual", running: null }, remote } }) as never;
  expect(ownerHostCandidates("s", pull, [], receipt(true), hosts)).toEqual(["peer-b"]);
  expect(ownerHostCandidates("s", pull, [], receipt(false), hosts)).toEqual([]);
  expect(ownerHostCandidates("s", pull, [], receipt(true, "elsewhere"), hosts)).toEqual([]);
});
