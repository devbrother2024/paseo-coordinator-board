import { SessionPhotoStore } from "../server/session-photos";
import { isBoardPhotoMessage } from "../shared/session-photos";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendDecision, type DecisionInput } from "../shared/decision-actions";
import { requestRecommendation } from "../shared/recommendation";
import { registerRecommendation } from "../server/recommendation";
import { ConversationReader } from "../server/conversation";
import { decorateDecision, DecisionSender } from "../server/decisions";
import { discoverSessions } from "../server/discovery";
import { NoteStore } from "../server/notes";
import { PreferenceStore } from "../server/preferences";
import { applyDoneNotes } from "../server/session-decisions";
import { closeQuestionByPerson } from "../server/open-questions";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "decision-card-test-"));
  const prefs = new PreferenceStore(join(root, "prefs.json"));
  prefs.change(s => { s.projects = ["project"]; s.coordinator = "coordinator"; });
  const notes = new NoteStore(join(root, "notes.json"));
  const reader = new ConversationReader();
  const sender = new DecisionSender(prefs, notes, reader);
  const actors = Object.fromEntries(["worker", "coordinator", "other"].map(id => [id, {
    id, title: id, updatedAt: "1", status: "idle", pendingPermissions: [], activeTurn: null,
  }]));
  const timelines = { worker: [{ type: "assistant_message", text: "자막을 한 줄로 할까요?" }], coordinator: [], other: [] };
  const sent = [];
  const state = { beforeRefresh: () => {}, loseReceipt: false };
  const page = entries => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });
  const sdk = {
    workspaces: { list: async () => page([]) },
    agents: {
      list: async () => page(Object.entries(actors).map(([id, agent]) => ({
        agent, project: { projectKey: id === "other" ? "unmanaged" : "project", projectName: "책" },
      }))),
      ref: id => ({
        refresh: async () => { state.beforeRefresh(); return { agent: actors[id] }; },
        timeline: { refetch: async () => ({ epoch: id, entries: timelines[id].map((item, seqEnd) => ({ item, seqEnd })) }) },
        send: async (text, { messageId, images }) => {
          sent.push({ id, text, messageId, ...(images ? {images} : {}) });
          timelines[id].push({ type: "user_message", text, clientMessageId: messageId });
          if (state.loseReceipt) throw Error("Lost receipt");
        },
      }),
    },
  };

  async function row() {
    const result = (await discoverSessions(sdk)).find(r => r.id === "worker");
    const scope = prefs.read();
    await reader.decorate(sdk, [result], scope);
    // As a snapshot does: a done note that already closed a question no longer hides the next one.
    const visibleNotes = notes.visible(new Set(["worker"]));
    applyDoneNotes([result], visibleNotes, scope);
    decorateDecision(result, visibleNotes.worker, scope);
    return result;
  }
  const initial = await row();
  const input: DecisionInput = {
    projectId: "project", sessionId: "worker", recipientId: "worker", version: initial.decision.version,
    action: "reply", text: "한 줄로 해 주세요.", requestKey: "send-000000001",
  };
  const send = (changes: Partial<DecisionInput> = {}) => sender.send(sdk, sendDecision.input.parse({ ...input, ...changes }));
  return { prefs, notes, sent, send, row, input, actors, timelines, state, reader, sdk, sender };
}

test("구조화 질문·추천·선택은 해당 근거에만 붙고 자유 입력은 클릭한 문장 그대로 원래 세션으로 간다", async () => {
  const f = await fixture();
  const original = await f.row();
  expect(original.decision.source).toBe("conversation");
  f.prefs.change(scope => { scope.judgments.worker = {
    projectId: "project", evidenceId: original.evidenceId, kind: "question", text: "자막 줄 수",
    content: { question: "몇 줄로 만들까요?", recommendation: "한 줄로", options: [{ label: "두 줄", reply: "두 줄로 나눠 주세요." }] },
  }; });
  const current = await f.row();
  expect(current.decision).toMatchObject({ source: "coordinator", question: "몇 줄로 만들까요?", options: [{ label: "두 줄", reply: "두 줄로 나눠 주세요." }] });
  await expect(f.send()).rejects.toThrow("바뀌었습니다");
  const text = "두 줄로 나눠 주세요.\n마지막 자막은 유지해 주세요.";
  const r = await f.send({ version: current.decision.version, text });
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({id: "worker", messageId: r.messageId});
  const [header,metadata,blank,...body] = f.sent[0].text.split("\n");
  expect(header).toContain("Coordinator Board");
  expect(JSON.parse(metadata)).toMatchObject({
    projectId:current.projectId,sourceSessionId:current.id,recipientSessionId:"worker",revision:current.decision.version,
    questions:[{id:current.decision.version,text:current.decision.question}],
  });
  expect(blank).toBe("");
  expect(body.join("\n")).toBe(text);
  expect((await f.row()).decisionAnswered).toBe(true);
});

