import type { Decision } from "../shared/decision-actions";
import { coordinatorChoiceGaps } from "../shared/choice-gaps";
import {
  cardCompletionRequest, choiceExplanationRequest, deferredNotice, missingChoicesNotice, OTHER_CHOICES, type Bilingual, type ChoiceGaps,
} from "../shared/question-choices";

/** The first `count` lines of Markdown, with an open code fence closed so the rest of the card renders normally. */
export function previewMarkdown(markdown: string, count = 4) {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    if (kept.filter(Boolean).length >= count) break;
    kept.push(line);
    const opener = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (opener) fence = fence ? null : opener;
  }
  const more = kept.length < lines.length && lines.slice(kept.length).some(line => line.trim());
  return { preview: (fence ? [...kept, fence] : kept).join("\n").trimEnd(), more };
}

const bare = (label: string) => label.replace(/[()]/g, "").toLowerCase();
// "(a), (b)" in label order, with "other options" last.
const byLabel = (a: string, b: string) => a === OTHER_CHOICES ? 1 : b === OTHER_CHOICES ? -1 : bare(a).localeCompare(bare(b));

export type ChoiceNotice = { notice: Bilingual; labels: string[]; deferred: boolean; where: "session" | "card" };

/** What a session decision card should say about options it could not explain. */
export function decisionChoiceNotice(decision: Decision | undefined): ChoiceNotice | null {
  if (!decision) return null;
  if (decision.source === "conversation") {
    if (!decision.missingLabels?.length) return null;
    return { notice: missingChoicesNotice(decision.missingLabels, "session"), deferred: false, where: "session",
      labels: [...(decision.choices ?? []).map(choice => choice.label), ...decision.missingLabels].sort(byLabel) };
  }
  if (decision.source === "coordinator") return cardChoiceNotice(coordinatorChoiceGaps(decision));
  return null;
}

/** What a coordinator or ledger card should say when it names options it does not carry. */
export function cardChoiceNotice(gaps: ChoiceGaps): ChoiceNotice | null {
  if (!gaps.missingLabels.length && !gaps.deferred) return null;
  const parts = [
    ...(gaps.missingLabels.length ? [missingChoicesNotice(gaps.missingLabels, "card")] : []),
    ...(gaps.deferred ? [deferredNotice] : []),
  ];
  return { notice: [parts.map(part => part[0]).join(" "), parts.map(part => part[1]).join(" ")], labels: gaps.missingLabels, deferred: gaps.deferred, where: "card" };
}

export type ChoiceRequest = { label: Bilingual; text: Bilingual };

/**
 * The draft a button puts into an existing question box. A work session is asked to explain its options;
 * a coordinator is asked to complete the card. The person still reads and sends it.
 */
export function choiceRequest(notice: ChoiceNotice | null, toCoordinator: boolean): ChoiceRequest | null {
  if (!notice) return null;
  if (toCoordinator) {
    return { label: ["코디네이터에 카드 보완 요청", "Ask coordinator to complete the card"], text: cardCompletionRequest(notice.labels, notice.deferred) };
  }
  return { label: ["작업 세션에 선택지 설명 요청", "Ask the session to explain the options"], text: choiceExplanationRequest(notice.labels) };
}
