import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { sortTrackedByPriority } from "../shared/decision-priority";
import type { SessionRow } from "../shared/contract";
import { readReplyPhoto, replyOrigin, type ReplyEntry } from "../shared/reply-history";
import { MAX_WORK_IMAGES, WORK_IMAGE_MIME_TYPES, type WorkImage } from "../shared/work-images";
import { describePhotos, readLocalPhoto, removeLocalPhotos, saveLocalPhotos, type PhotoReference } from "./reply-photos";
import { boardPhotoMessageId } from "../shared/session-photos";
import { SessionPhotoStore } from "./session-photos";
import { openNoFollowSync } from "./safe-open";
import { trackedReplyMessage, trackedReplyOrigin } from "./decision-message";
import type { Evidence } from "./conversation";
import type { LedgerDiagnostics } from "../shared/ledger-diagnostics";
import type { MergeTarget, PullRequestView } from "../shared/prs";
import {
  cancelQueuedReply, legacyTrackedAnswer, resolveTrackedDecision, trackedDecisionInputSchema, trackedPullTarget, trackedKey, trackedMatches, usesSourceCoordinator,
  type RoutedTrackedDecision, type TrackedDecisionInput, type TrackedDecisionView, type TrackedReplyReason, type TrackedResolution,
} from "../shared/tracked-decisions";

const maxBytes = 8 * 1024 * 1024;
const feed = z.union([z.object({version:z.literal(1),items:z.array(z.unknown())}).transform(v=>v.items),z.array(z.unknown())]);
const sourceAuthority = z.object({sourceCoordinatorId:z.string().min(1).max(256)});
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const photoReference = z.object({mimeType:z.enum(WORK_IMAGE_MIME_TYPES), digest:sha256});
const receipt = z.object({
  queue:z.object({source:z.string(),projectId:z.string().nullable(),id:z.string(),owner:z.string().nullish(),
    questionIndexes:z.array(z.number().int().nonnegative()).max(128).optional(),stopped:z.boolean().default(false)}).optional(),
  legacySession:replyOrigin.pick({sessionId:true,sessionHost:true,sessionProjectId:true}).optional(),
  origin:replyOrigin.optional(), messageHash:sha256.optional(), photos:z.array(photoReference).max(MAX_WORK_IMAGES).optional(),
  reviewedBy:z.string().optional(), reviewReason:z.string().optional(), title:z.string().optional(), coordinator:z.boolean().optional(), response:z.string().optional(),key:z.string(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),at:z.string().datetime(),answer:z.string().max(4000).optional(), recipientId:z.string().optional(), messageId:z.string().uuid().optional(), pending:z.boolean().optional()});
const receipts = z.object({version:z.literal(1),items:z.array(receipt)});
type SourceStatus = TrackedDecisionView["status"];
type InputRow = {key:string;fingerprint:string;item:RoutedTrackedDecision;historyUnavailable:boolean};
type Receipt = z.output<typeof receipt>;
// `redirectable` says whether a new reply may still go to the fallback. A redirected delivery without it sends nothing new.
type PendingDelivery = { ready:boolean; send:(answer:string,messageId:string,images?:WorkImage[])=>Promise<void>; accepted:(messageId:string,matches:(text:string)=>boolean)=>Promise<boolean>; stillCurrent:()=>boolean; redirectable?:()=>boolean };
export type BlockedDelivery = { blocked:TrackedReplyReason };
type Prepared = PendingDelivery | BlockedDelivery | null;
// Asks the session that took a reply the board already sent whether the reply is in its conversation, and whether that
// session was deleted or archived. It never sends.
type SentCheck = {
  arrived:(recipientId:string,messageId:string,matches:(text:string)=>boolean)=>Promise<boolean>;
  gone:(recipientId:string)=>Promise<boolean>;
};
const notChecked:SentCheck = {arrived:async () => false, gone:async () => false};
const holdMs = 10 * 60_000;
type Attempt = z.output<typeof resolveTrackedDecision.output> & {queueId?:string};
const changed = (reason?:TrackedReplyReason):Attempt => ({status:"changed", ...(reason ? {reason} : {})});
type AdditionalSources = unknown[] | {items:unknown[];partial?:boolean;diagnostics?:LedgerDiagnostics};
type ReadSources = (selected:Set<string>)=>AdditionalSources;

