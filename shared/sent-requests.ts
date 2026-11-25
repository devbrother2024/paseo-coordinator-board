import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { MAX_WORK_IMAGES } from "./work-images";

export const sentRequestSchema = z.object({
  messageId: z.string().uuid(),
  coordinatorId: z.string().min(1).max(256),
  text: z.string().max(24000),
  at: z.string().datetime(),
  photoCount: z.number().int().min(0).max(MAX_WORK_IMAGES),
  // pending: the send was not confirmed. sent: Paseo accepted it. delivered: it appears in the coordinator's conversation.
  status: z.enum(["pending", "sent", "delivered"]),
});
export type SentRequest = z.output<typeof sentRequestSchema>;

export const listSentRequests = defineRpc({
  name: "board.sent-requests",
  input: z.strictObject({}),
  output: z.object({ requests: z.array(sentRequestSchema) }),
});
