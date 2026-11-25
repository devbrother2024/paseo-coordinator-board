import { canReceiveBoardInput } from "./discovery";
import type { PluginHandlerContext, PluginHookEvents } from "@getpaseo/plugin/server";
import { createHash } from "node:crypto";
import { photoDigest } from "./reply-photos";
import { PreferenceStore } from "./preferences";
import type { WorkImage } from "../shared/operations";
import { boardActionName } from "../shared/coordinator-contract";

const prompts = {
  ko: "관리 프로젝트의 다이제스트를 한국어로 갱신하세요. review_board_records로 완료된 단독 병합 기록을 정리하세요. 다른 확인 기록은 원 세션에서 완료 근거가 확인된 경우에만 이 도구로 닫으세요. read_board_conversation에서 최근 근거를 확인하고 classify_board_conversation으로 기록하세요. 목록에서 needsCoordinator가 붙은 확인 대기 세션을 먼저 읽고, 사람이 정할 일이면 question, 아니면 review나 idle로 분류하세요. 각 질문에는 당사자가 정할 한 문장을 content.question에 적으세요. 근거·기존 기준에서 제안할 수 있는 가장 타당한 답장 하나를 content.recommendation에, 간단한 이유를 content.recommendationReason에 적으세요. 증거에 실제 답장 문장이 없어도 근거 있는 제안은 작성할 수 있습니다. 판단에 필요한 정보가 부족하면 결정을 지어내지 말고 필요한 정보를 content.needsInput에 적으세요. 작업 세션이 'B로 진행할까요?'처럼 이름표만 묻고 멈췄으면 모든 선택지를 content.options(원장은 questions[].options의 does·pros·cons)로 옮기세요. 세션 기록에 다른 선택지 설명이 없으면 작업 세션에 먼저 정리를 요청하고, '자세한 건 세션 화면에'라고 쓰지 마세요. 예전에 판단한 질문도 needsRecommendation이 표시되면 갱신하세요. judge_board_pull을 입력 없이 불러 열린 PR 목록을 보고, PR마다 머리 커밋 기준으로 작업 완료, 리뷰 반영, 검사 통과를 확인해 verdict(ready, needs-changes, in-progress, blocked)와 한 줄 이유를 기록하세요. 새 커밋이 올라온 PR은 다시 판단하세요. 진행 보고와 이미 정해진 사항은 내 결정에서 내리고, 직접 결정할 안건을 먼저 보고하세요.",
  en: "Refresh the digest for managed projects in English. Use review_board_records for verified standalone merges and coordinator checks with completion evidence from the originating session. Inspect recent evidence with read_board_conversation and use classify_board_conversation to record your findings. Read Awaiting review sessions marked needsCoordinator in the list first, and classify each as question when a person must decide, otherwise as review or idle. For every genuine human decision, write one short question in content.question. When evidence or an established preference supports it, propose one editable, ready-to-send reply in content.recommendation and give a brief reason in content.recommendationReason. The proposed wording may be new. If essential input is missing, name it in content.needsInput without inventing the person's choice. When a work session stops on a bare label such as 'Shall I go with B?', put every option on the card in content.options (questions[].options with does, pros and cons in a ledger). If the session history does not explain the other options, ask the work session to summarize them first, and never write 'see the session for details'. Revisit earlier decisions marked needsRecommendation. Call judge_board_pull without input to list open PRs. For each one, check on its head commit that the work is finished, review comments are addressed and checks pass, then record a verdict (ready, needs-changes, in-progress or blocked) with a one-line reason. Judge again when a PR has new commits. Keep progress reports and resolved matters out of My decisions, and report the remaining decisions first.",
};

export const digestPrompt = prompts.ko + " 이번 요청은 조회와 분류만 맡깁니다.";
export const englishDigestPrompt = prompts.en + " Limit this request to reading and classification.";

export function digestWithFactReplies(language: "ko" | "en", cycleId: string) {
  const instructions = language === "ko"
    ? "이번 다이제스트에서 보드가 단독 사실 질문으로 식별한 세션에는 answer_board_fact로 답하세요. 이 도구가 허용한 대상·근거에 대해서만 코디네이터 이름으로 확인된 사실을 보낼 수 있습니다. 다른 방식의 메시지 전송은 요청하지 않았습니다. 처리 결과와 사람이 결정할 안건을 구분하세요."
    : "For this digest, call answer_board_fact for standalone factual questions identified by the board. Only that tool may send its verified facts as the coordinator. Do not send a message by any other route. Report handled items separately from human decisions.";
  return prompts[language] + " " + instructions + " " + JSON.stringify({ cycleId });
}

