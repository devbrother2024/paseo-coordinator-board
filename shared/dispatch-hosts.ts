import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { assignmentFailure, assignmentPolicy, assignmentReason, hostIdentity, hostPlatform, pairedProjectId, taskPlatform } from "./host-assignment";

export const assignmentLocation = z.object({
  serverId: hostIdentity,
  label: z.string(),
  reason: assignmentReason,
  running: z.number().int().nonnegative().nullable(),
});

export const assignmentNotice = z.object({
  projectId: pairedProjectId,
  failure: assignmentFailure,
  platform: taskPlatform,
  host: z.string().optional(),
});

const projectChoice = z.object({ id: pairedProjectId, name: z.string() });
export const dispatchHosts = defineRpc({
  name: "board.dispatch-hosts",
  input: z.strictObject({ settings: z.boolean().optional() }),
  output: z.object({
    hosts: z.array(z.object({
      id: hostIdentity, label: z.string(), local: z.boolean(), online: z.boolean(), resolved: z.boolean(), settings: assignmentPolicy,
      detected: hostPlatform.nullable(), projects: z.array(projectChoice),
    })),
    projects: z.array(projectChoice),
    revision: z.number().int().nonnegative(),
  }),
});

export const saveDispatchHost = defineRpc({
  name: "board.save-dispatch-host",
  input: z.strictObject({
    serverId: hostIdentity,
    expectedRevision: z.number().int().nonnegative(),
    settings: assignmentPolicy,
  }),
  output: z.object({ ok: z.literal(true) }),
});

export type DispatchHosts = z.output<typeof dispatchHosts.output>;
export type AssignmentLocation = z.output<typeof assignmentLocation>;