test("질문과 조율은 답변 처리하지 않으며 지정한 세션 이외에는 보낼 수 없다", async () => {
  const f = await fixture();
  await expect(f.send({ recipientId: "other" })).rejects.toThrow();
  await expect(f.send({ action: "coordinate", recipientId: "other" })).rejects.toThrow();
  await f.send({ action: "coordinate", recipientId: "coordinator", text: "두 작업의 순서를 조율해 주세요." });
  expect((await f.row()).decision?.source).toBe("conversation");
  expect(f.sent[0].id).toBe("coordinator");
  for (const field of ["worker","coordinator",f.input.version,"자막을 한 줄로 할까요?"]) {
    expect(f.sent[0].text).toContain(field);
  }
  expect(f.sent[0].text.endsWith("두 작업의 순서를 조율해 주세요.")).toBe(true);
  await f.send({ action: "question", text: "두 줄로 나누면 어디에서 끊나요?", requestKey: "send-000000002" });
  expect(f.sent[1].id).toBe("worker");
  expect(f.prefs.read().answers).toEqual({});
});

test("권한 요청, 관리 범위 철회, 수신자 교체, 변경된 발췌를 전송 직전 거절한다", async () => {
  for (const scenario of ["native", "recipient-native", "stale", "removed", "rotated", "activity"]) {
    const f = await fixture();
    const changes = ["recipient-native", "rotated"].includes(scenario) ? { action: "coordinate", recipientId: "coordinator" } as const : {};
    if (scenario === "native") {
      f.actors.worker.pendingPermissions.push({ id: "perm" });
      expect((await f.row()).decision?.source).toBe("permission");
    }
    if (scenario === "recipient-native") f.state.beforeRefresh = () => { f.actors.coordinator.pendingPermissions.push({ id: "perm" }); };
    if (scenario === "removed") f.state.beforeRefresh = () => f.prefs.change(s => { s.projects = []; });
    if (scenario === "rotated") f.state.beforeRefresh = () => f.prefs.change(s => { s.coordinator = "other"; });
    if (scenario === "activity") f.state.beforeRefresh = () => { f.actors.worker.updatedAt = "2"; };
    if (scenario === "stale") f.timelines.worker.push({ type: "assistant_message", text: "새 기획 제목을 정해 주세요." });
    await expect(f.send(changes)).rejects.toThrow();
    expect(f.sent).toBeEmpty();
  }
});

test("수신 확인이 끊겨도 동일 요청을 재전송하지 않고 타임라인의 같은 메시지 ID로 복구한다", async () => {
  const f = await fixture();
  f.state.loseReceipt = true;
  const text = "한 줄로 해 주세요.";
  await expect(f.send()).rejects.toThrow("전송 결과");
  await expect(f.send({ text: "바뀐 답" })).rejects.toThrow();
  await expect(f.send({ text: "다른 부탁", requestKey: "other-000000000" })).rejects.toThrow();
  const restarted = new DecisionSender(f.prefs, f.notes, new ConversationReader());
  const result = await restarted.send(f.sdk, { ...f.input, requestKey: "after-restart-0001" });
  expect(result.messageId).toBe(f.sent[0].messageId);
  await expect(restarted.send(f.sdk, { ...f.input, text: "different", requestKey: "after-restart-0001" })).rejects.toThrow("같은 전송 키");
  const replay = await restarted.send(f.sdk, { ...f.input, text });
  expect(replay).toEqual(result);
  expect(f.sent).toHaveLength(1);
});

