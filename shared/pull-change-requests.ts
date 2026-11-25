import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { SessionRow } from "./contract";
import { commitSha, repositorySlug, type PullRequestItem } from "./prs";
import { WORK_IMAGE_MIME_TYPES, workImages } from "./work-images";
import { parallelState } from "./busy-delivery";

// A change request is what the person wrote on a merge card instead of merging. It is sent to the PR's work session
// or the coordinator, and it takes the merge card down for the head commit it was written about.
export const MAX_PULL_CHANGE_REQUESTS = 200;
export const MAX_CHANGE_REQUEST_TEXT = 4000;
const id = z.string().min(1).max(256);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const pullChangeRequestSchema = z.object({
  repo: repositorySlug, number: z.number().int().positive(), projectId: z.string().min(1).max(4096), headSha: commitSha,
  title: z.string().max(512), text: z.string().max(MAX_CHANGE_REQUEST_TEXT),
  recipientId: id, coordinator: z.boolean(), messageId: z.string().uuid(), messageHash: sha256, fingerprint: sha256,
  // The key the screen sent this request under. The same key again is a retry of this request, whatever its message ID.
  requestKey: z.string().max(96).optional(),
  // queued: the recipient is in a turn that cannot take input, so the request waits for it to rest.
  at: z.iso.datetime(), status: z.enum(["pending", "sent", "queued"]),
  queue: z.object({
    stopped: z.boolean(), parallel: parallelState.optional(),
    photos: z.array(z.object({ mimeType: z.enum(WORK_IMAGE_MIME_TYPES), digest: sha256 })),
  }).optional(),
  imageCount: z.number().int().positive().optional(),
  // The person reopened the merge card. Nothing was sent for it.
  withdrawnAt: z.iso.datetime().optional(),
});
export type PullChangeRequest = z.output<typeof pullChangeRequestSchema>;

const target = { projectId: z.string().min(1).max(4096), repo: repositorySlug, number: z.number().int().positive().max(2147483647), headSha: commitSha };
export const requestPullChanges = defineRpc({
  name: "board.request-pull-changes",
  input: z.strictObject({
    ...target, recipientId: id, text: z.string().max(MAX_CHANGE_REQUEST_TEXT), images: workImages.optional(),
    requestKey: z.string().min(12).max(96).regex(/^[A-Za-z0-9_-]+$/),
  }).refine(input => !!input.text.trim() || !!input.images?.length, "Provide text or a photo."),
  // changed: the PR, its head or the recipient is no longer what the card showed. busy: the recipient waits on a
  // permission request or is in an error state. queued: the recipient is in a turn that cannot take input, so the
  // request is kept and sent when it rests. unconfirmed: the board could not tell whether an earlier attempt arrived.
  output: z.object({ status: z.enum(["sent", "changed", "busy", "queued", "unconfirmed"]), recipientId: id.optional() }),
});
export type PullChangeInput = z.output<typeof requestPullChanges.input>;
export type PullChangeResult = z.output<typeof requestPullChanges.output>;

export const withdrawPullChangeRequest = defineRpc({
  name: "board.withdraw-pull-change-request",
  input: z.strictObject(target),
  output: z.object({ ok: z.boolean() }),
});

type Owner = Pick<SessionRow, "id" | "projectId" | "status"> & Partial<Pick<SessionRow, "serverId" | "nativePending">>;

// Who takes a merge card's change request: the work session the coordinator named for the PR, while it is a session on
// this host in the PR's project that has not ended, failed or stopped on a permission request. Otherwise the coordinator.
export function changeRequestRecipient(pr: Pick<PullRequestItem, "judgment" | "projectIds">, sessions: readonly Owner[], coordinator: string | null) {
  const owner = pr.judgment?.ownerSessionHost ? undefined : pr.judgment?.ownerSessionId;
  const row = owner && owner !== coordinator ? sessions.find(session => session.id === owner && !session.serverId && pr.projectIds.includes(session.projectId)) : undefined;
  if (row && row.status !== "closed" && row.status !== "error" && !row.nativePending) return { id: row.id, coordinator: false };
  return coordinator ? { id: coordinator, coordinator: true } : null;
}

// Whether a recorded request still keeps the merge card down and the board from merging: it was not withdrawn and it
// was written about this head. A request whose delivery is still unknown may have arrived, so it holds too. Only a new
// head or the person reopening the card lifts it. A verdict on the same head does not, whenever it was written: a
// coordinator checking PRs on its rounds may not know the person asked for changes.
export function holdsMergeCard(request: Pick<PullChangeRequest, "headSha" | "withdrawnAt"> | undefined, headSha: string | undefined) {
  return !!request && !request.withdrawnAt && !!headSha && request.headSha === headSha;
}

// Keep the newest requests when the store grows past its limit.
export function prunePullChangeRequests<T extends { at: string }>(requests: Record<string, T>, limit = MAX_PULL_CHANGE_REQUESTS) {
  const entries = Object.entries(requests);
  if (entries.length <= limit) return requests;
  entries.sort((a, b) => b[1].at.localeCompare(a[1].at));
  return Object.fromEntries(entries.slice(0, limit));
}

// Whether a PR card takes a change request now: it is a merge card (GitHub ready, in the merge lane), the board knows
// its head commit, and no security gate holds the merge.
export const takesChangeRequest = (pr: Pick<PullRequestItem, "lane" | "reason" | "headSha">, securityGate = false) =>
  !securityGate && pr.lane === "review" && pr.reason === "ready" && !!pr.headSha;

export const changeRequestWords = {
  changed: ["PR이나 받는 곳이 바뀌었습니다. 새로 고친 카드에서 다시 보내 주세요.", "The PR or its recipient changed. Send again from the refreshed card."],
  busy: ["받는 세션이 권한 확인을 기다리거나 오류 상태입니다. 풀린 뒤 다시 보내 주세요.", "The recipient is waiting on a permission request or is in an error state. Send again once that clears."],
  unconfirmed: ["전송을 확인하지 못했습니다. 받은 세션에서 확인되면 보낸 것으로 바뀝니다. 다시 보내려면 PR 줄의 병합 카드 다시 열기를 누르세요.", "Delivery is unconfirmed. It turns to sent once the board finds it in the recipient's conversation. To send again, press Reopen merge card on the pull request row."],
} as const satisfies Record<Exclude<PullChangeResult["status"], "sent" | "queued">, readonly [string, string]>;
