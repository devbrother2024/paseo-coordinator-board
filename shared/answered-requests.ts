import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

// Requests this board already answered, kept on the host that runs the board plugin so a redrawn
// card, a reloaded app or another screen attached to that host does not answer one a second time.
const sentRecord = z.object({ session: z.string().min(1).max(256), request: z.string().min(1).max(256), at: z.number() });
export type SentRecord = z.infer<typeof sentRecord>;
export const answeredRequests = defineSettings({
  id: "answered-requests",
  scope: "host",
  version: 1,
  schema: z.object({ sent: z.array(sentRecord).default([]) }),
});

const keep = 200;
const maxAge = 14 * 24 * 60 * 60 * 1000;

export function wasSent(records: readonly SentRecord[], session: string, request: string) {
  return records.some(entry => entry.session === session && entry.request === request);
}

// Adds records, newest last, without duplicates. Old and surplus records fall off the front.
export function withSent(records: readonly SentRecord[], added: readonly SentRecord[], now: number): SentRecord[] {
  const merged = new Map<string, SentRecord>();
  for (const entry of [...records, ...added]) {
    const key = JSON.stringify([entry.session, entry.request]);
    const prior = merged.get(key);
    if (now - entry.at <= maxAge && (!prior || prior.at < entry.at)) merged.set(key, entry);
  }
  return [...merged.values()].sort((a, b) => a.at - b.at).slice(-keep);
}
