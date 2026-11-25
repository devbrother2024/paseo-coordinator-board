import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Records on this host that the person closed a kept question. Nothing is sent to the session.
export const closeKeptQuestion = defineRpc({
  name: "board.close-kept-question",
  input: z.strictObject({ sessionId: z.string().min(1).max(256), key: z.string().min(1).max(64) }),
  output: z.object({ ok: z.literal(true) }),
});
