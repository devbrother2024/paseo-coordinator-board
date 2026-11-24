import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { sentRequestSchema, type SentRequest } from "../shared/sent-requests";

// As many as the session photo cache keeps. Other board messages share that cache, so an older request may lose its photos first.
export const retainedSentRequests = 20;
const stored = z.object({ version: z.literal(1), requests: z.array(sentRequestSchema) });
const rank = { pending: 0, sent: 1, delivered: 2 } as const;

export class SentRequestStore {
  constructor(private readonly path: string) {}

  list(): SentRequest[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    try {
      return stored.parse(JSON.parse(text)).requests;
    } catch {
      // The history only shows what was sent, so an unreadable file starts over rather than block new entries.
      return [];
    }
  }

  // A retry reuses the reserved message ID, so it keeps the first entry and its time.
  record(entry: Omit<SentRequest, "at" | "status">) {
    const requests = this.list();
    if (requests.some(request => request.coordinatorId === entry.coordinatorId && request.messageId === entry.messageId)) return;
    const added: SentRequest = { ...entry, at: new Date().toISOString(), status: "pending" };
    this.write([added, ...requests].slice(0, retainedSentRequests));
  }

  mark(coordinatorId: string, messageIds: readonly string[], status: "sent" | "delivered") {
    const requests = this.list();
    let changed = false;
    for (const request of requests) {
      if (request.coordinatorId !== coordinatorId || !messageIds.includes(request.messageId) || rank[request.status] >= rank[status]) continue;
      request.status = status;
      changed = true;
    }
    if (changed) this.write(requests);
  }

  // One recent-timeline read per coordinator that still has unconfirmed requests.
  async confirm(paseo: PluginHandlerContext["paseo"]) {
    const waiting = new Map<string, SentRequest[]>();
    for (const request of this.list()) {
      if (request.status !== "delivered") waiting.set(request.coordinatorId, [...waiting.get(request.coordinatorId) ?? [], request]);
    }
    for (const [coordinatorId, requests] of waiting) {
      try {
        const page = await paseo.agents.ref(coordinatorId).timeline.refetch({ direction: "tail", projection: "projected", limit: 128 });
        if (page.error || page.gap || page.staleCursor) continue;
        const seen = requests.filter(request => page.entries.some(({ item }) => item.type === "user_message" &&
          (item.messageId === request.messageId || item.clientMessageId === request.messageId) && item.text === request.text));
        if (seen.length) this.mark(coordinatorId, seen.map(request => request.messageId), "delivered");
      } catch {
        // A removed coordinator keeps its requests at their last known state.
      }
    }
    return this.list();
  }

  private write(requests: SentRequest[]) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(temporary, JSON.stringify({ version: 1, requests }), { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}