export async function sendCoordinatorRequest(
  paseo: PluginHandlerContext["paseo"],
  store: PreferenceStore,
  expected: string,
  key: string,
  text: string,
  options: {
    images?: WorkImage[];
    reserveMessage?: (originalId: string) => string;
    allowActiveCoordinator?: boolean;
    beforeSend?: (messageId: string) => void;
  } = {},
) {
  if (store.read().coordinator !== expected) throw new Error("현재 코디네이터를 다시 확인해 주세요.");
  if (!store.read().projects.length) throw new Error("관리할 프로젝트를 하나 이상 선택하세요.");
  const handle = paseo.agents.ref(expected);
  const snapshot = (await handle.refresh())?.agent;
  if (
    !snapshot ||
    snapshot.archivedAt ||
    snapshot.internal ||
    !canReceiveBoardInput(snapshot,options.allowActiveCoordinator===true)
  ) {
    throw new Error("코디네이터가 대기 상태일 때 요청할 수 있습니다. 세션에서 현재 작업을 확인하세요.");
  }
  if (store.read().coordinator !== expected) throw new Error("코디네이터가 교체되었습니다. 새로 고쳐 주세요.");
  if (!store.read().projects.length) throw new Error("관리 프로젝트가 변경되었습니다.");
  const images = options.images;
  const content = images?.length ? [expected, key, text, images.map(photoDigest)] : [expected, key, text];
  const id = createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
  const originalId = [
    id.slice(0, 8),
    id.slice(8, 12),
    "4" + id.slice(13, 16),
    "8" + id.slice(17, 20),
    id.slice(20, 32),
  ].join("-");
  const messageId = options.reserveMessage?.(originalId) ?? originalId;
  options.beforeSend?.(messageId);
  await handle.send(text, { messageId, activeTurnBehavior: "steer", ...(images?.length ? {images} : {}) });
  return { ok: true };
}

type TimelineItem = Awaited<ReturnType<ReturnType<PluginHandlerContext["paseo"]["agents"]["ref"]>["timeline"]["refetch"]>>["entries"][number]["item"];

const reportsError = (output: unknown) => !!output && typeof output === "object" &&
  ((output as { isError?: unknown }).isError === true || (output as { is_error?: unknown }).is_error === true);

// The board tools a completed tool call ran. A tool run through board_action counts as that tool too.
// A call the board refused ran nothing: Paseo's Claude provider reports a tool error as a failed call,
// and for a provider that reports it as completed the error flag in its output is checked as well.
export function completedBoardTools(item: TimelineItem): string[] {
  if (item.type !== "tool_call" || item.status !== "completed") return [];
  const name = item.name.split("__").at(-1) ?? item.name;
  const detail: { input?: unknown; output?: unknown } | null = item.detail && typeof item.detail === "object" ? item.detail as { input?: unknown; output?: unknown } : null;
  if (reportsError(detail?.output)) return [];
  const input = name === boardActionName ? detail?.input : undefined;
  const action = input && typeof input === "object" ? (input as { action?: unknown }).action : undefined;
  return typeof action === "string" ? [name, action] : [name];
}

export async function recordDigestCompletion(
  store: PreferenceStore,
  paseo: PluginHandlerContext["paseo"],
  { agent, turnId, outcome }: PluginHookEvents["agent.turn.after"],
  at = new Date().toISOString(),
) {
  if (!turnId || outcome?.kind !== "completed" || store.read().coordinator !== agent.id) return;
  const page = await paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", projection: "projected", limit: 1, wholeTurns: true });
  if (page.error || page.gap || page.staleCursor) return;
  const tools = new Set<string>();
  let requested = false;
  for (const entry of page.entries) {
    if (entry.turnId !== turnId) continue;
    const item = entry.item;
    const text = item.type === "user_message" ? item.text : item.type === "tool_call" && item.agentMessage?.event === "message" ? item.agentMessage.text : "";
    const cycle = /"cycleId":"([a-f0-9]{64})"\}$/.exec(text)?.[1];
    requested ||= text === digestPrompt || text === englishDigestPrompt ||
      !!cycle && (text === digestWithFactReplies("ko", cycle) || text === digestWithFactReplies("en", cycle));
    for (const name of completedBoardTools(item)) tools.add(name);
  }
  // Scheduled reviews can use their own prompt. Require both board review steps in that turn.
  if (!requested && !(tools.has("read_board_conversation") && tools.has("review_board_records"))) return;
  const scope = store.read();
  const previous = scope.lastDigest;
  if (scope.coordinator !== agent.id ||
    (previous && (at <= previous.at || (previous.coordinator === agent.id && previous.turnId === turnId)))) return;
  store.change(current => { current.lastDigest = { coordinator: agent.id, turnId, at }; });
}