test("동시 클릭을 한 번만 전달하고 이전 형식의 세션 보고 답장은 후속 결과 확인으로 남긴다", async () => {
  const f = await fixture();
  f.timelines.worker.length = 0;
  f.actors.worker.updatedAt = "2";
  f.notes.update({ sessionId: "worker", kind: "question", text: "제목을 정해 주세요.", expectedRevision: 0 }, "agent");
  const note = await f.row();
  expect(note.decision).toMatchObject({ source: "agent-note", question: "제목을 정해 주세요." });
  const pair = await Promise.all([f.send({ version: note.decision.version }), f.send({ version: note.decision.version })]);
  expect(pair[0]).toEqual(pair[1]);
  expect(f.sent).toHaveLength(1);
  expect((await f.row()).decisionAnswered).toBe(true);
  f.notes.update({ sessionId: "worker", kind: "question", text: "다음 제목은요?", expectedRevision: 1 }, "agent");
  expect((await f.row()).decision?.question).toBe("다음 제목은요?");
});

test("발송 결과가 불명확하고 수신 타임라인에 해당 ID가 없으면 확인 없이 재전송하지 않는다", async () => {
  const f = await fixture();
  f.state.loseReceipt = true;
  await expect(f.send()).rejects.toThrow("전송 결과");
  // A matching sentence from another sender is not a receipt for this board message.
  const last = f.timelines.worker.at(-1);
  last.clientMessageId = "different-id";
  await expect(f.send()).rejects.toThrow("이전 전송 결과");
  expect(f.sent).toHaveLength(1);
  expect(f.prefs.read().answers).toEqual({});
});

test("a recommendation refresh targets just one card and leaves its answer open", async () => {
  const f = await fixture();
  let handler;
  registerRecommendation({handle(contract, fn) { expect(contract.name).toBe(requestRecommendation.name); handler = fn; }}, f.sender);
  const input = requestRecommendation.input.parse({
    sessionId:"worker", projectId:"project", version:f.input.version,
    requestKey:"recommendation-click-01", coordinator:"coordinator", language:"en",
  });
  const invoke = (args = input) => handler(args, {paseo:f.sdk});
  const results = await Promise.all([invoke(), invoke()]);
  expect(results[1]).toEqual(results[0]);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].id).toBe("coordinator");
  expect(f.sent[0].text).toContain('"sessionId":"worker"');
  expect(f.sent[0].text).toContain("content.needsInput");
  expect(f.sent[0].text).not.toContain("answer_board_fact");
  expect(f.prefs.read().answers).toEqual({});
  f.actors.worker.pendingPermissions.push({id:"native"});
  expect(await invoke({...input, requestKey:"repeat-recommendation-02"})).toEqual(results[0]);
  await expect(invoke({...input, language:"ko", requestKey:"different-recommendation-03"})).rejects.toThrow();
  expect(f.sent).toHaveLength(1);
});

test("a native card keeps a single durable record with the original question, recipient, and sent text", async () => {
  const f = await fixture();
  const original = await f.row();
  const delivered = await f.send({text:"Use two lines"});
  await f.send({text:"Use two lines", requestKey:"repeat-0000001"});
  const owned = Object.entries(f.prefs.read().decisionReceipts).filter(([id,r])=>!r.messageId || r.messageId === id);
  expect(owned).toHaveLength(1);
  expect(owned[0][0]).toBe(delivered.messageId);
  expect(owned[0][1]).toMatchObject({status:"sent",activity:{projectId:"project",title:original.decision.question,answer:"Use two lines",recipientId:"worker",coordinator:false}});
});

