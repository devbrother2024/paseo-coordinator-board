import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readProjectDecisionSources } from "../server/project-decision-sources";
import { TrackedDecisionStore } from "../server/tracked-decisions";
import { trackedDecisionViewSchema, type TrackedDecisionView } from "../shared/tracked-decisions";
import { ledgerIssueLimit } from "../shared/ledger-diagnostics";

test("project ledgers retain manual checks, compound questions, and scoped exact matches", () => {
  const directory = mkdtempSync(join(tmpdir(),"board-source-"));
  const manifest = join(directory,"sources.json");
  const selected = new Set(["studio","editor"]);
  const binding = {id:"a",title:"Check playback",ask:["Listen once"],projectId:"editor",sessionId:"s",question:"Which take?"};
  const source = {source:"production",projectId:"studio",projectTitle:"Studio",repository:"studio/app",directory,matches:[binding]};
  writeFileSync(manifest, JSON.stringify({version:1,sources:[source,{...source,projectId:"other",directory:join(directory,"missing")}]}));
  const first = {since:"2025-11-01",id:"a",title:binding.title,ask:binding.ask[0],kind:"human",agentId:"s",pr:1};
  const second = {id:"b",title:"Review publication",kind:"merge",pr:2,blocksWork:true,dueAt:"2026-11-23",questions:[{text:"Pick one",options:[{key:"A",text:"Tomorrow"}]}]};
  writeFileSync(join(directory,"decisions.json"),JSON.stringify({items:[first,second]}));
  mkdirSync(join(directory,"live"));
  writeFileSync(join(directory,"live","board-answers.tsv"),"at\titemId\ttext\tattachments\tsaid\n2026-01-01\ta\tUse take 2\t0\tshort\n");
  const [a,b]=readProjectDecisionSources(manifest,selected).items;
  expect(a.sessionMatch?.question).toBe("Which take?");
  expect(a.mergeTarget).toBeUndefined();
  expect(a.replyHistory[0].text).toBe("Use take 2");
  expect(b.mergeTarget).toEqual({repo:"studio/app",number:2});
  expect(b).toMatchObject({blocksWork:true,dueAt:"2026-11-23"});
  expect(b.questions[0].options[0].text).toBe("Tomorrow");
  expect(readProjectDecisionSources(manifest,new Set(["studio"])).items[0].sessionMatch).toBeUndefined();
  writeFileSync(join(directory,"decisions.json"),JSON.stringify({items:[{...first,ask:"Check the other take"}]}));
  expect(readProjectDecisionSources(manifest,selected).items[0].sessionMatch).toBeUndefined();
  expect(readProjectDecisionSources(manifest,new Set()).items).toEqual([]);
  expect(readProjectDecisionSources(manifest,new Set(["other"])).diagnostics?.issues[0]).toMatchObject({ kind: "source", source: "production" });
  expect(readProjectDecisionSources(join(directory,"missing.json"),selected).items).toEqual([]);
});

