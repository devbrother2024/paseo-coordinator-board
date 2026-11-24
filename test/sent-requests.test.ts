import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SentRequestStore, retainedSentRequests } from "../server/sent-requests";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "board-sent-requests-"));
  paths.push(dir);
  const path = join(dir, "sent-requests.json");
  return { path, store: new SentRequestStore(path) };
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const request = (n: number, coordinatorId = "coordinator-A") => ({ messageId: id(n), coordinatorId, text: "Request " + n, photoCount: 0 });

test("a retry keeps the first entry, and a delivery state never moves back", () => {
  const { store } = fixture();
  store.record(request(1));
  const [first] = store.list();
  expect(first).toMatchObject({ ...request(1), status: "pending" });
  store.record(request(1));
  expect(store.list()).toEqual([first]);
  store.mark("coordinator-A", [id(1)], "delivered");
  store.mark("coordinator-A", [id(1)], "sent");
  expect(store.list()).toEqual([{ ...first, status: "delivered" }]);
  // The same message ID sent to another coordinator is another request.
  store.record(request(1, "coordinator-B"));
  expect(store.list().map(entry => [entry.coordinatorId, entry.status])).toEqual([["coordinator-B", "pending"], ["coordinator-A", "delivered"]]);
});

test("only the latest requests are kept, newest first", () => {
  const { store } = fixture();
  for (let n = 1; n <= retainedSentRequests + 3; n++) store.record(request(n));
  const kept = store.list();
  expect(kept).toHaveLength(retainedSentRequests);
  expect([kept[0].text, kept.at(-1)!.text]).toEqual(["Request " + (retainedSentRequests + 3), "Request 4"]);
});

test("an unreadable history starts over instead of blocking new entries", () => {
  const { path, store } = fixture();
  writeFileSync(path, "{not json");
  expect(store.list()).toEqual([]);
  store.record(request(1));
  expect(store.list().map(entry => entry.text)).toEqual(["Request 1"]);
});

test("delivery is read once per coordinator from its recent conversation, and only the same message and text count", async () => {
  const { store } = fixture();
  for (const n of [1, 2, 3]) store.record(request(n));
  store.record(request(4, "removed-coordinator"));
  store.mark("coordinator-A", [id(2)], "sent");
  const reads: string[] = [];
  const entries = [
    { item: { type: "user_message", messageId: id(1), text: "Request 1" } },
    { item: { type: "user_message", clientMessageId: id(2), text: "Request 2" } },
    { item: { type: "user_message", messageId: id(3), text: "Different text" } },
  ];
  const paseo = { agents: { ref: (agentId: string) => ({ timeline: { refetch: async () => {
    reads.push(agentId);
    if (agentId !== "coordinator-A") throw Error("gone");
    return { entries };
  } } }) } };
  const listed = await store.confirm(paseo as never);
  expect(reads.sort()).toEqual(["coordinator-A", "removed-coordinator"]);
  expect(listed.map(entry => [entry.text, entry.status])).toEqual([
    ["Request 4", "pending"], ["Request 3", "pending"], ["Request 2", "delivered"], ["Request 1", "delivered"],
  ]);
  // A delivered request is not looked up again, and a page with a gap proves nothing.
  reads.length = 0;
  entries.push({ item: { type: "user_message", messageId: id(3), text: "Request 3" } });
  const gap = { agents: { ref: (agentId: string) => ({ timeline: { refetch: async () => { reads.push(agentId); return { entries, gap: true }; } } }) } };
  expect((await store.confirm(gap as never)).map(entry => entry.status)).toEqual(["pending", "pending", "delivered", "delivered"]);
  expect(reads.sort()).toEqual(["coordinator-A", "removed-coordinator"]);
  expect((await store.confirm(paseo as never)).map(entry => entry.status)).toEqual(["pending", "delivered", "delivered", "delivered"]);
});

test("the same text under another message ID, or a page that failed or came from a stale cursor, is not a delivery", async () => {
  const { store } = fixture();
  store.record(request(1));
  store.record(request(2));
  const entries = [
    { item: { type: "user_message", messageId: id(9), clientMessageId: id(8), text: "Request 1" } },
    { item: { type: "user_message", messageId: id(2), text: "Request 2" } },
  ];
  const reading = (page: object) => ({ agents: { ref: () => ({ timeline: { refetch: async () => ({ entries, ...page }) } }) } });
  for (const page of [{ error: "timeline unavailable" }, { staleCursor: true }]) {
    expect((await store.confirm(reading(page) as never)).map(entry => entry.status)).toEqual(["pending", "pending"]);
  }
  expect((await store.confirm(reading({}) as never)).map(entry => [entry.text, entry.status])).toEqual([["Request 2", "delivered"], ["Request 1", "pending"]]);
});
