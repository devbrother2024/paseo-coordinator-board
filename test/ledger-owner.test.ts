import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contribute from "../index.server";
import { boardSnapshot, boardScope } from "../shared/contract";
import { askClarification, clarificationRecipient, trackedClarificationCard } from "../shared/clarifications";
import { trackedRecipient, resolveTrackedDecision } from "../shared/tracked-decisions";

const scratch:string[] = [];
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path,{recursive:true,force:true}); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(),"ledger-owner-")); scratch.push(root);
  const data = join(root,"plugin-data","coordinator-board"), ledger = join(root,"ledger");
  mkdirSync(data,{recursive:true}); mkdirSync(ledger);
  const ownerPath = join(root,"manager.json");
  const configure = (coordinatorFile?:string) => writeFileSync(join(data,"tracked-sources.json"),JSON.stringify({
    version:1,sources:[{source:"production",directory:ledger,projectId:"studio",projectTitle:"Studio",coordinatorFile}],
  }));
  const owner = (id:string) => writeFileSync(ownerPath,JSON.stringify({agentId:id}));
  const project = new Map(["general","operator","next","source"].map(id => [id,"studio"]));
  project.set("outside","private");
  configure(ownerPath); owner("operator");
  writeFileSync(join(ledger,"decisions.json"),JSON.stringify({items:[
    {id:"check",title:"Verify recording",kind:"human",where:"human",agentId:"source",sourceCoordinatorId:"general"},
    {id:"warning",title:"Replace media",kind:"answer",where:"manager",agentId:"source",coordinatorFile:"/fake/file",sourceCoordinatorId:"general"},
  ]}));
  writeFileSync(join(data,"tracked-decisions.json"),JSON.stringify({version:1,items:[
    {source:"flat",projectId:"studio",id:"independent",title:"Independent",where:"manager",sourceCoordinatorId:"operator"},
  ]}));
  const sendLog:{id:string;text:string}[] = [];
  const hook = { refresh: () => {}, loseReceipt: false };
  const actor = (id:string) => ({id,title:id,updatedAt:"1",status:"idle",pendingPermissions:[]});
  const page = (entries:unknown[]) => ({entries,pageInfo:{hasMore:false,nextCursor:null}});
  const sdk = {
    workspaces:{list:async()=>page([])},
    projects:{list:async()=>({projects:[{projectId:"studio",projectDisplayName:"Studio",projectRootPath:""}]})},
    agents:{list:async()=>page([...project].map(([id,projectKey])=>({agent:actor(id),project:{projectKey}}))),
      ref:(id:string)=>({refresh:async()=>{hook.refresh();return project.has(id)?{agent:actor(id)}:null;},
        timeline:{refetch:async()=>({epoch:id,entries:[]})},
        send:async(text:string)=>{sendLog.push({id,text}); if(hook.loseReceipt) throw Error("lost receipt");}})},
  };
  const handlers = new Map(), previous = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
  try {contribute({handle:(rpc,fn)=>handlers.set(rpc.name,fn),registerSettings(){},addHook:()=>()=>{}} as never);}
  finally {if(previous===undefined)delete process.env.PASEO_HOME; else process.env.PASEO_HOME=previous;}
  const rpc = async (def,input) => def.output.parse(await handlers.get(def.name)(def.input.parse(input),{paseo:sdk}));
  await rpc(boardScope,{kind:"project",projectId:"studio",enabled:true});
  await rpc(boardScope,{kind:"coordinator",sessionId:"general"});
  const board = () => rpc(boardSnapshot,{fresh:true});
  const answer = (item,recipientId?:string) => rpc(resolveTrackedDecision,{
    id:item.id,source:item.source,projectId:item.projectId,fingerprint:item.fingerprint,answer:"Ready",recipientId,
  });
  const ask = (item,snapshot,id:string,key:string) => rpc(askClarification,{
    card:trackedClarificationCard(item,snapshot.sessions),recipientId:id,question:"What changed?",requestKey:key,
  });
  return {board,answer,ask,owner,ownerPath,configure,project,sendLog,hook,ledger};
}

