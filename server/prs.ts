import { execCommand, type PluginHandlerContext, type PluginServerContext } from "@getpaseo/plugin/server";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { commitSha, confirmPullRequestMerge, previewPullRequestMerge, pullLifecycle, pullReason, pullUrl, readPullLifecycle, repositorySlug, setProjectRepository,
  type MergeTarget, type PullDetail, type PullRequestItem, type PullRequestView } from "../shared/prs";
import { mergeHistoryKey, type MergeNotifications } from "./merge-notifications";
import { githubMergeApi, PullMerges } from "./pr-merge";
import { githubRepository } from "../shared/github-repository";
export { githubRepository } from "../shared/github-repository";
import { readPages } from "./discovery";
import { MergeabilityChecks } from "./pull-mergeability";
import { settledKey, type SettledState } from "../shared/merge-card-place";
import type { Preferences, PreferenceStore } from "./preferences";

type Sdk = Pick<PluginHandlerContext["paseo"],"projects"|"workspaces">;
type NativeProject = Awaited<ReturnType<Sdk["projects"]["list"]>>["projects"][number];
type Workspace = Awaited<ReturnType<Sdk["workspaces"]["list"]>>["entries"][number];
type ProjectView = PullRequestView["projects"][number];
type Reason = z.infer<typeof pullReason>;
type Pull = Omit<PullRequestItem,"projectIds">;
type Source = {status:"ok"|"unavailable"|"truncated"; items:Pull[]; failure?:PullDetail};
const scanLimit = 200;
const check = z.object({ status:z.string().nullish(), conclusion:z.string().nullish(), state:z.string().nullish() });
const rawPull = z.object({
  number:z.number().int().positive(), title:z.string(), state:z.literal("OPEN"), updatedAt:z.string().datetime({offset:true}),
  isDraft:z.boolean(), mergeable:z.string().nullable(), mergeStateStatus:z.string().nullable(), reviewDecision:z.string().nullable(),
  headRepo:z.string().nullish(), headBranch:z.string().nullish(), headSha:z.string().nullish(),
  checks:z.array(check), autoMerge:z.boolean(),
});
const fields = "number,title,state,updatedAt,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,autoMergeRequest,headRepository,headRefName,headRefOid";
const row = "{number,title,state,updatedAt,isDraft,mergeable,mergeStateStatus,reviewDecision,headRepo:.headRepository.nameWithOwner,headBranch:.headRefName,headSha:.headRefOid,checks:[.statusCheckRollup[]? | {status,conclusion,state}],autoMerge:(.autoMergeRequest != null)}";
const projection = "[.[] | " + row + "]";
const ttl = 60_000;
// GitHub's PR list can report mergeability as UNKNOWN until someone asks for that PR alone.
// retryMs: wait before asking again. attempts: single reads per round. perRead: single reads one board read may start.
// resolvedMs: how long a single answer stands in for a list that still says UNKNOWN. restMs: pause after a round gives up.
// waitMs: the most a board read waits for a single read before it shows "computing" and lets the read finish later.
export const mergeabilityRetry = { retryMs: 15_000, attempts: 4, perRead: 3, resolvedMs: ttl, restMs: 5 * 60_000, waitMs: 2_000 };

function judge(p: z.output<typeof rawPull>):{reason:Reason; detail?:PullDetail} {
  const why = (reason:Reason, detail?:PullDetail) => detail ? {reason,detail} : {reason};
  if (p.isDraft || p.mergeStateStatus === "DRAFT") return why("draft");
  if (p.mergeable === "CONFLICTING" || p.mergeStateStatus === "DIRTY") return why("conflict");
  const failing = ["FAILURE","ERROR","TIMED_OUT","CANCELLED","ACTION_REQUIRED","STARTUP_FAILURE","STALE"];
  if (p.checks.some(c => failing.includes(c.conclusion || c.state || ""))) return why("checks-failed");
  if (p.reviewDecision === "CHANGES_REQUESTED") return why("changes-requested");
  if (p.checks.some(c => c.status ? c.status !== "COMPLETED" : ["PENDING","EXPECTED"].includes(c.state ?? ""))) return why("checks-pending");
  if (p.autoMerge) return why("auto-merge");
  if (p.reviewDecision === "REVIEW_REQUIRED") return why("review-required");
  if (["BLOCKED","BEHIND","UNSTABLE","HAS_HOOKS"].includes(p.mergeStateStatus ?? "")) return why("blocked");
  const green = ["SUCCESS","NEUTRAL","SKIPPED"];
  if (p.reviewDecision && p.reviewDecision !== "APPROVED") return why("unknown","review-state");
  if (p.checks.some(c => !(c.status === "COMPLETED" && green.includes(c.conclusion ?? "")) && c.state !== "SUCCESS")) return why("unknown","check-result");
  if (p.mergeable === "UNKNOWN" || p.mergeStateStatus === "UNKNOWN") return why("computing");
  return p.mergeable === "MERGEABLE" && p.mergeStateStatus === "CLEAN" ? why("ready") : why("unknown","merge-state");
}

