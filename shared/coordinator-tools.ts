import { z } from "zod";

// A coordinator conversation keeps the board tool definitions it first received. Claude Code stores
// them in the conversation record and sends the stored copy again on later turns and on resume, so
// reloading the session, reloading the plugin or restarting the daemon does not change them. Only a
// new conversation does: replacing the coordinator, or /clear in the coordinator session.
//
// The board stamps each coordinator conversation with a fingerprint of the definitions it served when
// that conversation first called a board tool, and compares the stamp with the definitions it serves now.
export type ToolStamp = { session: string; fingerprint: string };
export type ToolStaleness = "stale" | "current" | "unknown";

// A provider conversation ID the board is willing to store. Anything longer or stranger is unknown.
export const conversationIdPattern = /^[A-Za-z0-9._:-]{1,256}$/;
export const validConversationId = (value: unknown): value is string => typeof value === "string" && conversationIdPattern.test(value);

// `session` is the provider conversation the coordinator runs now. Silence beats a false alarm:
// whatever the board cannot tell is "unknown", and only "stale" shows a notice.
export function toolStaleness(stamp: ToolStamp | undefined, current: string | undefined, session: string | null | undefined): ToolStaleness {
  if (!stamp || !current) return "unknown";
  if (stamp.fingerprint === current) return "current";
  if (!validConversationId(session)) return "unknown";
  // A new conversation gets the definitions served now on its first call.
  return session === stamp.session ? "stale" : "current";
}

// The stamp to keep after a board tool call. A conversation keeps its first stamp; a new one starts over.
export function nextToolStamp(previous: ToolStamp | undefined, current: string | undefined, session: string | null | undefined): ToolStamp | undefined {
  if (!current || !validConversationId(session)) return previous;
  if (previous?.session === session) return previous;
  return { session, fingerprint: current };
}

// Only Paseo's Claude provider is known to keep the first definitions. Paseo reopens a provider session
// when the plugin generation changes, and another provider may take the new tools then. The board
// cannot tell, so it says nothing for other providers.
export const coordinatorToolsSchema = z.object({
  stale: z.literal(true),
});
export type CoordinatorTools = z.infer<typeof coordinatorToolsSchema>;

export const providerKeepsTools = (provider: string | null | undefined) => provider === "claude";