function validQuestions(row:TrackedDecisionInput,input:TrackedResolution) {
  return !input.questionIndexes || (new Set(input.questionIndexes).size===input.questionIndexes.length &&
    input.questionIndexes.every(i=>Number.isInteger(i) && i>=0 && i<row.questions.length));
}

function receiptKey(key: string, fingerprint: string): string {
  return JSON.stringify([key, fingerprint]);
}

// A receipt written before the answer lead holds the same reply in its older form.
function sameAnswer(recorded:string|undefined,answer:string|undefined,item:TrackedDecisionInput) {
  return (recorded ?? "")===(answer ?? "") || (recorded ?? "")===legacyTrackedAnswer(item,answer ?? "");
}

function sameContent(receipt:Receipt,input:TrackedResolution,photos:readonly PhotoReference[],item:TrackedDecisionInput) {
  return sameAnswer(receipt.answer,input.answer,item) && JSON.stringify(receipt.photos ?? [])===JSON.stringify(photos);
}

function sameReply(receipt:Receipt,input:TrackedResolution,photos:readonly PhotoReference[],item:TrackedDecisionInput) {
  return receipt.recipientId===input.recipientId && sameContent(receipt,input,photos,item);
}

// An unconfirmed reply to an earlier revision holds its card for `holdMs`, and only while the session that took it is
// still there. When that session cannot be asked, the reply keeps holding the card until the time runs out.
async function holdsCard(receipt:Receipt, check:SentCheck) {
  if (!receipt.recipientId || !(Date.now()-Date.parse(receipt.at) < holdMs)) return false;
  try { return !(await check.gone(receipt.recipientId)); }
  catch { return true; }
}

// The recorded message is matched by its hash, which still holds after the card has changed.
function sentAs(receipt:Receipt) {
  return (text:string) => typeof text==="string" &&
    (receipt.messageHash ? createHash("sha256").update(text).digest("hex")===receipt.messageHash : text===(receipt.answer ?? ""));
}

function readJson(path:string):{data:unknown;status:"ok"} | {status:"absent"|"invalid"|"unavailable"} {
  let fd:number|undefined;
  try {
    // Only regular files, and never allocate unbounded output for a growing export.
    fd=openNoFollowSync(path);
    const stat=fstatSync(fd);
    if(!stat.isFile() || stat.size>maxBytes) return {status:"invalid"};
    const buffer=Buffer.alloc(stat.size+1);
    let length=0;
    while(length<buffer.length) {
      const count=readSync(fd,buffer,length,buffer.length-length,null);
      if(!count)break;
      length+=count;
    }
    if(length!==stat.size)return {status:"invalid"};
    return {data:JSON.parse(buffer.toString("utf8",0,length)),status:"ok"};
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==="ENOENT") return {status:"absent"};
    return {status:error instanceof SyntaxError?"invalid":"unavailable"};
  } finally {if(fd!==undefined)closeSync(fd);}
}

export class TrackedDecisionStore {
  private readonly sessionPhotos:SessionPhotoStore;
  private readonly resolutionPath:string;
  private readonly photoDirectory:string;
  private readonly draining = new Map<string,Promise<boolean>>();
  constructor(private readonly path:string, private readonly readSources?:ReadSources) {
    const file=parse(path);
    this.sessionPhotos=new SessionPhotoStore(join(file.dir,"session-photos"));
    this.photoDirectory=join(file.dir, file.name+".photos");
    this.resolutionPath=join(file.dir,file.name+".resolved.json");
  }