const replyPng = {mimeType:"image/png" as const,data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mOYvLAHAAOLAcF4E9p3AAAAAElFTkSuQmCC"};
const replyWebp = {mimeType:"image/webp" as const,data:"UklGRi4AAABXRUJQVlA4ICIAAABwAQCdASoBAAEAAUAmJZQCdAFAAAD+67eowmknPaRBAAAA"};

test("a photo-only decision reply reaches the original session and a lost acknowledgement never sends different photos", async () => {
  const f = await fixture();
  const request = {text:"",images:[replyPng]};
  expect(sendDecision.input.safeParse({...f.input,...request}).success).toBe(true);
  expect(sendDecision.input.safeParse({...f.input,text:"   ",images:[]}).success).toBe(false);
  await expect(async () => f.send({...request,images:[{...replyPng,data:replyWebp.data}]})).toThrow();
  expect(f.sent).toBeEmpty();
  f.state.loseReceipt = true;
  await expect(f.send(request)).rejects.toThrow("전송 결과");
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({id:"worker",images:[replyPng]});
  const wire = f.sent[0].messageId;
  expect(isBoardPhotoMessage(wire)).toBe(true);
  expect(f.prefs.read().decisionReceipts[wire].messageId).toBe(wire);
  const previews = new SessionPhotoStore(join(f.prefs.directory, "session-photos"));
  expect(previews.read("worker", wire, 0)).toEqual({count:1,image:replyPng});
  expect(previews.read("coordinator", wire, 0).count).toBe(0);
  expect(f.sent[0].text).toContain("자막을 한 줄로 할까요?");
  expect(f.sent[0].text).not.toContain(replyPng.data);
  await expect(f.send({...request,images:[replyWebp]})).rejects.toThrow();
  const restarted = new DecisionSender(f.prefs,f.notes,new ConversationReader());
  const received = f.timelines.worker.at(-1);
  received.text = "A different event";
  await expect(restarted.send(f.sdk,{...f.input,...request})).rejects.toThrow();
  received.text = f.sent[0].text;
  const result = await restarted.send(f.sdk,{...f.input,...request,requestKey:"after-restart-photo-01"});
  expect(result.messageId).toBe(f.sent[0].messageId);
  expect(f.sent).toHaveLength(1);
  expect(JSON.stringify(f.prefs.read())).not.toContain(replyPng.data);
});

test("an in-flight text reply from before envelopes remains recoverable after the upgrade", async () => {
  const f = await fixture();
  const original = await f.row();
  const digest = (value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const hash = digest(["coordinator-board/decision",f.input.requestKey]);
  const messageId = [hash.slice(0,8),hash.slice(8,12),"4"+hash.slice(13,16),"8"+hash.slice(17,20),hash.slice(20,32)].join("-");
  const {projectId,sessionId,recipientId,version,action,text}=f.input;
  f.prefs.change(current=>{
    current.decisionReceipts[messageId]={
      fingerprint:digest([projectId,sessionId,recipientId,version,action,text]), sessionId, version,
      evidenceId:original.evidenceId, status:"pending",
      activity:{projectId,title:original.decision.question,at:"2026-11-21T05:00:00.000Z",answer:text,recipientId,coordinator:false},
    };
  });
  f.timelines.worker.push({type:"user_message",text,clientMessageId:messageId});
  expect((await f.send()).messageId).toBe(messageId);
  expect(f.prefs.read().decisionReceipts[messageId].status).toBe("sent");
  expect(f.sent).toBeEmpty();
});

test("pending and sent photo replies from before the preview upgrade retain the original UUID on retry", async () => {
  const f = await fixture();
  const value = {text:"사진 첨부", images:[replyPng]};
  f.state.loseReceipt = true;
  await expect(f.send(value)).rejects.toThrow();
  const wire = f.sent[0].messageId;
  const h = createHash("sha256").update(JSON.stringify(["coordinator-board/decision", f.input.requestKey])).digest("hex");
  const oldId = [h.slice(0,8),h.slice(8,12),"4"+h.slice(13,16),"8"+h.slice(17,20),h.slice(20,32)].join("-");
  f.prefs.change(s => {
    const { messageId, ...older } = s.decisionReceipts[wire];
    s.decisionReceipts[oldId] = older;
    delete s.decisionReceipts[wire];
  });
  f.timelines.worker.at(-1).clientMessageId = oldId;
  const restarted = new DecisionSender(f.prefs, f.notes, new ConversationReader());
  const input = {...f.input,...value};
  expect((await restarted.send(f.sdk,input)).messageId).toBe(oldId);
  expect((await restarted.send(f.sdk,input)).messageId).toBe(oldId);
  expect(f.sent).toHaveLength(1);
  expect(f.prefs.read().decisionReceipts[wire]).toBeUndefined();
});

test("only opted-in operations steer supported active turns and permission or error states always block",async()=>{
  const {canReceiveBoardInput}=await import("../server/discovery");
  const active={status:"running",activeTurn:{id:"turn"},pendingPermissions:[],provider:"claude"};
  for (const provider of ["claude","codex"]) {
    expect(canReceiveBoardInput({...active,provider},true)).toBe(true);
    expect(canReceiveBoardInput({...active,provider},false)).toBe(false);
    expect(canReceiveBoardInput({...active,provider,attentionReason:"error"},true)).toBe(false);
    expect(canReceiveBoardInput({...active,provider,pendingPermissions:[{id:"permission"}]},true)).toBe(false);
    expect(canReceiveBoardInput({...active,provider,attentionReason:"permission"},true)).toBe(false);
  }
  expect(canReceiveBoardInput({...active,provider:"custom"},true)).toBe(false);
  expect(canReceiveBoardInput({...active,status:"closed"},true)).toBe(false);
  const f=await fixture();
  Object.assign(f.actors.coordinator,active);
  await f.send({action:"coordinate",recipientId:"coordinator",text:"이 질문을 확인해 주세요."});
  expect(f.sent[0].id).toBe("coordinator");
});

test("an unchanged open conversation card steers a running worker, while a new turn message invalidates it", async () => {
  for (const provider of ["claude", "codex"]) {
    const f = await fixture();
    Object.assign(f.actors.worker, {status:"running", provider, activeTurn:{id:"turn"}});
    await f.send();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].text).toBe(f.input.text);
    const changed = await fixture();
    Object.assign(changed.actors.worker, {status:"running", provider, activeTurn:{id:"turn"}});
    changed.timelines.worker.push({type:"user_message", text:"Choose a different layout."});
    await expect(changed.send()).rejects.toThrow();
    expect(changed.sent).toBeEmpty();
  }
});

