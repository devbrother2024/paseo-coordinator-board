import type { Decision } from "../shared/decision-actions";
import { coordinatorChoiceGaps } from "../shared/choice-gaps";
import {
  cardCompletionRequest, choiceExplanationRequest, deferredNotice, missingChoicesNotice, OTHER_CHOICES, type Bilingual, type ChoiceGaps,
} from "../shared/question-choices";

const tableDivider = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const isTableStart = (line: string, next: string | undefined) => line.includes("|") && next !== undefined && next.includes("|") && tableDivider.test(next);
const isHeading = (line: string) => /^\s{0,3}#{1,6}(\s|$)/.test(line);

/**
 * The first `count` lines of Markdown, cut so no block shows as a broken half: an open code fence is closed,
 * a table keeps its header with its first row (the header and divider count as one line), and a heading at the end
 * keeps the first thing under it.
 */
export function previewMarkdown(markdown: string, count = 4) {
  const lines = markdown.split(/\r?\n/);
  const kept: string[] = [];
  let fence: string | null = null;
  let units = 0;
  let i = 0;
  // Past the limit, a heading at the end gets one extension: up to the first line of content under it.
  let extended = false;
  let extending = false;
  while (i < lines.length) {
    if (units >= count && !extending) {
      const lastShown = kept.findLast(line => line.trim());
      if (extended || fence !== null || lastShown === undefined || !isHeading(lastShown)) break;
      extended = extending = true;
    }
    const line = lines[i];
    if (fence === null && isTableStart(line, lines[i + 1])) {
      kept.push(line, lines[i + 1]);
      i += 2;
      units++;
      if (i < lines.length && lines[i].trim() && lines[i].includes("|")) { kept.push(lines[i]); i++; units++; }
      extending = false;
      continue;
    }
    kept.push(line);
    i++;
    if (line.trim()) units++;
    const opener = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    const opening = !!opener && fence === null;
    if (opener) fence = fence ? null : opener;
    // An opening fence is not content yet: keep going to the block's first line.
    if (line.trim() && !opening) extending = false;
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
 * The draft a button puts into the card's input. A work session is asked to explain its options;
 * a coordinator is asked to complete the card. The person still reads and sends it.
 */
export function choiceRequest(notice: ChoiceNotice | null, toCoordinator: boolean): ChoiceRequest | null {
  if (!notice) return null;
  if (toCoordinator) {
    return { label: ["코디네이터에 카드 보완 요청", "Ask coordinator to complete the card"], text: cardCompletionRequest(notice.labels, notice.deferred) };
  }
  return { label: ["작업 세션에 선택지 설명 요청", "Ask the session to explain the options"], text: choiceExplanationRequest(notice.labels) };
}
