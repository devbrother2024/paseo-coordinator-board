import type { PaseoAgentTimelineHandle } from "@getpaseo/client";
import { splitQuestionBlock } from "./question-block";
import { asksForDecision, unquoted } from "./question-request";
import { cleanSessionText } from "./review-wait";

const reasons = {
  screen: ["화면 차례", "Screen access"],
  decision: ["판단", "Decision"],
  merge: ["병합", "Merge"],
  report: ["보고에 대한 답", "Reply to report"],
  reply: ["코디네이터 답", "Coordinator reply"],
} as const;
export type CoordinatorWaitReason = keyof typeof reasons;
export type CoordinatorWait = { reason: CoordinatorWaitReason; since?: string };
type Translate = (ko: string, en: string) => string;

export const coordinatorWaitReasons = Object.keys(reasons) as CoordinatorWaitReason[];
const longWait = 30 * 60_000;

export function coordinatorWaitLabel(reason: CoordinatorWaitReason, t: Translate) {
  const [ko, en] = reasons[reason];
  return t("코디네이터 대기", "Waiting on coordinator") + " · " + t(ko, en);
}

export function isLongCoordinatorWait(since: string | undefined, now: number) {
  return now - Date.parse(since ?? "") >= longWait;
}

const koreanTarget = /코디네이터|(?:다른|동료|병렬|작업|설계|담당)\s*세션/iu;
const englishTarget = /\b(?:coordinator|(?:another|other|peer|parallel|worker|design|work) (?:session|agent))\b/i;
const englishDependency = new RegExp(`^(?:(?:a|an|the|my|our)\\s+)?(?:(?:reply|response|approval|decision|feedback|go-ahead)\\s+from\\s+(?:the\\s+)?)?${englishTarget.source}`, "i");
const koreanWaiting = /기다리(?:고|겠|는)|기다립|대기(?!열)|(?:오면|받으면|나오면|주면|되면)\s*(?:다시\s*)?(?:이어|계속|재개|진행|시작)/u;
const koreanReplyWord = /답변?|회신|응답|승인|판단|결정|병합|화면\s*(?:사용\s*)?(?:차례|허락|승인)/u;
const koreanWaitVerb = /기다리(?:고|겠|는)|기다립|대기|오면|받으면|나오면|되면/u;
const koreanDependency = new RegExp(
  `(?:${koreanTarget.source})(?:(?:의|에게서|한테서|로부터)?\\s*(?:${koreanReplyWord.source})(?:을|를|이|가)?|(?:을|를)?)\\s*(?:${koreanWaitVerb.source})|` +
  `(?:${koreanTarget.source})(?:가|이)?\\s+(?:${koreanReplyWord.source})(?:을|를)?\\s*(?:주면|해\\s*주면)|` +
  `(?:${koreanTarget.source})(?:가|이)\\s+[^.!?]*?(?:답|응답|회신|승인|판단|결정|병합)할\\s*때까지\\s*(?:${koreanWaitVerb.source})`,
  "u",
);
const reportClauseEnd = /(?:보고|전달|문의|공유|요청)(?:드렸고|했고|했으며|했습니다|한 뒤)\s*[,，]?\s*|알렸고\s*|[,，]\s*/u;
const koreanImplicitReply = /^(?:(?:라는|는|그|지금은|현재는|아직)\s+)*(?:(?:답변?|회신|응답|승인|판단|화면\s*사용\s*(?:승인|허락))(?:을|를|이|가)?\s*(?:기다리|기다립|대기|오면|받으면)|(?:대기|기다리|기다립))/u;
const englishImplicitReply = /^(?:(?:its|their|a|the)\s+)?(?:reply|response|go-ahead|approval|decision|confirmation)(?:[.!?]|\s*$)/i;
const englishWaiting = /\b(?:wait(?:ing)? (?:for|on|until)|await(?:ing)?|(?:blocked|paused|on hold) (?:on|until|pending)|(?:resume|continue|proceed)\b.*\b(?:once|when|after))\b/i;
const englishWaitingAlone = /^(?:(?:I'm|I am|We're|We are|still|now)\s+)*waiting[.!?]?$/i;
const humanTarget = /사용자|유지\s*관리자|사람|[\p{L}\p{N}]+님|\b(?:users?|humans?|maintainers?|you|your)\b/iu;
const reply = /\b(?:its|their|a|the)\s+(?:reply|response|go-ahead|approval|decision|confirmation)\b|(?:답변?|회신|응답|승인|판단)(?:을|를|이|가)?\s*(?:기다리|기다립|대기|오면|받으면)/iu;
const report = /보고|\b(?:report|reported|update|briefed)\b/iu;
const screen = /화면\s*(?:차례|사용|공유|확인|검증)|\bscreen\s+(?:access|time|turn|slot|permission|clearance)\b/iu;
const koreanScreenTurn = /^(?:(?:저는|현재|지금|아직|이제)\s+)*화면\s*차례(?:를|가)?\s*(?:기다리|기다립|대기|오면)/u;
const englishScreenTurn = /^(?:(?:a|the|my|our)\s+)?(?:screen\s+(?:turn|slot)|visual (?:check|QA) slot)\b/i;
const decision = /판단|결정|승인|\b(?:decision|approval|review|verdict)\b/iu;
const merge = /병합|\bmerg(?:e[sd]?|ing)\b/iu;
const resolved = /기다리지\s*(?:않|말)|대기(?:하지\s*않|가?\s*끝)|(?:답변?|회신|승인|화면\s*차례)(?:을|를)?\s*받았|\b(?:not|never|no longer|was|were)\s+waiting\b|\b(?:already|has|have|just)\s+(?:replied|responded|approved|merged)\b/i;