  private load(selected:Set<string>):{status:SourceStatus;rows:Map<string,InputRow>;diagnostics?:LedgerDiagnostics} {
    const rows=new Map<string,InputRow>();
    const input=readJson(this.path);
    if(input.status==="invalid" || input.status==="unavailable")return {status:input.status,rows};
    let sources:AdditionalSources;
    try{sources=this.readSources?.(new Set(selected)) ?? [];}catch{return {status:"unavailable",rows};}
    const diagnostics = Array.isArray(sources) ? undefined : sources.diagnostics;
    const partial = !Array.isArray(sources) && (sources.partial || !!diagnostics);
    const extra=Array.isArray(sources) ? sources : sources.items;
    const raw=feed.safeParse(input.status==="ok"?input.data:[]);
    if(!raw.success || !Array.isArray(extra) || raw.data.length+extra.length>5000)return {status:"invalid",rows};
    for(const [index,entry] of [...raw.data,...extra].entries()) {
      const parsed=trackedDecisionInputSchema.safeParse(entry);
      if(!parsed.success)return {status:"invalid",rows:new Map()};
      const item:RoutedTrackedDecision=parsed.data;
      if(item.projectId!==null && !selected.has(item.projectId))continue;
      const key=trackedKey(item);
      if(rows.has(key))return {status:"invalid",rows:new Map()};
      // An old feed without a host and a current feed explicitly marking this host are the same record.
      // Display-only scheduling and PR references must not reopen an answered version.
      const {dueAt, blocksWork, pullTarget, pullRepository, ...content} = item;
      const fingerprint=createHash("sha256").update(JSON.stringify({...content,sessionHost:item.sessionHost ?? undefined})).digest("hex");
      // Authority belongs to the operator-configured importer. Keep it out of
      // the content fingerprint so rotating owners cannot reopen old receipts.
      const imported = index >= raw.data.length;
      if (imported) {
        const owner = sourceAuthority.safeParse(entry);
        item.sourceCoordinatorId = owner.success ? owner.data.sourceCoordinatorId : null;
      }
      const historyUnavailable = imported && typeof entry === "object" && entry !== null &&
        "historyUnavailable" in entry && entry.historyUnavailable === true;
      rows.set(key,{key,fingerprint,item,historyUnavailable});
    }
    if(partial)return {status:"partial",rows,diagnostics};
    return {status:input.status==="absent" && !extra.length?"absent":"ok",rows};
  }

  private recorded():Map<string,z.output<typeof receipt>> | null {
    const input=readJson(this.resolutionPath);
    if(input.status==="absent")return new Map();
    if(input.status!=="ok")return null;
    const parsed=receipts.safeParse(input.data);
    if(!parsed.success)return null;
    const rows=new Map(parsed.data.items.map(r=>[receiptKey(r.key,r.fingerprint),r]));
    return rows.size===parsed.data.items.length?rows:null;
  }

  mergeRecipient(target: MergeTarget, coordinator: string | null): string | null {
    // Include rows just archived by a simultaneous refresh. Approval belongs to
    // the configured importer, never a session ID written into a decision.
    const {status,rows} = this.load(new Set([target.projectId]));
    if (status !== "ok" && status !== "absent") return null;
    const owners = new Set<string | null>();
    for (const {item} of rows.values()) {
      const pull = trackedPullTarget(item);
      if (pull?.repo === target.repo && pull.number === target.number) {
        owners.add(item.sourceCoordinatorId === undefined ? coordinator : item.sourceCoordinatorId);
      }
    }
    return owners.size ? (owners.size === 1 ? [...owners][0] : null) : coordinator;
  }

  // First paint can show local titles while Paseo and GitHub resolve the actionable cards.
  previewTitles(selected: Set<string>): string[] {
    if (!selected.size) return [];
    const {rows} = this.load(selected);
    const resolved = this.recorded();
    if (!resolved) return [];
    const pending = [...rows.values()]
      .filter(({key, fingerprint}) => { const record=resolved.get(receiptKey(key,fingerprint)); return !record || !!record.queue; })
      .map(row => row.item);
    return sortTrackedByPriority(pending).slice(0, 3).map(item => item.title);
  }

