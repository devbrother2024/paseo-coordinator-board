import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// GitHub.com owner/repository only. Keep remote credentials, paths and CLI flags out of settings.
export const repositorySlug = z.string().trim()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/[a-z0-9_.-]{1,100}$/i)
  .refine(value => ![".", ".."].includes(value.split("/")[1]))
  .transform(value => value.toLowerCase());
export const repositoryMode = z.enum(["auto", "manual", "off"]);
export const repositoryOverride = z.discriminatedUnion("mode", [
  z.object({ mode:z.literal("manual"), repo:repositorySlug }), z.object({mode:z.literal("off")}),
]);
// "computing": GitHub has not finished working out mergeability yet. "unknown": the board could not read
// the PR or could not judge what GitHub reported; the item's detail says which.
export const pullReason = z.enum(["ready","draft","conflict","checks-failed","checks-pending","changes-requested","review-required","blocked","computing","unknown","auto-merge"]);
export const commitSha = z.string().regex(/^[a-f0-9]{40}$/);
// Why the board shows a PR as status unknown. The gh-* and lookup values say why GitHub could not be read.
export const pullDetail = z.enum(["gh-missing", "gh-auth", "timeout", "network", "lookup-failed", "closed", "still-computing",
  "check-result", "review-state", "merge-state"]);
export type PullDetail = z.infer<typeof pullDetail>;
// What the coordinator decided about one PR head. GitHub readiness alone is not a merge decision.
export const pullVerdict = z.enum(["ready", "needs-changes", "in-progress", "blocked"]);
export type PullVerdict = z.infer<typeof pullVerdict>;
// Why a GitHub-ready PR is or is not a merge card: github (setting off or no coordinator),
// ledger (a coordinator ledger merge card), judged (ready verdict on this head), awaiting
// (no verdict), stale (verdict on an older head), or the coordinator's other verdicts.
export const pullGate = z.enum(["github", "ledger", "judged", "awaiting", "stale", "needs-changes", "in-progress", "blocked"]);
export type PullGate = z.infer<typeof pullGate>;
const pull = z.object({
  repo:repositorySlug, number:z.number().int().positive(), title:z.string(), url:z.string().url(),
  headRepo:repositorySlug.optional(), headBranch:z.string().optional(), headSha:commitSha.optional(),
  projectIds:z.array(z.string()), lane:z.enum(["review","progress"]), reason:pullReason, detail:pullDetail.optional(), updatedAt:z.string(),
  gate:pullGate.optional(),
  judgment:z.object({ verdict:pullVerdict, reason:z.string(), at:z.string(), ownerSessionId:z.string().optional(), ownerSessionHost:z.string().optional() }).optional(),
});
export const pullRequestViewSchema = z.object({
  items:z.array(pull),
  projects:z.array(z.object({
    projectId:z.string(), repo:repositorySlug.nullable(), mode:repositoryMode,
    status:z.enum(["ok","unmapped","unavailable","off","truncated"]), failure:pullDetail.optional(),
  })),
});
export type PullRequestView = z.infer<typeof pullRequestViewSchema>;
export type PullRequestItem = z.infer<typeof pull>;
export const setProjectRepository = defineRpc({
  name:"board.set-project-repository",
  input:z.strictObject({
    projectId:z.string().min(1).max(4096), mode:repositoryMode, repo:repositorySlug.nullable().optional(),
    expectedMode:repositoryMode, expectedRepo:repositorySlug.nullable(),
  }).refine(input => input.mode === "manual" ? !!input.repo : !input.repo),
  output:z.object({ok:z.literal(true)}),
});

export const mergeMethod = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.infer<typeof mergeMethod>;
const mergeReason = z.enum([...pullReason.options, "merged", "closed", "queue", "permission", "no-method",
  // outdated: the head is the one reviewed, but the base tip or another merge detail changed.
  "changed", "outdated", "expired", "scope", "unavailable", "unconfirmed"]);
export type MergeReason = z.infer<typeof mergeReason>;
const mergeTarget = z.strictObject({
  projectId: z.string().min(1).max(4096), repo: repositorySlug, number: z.number().int().positive().max(2147483647),
});
export type MergeTarget = z.infer<typeof mergeTarget>;
export const mergeNotification = z.object({
  status: z.enum(["sent", "queued", "unavailable", "unconfirmed"]),
  recipientId: z.string().optional(),
});
export type MergeNotification = z.infer<typeof mergeNotification>;
export const pullMergeEvidence = mergeTarget.omit({projectId:true}).extend({
  status: z.enum(["merged", "already-merged"]),
  mergeSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(),
  notification: mergeNotification.optional(),
});
export const pullMergeActivity = z.object({
  projectId: z.string(), title: z.string(), at: z.string().datetime(), pullMerge: pullMergeEvidence,
});
export type PullMergeActivity = z.infer<typeof pullMergeActivity>;
export const pullLifecycle = z.enum(["OPEN", "DRAFT", "CLOSED", "MERGED", "UNKNOWN"]);
export const readPullLifecycle = defineRpc({
  name: "board.read-pull-lifecycle", input: mergeTarget.extend({ reference: z.literal(true).optional() }),
  // why explains UNKNOWN: scope when the project is not managed or not linked to this repository.
  output: z.object({ state: pullLifecycle, why: z.enum([...pullDetail.options, "scope"]).optional() }),
});
export const pullUrl = (repo: string, number: number) => `https://github.com/${repo}/pull/${number}`;
const mergePreview = z.object({
  status: z.enum(["ready", "blocked", "merged"]), reason: mergeReason, title: z.string(),
  headSha: z.string(), headRef: z.string(), baseRef: z.string(), baseSha: z.string(), checks: z.number().int().nonnegative(),
  methods: z.array(mergeMethod), defaultMethod: mergeMethod.nullable(), token: z.string().uuid().nullable(),
});
export type MergePreview = z.infer<typeof mergePreview>;
const mergeResult = z.object({
  status: z.enum(["merged", "already-merged", "changed", "blocked", "unconfirmed"]),
  reason: mergeReason, mergeSha: z.string().nullable(), notification: mergeNotification.optional(),
});
export type MergeResult = z.infer<typeof mergeResult>;
// expectedHeadSha is the head the board showed. A newer head was never judged, so the preview stops.
export const previewPullRequestMerge = defineRpc({
  name: "board.preview-pull-request-merge", input: mergeTarget.extend({ expectedHeadSha: commitSha.optional() }), output: mergePreview,
});
export const mergeJudgmentSettings = defineRpc({
  name: "board.merge-judgment-settings", input: z.strictObject({}), output: z.object({ enabled: z.boolean() }),
});
export const setMergeJudgment = defineRpc({
  name: "board.set-merge-judgment", input: z.strictObject({ enabled: z.boolean() }), output: z.object({ ok: z.literal(true) }),
});
export const confirmPullRequestMerge = defineRpc({
  name: "board.confirm-pull-request-merge",
  input: mergeTarget.extend({ token: z.string().uuid(), method: mergeMethod }), output: mergeResult,
});