async function fixture(run: (context: {
  root: string; ledger: string; manifest: string; read: () => ReturnType<typeof readProjectDecisionSources>;
  snapshot: () => TrackedDecisionView; store: TrackedDecisionStore; scope: () => Set<string>;
}) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "board-ledger-reading-"));
  try {
    const manifest = join(root, "manifest.json");
    const ledger = join(root, "decisions.json");
    const selected = new Set(["studio"]);
    const read = () => readProjectDecisionSources(manifest, selected);
    const store = new TrackedDecisionStore(join(root, "tracked-decisions.json"), read);
    writeFileSync(manifest, JSON.stringify({ version: 1, sources: [{ source: "releases", projectId: "studio", projectTitle: "Studio", directory: root }] }));
    await run({ root, ledger, manifest, read, store, scope: () => selected,
      snapshot: () => trackedDecisionViewSchema.parse(store.read(selected, [], { items: [], projects: [] })) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const valid = { id: "working", title: "Review sample", where: "human" };
const malformed = { id: "bad-choices", title: "Fix sample choices", questions: [{ text: "Which take?", options: [{ key: "A", label: "First", detail: "Summary" }] }] };

test("a mixed ledger imports the valid cards and exposes concise field errors on the decision view", () => {
  return fixture(({ ledger, read, snapshot }) => {
    writeFileSync(ledger, JSON.stringify({ items: [valid, malformed, { id: "bad-qa", title: "Review", qa: [{ a: "Missing question" }] }, {
      id: "extra-fields", title: "Check formatting", questions: [{ text: "Which take?", options: [
        { key: "A", text: "First", does: "Use first take", label: "Ignored label", detail: "Ignored detail" },
      ] }],
    }] }));
    expect(read().items.map(row => row.id)).toEqual(["working", "extra-fields"]);
    expect(read().items[1].questions[0].options[0]).toEqual({
      key: "A", text: "First", does: ["Use first take"], pros: [], cons: [], recommended: false,
    });
    expect(snapshot()).toMatchObject({
      status: "partial", items: [{ id: "working" }, { id: "extra-fields" }], diagnostics: {
        count: 2, issues: [
          { kind: "entry", source: "releases", projectTitle: "Studio", id: "bad-choices", title: "Fix sample choices", fields: [
            { path: "questions.0.options.0.text", reason: "missing", hint: "option-text" },
          ] },
          { id: "bad-qa", fields: [{ path: "qa.0.q", reason: "missing" }] },
        ],
      },
    });
  });
});

test("unreadable, broken JSON and missing items fail that ledger with its source name", () => {
  return fixture(({ ledger, snapshot }) => {
    const expected = { status: "partial", items: [], diagnostics: { count: 1, issues: [{ kind: "source", source: "releases", projectTitle: "Studio" }] } };
    expect(snapshot()).toMatchObject(expected);
    for (const raw of ["{ broken", "{}", '{"items":{}}']) {
      writeFileSync(ledger, raw);
      expect(snapshot()).toMatchObject(expected);
    }
  });
});

test("an all-invalid ledger remains partial and reports record positions when IDs are absent", () => {
  return fixture(({ ledger, snapshot }) => {
    writeFileSync(ledger, JSON.stringify({ items: [malformed, { title: "No identity" }, null] }));
    expect(snapshot()).toMatchObject({ status: "partial", items: [], diagnostics: {
      count: 3, issues: [
        { kind: "entry", id: "bad-choices", row: 1 },
        { kind: "entry", title: "No identity", row: 2, fields: [{ path: "id", reason: "missing" }] },
        { kind: "entry", row: 3, fields: [{ path: "", reason: "invalid" }] },
      ],
    } });
  });
});

test("diagnostics retain read-only cards and prioritize failed ledgers within the safe warning budget", () => {
  return fixture(({ root, ledger, manifest, snapshot }) => {
    mkdirSync(join(root, "live", "board-answers.tsv"), { recursive: true });
    const source = { source: "releases", projectId: "studio", projectTitle: "Studio", directory: root };
    writeFileSync(manifest, JSON.stringify({ version: 1, sources: [
      source, { ...source, source: "archive", directory: join(root, "missing") },
    ] }));
    const suffix = "L".repeat(251);
    const title = "Test\u202e\n\u2028\u2029\u200b\u200c\u200d\u2060\u034f\ufe0f" + suffix + "🙂more";
    const many = Array.from({ length: 55 }, () => ({ ...malformed, title }));
    writeFileSync(ledger, JSON.stringify({ items: [valid, ...many] }));
    const result = snapshot();
    expect(result.items).toMatchObject([{ id: "working", historyUnavailable: true }]);
    expect(result.diagnostics?.count).toBe(57);
    expect(result.diagnostics?.issues).toHaveLength(ledgerIssueLimit);
    expect(result.diagnostics?.issues[0]).toMatchObject({ kind: "source", source: "archive" });
    expect(result.diagnostics?.issues[1]).toMatchObject({ kind: "history", part: "answers" });
    expect(result.diagnostics?.issues[2]).toMatchObject({ kind: "entry", title: "Test" + suffix });
  });
});

test("duplicate IDs do not select either ambiguous card and leave unrelated cards visible", () => {
  return fixture(({ ledger, snapshot }) => {
    writeFileSync(ledger, JSON.stringify({ items: [valid, { id: "copy", title: "First copy" }, { id: "copy", title: "Second copy" }] }));
    expect(snapshot()).toMatchObject({ items: [{ id: "working" }], diagnostics: {
      count: 2, issues: [{ id: "copy", row: 2, fields: [{ path: "id", reason: "duplicate" }] }, { id: "copy", row: 3 }],
    } });
  });
});

test("a history read error cannot reopen an answered revision for delivery or local resolution", async () => {
  await fixture(async ({ root, ledger, snapshot, store, scope }) => {
    writeFileSync(ledger, JSON.stringify({ items: [{ ...valid, where: "session", agentId: "worker-1", since: "2025-11-01" }] }));
    mkdirSync(join(root, "live"));
    const path = join(root, "live", "board-questions.tsv");
    const history = "at\titemId\ttext\n2026-01-01\tworking\tWhich take?\n";
    writeFileSync(path, history);
    let sends = 0;
    const prepare = async () => ({
      ready: true, stillCurrent: () => true, accepted: async () => true, send: async () => { sends++; },
    });
    const [original] = snapshot().items;
    const input = { id: original.id, source: original.source, projectId: original.projectId, answer: "First take", recipientId: "worker-1" };
    expect(await store.deliver({ ...input, fingerprint: original.fingerprint }, scope, prepare)).toEqual({ status: "sent" });
    expect(snapshot().items).toEqual([]);

    unlinkSync(path);
    mkdirSync(path);
    const [unavailable] = snapshot().items;
    const degradedInput = { ...input, fingerprint: unavailable.fingerprint };
    expect(await store.deliver(degradedInput, scope, prepare)).toEqual({ status: "unavailable" });
    expect(store.resolve({ ...degradedInput, recipientId: undefined }, scope)).toEqual({ status: "unavailable" });
    expect(sends).toBe(1);
    expect(unavailable.historyUnavailable).toBe(true);

    rmdirSync(path);
    writeFileSync(path, history);
    expect(snapshot().items).toEqual([]);
  });
});

test("large TSV histories keep their newest 200 rows and detect insufficient tail data", () => {
  return fixture(({ root, ledger, read, snapshot }) => {
    writeFileSync(ledger, JSON.stringify({ items: [{ ...valid, since: "2025-11-01" }] }));
    mkdirSync(join(root, "live"));
    const path = join(root, "live", "board-answers.tsv");
    const header = "at\titemId\ttext\r\n";
    const recent = Array.from({ length: 201 }, (_, i) => `2026-01-01\tworking\tTake ${i}\r\n`).join("");
    writeFileSync(path, header + "X".repeat(4 * 1024 * 1024) + "\r\n" + recent);
    const result = read();
    expect(result.diagnostics).toBeUndefined();
    expect(result.items[0].replyHistory).toHaveLength(200);
    expect(result.items[0].replyHistory[0].text).toBe("Take 1");
    expect(result.items[0].replyHistory.at(-1)?.text).toBe("Take 200");

    writeFileSync(path, header + "2026-01-01\tworking\t" + "X".repeat(256 * 1024) + "\n" + "2026-01-01\tworking\tTake 200");
    expect(snapshot()).toMatchObject({ status: "partial", items: [{ id: "working", historyUnavailable: true }],
      diagnostics: { issues: [{ kind: "history", part: "answers" }] } });
  });
});

test("an unavailable history leaves a queued answer pending and is rechecked after recipient lookup", async () => {
  await fixture(async ({ root, ledger, snapshot, store, scope }) => {
    writeFileSync(ledger, JSON.stringify({ items: [{ ...valid, where: "session", agentId: "worker-1", since: "2025-11-01" }] }));
    mkdirSync(join(root, "live"));
    const path = join(root, "live", "board-answers.tsv");
    const history = "at\titemId\ttext\n2026-01-01\tworking\tA previous reply\n";
    const makeUnreadable = () => { unlinkSync(path); mkdirSync(path); };
    const restore = () => { rmdirSync(path); writeFileSync(path, history); };
    writeFileSync(path, history);
    const [card] = snapshot().items;
    const input = { id: card.id, source: card.source, projectId: card.projectId, fingerprint: card.fingerprint, answer: "First take", recipientId: "worker-1" };
    let sends = 0;
    const target = { ready: true, stillCurrent: () => true, accepted: async () => true, send: async () => { sends++; } };
    expect(await store.deliver(input, scope, async () => { makeUnreadable(); return target; })).toEqual({ status: "unavailable" });
    restore();
    expect((await store.deliver(input, scope, async () => ({ ...target, ready: false }))).status).toBe("queued");
    makeUnreadable();
    expect(await store.resumeQueued(scope, async () => target)).toBe(false);
    expect(store.hasWaitingReplies()).toBe(true);
    expect(sends).toBe(0);
    restore();
    expect(await store.resumeQueued(scope, async () => target)).toBe(true);
    expect(sends).toBe(1);
  });
});

test("ledger PRs remain readable references without becoming merge targets", () => {
  const directory = mkdtempSync(join(tmpdir(), "board-source-"));
  try {
    const manifest = join(directory, "sources.json");
    const source = { source: "sample", projectId: "studio", projectTitle: "Studio", repository: "studio/app", directory };
    const selected = new Set(["studio"]);
    writeFileSync(manifest, JSON.stringify({ version: 1, sources: [source] }));
    writeFileSync(join(directory, "decisions.json"), JSON.stringify({ items: [
      { id: "approve", kind: "approval", title: "Approve the outline", pr: 42 },
      { id: "merge", kind: "merge", title: "Merge the outline", pr: 43 },
      { id: "ask", kind: "answer", title: "What changed in #44?" },
    ] }));

    const [approve, merge, ask] = readProjectDecisionSources(manifest, selected).items;
    expect(approve).toMatchObject({ kind: "approve", pullRepository: "studio/app", pullTarget: { repo: "studio/app", number: 42 } });
    expect(approve.mergeTarget).toBeUndefined();
    expect(merge.mergeTarget).toEqual({ repo: "studio/app", number: 43 });
    expect(merge.pullTarget).toEqual(merge.mergeTarget);
    expect(ask.pullRepository).toBe("studio/app");
    expect(ask.pullTarget).toBeUndefined();

    writeFileSync(manifest, JSON.stringify({ version: 1, sources: [{ ...source, repository: undefined }] }));
    const [unmapped] = readProjectDecisionSources(manifest, selected).items;
    expect(unmapped.pullRepository).toBeUndefined();
    expect(unmapped.pullTarget).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
