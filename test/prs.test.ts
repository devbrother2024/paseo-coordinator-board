import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPullRequests, githubRepository, mergeabilityRetry, parseOpenPull, parseOpenPulls, pullLookupFailure } from "../server/prs";
import { pullRequestViewSchema, readPullLifecycle, setProjectRepository } from "../shared/prs";
import { PreferenceStore } from "../server/preferences";

const paths: string[] = [];
afterEach(() => {for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true});});
const raw = (number=1,extra={}) => ({
  number, title:"Sample #"+number, state:"OPEN", updatedAt:"2026-11-22T02:00:00Z", isDraft:false,
  mergeable:"MERGEABLE", mergeStateStatus:"CLEAN", reviewDecision:"", checks:[], autoMerge:false,
  ...extra,
});
const page = (entries:unknown[]) => ({entries,pageInfo:{hasMore:false,nextCursor:null}});
function fixture(ids = ["root","checkout","runtime"], lookupLifecycle?: ConstructorParameters<typeof ProjectPullRequests>[3]) {
  const dir = mkdtempSync(join(tmpdir(),"project-prs-"));paths.push(dir);
  const store = new PreferenceStore(join(dir,"prefs.json"));
  store.change(s=>{s.projects=ids;});
  const roots = new Map([["root","/primary"],["checkout","/missing"],["runtime","/missing-runtime"],["unselected","/ignored"]]);
  const spaces = new Map([
    ["checkout",[{projectId:"checkout", workspaceDirectory:"/checkout",project:{checkout:{cwd:"/checkout"}}}]],
    ["runtime",[{projectId:"runtime", workspaceDirectory:"/missing-runtime",gitRuntime:{remoteUrl:"git@github.com:org/Other.git"}}]],
    ["unselected",[{projectId:"unselected",workspaceDirectory:"/ignored"}]],
  ]);
  const log={local:[] as string[],gh:[] as string[],single:[] as string[],lookups:[] as string[],native:0,active:0,max:0,invalidated:0};
  let now=0;
  const behavior={fail:false, delay:async (_repo:string)=>{}, beforeOrigin:async (_path:string)=>{}, after:()=>{}, rows:[raw()],
    single:new Map<number,unknown>() as Map<number,unknown>, singleFail:false};
  const sdk={
    projects:{list:async()=>{log.native++;return {projects:[...roots].map(([projectId,projectRootPath])=>({projectId,projectRootPath}))};}},
    workspaces:{list:async ({filter})=>{log.lookups.push(filter.projectId);return page(spaces.get(filter.projectId)??[]);}},
  };
  const deps={now:()=>now,localOrigin:async p=>{log.local.push(p);await behavior.beforeOrigin(p);return ["/primary","/checkout"].includes(p)?"org/example":null;},
    githubPulls:async repo=>{
      log.gh.push(repo);log.active++;log.max=Math.max(log.max,log.active);
      try{await behavior.delay(repo);behavior.after();if(behavior.fail)throw Error("private host error");return parseOpenPulls(repo,JSON.stringify(behavior.rows));}finally{log.active--;}
    },
    githubPull:async (repo:string,number:number)=>{
      log.single.push(repo+"#"+number);log.active++;log.max=Math.max(log.max,log.active);
      try{await behavior.delay(repo);if(behavior.singleFail)throw Error("private host error");return parseOpenPull(repo,JSON.stringify(behavior.single.get(number)??raw(number)));}finally{log.active--;}
    }};
  const prs=new ProjectPullRequests(store,deps,undefined,lookupLifecycle);
  let onMapping, onLifecycle;
  prs.register({handle:(rpc,fn)=>{if(rpc.name===setProjectRepository.name)onMapping=fn; if(rpc.name===readPullLifecycle.name)onLifecycle=fn;}},()=>{log.invalidated++;});
  const update=(input)=>onMapping(setProjectRepository.input.parse(input));
  const read=(refresh=false)=>prs.read(sdk,{refresh});
  const lifecycle = (input) => onLifecycle(readPullLifecycle.input.parse(input), {paseo:sdk});
  return {store,sdk,read,log,behavior,roots,spaces,update,lifecycle,service:prs,tick:n=>{now+=n;}};
}
test("GitHub remotes normalize one owner/repo and reject credentials, extra components and shell input",()=>{
  for(const remote of ["https://github.com/Dev-Team/Repo.git","ssh://git@github.com/Dev-Team/Repo","git@github.com:Dev-Team/Repo.git"])
    expect(githubRepository(remote)).toBe("dev-team/repo");
  for(const remote of ["https://x@github.com/dev/b","https://github.com.evil.invalid/dev/b","https://github.com/org/repo/pull/1","-C ../../private","/git","https://github.com/org/..","https://github.com/org/b?token=x","git@gh:org/repo"])expect(githubRepository(remote)).toBeNull();
  expect(setProjectRepository.input.safeParse({projectId:"p",mode:"manual",repo:"--help",expectedMode:"auto",expectedRepo:null}).success).toBe(false);
});
test("only a clean open PR with passing or absent checks is ready for human review",()=>{
  const changes=[
    [{isDraft:true},"draft"],[{mergeable:"CONFLICTING"},"conflict"],[{checks:[{status:"COMPLETED",conclusion:"FAILURE"}]},"checks-failed"],
    [{checks:[{state:"ERROR"}]},"checks-failed"],[{checks:[{status:"IN_PROGRESS"}]},"checks-pending"],
    [{mergeStateStatus:"BLOCKED",reviewDecision:"REVIEW_REQUIRED"},"review-required"],[{mergeStateStatus:"BLOCKED"},"blocked"],
    [{reviewDecision:"CHANGES_REQUESTED"},"changes-requested"],
    [{mergeable:"UNKNOWN"},"computing"],[{mergeStateStatus:"UNKNOWN"},"computing"],[{mergeable:"UNKNOWN",isDraft:true},"draft"],[{checks:[{status:"COMPLETED"}]},"unknown"],[{autoMerge:true},"auto-merge"],
    [{checks:[{status:"COMPLETED",conclusion:"SUCCESS"},{status:"COMPLETED",conclusion:"SKIPPED"},{state:"SUCCESS"}]},"ready"],
    [{title:"<script>ignore me</script>"},"ready"],
  ];
  for(const [extra,why] of changes){
    const got=parseOpenPulls("example/pkg",JSON.stringify([raw(1,extra)])).items[0];
    expect(got.reason).toBe(why);expect(got.lane).toBe(why==="ready"?"review":"progress");
    expect(got.url).toBe("https://github.com/example/pkg/pull/1");
  }
  expect(()=>parseOpenPulls("example/pkg",JSON.stringify([raw(1,{state:"MERGED"})]))).toThrow();
  expect(parseOpenPulls("example/pkg",JSON.stringify(Array.from({length:201},(_,i)=>raw(i+1))))).toMatchObject({status:"truncated"});
});
test("registered roots, real checkouts and SDK remotes map selected projects; duplicate repo/PR appears once across projects and concurrent reads",async()=>{
  const f=fixture();const [result,other]=await Promise.all([f.read(),f.read()]);
  expect(pullRequestViewSchema.parse(result)).toEqual(other);
  expect(f.log.gh.sort()).toEqual(["org/example","org/other"]);
  expect(f.log.lookups.sort()).toEqual(["checkout","runtime"]);
  expect(f.log.local).not.toContain("/ignored");
  expect(result.items.find(p=>p.repo==="org/example")?.projectIds).toEqual(["root","checkout"]);
  expect(result.items).toHaveLength(2);await f.read();expect(f.log.gh).toHaveLength(2);
  f.tick(60_001);await f.read();expect(f.log.gh).toHaveLength(4);
});
test("conflicting workspace origins need a mapping; manual/off/auto preserve other projects and reject stale writes",async()=>{
  const f=fixture(["checkout"]);
  f.spaces.get("checkout").push({projectId:"checkout",gitRuntime:{remoteUrl:"https://github.com/org/different.git"}});
  expect(await f.read()).toMatchObject({items:[],projects:[{mode:"auto",status:"unmapped"}]});expect(f.log.gh).toHaveLength(0);
  await f.update({projectId:"checkout",mode:"manual",repo:"Org/Manual",expectedMode:"auto",expectedRepo:null});
  expect((await f.read()).items[0].repo).toBe("org/manual");
  await expect(f.update({projectId:"unselected",mode:"off",expectedMode:"auto",expectedRepo:null})).rejects.toThrow();
  await expect(f.update({projectId:"checkout",mode:"off",expectedMode:"manual",expectedRepo:"org/old"})).rejects.toThrow();
  await f.update({projectId:"checkout",mode:"off",expectedMode:"manual",expectedRepo:"org/manual"});
  expect(await f.read()).toMatchObject({items:[],projects:[{mode:"off",status:"off",repo:null}]});
  await f.update({projectId:"checkout",mode:"auto",expectedMode:"off",expectedRepo:null});
  expect((await f.read()).projects[0].status).toBe("unmapped");
});
test("gh errors, empty selection, and deselection during a pending lookup never yield a misleading ready card",async()=>{
  const f=fixture(["root"]);f.behavior.fail=true;
  expect(await f.read()).toMatchObject({items:[],projects:[{status:"unavailable"}]});
  f.behavior.fail=false;f.tick(15_001);
  f.behavior.after=()=>f.store.change(s=>{s.projects=[]});
  expect(await f.read()).toEqual({items:[],projects:[]});
  const calls=f.log.native;await f.read();expect(f.log.native).toBe(calls);
});
test("repository fetches observe the same host-wide concurrency cap across two open board screens",async()=>{
  const ids=Array.from({length:9},(_,i)=>"project"+i);
  const f=fixture(ids);
  f.store.change(s=>{for(const id of ids)s.projectRepositories[id]={mode:"manual",repo:"test/"+id};});
  f.behavior.delay=async()=>{await new Promise(resolve=>setTimeout(resolve,3));};
  await Promise.all([f.read(),f.read()]);expect(f.log.max).toBe(3);expect(f.log.gh).toHaveLength(9);
});