// Keep decisions in prose. Markdown examples can contain sentences that
// look like either a request to the user or a wait.
function prose(text: string) {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of cleanSessionText(text).split("\n")) {
    if (line.trimStart().startsWith(">")) continue;
    if (fence) {
      const trimmed = line.trim();
      if (trimmed.startsWith(fence) && !trimmed.replaceAll(fence[0], "")) fence = undefined;
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (opening) {
      fence = opening;
      continue;
    }
    if (/^(?: {4}|\t)/.test(line)) continue;
    lines.push(line.replace(/(`+)[^`]*\1/g, ""));
  }
  return lines;
}

export function detectCoordinatorWait(text: string): CoordinatorWaitReason | undefined {
  const lines = prose(text);
  if (lines.some(asksForDecision)) return undefined;

  const sentences = lines.flatMap(line => unquoted(line).replace(/[*_]/g, " ")
    .split(/(?<=[.!?。！？])\s+/u)).map(sentence => sentence.trim()).filter(Boolean);
  const namesCoordinator = (sentence: string) => koreanTarget.test(sentence) || englishTarget.test(sentence);
  let reason: CoordinatorWaitReason | undefined;
  for (const [index, sentence] of sentences.entries()) {
    const koWaiting = koreanWaiting.test(sentence);
    const enWaiting = englishWaiting.exec(sentence);
    const enTarget = enWaiting ? sentence.slice(enWaiting.index + enWaiting[0].length).trim() : "";
    const koClause = sentence.split(reportClauseEnd).at(-1)?.trim() ?? "";
    if (resolved.test(sentence)) {
      if (namesCoordinator(sentence) || reply.test(sentence) || screen.test(sentence)) reason = undefined;
      continue;
    }
    if ((koWaiting && humanTarget.test(koClause)) || (enWaiting && humanTarget.test(enTarget))) return undefined;
    if (englishScreenTurn.test(enTarget)) {
      reason = "screen";
      continue;
    }
    const adjacent = [sentences[index - 1], sentences[index + 1]]
      .find(candidate => candidate && namesCoordinator(candidate) && !resolved.test(candidate));
    const tiedToCoordinator = namesCoordinator(sentence) ? sentence : adjacent;
    const indirect = tiedToCoordinator && ((koWaiting && koreanImplicitReply.test(koClause)) ||
      englishImplicitReply.test(enTarget) || englishWaitingAlone.test(sentence));
    if (!(indirect || englishDependency.test(enTarget) || (koWaiting && (
      koreanDependency.test(sentence) || koreanScreenTurn.test(sentence.replace(/^(?:[-+•]\s+)/, ""))
    )))) continue;
    const context = [sentence, indirect && tiedToCoordinator].filter(Boolean).join(" ");
    reason = screen.test(context) ? "screen" : merge.test(context) ? "merge" : decision.test(context) ? "decision"
      : report.test(context) ? "report" : "reply";
  }
  return reason;
}

type TimelineEntry = Awaited<ReturnType<PaseoAgentTimelineHandle["refetch"]>>["entries"][number];

export function coordinatorWaitInTimeline(entries: readonly TimelineEntry[]): CoordinatorWait | undefined {
  const latest = entries.findLast(({ item }) =>
    item.type === "user_message" ||
    (item.type === "assistant_message" && item.text.trim()) ||
    (item.type === "tool_call" && (item.agentMessage || item.name === "heartbeat")));
  if (latest?.item.type !== "assistant_message") return;
  const reason = detectCoordinatorWait(latest.item.text);
  if (reason && !splitQuestionBlock(latest.item.text).block) return { reason, since: latest.timestamp };
}