  read(selected:Set<string>, sessions:SessionRow[], prs:PullRequestView, evidence: ReadonlyMap<string,Evidence> = new Map()):TrackedDecisionView & { history?:ReplyEntry[] } {
    const {status,rows,diagnostics}=this.load(selected);
    const resolved=this.recorded();
    if(!resolved)return {items:[],status:"unavailable"};
    const history: ReplyEntry[] = [];
    let updated = false;
    for (const [version, receipt] of resolved) {
      if (receipt.queue && !receipt.queue.stopped) continue;
      let reference: unknown;
      try { reference = JSON.parse(receipt.key); } catch { continue; }
      if (!Array.isArray(reference) || reference.length !== 3) continue;
      const [, projectId, id] = reference;
      if (typeof id !== "string" || !(projectId === null ? selected.size > 0 : selected.has(projectId))) continue;
      const source = rows.get(receipt.key);
      const original = source?.fingerprint === receipt.fingerprint ? source.item : undefined;
      const title = receipt.title ?? original?.title ?? id;
      const coordinator = receipt.coordinator ?? (original ? original.where === "manager" || original.where === "human" : undefined);
      if (receipt.pending && receipt.recipientId && receipt.messageId && receipt.messageHash &&
          evidence.get(receipt.recipientId)?.boardMessageHashes?.get(receipt.messageId)===receipt.messageHash) {
        receipt.pending=false;
        updated=true;
      }
      const response = receipt.recipientId && receipt.messageId && !receipt.pending && !receipt.queue
        ? evidence.get(receipt.recipientId)?.replies?.get(receipt.messageId) : undefined;
      // Older receipts can recover a source from the exact recorded version, even after a restart.
      // Their selected question indexes were not stored.
      if (!receipt.origin && !receipt.legacySession && original && (original.sessionId || original.sessionMatch)) {
        const {sessionId,sessionHost,sessionProjectId} = trackedReplyOrigin(original,{...original,fingerprint:receipt.fingerprint});
        receipt.legacySession = {sessionId,sessionHost,sessionProjectId};
        updated = true;
      }
      // Preserve the old format's title while the original card is still available.
      if ((!receipt.title && original && receipt.recipientId) || (response && response !== receipt.response)) {
        Object.assign(receipt, {title, coordinator, response:response ?? receipt.response});
        updated = true;
      }
      const origin = receipt.origin ?? (receipt.legacySession && {...receipt.legacySession,cardId:id,revision:receipt.fingerprint,questions:[]});
      history.push({key:version, ...(origin ? {origin} : {}), title, projectId, coordinator, at:receipt.at, answer:receipt.answer,
        recipientId:receipt.recipientId, messageId:receipt.messageId, response:receipt.response,
        ...(receipt.photos?.length ? {imageCount:receipt.photos.length, localPhotos:!receipt.recipientId} : {}),
        ...(receipt.reviewedBy ? {reviewedBy:receipt.reviewedBy, reviewReason:receipt.reviewReason} : {}),
        status:receipt.queue ? "unsent" : receipt.pending ? "pending" : receipt.recipientId ? "sent" : (receipt.answer || receipt.photos?.length) ? "recorded" : "closed"});
    }
    if (updated) this.save(resolved);
    const scopedSessions=sessions.filter(s=>selected.has(s.projectId));
    const scopedPrs={...prs,items:prs.items.filter(p=>p.projectIds.some(id=>selected.has(id)))};
    const items=[];
    for(const {key,fingerprint,item,historyUnavailable} of rows.values()){
      const previous=resolved.get(receiptKey(key,fingerprint));
      if(previous && !previous.pending && !previous.queue)continue;
      const queuedReply=previous?.queue && previous.messageId && previous.recipientId
        ? {messageId:previous.messageId,recipientId:previous.recipientId,answer:previous.answer,
          imageCount:previous.photos?.length ?? 0,stopped:previous.queue.stopped} : undefined;
      items.push({...item,key,fingerprint,...(historyUnavailable ? {historyUnavailable: true as const} : {}),
        ...(queuedReply ? {queuedReply} : {}),...trackedMatches(item,scopedSessions,scopedPrs)});
    }
    return {items,status,...(diagnostics ? {diagnostics} : {}),...(history.length ? {history} : {})};
  }

  readPhoto(key:string,index:number,selected:Set<string>):WorkImage|null {
    const record=this.recorded()?.get(key);
    const photo=record?.photos?.[index];
    if (!photo || !record || record.recipientId || record.pending || !selected.size) return null;
    let ref:unknown;
    try { ref=JSON.parse(record.key); } catch { return null; }
    if (!Array.isArray(ref) || ref.length!==3 || !(ref[1]===null || selected.has(ref[1]))) return null;
    return readLocalPhoto(this.photoDirectory,key,index,photo);
  }

