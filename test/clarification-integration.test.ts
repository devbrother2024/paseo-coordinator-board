import { createHash } from "node:crypto";
import { PreferenceStore } from "../server/preferences";
import { isBoardPhotoMessage, readSessionPhoto } from "../shared/session-photos";
import {afterEach,expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import contribute from "../index.server";
import {boardScope,boardSnapshot} from "../shared/contract";
import {sendDecision} from "../shared/decision-actions";
import {askClarification,clarificationKey,trackedClarificationCard, type ClarificationCard} from "../shared/clarifications";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});});

async function fixture(matchedQuestion?: string) {
  const root=mkdtempSync(join(tmpdir(),"board-qa-integration-"));roots.push(root);
  const data=join(root,"plugin-data","coordinator-board");mkdirSync(data,{recursive:true});
  const workers=["editor","writer"];
  const items=workers.map(sessionId=>({source:"studio-ledger",projectId:"studio",projectTitle:"Studio",id:"timing-"+sessionId,
    title:"Timing · "+sessionId,where:"manager",sessionId,questions:[{id:"Q3",text:"How much padding?"}],
    ...(matchedQuestion && sessionId === "editor"
      ? {sessionMatch:{sessionId,projectId:"studio",question:matchedQuestion},questions:[]}
      : {})}));
  writeFileSync(join(data,"tracked-decisions.json"),JSON.stringify({version:1,items}));
  const timelines=new Map<string,any[]>([...workers,"coordinator"].map(id=>[id,[]]));
  const stamp=new Map([...timelines.keys()].map(id=>[id,1]));
  const sent:{id:string;text:string;messageId:string}[]=[];
  let loseAck=false;
  const append=(id:string,item:unknown)=>{timelines.get(id)!.push(item);stamp.set(id,stamp.get(id)!+1);};
  const running = new Set<string>();
  // Sessions working on a turn a reply could join (a provider that takes replies during a turn).
  const steering = new Set<string>();
  const actor=(id:string)=>({id,title:"Studio "+id,status:running.has(id)||steering.has(id)?"running":"idle",updatedAt:String(stamp.get(id)),workspaceId:"space",pendingPermissions:[],
    ...(steering.has(id)?{activeTurn:{id:"turn"},provider:"claude"}:{})});
  const page=entries=>({entries,pageInfo:{hasMore:false,nextCursor:null}});
  const sdk={
    projects:{list:async()=>({projects:[{projectId:"studio",projectDisplayName:"Studio",projectRootPath:""}]})},
    workspaces:{list:async()=>page([{id:"space",projectId:"studio",workspaceDirectory:"",projectDisplayName:"Studio",name:"space"}])},
    agents:{list:async()=>page([...timelines.keys()].map(id=>({agent:actor(id),project:{projectKey:"studio",projectName:"Studio"}}))),
      ref:(id:string)=>({refresh:async()=>timelines.has(id)?{agent:actor(id)}:null,
        timeline:{refetch:async()=>({epoch:"studio-"+id,entries:timelines.get(id)!.map((item,seqEnd)=>({seqEnd,item}))})},
        send:async(text:string,{messageId}:{messageId:string})=>{
          sent.push({id,text,messageId});append(id,{type:"user_message",text,clientMessageId:messageId});
          if(loseAck) throw Error("synthetic receipt timeout");
        }})},
  };
  function load() {
    const handlers=new Map();
    const old=process.env.PASEO_HOME;
    process.env.PASEO_HOME=root;
    try{contribute({handle:(def,fn)=>handlers.set(def.name,fn),registerSettings(){},addHook:()=>()=>{}} as never);}
    finally{if(old===undefined)delete process.env.PASEO_HOME;else process.env.PASEO_HOME=old;}
    return async (def,input)=>def.output.parse(await handlers.get(def.name)(def.input.parse(input),{paseo:sdk}));
  }
  let rpc=load();
  await rpc(boardScope,{kind:"project",projectId:"studio",enabled:true});
  await rpc(boardScope,{kind:"coordinator",sessionId:"coordinator"});
  const snapshot=()=>rpc(boardSnapshot,{fresh:true});
  function replaceReceivedText(id: string, text: string) {
    timelines.get(id)!.at(-1).text = text;
    stamp.set(id, stamp.get(id)! + 1);
  }
  return {snapshot,replaceReceivedText,running,steering,scopePath:join(data,"scope.json"),photo:input=>rpc(readSessionPhoto,input),answer:input=>rpc(sendDecision,input),ask:(input)=>rpc(askClarification,input),sent,append,loseAck:(value:boolean)=>{loseAck=value;},restart:()=>{rpc=load();}};
}

