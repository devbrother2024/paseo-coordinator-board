import { expect, test } from "bun:test";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { PreferenceStore } from "../server/preferences";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sendCoordinatorRequest, digestPrompt, digestWithFactReplies, recordDigestCompletion, completedBoardTools } from "../server/digest";

function fixture() {
  let owner = "primary";
  const state = { status: "idle", archivedAt: null, activeTurn: null, pendingPermissions: [] as unknown[] };
  const sent: { target: string; text: string; options: { messageId: string; activeTurnBehavior: string } }[] = [];
  const prefs = { read: () => ({ coordinator: owner, projects:["selected"] }) } as PreferenceStore;
  let afterRefresh = () => {};
  const api = {
    agents: {
      ref: (target: string) => ({
        refresh: async () => {
          afterRefresh();
          return { agent: state };
        },
        send: async (text: string, options: (typeof sent)[number]["options"]) => {
          sent.push({ target, text, options });
        },
      }),
    },
  } as unknown as PluginHandlerContext["paseo"];
  return {
    state,
    sent,
    request: () => sendCoordinatorRequest(api, prefs, "primary", "digest-request-1", digestPrompt),
    rotate: () => {
      afterRefresh = () => {
        owner = "replacement";
      };
    },
  };
}
test("a person requests the digest from the designated idle session with a stable delivery key", async () => {
  const f = fixture();
  await f.request();
  await f.request();
  expect(f.sent.map((s) => s.target)).toEqual(["primary", "primary"]);
  expect(f.sent[0].options.messageId).toBe(f.sent[1].options.messageId);
  expect(f.sent[0].text).toContain("조회와 분류");
});
test("pending approval, a busy session or a concurrent rotation prevents a digest send", async () => {
  const f = fixture();
  f.state.pendingPermissions.push({});
  await expect(f.request()).rejects.toThrow();
  f.state.pendingPermissions = [];
  f.state.status = "running";
  await expect(f.request()).rejects.toThrow();
  f.state.status = "idle";
  f.rotate();
  await expect(f.request()).rejects.toThrow();
  expect(f.sent).toHaveLength(0);
});

test("only a verified complete digest turn advances the host timestamp", async () => {
  const root = mkdtempSync(join(tmpdir(), "board-digest-"));
  try {
    const store = new PreferenceStore(join(root, "scope.json"));
    store.change(scope => { scope.coordinator = "primary"; scope.projects = ["studio"]; });
    const entries: unknown[] = [];
    let rotate = false;
    let calls = 0;
    const paseo = { agents: { ref: () => ({ timeline: { refetch: async () => {
      calls++;
      if (rotate) store.change(scope => { scope.coordinator = "replacement"; });
      return { entries };
    } } }) } } as unknown as PluginHandlerContext["paseo"];
    const at = "2026-02-01T10:00:00.000Z";
    const observe = (turnId: string, kind = "completed", id = "primary", time = at) =>
      recordDigestCompletion(store, paseo, { agent: { id }, turnId, outcome: { kind } } as never, time);
    const user = (turnId: string, text: string) => ({ turnId, item: { type: "user_message", text } });

    entries.push(user("newer", digestPrompt), user("ordinary", "Please review one session."));
    await observe("ordinary");
    await observe("newer", "failed");
    await observe("newer", "canceled");
    await observe("newer", "completed", "other");
    expect(calls).toBe(1);
    expect(store.read().lastDigest).toBeUndefined();
    await observe("newer");
    expect(store.read().lastDigest).toEqual({ turnId: "newer", coordinator: "primary", at });
    await observe("newer", "completed", "primary", "2026-02-01T11:00:00.000Z");
    expect(store.read().lastDigest?.at).toBe(at);

    const tool = (name: string) => ({ turnId: "recurring", item: { type: "tool_call", name, status: "completed" } });
    entries.push(tool("mcp__paseo__read_board_conversation"));
    await observe("recurring", "completed", "primary", "2026-02-01T11:00:00.000Z");
    expect(store.read().lastDigest?.at).toBe(at);
    entries.push(tool("review_board_records"));
    await observe("recurring", "completed", "primary", "2026-02-01T11:00:00.000Z");
    expect(store.read().lastDigest).toEqual({ turnId: "recurring", coordinator: "primary", at: "2026-02-01T11:00:00.000Z" });

    entries.push(user("after", digestWithFactReplies("en", "a".repeat(64))));
    rotate = true;
    await observe("after", "completed", "primary", "2026-02-01T12:00:00.000Z");
    expect(store.read().lastDigest?.turnId).toBe("recurring");
    await observe("after", "completed", "replacement", "2026-02-01T12:00:00.000Z");
    expect(store.read().lastDigest).toEqual({ turnId: "after", coordinator: "replacement", at: "2026-02-01T12:00:00.000Z" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a board tool run through board_action counts as that tool", () => {
  const call = (name: string, extra: Record<string, unknown> = {}) => ({ type: "tool_call", name, status: "completed", ...extra }) as any;
  const viaAction = (input: unknown, status = "completed") => call("mcp__paseo__board_action", { status, detail: { type: "unknown", input, output: null } });
  expect(completedBoardTools(call("mcp__paseo__review_board_records"))).toEqual(["review_board_records"]);
  expect(completedBoardTools(viaAction({ action: "review_board_records", input: {} }))).toEqual(["board_action", "review_board_records"]);
  // A call that did not complete, and one without a readable action, name nothing more.
  expect(completedBoardTools(viaAction({ action: "review_board_records" }, "failed"))).toEqual([]);
  for (const input of [undefined, null, "review_board_records", { action: 3 }, []]) expect(completedBoardTools(viaAction(input))).toEqual(["board_action"]);
  expect(completedBoardTools(call("board_action"))).toEqual(["board_action"]);
  // A call the board refused (unknown action, input the installed board does not accept) ran nothing.
  // Paseo's Claude provider reports it as failed. Another provider may report it completed with the error in its output.
  const refused = (output: unknown) => call("mcp__paseo__board_action", { detail: { type: "unknown", input: { action: "review_board_records" }, output } });
  for (const output of [{ isError: true, content: [{ type: "text", text: "Unknown board action" }] }, { is_error: true }, { structuredContent: {}, isError: true }]) {
    expect(completedBoardTools(refused(output))).toEqual([]);
  }
  expect(completedBoardTools(refused({ isError: false, content: [] }))).toEqual(["board_action", "review_board_records"]);
  expect(completedBoardTools(refused("Recorded."))).toEqual(["board_action", "review_board_records"]);
  // The same holds for a named tool that reported an error.
  expect(completedBoardTools(call("mcp__paseo__review_board_records", { detail: { type: "unknown", input: {}, output: { isError: true } } }))).toEqual([]);
  expect(completedBoardTools({ type: "user_message", text: "review_board_records" } as any)).toEqual([]);
});