  resolve(input:TrackedResolution,getScope:()=>Set<string>,proof?:{coordinatorId:string;reason:string}):Attempt {
    const allowed=(scope:Set<string>)=>scope.size>0 && (input.projectId===null || scope.has(input.projectId));
    const selected=getScope();
    if(!allowed(selected))return {status:"out-of-scope"};
    const data=this.load(selected);
    if(data.status==="invalid" || data.status==="unavailable")return {status:"unavailable"};
    const row=data.rows.get(trackedKey(input));
    if(!row)return data.status==="partial" ? {status:"unavailable"} : changed("removed");
    if(row.historyUnavailable)return {status:"unavailable"};
    if(row.fingerprint!==input.fingerprint || !validQuestions(row.item,input))return changed("revised");
    if(proof && usesSourceCoordinator(row.item) && row.item.sourceCoordinatorId !== proof.coordinatorId) return {status:"out-of-scope"};
    const records=this.recorded();
    if(!records)return {status:"unavailable"};
    if(!allowed(getScope()))return {status:"out-of-scope"};
    const version=receiptKey(row.key,row.fingerprint);
    const previous=records.get(version);
    if(previous?.pending || previous?.queue || input.recipientId)return {status:"unconfirmed"};
    const photos=describePhotos(input.images);
    const origin=trackedReplyOrigin(row.item,input);
    if(previous) {
      const differentAnswer=input.answer && !sameAnswer(previous.answer,input.answer,row.item);
      const samePhotos=JSON.stringify(photos)===JSON.stringify(previous.photos ?? []);
      const differentQuestion=input.questionIndexes && previous.origin && JSON.stringify(previous.origin.questions)!==JSON.stringify(origin.questions);
      return differentAnswer || !samePhotos || differentQuestion ? changed("conflict") : {status:"already-closed"};
    }
    records.set(version,{origin,title:row.item.title,key:row.key,fingerprint:row.fingerprint,at:new Date().toISOString(),
      ...(input.answer?{answer:input.answer}:{}), ...(photos.length ? {photos} : {}),
      ...(proof ? {reviewedBy:proof.coordinatorId, reviewReason:proof.reason} : {})});
    const saved=saveLocalPhotos(this.photoDirectory,version,input.images ?? [],()=>this.save(records));
    return {status:saved ? "closed" : "unavailable"};
  }

  private save(records:Map<string,Receipt>) {
    const body=JSON.stringify({version:1,items:[...records.values()]});
    if(Buffer.byteLength(body)>maxBytes)return false;
    const tmp=this.resolutionPath+"."+randomUUID()+".tmp";
    try {
      mkdirSync(dirname(this.resolutionPath),{recursive:true,mode:0o700});
      writeFileSync(tmp,body,{flag:"wx",mode:0o600});
      renameSync(tmp,this.resolutionPath);
    }catch{return false;}
    finally{rmSync(tmp,{force:true});}
    return true;
  }