test("a reply to a question kept after another session's message never joins the new turn bare", async () => {
  const f = await fixture();
  // Another session starts a new turn on the worker after its question. The card stays the same.
  f.timelines.worker.push({type:"tool_call", callId:"paseo-agent-message:m1", name:"message", status:"completed",
    agentMessage:{event:"message", sender:{id:"other"}, text:"Please review the release notes."}});
  Object.assign(f.actors.worker, {status:"running", provider:"claude", activeTurn:{id:"turn"}});
  expect(await f.send()).toMatchObject({queued:true});
  expect(f.sent).toBeEmpty();
  // Once the turn ends the reply goes with the card information that binds it to the question.
  f.actors.worker.status = "idle"; f.actors.worker.activeTurn = null;
  await new DecisionSender(f.prefs, f.notes, new ConversationReader()).resume(f.sdk);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].text).not.toBe(f.input.text);
  expect(f.sent[0].text).toContain("자막을 한 줄로 할까요?");
  expect(f.sent[0].text.endsWith(f.input.text)).toBe(true);
});

test("a done note that closed the newer question does not block replies to the older card it uncovers", async () => {
  const f = await fixture();
  f.timelines.worker.unshift({ type: "assistant_message", text: "Which region should I use? Please choose one." });
  f.actors.worker.updatedAt = "2";
  const newer = await f.row();
  expect(newer.decision?.question).toBe("자막을 한 줄로 할까요?");
  // The person marks the newer card done; a snapshot closes that question with the note's revision.
  expect(f.notes.update({ sessionId: "worker", kind: "done", text: "처리함", expectedRevision: 0, evidenceId: newer.evidenceId }).ok).toBe(true);
  f.prefs.change(scope => closeQuestionByPerson(scope, "worker", newer.keptQuestion!.key, Date.now(), 1));
  f.actors.worker.updatedAt = "3";
  const older = await f.row();
  expect(older.decision?.question).toContain("Which region");
  await f.send({ version: older.decision!.version, requestKey: "send-older-card-1" });
  expect(f.sent).toHaveLength(1);
});