test("tracked PR lifecycle reads distinguish merged, closed, open and unavailable outside the open-PR list", async () => {
  const target = {repo:"org/example",number:170,projectId:"root"};
  for (const state of ["MERGED", "CLOSED", "OPEN"] as const) {
    const f = fixture(["root"], async input => { expect(input).toEqual(target); return state; });
    expect(await f.lifecycle(target)).toEqual({state});
  }
  let calls = 0;
  const f = fixture(["root"], async () => { calls++; throw Error("offline"); });
  expect(await f.lifecycle(target)).toEqual({state:"UNKNOWN",why:"lookup-failed"});
  expect(await f.lifecycle({...target,repo:"other/repo"})).toEqual({state:"UNKNOWN",why:"scope"});
  expect(await f.lifecycle({...target,projectId:"unselected"})).toEqual({state:"UNKNOWN",why:"scope"});
  expect(calls).toBe(1);
  const moving = fixture(["root"], async () => { moving.store.change(s => {s.projects=[];}); return "MERGED"; });
  expect(await moving.lifecycle(target)).toEqual({state:"UNKNOWN",why:"scope"});
});

test("read-only PR references reuse the current repository cache and keep merge status behavior", async () => {
  const target = { repo: "org/example", projectId: "root", number: 1 };
  const lookedUp: number[] = [];
  const f = fixture(["root"], async ({number}) => {
    lookedUp.push(number);
    return number === 1 ? "DRAFT" : number === 3 ? "CLOSED" : "MERGED";
  });
  f.behavior.rows = [raw(1, { isDraft: true }), raw(2)];
  await f.read();
  expect(await f.lifecycle({...target, reference:true})).toEqual({state:"DRAFT"});
  expect(await f.lifecycle({...target, number:2, reference:true})).toEqual({state:"OPEN"});
  expect(await f.lifecycle({...target, repo:"org/other", reference:true})).toEqual({state:"UNKNOWN",why:"scope"});
  expect(lookedUp).toEqual([]);
  expect(await f.lifecycle({...target, number:3, reference:true})).toEqual({state:"CLOSED"});
  expect(await f.lifecycle({...target, number:4, reference:true})).toEqual({state:"MERGED"});
  expect(await f.lifecycle(target)).toEqual({state:"OPEN"});
  expect(lookedUp).toEqual([3,4,1]);
  f.tick(60_001);
  await f.lifecycle({...target, reference:true});
  expect(lookedUp).toEqual([3,4,1,1]);
});