  async deliver(input:TrackedResolution, getScope:()=>Set<string>, prepare:(row:RoutedTrackedDecision)=>Promise<Prepared>, queuedId?:string, check=notChecked):Promise<Attempt> {
    const selected=getScope();
    if (!selected.size || (input.projectId && !selected.has(input.projectId))) return {status:"out-of-scope"};
    const key=trackedKey(input), version=receiptKey(key,input.fingerprint);
    const current=()=>{
      const scope=getScope();
      if (!scope.size || (input.projectId && !scope.has(input.projectId))) return {};
      const source=this.load(scope), row=source.rows.get(key);
      return {row,unavailable:source.status==="invalid" || source.status==="unavailable" || row?.historyUnavailable || (source.status==="partial" && !row)};
    };
    const {row,unavailable}=current();
    if (unavailable) return {status:"unavailable"};
    if (!row) return changed("removed");
    if (row.fingerprint!==input.fingerprint) return this.confirmEarlier(input,version,row.item,check);
    if (!validQuestions(row.item,input)) return changed("revised");
    if ((!input.answer?.trim() && !input.images?.length) || !input.recipientId) return changed();
    // A reply this revision already sent is looked for with the session that took it, before the current owner and
    // route are checked. Looking only reads that conversation, so a rotated owner cannot strand the reply.
    const sentBefore=this.recorded()?.get(version);
    if (sentBefore?.pending && !sentBefore.queue && sameContent(sentBefore,input,describePhotos(input.images),row.item)) {
      const {status,recipientId}=await this.confirm(version,sentBefore,check,input.recipientId);
      if (status==="sent") return {status,...(recipientId ? {recipientId} : {})};
    }
    const fallback=input.route==="coordinator";
    if (fallback && row.item.where!=="session") return changed("recipient-changed");
    const owned=fallback ? row.item.sourceCoordinatorId!==undefined : usesSourceCoordinator(row.item);
    if (owned && row.item.sourceCoordinatorId !== input.recipientId) return changed("owner-changed");
    const target=await prepare(row.item);
    const currentSource=current();
    if (currentSource.unavailable) return {status:"unavailable"};
    const latestRow=currentSource.row;
    if (!latestRow) return changed("removed");
    if (latestRow.fingerprint!==input.fingerprint) return changed("revised");
    if (latestRow.item.sourceCoordinatorId !== row.item.sourceCoordinatorId) return changed("owner-changed");
    if (!target) return changed("recipient-missing");
    if ("blocked" in target) return changed(target.blocked);
    if (!target.stillCurrent()) return changed("recipient-changed");
    const records=this.recorded();
    if (!records) return {status:"unavailable"};
    const previous=records.get(version);
    if (queuedId && (!previous?.queue || previous.queue.stopped || previous.messageId!==queuedId)) return changed("queue-stopped");
    if (previous?.queue && previous.queue.owner!==row.item.sourceCoordinatorId) return changed("owner-changed");
    const photos=describePhotos(input.images);
    // While a reply to another revision of this card is still unconfirmed and holds the card, sending the same reply only
    // checks it and a different reply waits. That reply is looked for with the session that took it, even after the card
    // moved to another session. Once the hold ends, a new reply goes out and the earlier one stays unconfirmed.
    const waiting=previous ? [] : [...records].filter(([,record])=>record.key===key && record.fingerprint!==input.fingerprint && record.pending && !record.queue);
    for (const [earlierVersion,earlier] of waiting) {
      const checked=await this.confirm(earlierVersion,earlier,check,input.recipientId);
      // Once it arrived, the same reply closes only its own revision. A different reply answers the card as it is now.
      if (checked.status==="sent") return sameContent(earlier,input,photos,row.item) ? checked : this.deliver(input,getScope,prepare,queuedId,check);
      if (await holdsCard(earlier,check)) return sameReply(earlier,input,photos,row.item) ? checked : changed("earlier-unconfirmed");
    }
    if (previous && !sameReply(previous,input,photos,row.item)) return changed("conflict");
    // A retry repeats the recorded reply as it was written then.
    const text=trackedReplyMessage(row.item,previous ? {...input,answer:previous.answer} : input);
    const messageHash=createHash("sha256").update(text).digest("hex");
    if (previous?.messageHash && previous.messageHash!==messageHash) return changed("conflict");
    if (previous && !previous.pending && !previous.queue) return {status:"sent"};
    if (previous?.queue && !queuedId) return previous.queue.stopped ? changed("queue-stopped") : {status:"queued",queueId:previous.messageId};
    const messageId=previous?.messageId ?? (photos.length ? boardPhotoMessageId(randomUUID()) : randomUUID());
    const receipt:Receipt=previous ?? {origin:trackedReplyOrigin(row.item,input),messageHash,...(photos.length ? {photos} : {}),title:row.item.title,coordinator:fallback || row.item.where==="human" || row.item.where==="manager",key,fingerprint:input.fingerprint,at:new Date().toISOString(),answer:input.answer,recipientId:input.recipientId,messageId,pending:true};
    try {
      if (previous && !previous.queue) {
        if (!(await target.accepted(messageId,sentAs(previous)))) return {status:"unconfirmed"};
      } else {
        // The fallback takes a new reply only while the card's own session cannot. A reply it already took is still confirmed.
        if (fallback && !target.redirectable?.()) return changed("recipient-changed");
        if (!target.ready) {
          if (previous?.queue) return {status:"queued"};
          // A redirected reply is sent only while the person is watching it go.
          if (fallback) return {status:"busy"};
          const {source,projectId,id,questionIndexes}=input;
          records.set(version,{...receipt,pending:false,queue:{source,projectId,id,questionIndexes,owner:row.item.sourceCoordinatorId,stopped:false}});
          const saved=saveLocalPhotos(this.photoDirectory,messageId,input.images ?? [],()=>this.save(records));
          return saved ? {status:"queued",queueId:messageId} : {status:"unavailable"};
        }
        if (input.images?.length) {
          try { this.sessionPhotos.save(input.recipientId, messageId, input.images); }
          catch { return {status:"unavailable"}; }
        }
        if (receipt.queue) receipt.at=new Date().toISOString();
        delete receipt.queue;
        receipt.pending=true;
        records.set(version,receipt);
        if (!this.save(records)) return {status:"unavailable"};
        if (queuedId) removeLocalPhotos(this.photoDirectory,messageId,photos.length);
        await target.send(text,messageId,input.images);
      }
    } catch { return {status:"unconfirmed"}; }
    // Other decisions can be answered while the session receives this message.
    const latest=this.recorded();
    if (!latest || latest.get(version)?.messageId!==messageId) return {status:"unconfirmed"};
    latest.set(version,{...receipt,pending:false});
    return {status:this.save(latest) ? "sent" : "unconfirmed"};
  }