function pullItem(repo:string, p:z.output<typeof rawPull>):Pull {
  const {reason:why, detail} = judge(p);
  const head = repositorySlug.safeParse(p.headRepo);
  const headSha = commitSha.safeParse(p.headSha);
  return {repo, number:p.number, ...(head.success && p.headBranch ? {headRepo:head.data,headBranch:p.headBranch} : {}),
    ...(headSha.success ? {headSha:headSha.data} : {}), title:p.title.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g," ").slice(0,512),
    url:pullUrl(repo,p.number), lane:why==="ready"?"review":"progress",reason:why,...(detail ? {detail} : {}),updatedAt:p.updatedAt};
}

// A short, fixed reason for a failed GitHub read. Raw gh output can carry paths, so it never reaches the screen.
export function pullLookupFailure(error:unknown):PullDetail {
  const failure = error as {code?:unknown; killed?:boolean; signal?:unknown; stderr?:unknown; message?:unknown; pullClosed?:boolean} | null;
  if (failure?.pullClosed) return "closed";
  if (failure?.code === "ENOENT") return "gh-missing";
  const text = [failure?.stderr, failure?.message].filter(value => typeof value === "string").join(" ");
  if (failure?.killed || failure?.signal === "SIGTERM" || failure?.code === "ETIMEDOUT" || /timed? ?out/i.test(text)) return "timeout";
  if (/gh auth login|not logged in|authentication|HTTP 401|bad credentials/i.test(text)) return "gh-auth";
  if (/could not resolve|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|connection/i.test(text)) return "network";
  return "lookup-failed";
}

// One open PR read on its own. A PR that closed in the meantime fails the parse.
export function parseOpenPull(repo:string, json:string):Pull {
  const row:unknown = JSON.parse(json);
  if (row && typeof row === "object" && "state" in row && row.state !== "OPEN") throw Object.assign(Error("Pull request is not open"), {pullClosed:true});
  return pullItem(repo, rawPull.parse(row));
}

export function parseOpenPulls(repo:string, json:string):Source {
  const rows = z.array(rawPull).parse(JSON.parse(json));
  const seen = new Set<number>();
  const items: Pull[] = [];
  for (const p of rows.slice(0,scanLimit)) {
    if (seen.has(p.number)) continue;
    items.push(pullItem(repo,p));
    seen.add(p.number);
  }
  return {items,status:rows.length>scanLimit?"truncated":"ok"};
}

