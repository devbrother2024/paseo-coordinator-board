import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { sessionLinkSchema } from "../shared/session-links";
import {clarificationCard, clarificationEntry} from "../shared/clarifications";
import { decisionSchema, decisionFields } from "../shared/decision-actions";
import { dispatchInputSchema, routePolicySchema, workerModeProvider } from "../shared/dispatch";
import { pullMergeActivity, repositoryOverride } from "../shared/prs";
import { replyDetails } from "../shared/reply-history";
import { factSchema } from "../shared/board-facts";
import { assignmentPolicy, hostIdentity } from "../shared/host-assignment";
import { assignmentLocation, assignmentNotice } from "../shared/dispatch-hosts";
import { pullJudgmentSchema } from "../shared/pull-judgments";
import { conversationIdPattern } from "../shared/coordinator-tools";

export const judgment = z.object({
  content: decisionFields.optional(),
  evidenceId: z.string(), kind: z.enum(["question", "review", "idle"]), text: z.string().trim().min(1).max(1200),
});
const coordinatorConfig = z.object({ provider: z.string(), thinkingOptionId: z.string().optional(), modeId: z.string().optional() });
const schema = z.object({
  projects: z.array(z.string()), coordinator: z.string().nullable(),
  workerModeOverrides: z.record(workerModeProvider, z.string().min(1).max(256)).default({}),
  pullMergeHistory: z.record(z.string(), pullMergeActivity.extend({
    notificationCoordinator: z.string().nullable().optional(),
  })).default({}),
  projectRepositories: z.record(z.string(), repositoryOverride).default({}),
  autoPinCoordinatorWorkspace: z.boolean().default(true),
  autoReplyToBoardFacts: z.boolean().default(true),
  // Merge cards need a coordinator verdict on the PR head unless the person turns this off.
  judgedMergeCards: z.boolean().default(true),
  pullJudgments: z.record(z.string(), pullJudgmentSchema).default({}),
  lastDigest: z.object({ at: z.iso.datetime(), coordinator: z.string(), turnId: z.string() }).optional(),
  factHistory: z.record(z.string(), factSchema).default({}),
  workRequestIds: z.record(z.string(), z.string().uuid()).default({}),
  factCycleKeys: z.record(z.string(), z.literal(true)).default({}),
  factCycle: z.object({
    id: z.string(), coordinator: z.string(), expires: z.number(), messageId: z.string().optional(),
    candidates: z.record(z.string(), z.string()),
  }).optional(),
  judgments: z.record(z.string(), judgment.extend({ projectId: z.string(), requestedAt:z.string().optional() })),
  sessionLinks: z.record(z.string(), sessionLinkSchema).default({}),
  routing: routePolicySchema.default({}),
  excludedProviders: z.array(z.string().min(1).max(256)).default([]),
  usageRouting: z.boolean().default(true),
  routingRevision: z.number().int().nonnegative().default(0),
  assignmentHosts: z.record(hostIdentity, assignmentPolicy).default({}),
  assignmentRevision: z.number().int().nonnegative().default(0),
  assignmentNotice: assignmentNotice.optional(),
  dispatchReceipts: z.record(z.string().uuid(), z.object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    projectId: z.string(),
    sourceProjectId: z.string(),
    workspaceId: z.string(),
    location: assignmentLocation,
    remote: z.boolean(),
    delivered: z.boolean().optional(),
    createdAt: z.iso.datetime().optional(),
    requestKey: dispatchInputSchema.shape.requestKey.optional(),
  })).default({}),
  dispatchTombstones: z.record(z.string().uuid(), z.object({
    serverId: hostIdentity,
    // For earlier receipts, the session ID already derives from the request key.
    requestKey: dispatchInputSchema.shape.requestKey.optional(),
    retiredAt: z.iso.datetime(),
  })).default({}),
  answers: z.record(z.string(), z.object({ version: z.string(), noteRevision: z.number().optional() })).default({}),
  clarifications:z.record(z.string(),clarificationEntry.extend({
    card:clarificationCard,fingerprint:z.string(),bodyHash:z.string(),sourceSessionId:z.string().nullable(),
    savedDecision:decisionSchema.optional(),noteRevision:z.number().optional(),sourceEvidenceId:z.string().optional(), sourceRequestedAt:z.string().optional(),
  })).default({}),
  decisionReceipts: z.record(z.string(), z.object({
    activity: replyDetails.optional(), response: z.string().optional(),
    messageHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),
    fingerprint: z.string(), sessionId: z.string(), version: z.string(), status: z.enum(["pending", "sent"]),
    evidenceId: z.string().optional(),
    noteRevision: z.number().optional(), beforeAnswer: z.string().optional(), messageId: z.string().optional(),
  })).default({}),
  pendingCoordinator: z.object({
    id: z.string(), previous: z.string().nullable(),
    config: coordinatorConfig,
    language: z.enum(["ko", "en"]).optional(),
  }).optional(),
  createdCoordinator: z.object({
    id: z.string(), previous: z.string().nullable(), workspaceId: z.string(), config: coordinatorConfig,
    language: z.enum(["ko", "en"]).optional(),
  }).optional(),
  // For each coordinator, the fingerprint of the board tool definitions its current conversation first called.
  // A stamp the board cannot read is dropped rather than stopping the board.
  toolStamps: z.record(z.string(), z.object({ session: z.string().regex(conversationIdPattern), fingerprint: z.string().max(128), at: z.iso.datetime() })).catch({}),
});
export type Preferences = z.infer<typeof schema>;
export type DispatchReceipt = Preferences["dispatchReceipts"][string];