test("a known repository starts loading while another project is still resolving its origin", async () => {
  const f = fixture(["checkout", "root"]);
  let searching!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { searching = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.behavior.beforeOrigin = async path => {
    if (path === "/checkout") { searching(); await gate; }
  };
  const result = f.read(true);
  try {
    await started;
    await new Promise(resolve => setImmediate(resolve));
    expect(f.log.gh).toEqual(["org/example"]);
  } finally {
    release();
    await result;
  }
  // Both auto-mappings point to the same repo. Preserve the user's order and
  // avoid a second forced refresh after the earlier GitHub query completed.
  expect((await result).items[0].projectIds).toEqual(["checkout", "root"]);
  expect(f.log.gh).toEqual(["org/example"]);
});


test("queued lookups respect revocation and a later authorized mapping can still load the same repo", async () => {
  const blockers = ["one", "two", "three"];
  const f = fixture([...blockers, "revoked", "removed", "checkout"]);
  f.store.change(scope => {
    for (const id of blockers) scope.projectRepositories[id] = {mode:"manual",repo:"org/"+id};
    scope.projectRepositories.revoked = {mode:"manual",repo:"org/example"};
    scope.projectRepositories.removed = {mode:"manual",repo:"org/removed"};
  });
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const full = new Promise<void>(resolve => { started = resolve; });
  f.behavior.delay = async repo => {
    if (!blockers.includes(repo.slice(4))) return;
    if (f.log.active === 3) started();
    await held;
  };
  const read = f.read(true);
  await full;
  f.store.change(scope => { scope.projects = [...blockers, "checkout"]; });
  release();
  const result = await read;
  expect(f.log.gh).not.toContain("org/removed");
  expect(f.log.gh.filter(repo => repo === "org/example")).toHaveLength(1);
  expect(result.items.find(p => p.repo === "org/example")?.projectIds).toEqual(["checkout"]);
  expect(result.projects.map(p => p.projectId)).toEqual([...blockers,"checkout"]);
  expect(f.log.max).toBe(3);
});

test("conflicting workspace remotes avoid unnecessary git probes of other checkout paths", async () => {
  const f = fixture(["checkout"]);
  f.spaces.get("checkout").push(
    {projectId:"checkout",gitRuntime:{remoteUrl:"https://github.com/org/first.git"}},
    {projectId:"checkout",gitRuntime:{remoteUrl:"https://github.com/org/second.git"}},
  );
  const result = await f.read();
  expect(result.projects[0].status).toBe("unmapped");
  expect(f.log.local).toEqual(["/missing"]);
  expect(f.log.gh).toBeEmpty();
});

test("open PRs carry the head commit only when GitHub reports a full SHA", () => {
  const sha = "f".repeat(40);
  const {items} = parseOpenPulls("org/example", JSON.stringify([raw(1,{headSha:sha}), raw(2,{headSha:"abc"}), raw(3)]));
  expect(items.map(item => item.headSha)).toEqual([sha, undefined, undefined]);
  expect(pullRequestViewSchema.parse({items:items.map(item => ({...item, projectIds:["root"]})), projects:[]}).items[0].headSha).toBe(sha);
});

test("a PR GitHub has not finished computing is asked once more on its own and becomes ready", async () => {
  const f = fixture(["root"]);
  f.behavior.rows = [raw(1,{mergeable:"UNKNOWN",mergeStateStatus:"UNKNOWN"}), raw(2,{mergeable:"UNKNOWN",isDraft:true}), raw(3)];
  const view = await f.read();
  expect(f.log.single).toEqual(["org/example#1"]);
  expect(view.items.map(p => [p.number,p.reason,p.lane])).toEqual([[3,"ready","review"],[2,"draft","progress"],[1,"ready","review"]]);
  // The answer holds while the cached list still says UNKNOWN.
  await f.read();
  expect(f.log.single).toHaveLength(1);
});

test("a PR still computing shows that, retries a few times, then reads as unknown", async () => {
  const f = fixture(["root"]);
  const pending = raw(1,{mergeable:"UNKNOWN",mergeStateStatus:"UNKNOWN"});
  f.behavior.rows = [pending]; f.behavior.single.set(1,pending);
  const reasons: string[] = [];
  for (let round = 0; round < mergeabilityRetry.attempts + 1; round++) {
    reasons.push((await f.read()).items[0].reason);
    f.tick(mergeabilityRetry.retryMs);
  }
  expect(f.log.single).toHaveLength(mergeabilityRetry.attempts);
  expect(reasons).toEqual([...Array(mergeabilityRetry.attempts - 1).fill("computing"), "unknown", "unknown"]);
  expect((await f.read()).items[0].detail).toBe("still-computing");
  // No extra GitHub calls until the rest period passes.
  expect(f.log.single).toHaveLength(mergeabilityRetry.attempts);
  f.tick(mergeabilityRetry.restMs);
  f.behavior.single.set(1, raw(1));
  expect((await f.read()).items[0].reason).toBe("ready");
});

test("a failed single lookup reads as unknown, not as computing", async () => {
  const f = fixture(["root"]);
  f.behavior.rows = [raw(1,{mergeable:"UNKNOWN"})]; f.behavior.singleFail = true;
  expect((await f.read()).items[0]).toMatchObject({reason:"unknown",lane:"progress",detail:"lookup-failed"});
  // A PR that closed between the list and the single read is not reported as open and ready.
  const g = fixture(["root"]);
  g.behavior.rows = [raw(1,{mergeable:"UNKNOWN"})]; g.behavior.single.set(1, raw(1,{state:"MERGED"}));
  expect((await g.read()).items[0]).toMatchObject({reason:"unknown",detail:"closed"});
});

test("single lookups are capped per read and share the host-wide concurrency limit", async () => {
  const f = fixture(["root"]);
  f.behavior.rows = Array.from({length:8},(_,i)=>raw(i+1,{mergeable:"UNKNOWN"}));
  f.behavior.delay = async () => { await new Promise(resolve => setTimeout(resolve,3)); };
  const first = await f.read();
  expect(f.log.single).toHaveLength(mergeabilityRetry.perRead);
  expect(f.log.max).toBeLessThanOrEqual(3);
  expect(first.items.filter(p => p.reason === "ready")).toHaveLength(mergeabilityRetry.perRead);
  expect(first.items.filter(p => p.reason === "computing")).toHaveLength(8 - mergeabilityRetry.perRead);
  await f.read();
  expect(f.log.single).toHaveLength(mergeabilityRetry.perRead * 2);
});

test("a single lookup that sees a newer head keeps that head for the merge check", async () => {
  const f = fixture(["root"]);
  f.behavior.rows = [raw(1,{mergeable:"UNKNOWN",headSha:"a".repeat(40)})];
  f.behavior.single.set(1, raw(1,{headSha:"b".repeat(40),title:"Newer"}));
  expect((await f.read()).items[0]).toMatchObject({reason:"ready",headSha:"b".repeat(40),title:"Newer"});
});

test("a status-unknown PR carries why, and failed GitHub reads keep only a fixed reason", () => {
  const detail = (extra: Record<string, unknown>) => parseOpenPulls("example/pkg", JSON.stringify([raw(1, extra)])).items[0].detail;
  expect(detail({checks:[{status:"COMPLETED"}]})).toBe("check-result");
  expect(detail({reviewDecision:"SOMETHING_NEW"})).toBe("review-state");
  expect(detail({mergeable:"MERGEABLE",mergeStateStatus:"SOMETHING_NEW"})).toBe("merge-state");
  expect(detail({})).toBeUndefined();
  expect(pullLookupFailure(Object.assign(Error("spawn gh ENOENT"), {code:"ENOENT"}))).toBe("gh-missing");
  expect(pullLookupFailure({killed:true, signal:"SIGTERM", message:"Command failed"})).toBe("timeout");
  expect(pullLookupFailure({stderr:"To get started with GitHub CLI, please run:  gh auth login"})).toBe("gh-auth");
  expect(pullLookupFailure({stderr:"error connecting to api.github.com: could not resolve host"})).toBe("network");
  expect(pullLookupFailure(Error("/home/someone/secret path failed"))).toBe("lookup-failed");
});

test("a repository whose PR list cannot be read reports why", async () => {
  const f = fixture(["root"]);
  f.behavior.fail = true;
  expect((await f.read()).projects[0]).toMatchObject({status:"unavailable", failure:"lookup-failed"});
});

test("merged or closed merge-card PRs are confirmed in the background without slowing a read", async () => {
  const states = new Map<number,string>([[1,"MERGED"],[2,"CLOSED"],[3,"OPEN"]]);
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  const asked: number[] = [];
  const f = fixture(["root"], async ({number}) => { asked.push(number); await gate; return states.get(number) as never; });
  const targets = [1,2,3,4].map(number => ({repo:"org/example", number, projectId:"root"}));
  const read = () => f.service.settledStates(f.sdk, targets, (_repo: string, number: number) => number === 4 ? {state:"MERGED", at:"2026-11-25T00:00:00.000Z"} : undefined);
  // The board's own merge record answers at once; nothing else is known yet and the read does not wait.
  expect([...read().entries()]).toEqual([["org/example#4", {state:"MERGED", at:"2026-11-25T00:00:00.000Z"}]]);
  release();
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = read();
  expect(second.get("org/example#1")?.state).toBe("MERGED");
  expect(second.get("org/example#2")?.state).toBe("CLOSED");
  expect(second.has("org/example#3")).toBe(false);
  // Each confirmed merge or close refreshes the board count.
  expect(f.log.invalidated).toBe(2);
  // Final answers are kept; an open PR is asked again only after a minute.
  expect(asked.sort()).toEqual([1,2,3]);
  read(); expect(asked).toHaveLength(3);
  f.tick(60_001); read(); await new Promise(resolve => setTimeout(resolve, 5));
  expect(asked).toEqual([1,2,3,3]);
});

test("a slow single read does not hold up the board: this read says computing, a later read uses the answer", async () => {
  const { MergeabilityChecks } = await import("../server/pull-mergeability");
  let release = () => {};
  const slow = new Promise<void>(resolve => { release = resolve; });
  const reads: number[] = [];
  const checks = new MergeabilityChecks(async (repo, number) => { reads.push(number); await slow; return parseOpenPull(repo, JSON.stringify(raw(number))); },
    () => 0, { ...mergeabilityRetry, waitMs: 5 }, () => "lookup-failed");
  const pending = parseOpenPulls("org/example", JSON.stringify([raw(1,{mergeable:"UNKNOWN"})])).items;
  const run = <T,>(task: () => Promise<T>) => task();
  const started = Date.now();
  expect((await checks.apply([{items:pending, allowed:() => true}], run, 3))[0][0].reason).toBe("computing");
  expect(Date.now() - started).toBeLessThan(1_000);
  // Another read while it is still running neither waits long nor asks GitHub again.
  expect((await checks.apply([{items:pending, allowed:() => true}], run, 3))[0][0].reason).toBe("computing");
  release(); await slow; await new Promise(resolve => setTimeout(resolve, 0));
  expect((await checks.apply([{items:pending, allowed:() => true}], run, 3))[0][0].reason).toBe("ready");
  expect(reads).toEqual([1]);
});

test("PRs never answered go before refreshing answered ones, so no PR starves under steady polling", async () => {
  const f = fixture(["root"]);
  f.behavior.rows = Array.from({length:8},(_,i)=>raw(i+1,{mergeable:"UNKNOWN"}));
  for (let poll = 0; poll < 4; poll++) { await f.read(); f.tick(30_000); }
  // Eight PRs, three single reads per poll: the first three polls cover all eight before any refresh.
  expect(new Set(f.log.single).size).toBe(8);
  expect(f.log.single.slice(0, 8).sort()).toEqual(Array.from({length:8},(_,i)=>"org/example#"+(i+1)).sort());
});

test("a closed answer is dropped when the PR shows up open again, and rechecked after a while", async () => {
  const states = new Map<number,string>([[1,"CLOSED"]]);
  const asked: number[] = [];
  const f = fixture(["root"], async ({number}) => { asked.push(number); return states.get(number) as never; });
  const target = [{repo:"org/example", number:1, projectId:"root"}];
  const read = () => f.service.settledStates(f.sdk, target, () => undefined);
  read(); await new Promise(resolve => setTimeout(resolve, 0));
  expect(read().get("org/example#1")?.state).toBe("CLOSED");
  // It reopens: the open list shows it, so the closed answer goes.
  f.behavior.rows = [raw(1)];
  f.tick(60_001); await f.read();
  states.set(1, "MERGED");
  expect(read().has("org/example#1")).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(read().get("org/example#1")?.state).toBe("MERGED");
  // A closed answer the board never sees reopen is still asked again after ten minutes.
  states.set(2, "CLOSED");
  const second = [{repo:"org/example", number:2, projectId:"root"}];
  const readSecond = () => f.service.settledStates(f.sdk, second, () => undefined);
  readSecond(); await new Promise(resolve => setTimeout(resolve, 0));
  const before = asked.length;
  expect(readSecond().get("org/example#2")?.state).toBe("CLOSED");
  expect(asked.length).toBe(before);
  f.tick(10 * 60_000 + 1);
  // The old answer stays while the recheck runs in the background.
  expect(readSecond().get("org/example#2")?.state).toBe("CLOSED");
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(asked.length).toBe(before + 1);
});

test("the single-read budget goes to unanswered PRs across all repositories before any refresh", async () => {
  const f = fixture(["root","runtime"]);
  f.store.change(s => { s.projectRepositories.root = {mode:"manual",repo:"org/first"}; s.projectRepositories.runtime = {mode:"manual",repo:"org/second"}; });
  const rows = new Map([["org/first", Array.from({length:6},(_,i)=>raw(i+1,{mergeable:"UNKNOWN"}))], ["org/second", [raw(1,{mergeable:"UNKNOWN"})]]]);
  f.behavior.rows = [];
  const deps = (f.service as any).deps;
  deps.githubPulls = async (repo: string) => parseOpenPulls(repo, JSON.stringify(rows.get(repo) ?? []));
  for (let poll = 0; poll < 10; poll++) { await f.read(); f.tick(30_000); }
  expect(f.log.single).toContain("org/second#1");
  // All seven PRs were asked before any answered one was refreshed.
  expect(new Set(f.log.single.slice(0, 7)).size).toBe(7);
});