async function run(command:"git"|"gh", args:string[]) {
  const options = {shell:false, timeout:command==="gh"?15_000:3_000, maxBuffer:2*1024*1024,
    env:{...process.env, GH_PROMPT_DISABLED:"1", GH_NO_UPDATE_NOTIFIER:"1", GIT_TERMINAL_PROMPT:"0"}};
  try {return (await execCommand(command,args,options)).stdout;}
  catch(error) {
    if (process.platform !== "darwin" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    for (const directory of ["/opt/homebrew/bin","/usr/local/bin","/usr/bin"]) {
      try {return (await execCommand(join(directory,command),args,options)).stdout;}
      catch (next) { if ((next as NodeJS.ErrnoException).code !== "ENOENT") throw next; }
    }
    throw error;
  }
}

async function localOrigin(path:string):Promise<string|null> {
  if (!isAbsolute(path)) return null;
  try {
    // A nested non-Git folder otherwise inherits a parent repository from git -C.
    const marker = await stat(join(path,".git"));
    if (!marker.isFile() && !marker.isDirectory()) return null;
    return githubRepository(await run("git",["-C",path,"remote","get-url","origin"]));
  } catch { return null; }
}

const githubPulls = async (repo:string) => parseOpenPulls(repo,await run("gh",[
  "pr","list","--repo","github.com/"+repo,"--state","open","--limit",String(scanLimit+1),"--json",fields,"--jq",projection,
]));

const githubPull = async (repo:string, number:number) => parseOpenPull(repo,await run("gh",[
  "pr","view",String(number),"--repo","github.com/"+repo,"--json",fields,"--jq",row,
]));

async function githubLifecycle(target: MergeTarget) {
  const output = await run("gh", ["pr", "view", String(target.number), "--repo", "github.com/" + target.repo, "--json", "state,isDraft,url"]);
  const row = z.object({state:pullLifecycle, isDraft:z.boolean(), url:z.string()}).parse(JSON.parse(output));
  if (row.url.toLowerCase() !== pullUrl(target.repo, target.number)) return "UNKNOWN";
  return row.state === "OPEN" && row.isDraft ? "DRAFT" : row.state;
}

type Mapping = {mode:"auto"|"manual"|"off";repo:string|null};
function mapping(scope:Preferences, id:string):Mapping {
  const saved=Object.hasOwn(scope.projectRepositories,id)?scope.projectRepositories[id]:undefined;
  return {mode:saved?.mode??"auto",repo:saved?.mode==="manual"?saved.repo:null};
}
const equal = (a:Mapping,b:Mapping) => a.mode===b.mode && a.repo===b.repo;

export class ProjectPullRequests {
  private readonly sources = new Map<string,{expires:number; value:Promise<Source|null>}>();
  private readonly discovery = new Map<string,{expires:number; value:Promise<string|null>}>();
  private readonly waiting: (() => void)[] = [];
  private running = 0;
  private readonly mergeability: MergeabilityChecks;
  // Merged is final. Closed can reopen: it is dropped when the PR shows up open again and asked again
  // after ten minutes (the old answer stays meanwhile). Anything else is asked again after a minute.
  private readonly settled = new Map<string, (SettledState & {recheckAt?:number; inflight?:true}) | {retryAt:number; inflight?:true}>();
  private invalidated?: () => void;
  constructor(private store:PreferenceStore,private readonly deps:{localOrigin:typeof localOrigin; githubPulls:typeof githubPulls; githubPull?:typeof githubPull; now:()=>number} = {localOrigin,githubPulls,githubPull,now:Date.now},
    private readonly mergeApi=githubMergeApi(args=>run("gh",args)), private readonly lookupLifecycle=githubLifecycle) {
    this.mergeability = new MergeabilityChecks(deps.githubPull ?? githubPull, deps.now, mergeabilityRetry, pullLookupFailure);
  }

  private async limited<T>(task:()=>Promise<T>):Promise<T> {
    if (this.running >= 3) await new Promise<void>(resolve=>this.waiting.push(resolve));
    else this.running++;
    try { return await task(); }
    finally {
      const next=this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  async lifecycle(paseo: Sdk, input: z.output<typeof readPullLifecycle.input>) {
    return (await this.explainLifecycle(paseo, input)).state;
  }

  // The lifecycle with the reason it reads as UNKNOWN, when it does.
  async explainLifecycle(paseo: Sdk, {reference, ...target}: z.output<typeof readPullLifecycle.input>):Promise<z.output<typeof readPullLifecycle.output>> {
    const scope = {state:"UNKNOWN" as const, why:"scope" as const};
    try {
      return await this.limited(async () => {
        let current: () => boolean;
        try { current = await this.mergeScope(paseo, target); } catch { return scope; }
        if (!current()) return scope;
        const cached = reference ? this.sources.get(target.repo) : undefined;
        if (cached && cached.expires !== Infinity && cached.expires > this.deps.now()) {
          const source = await cached.value;
          const pull = source?.items.find(p => p.number === target.number);
          if (!current()) return scope;
          if (pull) return {state: pull.reason === "draft" ? "DRAFT" as const : "OPEN" as const};
        }
        let state: Awaited<ReturnType<typeof this.lookupLifecycle>>;
        try { state = await this.lookupLifecycle(target); } catch (error) { return {state:"UNKNOWN" as const, why:pullLookupFailure(error)}; }
        if (!current()) return scope;
        if (state === "UNKNOWN") return {state, why:"lookup-failed" as const};
        return {state: state === "DRAFT" && !reference ? "OPEN" as const : state};
      });
    } catch { return {state:"UNKNOWN" as const, why:"lookup-failed" as const}; }
  }

  // Which merge-card PRs are confirmed merged or closed. Lookups run in the background, a few per read,
  // so a board read never waits on GitHub here. A finished lookup refreshes the board count.
  settledStates(paseo:Sdk, targets:readonly {repo:string; number:number; projectId:string}[], known:(repo:string, number:number) => SettledState | undefined) {
    const result = new Map<string,SettledState>();
    const now = this.deps.now();
    let started = 0;
    for (const target of targets) {
      const key = settledKey(target.repo, target.number);
      const recorded = known(target.repo, target.number);
      if (recorded) { result.set(key, recorded); continue; }
      const entry = this.settled.get(key);
      if (entry && "state" in entry) {
        result.set(key, {state:entry.state, at:entry.at});
        if (entry.state === "MERGED" || entry.inflight || (entry.recheckAt ?? Infinity) > now) continue;
      } else if (entry && (entry.inflight || entry.retryAt > now)) continue;
      if (started >= mergeabilityRetry.perRead) continue;
      started++;
      const previous = entry && "state" in entry ? entry : undefined;
      this.settled.set(key, previous ? {...previous, inflight:true} : {retryAt:Infinity, inflight:true});
      void this.explainLifecycle(paseo, target).then(({state}) => {
        if (state === "MERGED" || state === "CLOSED") {
          const at = previous?.state === state ? previous.at : new Date(this.deps.now()).toISOString();
          this.settled.set(key, {state, at, ...(state === "CLOSED" ? {recheckAt:this.deps.now() + 10 * ttl} : {})});
          if (previous?.state !== state) this.invalidated?.();
        } else this.settled.set(key, {retryAt:this.deps.now() + ttl});
      }, () => this.settled.set(key, previous ? {...previous, recheckAt:this.deps.now() + ttl, inflight:undefined} : {retryAt:this.deps.now() + ttl}));
    }
    while (this.settled.size > 500) this.settled.delete(this.settled.keys().next().value!);
    return result;
  }

  register(server:PluginServerContext,onInvalidated?:()=>void,notifications?:MergeNotifications) {
    this.invalidated = onInvalidated;
    const merges = new PullMerges(this.mergeApi, this.deps.now, repo => {
      this.sources.delete(repo);
      onInvalidated?.();
    }, entry => {
      const {repo, number, status, mergeSha} = entry.pullMerge;
      const key = mergeHistoryKey(repo,number);
      this.store.change(scope => {
        const previous = scope.pullMergeHistory[key];
        if (!previous || (status === "merged" && previous.pullMerge.status !== "merged")) {
          scope.pullMergeHistory[key] = entry;
        } else if (!previous.pullMerge.mergeSha && mergeSha) {
          previous.pullMerge.mergeSha = mergeSha;
        }
      });
    });
    server.handle(readPullLifecycle, (input, {paseo}) => this.explainLifecycle(paseo, input));
    server.handle(previewPullRequestMerge,({expectedHeadSha,...target},{paseo})=>
      merges.preview(target,()=>this.mergeScope(paseo,target),expectedHeadSha));
    server.handle(confirmPullRequestMerge,(input,{paseo})=>{
      const owner = notifications?.owner(input);
      return merges.confirm(input,()=>this.mergeScope(paseo,input),notifications && owner
        ? entry => notifications.confirmed(paseo,entry,owner) : undefined);
    });
    server.handle(setProjectRepository,async input=>{
      this.store.change(s=>{
        if (!s.projects.includes(input.projectId)) throw Error("관리할 프로젝트를 먼저 선택하세요.");
        const current=mapping(s,input.projectId);
        if (current.mode!==input.expectedMode || (current.mode==="manual" && current.repo!==input.expectedRepo)) throw Error("저장소 연결이 변경되었습니다. 새로 고쳐 주세요.");
        if (input.mode==="manual" && input.repo) s.projectRepositories[input.projectId]={mode:"manual",repo:input.repo};
        if (input.mode==="off") s.projectRepositories[input.projectId]={mode:"off"};
        if (input.mode==="auto") delete s.projectRepositories[input.projectId];
      });
      this.discovery.delete(input.projectId);
      return {ok:true as const};
    });
  }

  async mergeScope(paseo:Sdk,target:MergeTarget) {
    const saved=this.store.read(), config=mapping(saved,target.projectId);
    if(!saved.projects.includes(target.projectId) || config.mode==="off") throw Error("scope");
    const current=()=>{
      const live=this.store.read();
      return live.projects.includes(target.projectId) && equal(config,mapping(live,target.projectId));
    };
    let repo=config.repo;
    if(config.mode==="auto"){
      const native=await paseo.projects.list();
      const project=native.projects.find(p=>p.projectId===target.projectId);
      if(!current()) throw Error("scope");
      // Bypass the browsing cache when a person is about to change a GitHub PR.
      repo=await this.discover(paseo,target.projectId,project?.projectRootPath);
    }
    if(repo!==target.repo || !current()) throw Error("scope");
    return current;
  }

  private async discover(paseo:Sdk,id:string,root:string|undefined) {
    const selected = () => {
      const scope = this.store.read();
      return scope.projects.includes(id) && mapping(scope,id).mode === "auto";
    };
    if (!selected()) return null;
    if (root) {
      const primary=await this.deps.localOrigin(root);
      if (primary) return primary;
    }
    if (!selected()) return null;
    const rows = await readPages<Workspace>(page=>paseo.workspaces.list({filter:{projectId:id,includeBackground:true},sort:[{key:"project_id",direction:"asc"}],page}));
    const repos = new Set<string>();
    const paths = new Set<string>();
    for (const w of rows) {
      if(w.projectId!==id || w.archivingAt || w.internal) continue;
      const checkout=w.project?.checkout;
      const remote = githubRepository(w.gitRuntime?.remoteUrl);
      const checkoutRemote = githubRepository(checkout?.remoteUrl);
      if (remote) repos.add(remote);
      if (checkoutRemote) repos.add(checkoutRemote);
      if (!remote && !checkoutRemote)
        for (const path of [w.workspaceDirectory,checkout?.cwd,checkout?.mainRepoRoot,w.projectRootPath])
        if (path && path!==root) paths.add(path);
    }
    for (const path of paths) {
      if (repos.size > 1 || !selected()) return null;
      const repo=await this.deps.localOrigin(path);
      if (repo) repos.add(repo);
    }
    return repos.size===1?[...repos][0]:null;
  }

  private resolve(paseo:Sdk,id:string,root:string|undefined,refresh:boolean) {
    const existing=this.discovery.get(id), now=this.deps.now();
    if(existing && existing.expires > now && (!refresh || existing.expires === Infinity))return existing.value;
    const entry={expires:Infinity,value:this.limited(()=>this.discover(paseo,id,root))};
    this.discovery.set(id,entry);
    entry.value.then(()=>{entry.expires=this.deps.now()+ttl;},()=>{if(this.discovery.get(id)===entry)this.discovery.delete(id);});
    return entry.value;
  }

  private pulls(repo:string,refresh:boolean,stillAllowed:()=>boolean) {
    const existing=this.sources.get(repo), now=this.deps.now();
    if(existing && existing.expires>now && (!refresh || existing.expires === Infinity))return existing.value;
    const entry={expires:Infinity,value:this.limited(async():Promise<Source|null>=>{
      if (!stillAllowed()) return null;
      try {return await this.deps.githubPulls(repo);}
      catch (error) {return {status:"unavailable",items:[],failure:pullLookupFailure(error)};}
    })};
    this.sources.set(repo,entry);
    const discard = () => {
      if (this.sources.get(repo) === entry) this.sources.delete(repo);
    };
    void entry.value.then(value => {
      if (!value) discard();
      else entry.expires = this.deps.now() + (value.status === "unavailable" ? 15_000 : ttl);
    }, discard);
    return entry.value;
  }

  async read(paseo:Sdk,options:{refresh?:boolean; projects?:NativeProject[]}={}):Promise<PullRequestView> {
    const selected=this.store.read(), ids=selected.projects;
    const now = this.deps.now();
    for (const [key,entry] of this.sources) if (entry.expires <= now) this.sources.delete(key);
    for (const [key,entry] of this.discovery) if (entry.expires <= now || !ids.includes(key)) this.discovery.delete(key);
    if (!ids.length) return {items:[],projects:[]};
    const refresh=options.refresh===true;
    const needsProjects = ids.some(id=>mapping(selected,id).mode==="auto");
    const native = options.projects ?? (needsProjects ? await paseo.projects.list().then(result=>result.projects,()=>null) : []);
    const roots=new Map((native ?? []).map(p=>[p.projectId,p.projectRootPath]));
    const configs=new Map(ids.map(id=>[id,mapping(selected,id)]));
    const allowed = (id:string, scope:Preferences) => scope.projects.includes(id) && equal(configs.get(id)!, mapping(scope,id));
    const pending = new Map<string,{ids:Set<string>; read:Promise<Source|null>; allowed:()=>boolean}>();
    const connect = (repo:string, projectId:string) => {
      const known = pending.get(repo);
      if (known) {
        known.ids.add(projectId);
        return;
      }
      const ids = new Set([projectId]);
      const stillAllowed = () => {
        const scope = this.store.read();
        return [...ids].some(id => allowed(id,scope));
      };
      pending.set(repo,{ids,read:this.pulls(repo,refresh,stillAllowed),allowed:stillAllowed});
    };
    const projects = await Promise.all(ids.map(async (projectId):Promise<ProjectView> => {
      const {mode,repo} = configs.get(projectId)!;
      if (mode === "off") return {projectId,mode,repo:null,status:"off"};
      try {
        const resolved = mode === "manual" ? repo : await this.resolve(paseo,projectId,roots.get(projectId),refresh);
        if (resolved) connect(resolved,projectId);
        return {projectId,mode,repo:resolved,status:resolved?"ok":native===null?"unavailable":"unmapped"};
      } catch { return {projectId,mode,repo:null,status:"unavailable"}; }
    }));
    const sources = new Map(await Promise.all([...pending].map(async ([repo,group]) => {
      let value = await group.read;
      // A queued lookup can lose its last authorized project while a slower
      // mapping for the same repository is still in progress.
      if (value === null && group.allowed()) value = await this.pulls(repo,false,group.allowed);
      return [repo,value] as const;
    })));
    // PRs whose mergeability GitHub is still computing are asked one by one, all repositories together.
    const computing = [...sources].flatMap(([repo,value]) => value?.items.some(p => p.reason === "computing")
      ? [{repo, value, allowed:pending.get(repo)!.allowed}] : []);
    if (computing.length) {
      const checked = await this.mergeability.apply(computing.map(({value,allowed}) => ({items:value.items, allowed})),
        task=>this.limited(task), mergeabilityRetry.perRead);
      computing.forEach(({repo,value}, index) => sources.set(repo, {...value, items:checked[index]}));
    }
    // A PR seen open again may have been reopened after a closed answer.
    for (const source of sources.values()) for (const p of source?.items ?? []) this.settled.delete(settledKey(p.repo, p.number));
    const latest = this.store.read();
    const visible = projects.filter(p => allowed(p.projectId,latest));
    const byRepo = new Map<string,string[]>();
    for (const project of visible) {
      if (!project.repo) continue;
      const source = sources.get(project.repo);
      project.status = source?.status ?? "unavailable";
      if (source?.failure) project.failure = source.failure;
      const connected = byRepo.get(project.repo);
      if (connected) connected.push(project.projectId);
      else byRepo.set(project.repo,[project.projectId]);
    }
    const items:PullRequestItem[] = [];
    for (const [repo,projectIds] of byRepo) {
      for (const p of sources.get(repo)?.items ?? []) items.push({...p,projectIds});
    }
    items.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.repo.localeCompare(b.repo)||b.number-a.number);
    return {items,projects:visible};
  }
}