  // Retrying an unconfirmed reply after its card changed only checks that reply. It is never sent again.
  private async confirmEarlier(input:TrackedResolution, version:string, item:RoutedTrackedDecision, check:SentCheck):Promise<Attempt> {
    const earlier=this.recorded()?.get(version);
    if (!input.recipientId || !earlier || earlier.queue || !sameReply(earlier,input,describePhotos(input.images),item)) return changed("revised");
    return earlier.pending ? this.confirm(version,earlier,check,input.recipientId) : {status:"sent",revision:earlier.fingerprint};
  }

  // Confirms a recorded reply with the session that took it, wherever the card goes now. Only its revision closes, and
  // the result names that session when the board asked another.
  private async confirm(version:string, receipt:Receipt, check:SentCheck, asked:string|undefined):Promise<Attempt> {
    const {messageId,recipientId}=receipt;
    if (!messageId || !recipientId) return {status:"unconfirmed"};
    try { if (!(await check.arrived(recipientId,messageId,sentAs(receipt)))) return {status:"unconfirmed"}; }
    catch { return {status:"unconfirmed"}; }
    const latest=this.recorded(), recorded=latest?.get(version);
    if (!latest || !recorded || recorded.messageId!==messageId) return {status:"unconfirmed"};
    latest.set(version,{...recorded,pending:false});
    return this.save(latest) ? {status:"sent",revision:recorded.fingerprint,...(recipientId!==asked ? {recipientId} : {})} : {status:"unconfirmed"};
  }

  cancelQueued(input:z.output<typeof cancelQueuedReply.input>, scope:Set<string>) {
    if (!scope.size || (input.projectId && !scope.has(input.projectId))) return false;
    const version=receiptKey(trackedKey(input),input.fingerprint);
    const records=this.recorded(), previous=records?.get(version);
    if (!records || !previous?.queue || previous.messageId!==input.messageId) return false;
    records.delete(version);
    if (!this.save(records)) return false;
    removeLocalPhotos(this.photoDirectory,input.messageId,previous.photos?.length ?? 0);
    return true;
  }

  hasWaitingReplies(id?:string) {
    const records=this.recorded();
    return !!records && [...records.values()].some(record=>record.queue && !record.queue.stopped && (!id || record.recipientId===id));
  }

  async resumeQueued(getScope:()=>Set<string>,prepare:(row:RoutedTrackedDecision,target:string)=>Promise<Prepared>,recipientId?:string) {
    const records=this.recorded();
    if (!records) return false;
    const waiting=new Map<string,[string,Receipt][]>();
    for (const entry of records) {
      const {queue,recipientId:id}=entry[1];
      if (!queue || queue.stopped || !id || (recipientId && recipientId!==id)) continue;
      const group=waiting.get(id) ?? [];
      group.push(entry);
      waiting.set(id,group);
    }
    const results=await Promise.all([...waiting].map(async ([id,entries])=>{
      const active=this.draining.get(id);
      if (active && !recipientId) return active;
      // A permission/turn hook may arrive while the previous check is still
      // observing a busy session. Run the newer check after that observation.
      const run=Promise.resolve(active).then(async ()=>{
        let changed=false;
        for (const [version,record] of entries) {
          const outcome=await this.resumeOne(getScope,prepare,version,record,id);
          if (outcome==="queued") break;
          if (outcome==="sent" || outcome==="unconfirmed" || outcome==="stopped") changed=true;
        }
        return changed;
      }).catch(()=>false);
      this.draining.set(id,run);
      try { return await run; }
      finally { if (this.draining.get(id)===run) this.draining.delete(id); }
    }));
    return results.some(Boolean);
  }

