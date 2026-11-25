import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const parallelWait = defineSettings({
  id: "parallel-reply", scope: "host", version: 1,
  schema: z.object({ minutes: z.number().int().min(1).max(1440).default(10) }),
});

export const supportsSteer = (provider?: string | null) => provider === "claude" || provider === "codex";
export function parallelEligible(at: string, provider: string | null | undefined, minutes: number, now = Date.now()) {
  return (!!provider && !supportsSteer(provider)) || now - Date.parse(at) >= minutes * 60000;
}

// Only an explicit line outside fenced examples marks a conversation card.
export function waitsForIdle(message: string) {
  let fence = "";
  for (const line of message.split("\n")) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      if (!fence) fence = delimiter[1];
      else if (delimiter[1].startsWith(fence) && !delimiter[2].trim()) fence = "";
    } else if (!fence && /^ {0,3}deliverWhenIdle:[ \t]*true[ \t]*$/.test(line.trimEnd())) {
      return true;
    }
  }
  return false;
}

export const queueRef = z.discriminatedUnion("kind", [
  z.object({kind:z.literal("session"), projectId:z.string(), sessionId:z.string(), version:z.string()}),
  z.object({kind:z.literal("ledger"), projectId:z.string().nullable(), source:z.string(), id:z.string(), fingerprint:z.string()}),
]);
export type QueueRef = z.infer<typeof queueRef>;
export const parallelState = z.enum(["held", "resumed"]);
export const queueView = z.object({
  messageId:z.string().uuid(), recipientId:z.string(), answer:z.string().optional(), imageCount:z.number().int().nonnegative(),
  stopped:z.boolean(), at:z.string().optional(), parallel:parallelState.optional(), offer:z.boolean().optional(),
  coordinatorId:z.string().optional(), originState:z.enum(["live","ended","unknown"]).optional(),
});
export type QueueView = z.infer<typeof queueView>;
export function canResumeHeldReply(queue:Pick<QueueView,"stopped"|"parallel"|"originState">) {
  return queue.parallel === "held" && !queue.stopped && queue.originState === "live";
}
export const manageQueuedAnswer = defineRpc({
  name:"board.manage-queued-answer",
  input:z.strictObject({card:queueRef,messageId:z.string().uuid(),action:z.enum(["parallel","resume","cancel"]),coordinatorId:z.string().optional()}),
  output:z.object({status:z.enum(["updated","changed","unavailable","unconfirmed"])}),
});
export type QueueAction = z.infer<typeof manageQueuedAnswer.input>;

export function canChangeQueue(queue:{at:string;stopped:boolean;parallel?:QueueView["parallel"]}, action:QueueAction["action"],
  provider:string|null|undefined, minutes:number) {
  if (action === "cancel") return true;
  if (queue.stopped) return false;
  if (action === "resume") return queue.parallel === "held";
  return !queue.parallel && parallelEligible(queue.at, provider, minutes);
}