export const maxDispatchReceipts = 256;
export const maxDispatchTombstones = 1024;
const dispatchRetentionMs = 30 * 24 * 60 * 60 * 1000;

export function retireDispatchReceipt(scope: Preferences, id: string, now = Date.now()) {
  const { location, requestKey } = scope.dispatchReceipts[id];
  scope.dispatchTombstones[id] = { serverId: location.serverId, requestKey, retiredAt: new Date(now).toISOString() };
  delete scope.dispatchReceipts[id];
}

export function pruneDispatchTombstones(scope: Preferences, now = Date.now()) {
  const retained: [string, Preferences["dispatchTombstones"][string]][] = [];
  let changed = false;
  for (const [id, record] of Object.entries(scope.dispatchTombstones)) {
    if (Date.parse(record.retiredAt) <= now - dispatchRetentionMs) {
      delete scope.dispatchTombstones[id];
      changed = true;
    } else retained.push([id, record]);
  }
  if (retained.length > maxDispatchTombstones) {
    retained.sort(([, a], [, b]) => a.retiredAt.localeCompare(b.retiredAt));
    for (const [id] of retained.slice(0, retained.length - maxDispatchTombstones)) delete scope.dispatchTombstones[id];
    changed = true;
  }
  return changed;
}

export function pruneDispatchReceipts(scope: Preferences, now = Date.now()) {
  const projects = new Set(scope.projects);
  let changed = false;
  for (const [id, receipt] of Object.entries(scope.dispatchReceipts)) {
    if (!projects.has(receipt.projectId) || (receipt.createdAt && Date.parse(receipt.createdAt) <= now - dispatchRetentionMs)) {
      retireDispatchReceipt(scope, id, now);
      changed = true;
      continue;
    }
    if (!receipt.createdAt) {
      receipt.createdAt = new Date(now).toISOString();
      changed = true;
    }
  }
  return pruneDispatchTombstones(scope, now) || changed;
}

export function isManagedCoordinator(scope: Preferences, id: string | null) {
  return id !== null && scope.createdCoordinator?.id === id;
}

export function setCoordinator(scope: Preferences, id: string | null) {
  if (scope.coordinator !== id) delete scope.factCycle;
  scope.coordinator = id;
  // A person's new selection supersedes any creation still in progress.
  delete scope.pendingCoordinator;
  // Judgments belong to the observed project/session and evidence, not the writer.
}

export class PreferenceStore {
  constructor(private readonly path: string) {}
  get directory() { return dirname(this.path); }
  read(): Preferences {
    try { return schema.parse(JSON.parse(readFileSync(this.path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return schema.parse({ projects: [], coordinator: null, judgments: {} });
      throw error;
    }
  }
  readDispatchScope() {
    const scope = this.read();
    if (pruneDispatchReceipts(scope)) this.change(pruneDispatchReceipts);
    return scope;
  }
  change(edit: (value: Preferences) => void) {
    const value = this.read();
    edit(value);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temp = this.path + "." + randomUUID();
    try {
      writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
      renameSync(temp, this.path);
    } finally { rmSync(temp, { force: true }); }
  }
}
