import { z } from "zod";

// A coordinator conversation keeps the board tool definitions it loaded. Claude Code stores them in
// the conversation record and sends the stored copy again on later turns and on resume, so reloading
// the session, reloading the plugin or restarting the daemon does not change them. A tool the board
// adds later is announced to the conversation and loads with its current definition. Compacting the
// conversation keeps its ID and makes it load the tools again.
//
// The board stamps each coordinator conversation on its first board tool call: the fingerprint of the
// tool contract it served then, and the contract number. Later it goes by what it can observe, never by
// what a call claims: a call to a tool shows the conversation holds the contract that introduced the
// tool, and a compaction in the coordinator's timeline shows it loads every definition again.
export type ToolStamp = {
  session: string; fingerprint: string;
  // The contract the conversation holds. Missing on a stamp from before the contract existed.
  contract?: number;
  // Stamped before the contract, so some of its tool definitions may be older than contract 1.
  early?: boolean;
  // The guide revision the conversation last read, and the one it was last told to read. A new
  // conversation starts at the empty revision; a stamp from before the contract has none.
  guide?: string; noted?: string;
};
export type ToolStaleness = "stale" | "current" | "unknown";
// What this board build serves: the contract fingerprint and numbers, and the guide revision.
// The revision is empty while nothing exists beyond the tool definitions.
export type ServedTools = { fingerprint: string; contract: number; compatibleFrom: number; guide: string };
// `since` is the contract that introduced the called tool, when the tool was not part of every contract.
export type ToolCall = { since?: number; readGuide?: boolean };

// A provider conversation ID the board is willing to store. Anything longer or stranger is unknown.
export const conversationIdPattern = /^[A-Za-z0-9._:-]{1,256}$/;
export const validConversationId = (value: unknown): value is string => typeof value === "string" && conversationIdPattern.test(value);

// `session` is the provider conversation the coordinator runs now. Silence beats a false alarm:
// whatever the board cannot tell is "unknown", and only "stale" shows a notice.
export function toolStaleness(stamp: ToolStamp | undefined, current: ServedTools | undefined, session: string | null | undefined): ToolStaleness {
  if (!stamp || !current) return "unknown";
  if (stamp.fingerprint === current.fingerprint) return "current";
  if (!validConversationId(session)) return "unknown";
  // A new conversation gets the definitions served now on its first call.
  if (session !== stamp.session) return "current";
  // An older contract that this board still works with needs nothing from the person.
  return (stamp.contract ?? 0) >= current.compatibleFrom ? "current" : "stale";
}

// The stamp to keep after a board tool call. A conversation keeps its first stamp; a new one starts over.
export function nextToolStamp(previous: ToolStamp | undefined, current: ServedTools | undefined, session: string | null | undefined, call: ToolCall = {}): ToolStamp | undefined {
  if (!current || !validConversationId(session)) return previous;
  let stamp: ToolStamp = previous?.session === session ? previous : { session, fingerprint: current.fingerprint, contract: current.contract, guide: "" };
  const since = call.since;
  if (since !== undefined && Number.isInteger(since) && since >= 1 && since <= current.contract && (stamp.contract ?? 0) < since) {
    // The other tools it loaded earlier are still the older copies.
    stamp = { ...stamp, contract: since, ...(stamp.contract === undefined ? { early: true } : {}) };
  }
  if (call.readGuide && stamp.guide !== current.guide) stamp = { ...stamp, guide: current.guide };
  return stamp;
}

// The stamp of a conversation the board saw compacted: it loads every board tool again, so it holds
// what the board serves now, like a new conversation under the same ID.
export function compactedToolStamp(stamp: ToolStamp, current: ServedTools | undefined): ToolStamp {
  return current ? { session: stamp.session, fingerprint: current.fingerprint, contract: current.contract, guide: "" } : stamp;
}

// Whether the board still holds something against the conversation that a compaction would clear.
export function behindServedTools(stamp: ToolStamp | undefined, current: ServedTools | undefined): boolean {
  return !!stamp && !!current && (!!stamp.early || toolStaleness(stamp, current, stamp.session) === "stale");
}

// A conversation is told once per guide revision to read the guide, until it has read that revision.
// The revision changes only when something becomes reachable through board_action alone, so rewording
// tells a running conversation nothing.
export function guideNoteDue(stamp: ToolStamp | undefined, current: ServedTools | undefined): boolean {
  return !!stamp && !!current && stamp.guide !== current.guide && stamp.noted !== current.guide;
}

// Only Paseo's Claude provider is known to keep the first definitions. Paseo reopens a provider session
// when the plugin generation changes, and another provider may take the new tools then. The board
// cannot tell, so it says nothing for other providers.
//
// A provider profile (a second Claude Code account, say) has its own provider ID. Paseo's provider
// implementation writes its own name into the conversation's persistence metadata, so that is what
// tells which implementation runs the conversation. Without it, the provider ID is all there is: the
// board does not guess from how an ID is spelled.
export function conversationProvider(persistence: { provider?: unknown; metadata?: unknown } | null | undefined): string | null {
  const metadata = persistence?.metadata;
  const recorded = metadata && typeof metadata === "object" ? (metadata as { provider?: unknown }).provider : undefined;
  const provider = typeof recorded === "string" && recorded ? recorded : persistence?.provider;
  return typeof provider === "string" && provider ? provider : null;
}

export const coordinatorToolsSchema = z.object({
  stale: z.literal(true),
});
export type CoordinatorTools = z.infer<typeof coordinatorToolsSchema>;

export const providerKeepsTools = (provider: string | null | undefined) => provider === "claude";