  private async resumeOne(getScope:()=>Set<string>,prepare:(row:RoutedTrackedDecision,id:string)=>Promise<Prepared>,
    version:string,record:Receipt,id:string):Promise<Attempt["status"]|"stopped"> {
    const queue=record.queue!, messageId=record.messageId!;
    const scope=getScope();
    const visible=scope.size>0 && (!queue.projectId || scope.has(queue.projectId));
    const source=visible ? this.load(scope) : undefined;
    const row=source?.rows.get(record.key);
    if (source?.status==="unavailable" || source?.status==="invalid" || row?.historyUnavailable || (source?.status==="partial" && !row)) return "unavailable";
    if (row && row.fingerprint===record.fingerprint && row.item.sourceCoordinatorId===queue.owner) {
      const target=await prepare(row.item,id);
      if (target && !("blocked" in target) && target.stillCurrent()) {
        if (!target.ready) return "queued";
        const images:WorkImage[]=[];
        for (const [index,photo] of (record.photos ?? []).entries()) {
          const image=readLocalPhoto(this.photoDirectory,messageId,index,photo);
          if (!image) break;
          images.push(image);
        }
        if (images.length===(record.photos?.length ?? 0)) {
          const input={source:queue.source,projectId:queue.projectId,id:queue.id,fingerprint:record.fingerprint,
            recipientId:id,answer:record.answer,questionIndexes:queue.questionIndexes,...(images.length ? {images} : {})};
          const result=await this.deliver(input,getScope,async()=>target,messageId);
          if (result.status!=="changed" && result.status!=="out-of-scope") return result.status;
        }
      }
    }
    const latest=this.recorded(), current=latest?.get(version);
    if (latest && current?.queue && current.messageId===messageId) {
      current.queue.stopped=true;
      if(this.save(latest)) {
        removeLocalPhotos(this.photoDirectory,messageId,record.photos?.length ?? 0);
        return "stopped";
      }
    }
    return "unavailable";
  }

  register(server:PluginServerContext,getScope:()=>Set<string>,onChange?:()=>void,
    prepare?: (row:RoutedTrackedDecision, target:string, ctx:import("@getpaseo/plugin/server").PluginHandlerContext, route?:TrackedResolution["route"])=>Promise<Prepared>,
    sentTo?: (ctx:import("@getpaseo/plugin/server").PluginHandlerContext)=>SentCheck) {
    server.handle(cancelQueuedReply,input=>{
      const canceled=this.cancelQueued(input,getScope());
      if (canceled) onChange?.();
      return {canceled};
    });
    server.handle(readReplyPhoto,({key,index})=>({image:this.readPhoto(key,index,getScope())}));
    server.handle(resolveTrackedDecision,async (input,ctx)=>{
      const result=input.recipientId && prepare
        ? await this.deliver(input,getScope,row=>prepare(row,input.recipientId!,ctx,input.route),undefined,sentTo?.(ctx))
        : this.resolve(input,getScope);
      // Close the window where the ready event fired after the live check but
      // before the queue was persisted. Re-read the receipt using its same ID.
      if (result.status==="queued" && prepare && input.recipientId) {
        await this.resumeQueued(getScope,(row,target)=>prepare(row,target,ctx),input.recipientId);
        const receipt=this.recorded()?.get(receiptKey(trackedKey(input),input.fingerprint));
        if (!receipt || receipt.messageId!==result.queueId || receipt.queue?.stopped) Object.assign(result,changed("queue-stopped"));
        else if (!receipt.queue) result.status=receipt.pending ? "unconfirmed" : "sent";
      }
      if(result.status==="closed" || result.status==="sent" || result.status==="queued")onChange?.();
      const sent=result.status==="sent";
      return {status:result.status, ...(result.reason ? {reason:result.reason} : {}), ...(sent && result.revision ? {revision:result.revision} : {}),
        ...(sent && result.recipientId ? {recipientId:result.recipientId} : {})};
    });
    return async (ctx:import("@getpaseo/plugin/server").PluginHandlerContext,id?:string)=>{
      if (prepare && await this.resumeQueued(getScope,(row,target)=>prepare(row,target,ctx),id)) onChange?.();
    };
  }
}