test("a reply's receipt names the conversation question it answers", async () => {
  const f = await fixture();
  const card = await f.row();
  await f.send();
  const receipts = Object.values(f.prefs.read().decisionReceipts);
  expect(receipts).toHaveLength(1);
  expect(receipts[0].question).toBe(card.keptQuestion!.key);
});

test("a kept question still takes its answer while a status report is the latest message", async () => {
  const f = await fixture();
  f.timelines.worker.push({type:"assistant_message", text:"Status update only. No decision is requested."});
  const card = await f.row();
  expect(card.decision?.question).toBe("자막을 한 줄로 할까요?");
  f.input.version = card.decision!.version;
  await f.send();
  expect(f.sent).toHaveLength(1);
});

test("a queued conversation answer rechecks the revision after restart", async () => {
  const f = await fixture();
  Object.assign(f.actors.worker, {status:"running", provider:"other", activeTurn:{id:"turn"}});
  expect(await f.send()).toMatchObject({queued:true});
  expect(f.sent).toBeEmpty();
  f.actors.worker.status = "idle"; f.actors.worker.activeTurn = null;
  // A new question from the session replaces the card, so the answer to the old one is held.
  f.timelines.worker.push({type:"assistant_message",text:"Which layout should we use? Please choose one."});
  const restarted = new DecisionSender(f.prefs, f.notes, new ConversationReader());
  await restarted.resume(f.sdk);
  expect(f.sent).toBeEmpty();
});

test("a queued answer still goes out when the session only spoke without asking, since its question is still open", async () => {
  const f = await fixture();
  Object.assign(f.actors.worker, {status:"running", provider:"other", activeTurn:{id:"turn"}});
  expect(await f.send()).toMatchObject({queued:true});
  f.actors.worker.status = "idle"; f.actors.worker.activeTurn = null;
  f.timelines.worker.push({type:"assistant_message",text:"Noted the report from the other session."});
  const restarted = new DecisionSender(f.prefs, f.notes, new ConversationReader());
  await restarted.resume(f.sdk);
  expect(f.sent).toHaveLength(1);
});

test("a conversation idle marker queues a running Codex reply and sends its original photos once after idle", async()=>{
  const f=await fixture();
  f.timelines.worker[0].text="deliverWhenIdle: true\n자막을 한 줄로 할까요?";
  f.actors.worker.updatedAt="2";
  const decision=(await f.row()).decision;
  Object.assign(f.actors.worker,{status:"running",provider:"codex",activeTurn:{id:"turn"}});
  const first=await f.send({version:decision.version,images:[replyPng]});
  expect(first.queued).toBe(true);
  const resumed=new DecisionSender(f.prefs,f.notes,new ConversationReader());
  await resumed.resume(f.sdk);
  expect(f.sent).toBeEmpty();
  Object.assign(f.actors.worker,{status:"idle",activeTurn:null});
  await Promise.all([resumed.resume(f.sdk),resumed.resume(f.sdk)]);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toMatchObject({messageId:first.messageId,images:[replyPng]});
  expect(f.prefs.read().queuedDecisions).toEqual({});
});

test("canceling a held conversation reply prevents delivery after the worker becomes idle", async () => {
  const f=await fixture();
  Object.assign(f.actors.worker,{status:"running",provider:"custom",activeTurn:{id:"turn"}});
  const {messageId}=await f.send();
  const card={kind:"session",sessionId:"worker",version:f.input.version,projectId:"project"} as const;
  expect(await f.sender.verifyQueue(f.sdk,messageId)).toBe(true);
  const request={card,messageId,action:"parallel" as const};
  expect(f.sender.control(request,"custom",10)?.answer).toBe(f.input.text);
  expect(f.sender.control(request,"custom",10)).toBeUndefined();
  Object.assign(f.actors.worker,{status:"idle",activeTurn:null});
  const restarted=new DecisionSender(f.prefs,f.notes,new ConversationReader());
  await restarted.resume(f.sdk);
  expect(f.sent).toBeEmpty();
  expect(restarted.control({...request,action:"cancel"},"custom",10)).toBeDefined();
  await restarted.resume(f.sdk);
  expect(f.prefs.read().queuedDecisions).toEqual({});
  expect(f.sent).toBeEmpty();
});
