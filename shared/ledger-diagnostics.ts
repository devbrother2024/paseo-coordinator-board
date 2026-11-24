import { z } from "zod";

export const ledgerIssueLimit = 40;
export const ledgerFieldLimit = 3;
const location = z.object({ source: z.string().min(1).max(256), projectTitle: z.string().min(1).max(256) });
const field = z.object({
  path: z.string().max(256),
  reason: z.enum(["missing", "invalid", "duplicate"]),
  hint: z.literal("option-text").optional(),
});
const ledgerIssue = z.discriminatedUnion("kind", [
  location.extend({ kind: z.literal("source") }),
  location.extend({ kind: z.literal("history"), part: z.enum(["answers", "questions"]) }),
  location.extend({
    kind: z.literal("entry"), id: z.string().min(1).max(256).optional(), title: z.string().min(1).max(256).optional(),
    row: z.number().int().positive(), fields: z.array(field).min(1).max(ledgerFieldLimit),
  }),
]);
export const ledgerDiagnosticsSchema = z.object({
  count: z.number().int().positive(), issues: z.array(ledgerIssue).min(1).max(ledgerIssueLimit),
});
export type LedgerIssue = z.infer<typeof ledgerIssue>;
export type LedgerField = z.infer<typeof field>;
export type LedgerDiagnostics = z.infer<typeof ledgerDiagnosticsSchema>;
