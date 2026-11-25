import { Parser } from "./vendor/marked/marked";
import { lexBoardInline } from "./board-markdown";
import type { Translate } from "./language";
import { sessionDetail, type Card } from "./model";
import { asksForDecision, unquoted } from "../shared/question-request";

// A button can describe a Markdown title without putting links inside its press target.
export function plainDecisionTitle(title: string) {
  const parser = new Parser({ gfm: true });
  const label = title.trim().replace(/^#{1,6}\s+/, "");
  return parser.parseInline(lexBoardInline(label), parser.textRenderer).replace(/\s+/g, " ").trim();
}

// Older coordinator reports combine status, evidence and the question in one text field.
function excerptQuestion(text: string, dedicatedQuestion: boolean) {
  const lines = text
    .replace(/^```[^\n]*\n[\s\S]*?(?:^```[^\n]*$|(?![\s\S]))/gm, "")
    .split(/\r?\n/)
    .filter(line => !/^\s*>/.test(line))
    .map(line => line.trim().replace(/^[-*•]\s+/, ""))
    .filter(Boolean);
  const marker = /(?:^|[\s;·|—])(?:\*\*|__)?(?:결정\s*필요|내\s*결정|정할\s*(?:일|것)|결정\s*요청|질문|decision\s+(?:needed|required)|question)(?:\*\*|__)?\s*[:：](?:\*\*|__)?\s*/i;
  // A question that starts its own structured field can carry a checklist or code after it.
  if (dedicatedQuestion && text.includes("\n") && marker.exec(text.trimStart())?.index === 0) return text.trim();
  for (const [index, line] of lines.entries()) {
    const match = marker.exec(line);
    if (!match) continue;
    const after = line.slice(match.index + match[0].length).trim() || lines[index + 1] || "";
    if (after) return after.split(/(?<=[?？])\s|\s+(?=(?:근거|상태|배경|다음 단계|evidence|status|context)\s*[:：])/i)[0];
  }
  if (dedicatedQuestion) return text.trim();
  // Select an actual question without including a preceding status sentence or changing its words.
  for (const line of lines) {
    const question = line.split(/(?<=[.!。])\s+/).find(sentence => /[?？]/.test(sentence));
    if (question) return question.slice(0, question.search(/[?？]/) + 1);
  }
  return lines[0] || "";
}

// Bold, italic or code that opens in one part and closes in another would break the Markdown.
const balanced = (text: string) => ["**", "__", "`"].every(mark => text.split(mark).length % 2 === 1);

/**
 * A session's question Markdown starts at the line that asks. The title is the sentence in that line that makes the
 * request, with the questions right before it. The sentences before those lead up to it, and everything after it is the body.
 */
export function questionParts(markdown: string) {
  const [first = "", ...rest] = markdown.split("\n");
  const after = rest.join("\n").replace(/^\s*\n/, "").trimEnd();
  const whole = { lead: "", title: first.trim(), body: after };
  // The dot after a list number ("1. ") is not a sentence end. Cutting there leaves the number alone as an empty item and splits the list.
  if (/^\s*(?:[-*+]|\d+[.)])\s/.test(first)) return whole;
  // Sentence ends found outside quotes, so a quoted question never splits the line.
  const cuts = [0, ...[...unquoted(first).matchAll(/[.!?。？！]+["'”’)\]]*\s+/g)].map(match => match.index + match[0].length), first.length];
  const sentences = cuts.slice(1).map((end, index) => first.slice(cuts[index], end)).filter(sentence => sentence.trim());
  const ask = sentences.findIndex(asksForDecision);
  if (sentences.length < 2 || ask < 0) return whole;
  // Questions right before the request sentence ask the same thing ("A or B? Which one should I use?").
  let start = ask;
  while (start > 0 && /[?？]["'”’)\]]*\s*$/.test(unquoted(sentences[start - 1]))) start--;
  const lead = sentences.slice(0, start).join("").trim();
  const title = sentences.slice(start, ask + 1).join("").trim();
  const tail = sentences.slice(ask + 1).join("").trim();
  if (![lead, title, tail].every(balanced)) return whole;
  return { lead, title, body: [tail, after].filter(Boolean).join("\n\n") };
}

/**
 * The question title shows two lines, so "More" must appear whenever that cuts it off: on a narrow screen or with a
 * large font even a short title can. `fullHeight` is the title laid out in full and `shownHeight` the two-line title.
 */
export function questionFolds(input: { bodyFolds: boolean; fullHeight?: number; shownHeight?: number }) {
  const { bodyFolds, fullHeight, shownHeight } = input;
  return bodyFolds || (fullHeight !== undefined && shownHeight !== undefined && fullHeight > shownHeight + 1);
}

export function decisionSummary({ session, note }: Card, t: Translate) {
  const decision = session.decision;
  const question = decision?.question || (note?.kind === "question" && note.text) || session.detail;
  const formal = !!session.nativePending || decision?.source === "permission";
  const raw = question.replace(/^(?:코디네이터 판단|세션의 확인 요청) · /, "");
  const headline = formal ? sessionDetail(question, t)
    : decision?.source === "conversation" ? decision.questionMarkdown ?? raw
    : excerptQuestion(raw, !!decision || note?.kind === "question");
  const normalize = (text: string) => text.replace(/^(?:코디네이터 판단|세션의 확인 요청) · /, "").trim();
  const evidence: string[] = [];
  for (const source of [question, session.detail, note?.kind !== "clear" && note?.text]) {
    const text = source && decision?.questionMarkdown && normalize(source) === normalize(question)
      ? decision.questionMarkdown : source;
    if (text && !evidence.some(prior => normalize(prior) === normalize(text))) evidence.push(text);
  }
  return {
    formal,
    headline: headline || t("원래 세션에서 정할 내용을 확인하세요.", "Open the session to review the decision."),
    evidence,
  };
}