test("history failures block tracked questions and leave independent records usable", async () => {
  const f = await fixture();
  const before = await f.board();
  const card = before.trackedDecisions.items.find(i => i.id === "warning");
  const historyPath = join(f.ledger,"live","board-questions.tsv");
  mkdirSync(historyPath,{recursive:true});
  const blocked = await f.board();
  const unavailable = blocked.trackedDecisions.items.find(i => i.id === card.id);
  expect(unavailable).toMatchObject({ fingerprint:card.fingerprint, historyUnavailable:true });
  expect(clarificationRecipient(trackedClarificationCard(unavailable,blocked.sessions),blocked)).toBeNull();
  await expect(f.ask(card,before,"operator","unreadable-history")).rejects.toThrow();
  expect((await f.answer(unavailable,"operator")).status).toBe("unavailable");
  expect(f.sendLog).toBeEmpty();
  const independent = blocked.trackedDecisions.items.find(i => i.id === "independent");
  expect((await f.answer(independent)).status).toBe("closed");
});

test("only an operator-configured local owner can receive imported coordinator answers and questions", async () => {
  const f = await fixture(), board = await f.board();
  const [flat,check,warning] = board.trackedDecisions.items;
  expect(flat.sourceCoordinatorId).toBeUndefined();
  expect(trackedRecipient(flat,board.coordinator,board.sessions)).toBe("general");
  for (const item of [check,warning]) {
    expect(item.sourceCoordinatorId).toBe("operator");
    expect(trackedRecipient(item,board.coordinator,board.sessions)).toBe("operator");
    expect(clarificationRecipient(trackedClarificationCard(item,board.sessions),board)).toBe("operator");
    await expect(f.ask(item,board,"general","foreign-request-"+item.id)).rejects.toThrow();
    expect((await f.answer(item,"general")).status).toBe("changed");
  }
  await f.ask(warning,board,"operator","verified-owner-question");
  expect((await f.answer(check,"operator")).status).toBe("sent");
  expect(f.sendLog.map(m=>m.id)).toEqual(["operator","operator"]);
  f.owner("next");
  const changed = await f.board();
  expect(changed.trackedDecisions.items.some(i=>i.id===check.id)).toBe(false);
  expect(changed.replyHistory.find(r=>r.title===check.title).recipientId).toBe("operator");
  expect(changed.trackedDecisions.items.find(i=>i.id==="warning")).toMatchObject({sourceCoordinatorId:"next",fingerprint:warning.fingerprint});
});

test("missing, invalid, remote, inaccessible, and rotated owners cannot fall back to the current coordinator", async () => {
  const f = await fixture();
  const board = await f.board(), item = board.trackedDecisions.items.find(i=>i.id==="warning");
  for (const configure of [
    () => f.configure(), () => f.configure("relative.json"),
    () => f.configure(f.ownerPath+".missing"),
    () => {f.configure(f.ownerPath);writeFileSync(f.ownerPath,"invalid");},
    () => f.owner("remote-owner"), () => f.owner("outside"),
  ]) {
    configure();
    const current = await f.board(), record = current.trackedDecisions.items.find(i=>i.id==="warning");
    expect(record.fingerprint).toBe(item.fingerprint);
    expect(trackedRecipient(record,current.coordinator,current.sessions)).toBeNull();
    expect(clarificationRecipient(trackedClarificationCard(record,current.sessions),current)).toBeNull();
    expect((await f.answer(record,"general")).status).toBe("changed");
    await expect(f.ask(record,current,"general","missing-recipient-key")).rejects.toThrow();
  }
  f.owner("operator");
  f.hook.refresh=()=>f.owner("next");
  expect((await f.answer(item,"operator")).status).toBe("changed");
  let refresh = 0;
  f.owner("operator");
  f.hook.refresh=()=>{if(++refresh===2)f.owner("next");};
  await expect(f.ask(item,board,"operator","rotated-in-flight")).rejects.toThrow();
  f.owner("operator"); refresh = 0;
  f.hook.refresh = () => { if (++refresh === 2) f.project.set("operator","private"); };
  await expect(f.ask(item,board,"operator","moved-outside-scope")).rejects.toThrow();
  expect(f.sendLog).toBeEmpty();
});

test("a rotation during a pending answer preserves its receipt and never resends it to the new owner", async () => {
  const f = await fixture(), board = await f.board(), item = board.trackedDecisions.items.find(i=>i.id==="check");
  f.hook.loseReceipt=true;
  expect((await f.answer(item,"operator")).status).toBe("unconfirmed");
  f.hook.loseReceipt=false; f.owner("next");
  expect((await f.answer(item,"next")).status).toBe("changed");
  expect((await f.answer(item,"operator")).status).toBe("changed");
  expect((await f.board()).replyHistory.find(r=>r.title===item.title)).toMatchObject({status:"pending",recipientId:"operator"});
  expect(f.sendLog.map(m=>m.id)).toEqual(["operator"]);
});