test("clarifications for two Q3s route, persist, and surface on their original open cards through public RPCs",async()=>{
  const f=await fixture();
  const initial=await f.snapshot();
  const source=initial.trackedDecisions.items;
  expect(source).toHaveLength(2);
  const input=source.map(item=>{
    const card:ClarificationCard={kind:"tracked",source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint};
    return {card,recipientId:item.sessionId,question:"Which audio sample supports Q3?",requestKey:"fixture-question-"+item.id};
  });
  const photo={mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOYvLAHAAOLAcF4E9p3AAAAAElFTkSuQmCC"};
  input[1] = {...input[1], images:[photo]};
  const editor=await f.ask(input[0]);
  expect((await f.ask(input[0])).messageId).toBe(editor.messageId);
  f.loseAck(true);
  await expect(f.ask(input[1])).rejects.toThrow();
  f.loseAck(false);
  f.restart();
  const writer=await f.ask(input[1]);
  expect(writer.messageId).not.toBe(editor.messageId);
  expect(isBoardPhotoMessage(editor.messageId)).toBe(false);
  expect(isBoardPhotoMessage(writer.messageId)).toBe(true);
  expect(await f.photo({sessionId:"writer",messageId:writer.messageId,index:0})).toEqual({count:1,image:photo});
  expect(await f.photo({sessionId:"editor",messageId:writer.messageId,index:0})).toEqual({count:0,image:null});
  expect(f.sent.map(m=>m.id)).toEqual(["editor","writer"]);
  for(const [index,m] of f.sent.entries()) {
    expect(m.text).toContain(source[index].id);
    expect(m.text).toContain(source[index].fingerprint);
    expect(m.text).toContain(source[index].sessionId);
    expect(m.text).toContain("Q3");
    expect(m.text).toContain(input[index].question);
  }
  let board=await f.snapshot();
  expect(board.trackedDecisions.items.map(c=>c.id)).toEqual(source.map(c=>c.id));
  expect(board.clarifications.map(q=>q.cardKey).sort()).toEqual(input.map(i=>clarificationKey(i.card)).sort());
  expect(board.clarifications.every(q=>q.status==="sent" && !q.response)).toBe(true);
  f.append("writer",{type:"assistant_message",text:"Use the **second clip** for the narration."});
  f.append("editor",{type:"assistant_message",text:"The first clip shows the edit."});
  board=await f.snapshot();
  for(const [index,response] of ["The first clip shows the edit.","Use the **second clip** for the narration."].entries()){
    const matching=board.clarifications.filter(q=>q.cardKey===clarificationKey(input[index].card));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({response,recipientId:source[index].sessionId,question:input[index].question});
  }
  expect(board.trackedDecisions.items.map(c=>c.fingerprint)).toEqual(source.map(c=>c.fingerprint));
  expect(board.replyHistory ?? []).toBeEmpty();
  f.restart();
  expect((await f.snapshot()).clarifications).toEqual(board.clarifications);
});

test("an explanation in the source session keeps the original choice answerable until the person chooses or the conversation moves on",async()=>{
  const f=await fixture();
  for(const id of ["editor","writer"]) f.append(id,{type:"assistant_message",text:"Q3. Shall I keep the original cutoff?"});
  const original=await f.snapshot();
  const before=(id:string)=>original.sessions.find(row=>row.id===id).decision;
  for(const id of ["editor","writer"]) {
    const source=before(id);
    await f.ask({card:{kind:"session",projectId:"studio",sessionId:id,version:source.version},
      recipientId:id,question:"What is the current value?",requestKey:"fixture-native-question-"+id});
    f.append(id,{type:"assistant_message",text:"The current value is 0.04 seconds."});
  }
  const explained=await f.snapshot();
  expect(explained.clarifications).toHaveLength(2);
  for(const id of ["editor","writer"]) expect(explained.sessions.find(row=>row.id===id).decision).toEqual(before(id));
  const answer=(id:string)=>f.answer({projectId:"studio",sessionId:id,recipientId:id,version:before(id).version,
    action:"reply",text:"Use 0.10 seconds.",requestKey:"fixture-native-answer-"+id});
  f.append("writer",{type:"user_message",text:"A separate studio request.",clientMessageId:"other-event"});
  const later=await f.snapshot();
  expect(later.sessions.find(row=>row.id==="writer").decision?.version).not.toBe(before("writer").version);
  await expect(answer("writer")).rejects.toThrow();
  const final=await answer("editor");
  expect(final.recipientId).toBe("editor");
  expect(f.sent.map(m=>m.id)).toEqual(["editor","writer","editor"]);
  expect((await f.snapshot()).replyHistory?.some(r=>r.answer==="Use 0.10 seconds.")).toBe(true);
});

test("a clarification on a tracked card with inline native controls keeps the thread and the original native answer",async()=>{
  const originalQuestion="Q3. Shall I keep the original cutoff?";
  const f=await fixture(originalQuestion);
  f.append("editor",{type:"assistant_message",text:originalQuestion});
  const initial=await f.snapshot();
  const item=initial.trackedDecisions.items.find(entry=>entry.id==="timing-editor");
  expect(item.matchedSessionId).toBe("editor");
  expect(item.questions).toHaveLength(0);
  const original=initial.sessions.find(session=>session.id===item.matchedSessionId).decision;
  expect(original.question).toBe(originalQuestion);
  const card=trackedClarificationCard(item,initial.sessions);
  expect(card.sessionQuestion).toEqual({projectId:"studio",sessionId:"editor",version:original.version});
  const input={card,recipientId:"editor",question:"Which take preserves the final consonant?",requestKey:"fixture-matched-question"};
  const sent=await f.ask(input);
  expect(f.sent[0].text).toContain(original.question);
  expect(f.sent[0].text).toContain(original.version);
  const response="The second take preserves the final consonant.";
  f.append("editor",{type:"assistant_message",text:response});

  const explained=await f.snapshot();
  const tracked=explained.trackedDecisions.items.find(entry=>entry.key===item.key);
  expect(tracked.matchedSessionId).toBe("editor");
  const session=explained.sessions.find(row=>row.id===tracked.matchedSessionId);
  expect(session.lane).toBe("human");
  expect(session.decision).toEqual(original);
  expect(explained.clarifications).toHaveLength(1);
  expect(explained.clarifications[0]).toMatchObject({cardKey:clarificationKey(card),messageId:sent.messageId,recipientId:"editor",question:input.question,response});
  expect(explained.replyHistory ?? []).toBeEmpty();

  const result=await f.answer({projectId:"studio",sessionId:"editor",recipientId:"editor",version:original.version,
    action:"reply",text:"Use the second take.",requestKey:"fixture-matched-final"});
  expect(result.recipientId).toBe("editor");
  expect(f.sent.map(message=>message.id)).toEqual(["editor","editor"]);
  expect(f.sent[1].text).toContain("Use the second take.");
  expect((await f.snapshot()).replyHistory?.some(entry=>entry.answer==="Use the second take.")).toBe(true);

  f.append("editor",{type:"user_message",text:"Review today's revised cut.",clientMessageId:"new-edit-request"});
  f.append("editor",{type:"assistant_message",text:originalQuestion});
  const updated=await f.snapshot();
  const next=updated.sessions.find(row=>row.id==="editor").decision;
  expect(next.question).toBe(original.question);
  expect(next.version).not.toBe(original.version);
  await expect(f.ask({...input,requestKey:"fixture-matched-request-after-revision"})).rejects.toThrow();
  expect(f.sent).toHaveLength(2);
});

test("reopening the board confirms the exact accepted question before the assistant replies", async () => {
  const f = await fixture();
  const board = await f.snapshot();
  const record = board.trackedDecisions.items[0];
  const card = trackedClarificationCard(record, board.sessions);
  const question = { card, recipientId: record.sessionId, requestKey: "fixture-lost-confirmation", question: "Which take?" };
  f.loseAck(true);
  await expect(f.ask(question)).rejects.toThrow();
  f.loseAck(false);
  f.restart();

  const received = f.sent[0];
  f.replaceReceivedText(received.id, received.text + " changed");
  const mismatch = await f.snapshot();
  expect(mismatch.clarifications[0].status).toBe("pending");
  const another = { ...question, requestKey: "fixture-second-question", question: "Which speaker?" };
  await expect(f.ask(another)).rejects.toThrow();
  expect(f.sent).toHaveLength(1);

  f.running.add(received.id);
  f.replaceReceivedText(received.id, received.text);
  const recovered = await f.snapshot();
  expect(recovered.clarifications[0]).toMatchObject({ messageId: received.messageId, status: "sent" });
  expect(recovered.clarifications[0].response).toBeUndefined();
  f.restart();
  expect((await f.ask(question)).messageId).toBe(received.messageId);
  expect(f.sent).toHaveLength(1);
  f.running.delete(received.id);
  await f.ask(another);
  expect(f.sent).toHaveLength(2);
});

test("a clarification photo receipt from the previous release reuses its accepted UUID without forwarding twice", async () => {
  const f = await fixture();
  const item = (await f.snapshot()).trackedDecisions.items[0];
  const input = {card:{kind:"tracked",source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint},
    recipientId:item.sessionId,question:"Which reference?",requestKey:"previous-clarification-photo",
    images:[{mimeType:"image/png",data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOYvLAHAAOLAcF4E9p3AAAAAElFTkSuQmCC"}]};
  f.loseAck(true);
  await expect(f.ask(input)).rejects.toThrow();
  const {messageId:wire,text} = f.sent[0];
  const h = createHash("sha256").update("coordinator-board/clarification/" + input.requestKey).digest("hex");
  const oldId = [h.slice(0,8),h.slice(8,12),"4"+h.slice(13,16),"8"+h.slice(17,20),h.slice(20,32)].join("-");
  new PreferenceStore(f.scopePath).change(state => {
    state.clarifications[oldId] = {...state.clarifications[wire],messageId:oldId};
    delete state.clarifications[wire];
  });
  f.replaceReceivedText(item.sessionId, "Unrelated delivery");
  f.append(item.sessionId,{type:"user_message",text,clientMessageId:oldId});
  f.restart();
  expect((await f.ask(input)).messageId).toBe(oldId);
  expect((await f.ask(input)).messageId).toBe(oldId);
  expect(f.sent).toHaveLength(1);
  f.append(item.sessionId,{type:"assistant_message",text:"Use the second sample."});
  expect((await f.snapshot()).clarifications[0]).toMatchObject({messageId:oldId,status:"sent",response:"Use the second sample."});
});

test("a short reply to a restored card never joins the turn of the session's next question bare",async()=>{
  const f=await fixture();
  f.append("editor",{type:"assistant_message",text:"Q3. Shall I keep the original cutoff?"});
  const before=(await f.snapshot()).sessions.find(row=>row.id==="editor").decision;
  await f.ask({card:{kind:"session",projectId:"studio",sessionId:"editor",version:before.version},
    recipientId:"editor",question:"What is the current value?",requestKey:"fixture-restored-question"});
  // The explanation asks a new question. The board still shows the original card for the answer.
  f.append("editor",{type:"assistant_message",text:"The current value is 0.04 seconds.\nShall I also trim the intro? Please choose one."});
  expect((await f.snapshot()).sessions.find(row=>row.id==="editor").decision?.version).toBe(before.version);
  f.steering.add("editor");
  const sent=f.sent.length;
  const result=await f.answer({projectId:"studio",sessionId:"editor",recipientId:"editor",version:before.version,
    action:"reply",text:"yes",requestKey:"fixture-restored-answer"});
  expect(result.queued).toBe(true);
  expect(f.sent.slice(sent)).toEqual([]);
});

test("a reply to a restored card closes the original question, and the session's new question stays open",async()=>{
  const f=await fixture();
  f.append("editor",{type:"assistant_message",text:"Q3. Shall I keep the original cutoff?"});
  const before=(await f.snapshot()).sessions.find(row=>row.id==="editor").decision;
  await f.ask({card:{kind:"session",projectId:"studio",sessionId:"editor",version:before.version},
    recipientId:"editor",question:"What is the current value?",requestKey:"fixture-restored-question-idle"});
  f.append("editor",{type:"assistant_message",text:"The current value is 0.04 seconds.\nShall I also trim the intro? Please choose one."});
  expect((await f.snapshot()).sessions.find(row=>row.id==="editor").decision?.version).toBe(before.version);
  await f.answer({projectId:"studio",sessionId:"editor",recipientId:"editor",version:before.version,
    action:"reply",text:"Keep the original cutoff.",requestKey:"fixture-restored-answer-idle"});
  f.append("editor",{type:"assistant_message",text:"Kept the original cutoff."});
  const after=(await f.snapshot()).sessions.find(row=>row.id==="editor");
  expect(after.decision?.question).toContain("trim the intro");
  expect(after.keptQuestion?.older ?? []).toEqual([]);
});
