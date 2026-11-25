import { contextBefore } from "../shared/question-choices";
import { blockQuestionLabel, type QuestionBlock } from "../shared/question-block";
import { asksForDecision } from "../shared/question-request";

// What turnQuestion reads from a turn: its shown text and the question block it ended with.
type Asking = { text: string; block?: QuestionBlock };

export function questionIn(text: string, coordinatorDigest = false) {
  const original = text.split("\n");
  // Keep the source line indexes when ignoring code examples during question detection.
  const lines = text.replace(/^`{3}[\s\S]*?^`{3}[^\n]*/gm, block => block.replace(/[^\n]/g, ""))
    .split("\n").map(line => line.trim());
  // A coordinator's digest quotes questions belonging to other sessions in typed table rows.
  const quotedRow = (line: string) => coordinatorDigest && /^\|[^|]+\|\s*(?:question|질문)\s*(?:\+[^|]*)?\|/i.test(line);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (quotedRow(lines[i]) || lines[i].startsWith(">") || !asksForDecision(lines[i])) continue;
    // A request inside a list belongs to the line right above that opens the list ("결정할 것: …" and its answer options), so the card starts there. A list with no request line above it keeps its own start.
    const listItem = /^(?:[-*+]|\d+[.)])\s/;
    let start = i;
    while (listItem.test(lines[start]) && start > 0 && lines[start - 1] && !lines[start - 1].startsWith(">") && !quotedRow(lines[start - 1])) {
      start--;
      if (!listItem.test(lines[start])) { if (asksForDecision(lines[start])) i = start; break; }
    }
    // Include the checklist or options after a request heading.
    const included = (line: string) => !line.startsWith(">") && !quotedRow(line);
    return {
      // Existing replies and ledger matches identify this question by its compact text.
      question: lines.slice(i).filter(line => line && included(line)).join(" ").slice(0, 340),
      markdown: original.slice(i).filter((_, index) => included(lines[i + index])).join("\n").trimEnd(),
      // The explanation the session wrote before asking, for display only.
      context: contextBefore(original.slice(0, i).filter((_, index) => included(lines[index]))),
    };
  }
  return null;
}

// The question a turn asks. A turn that ends in a question block asks even when no sentence does: its first question
// is the title, and the text before the block is the context.
export function turnQuestion(turn: Asking, coordinatorDigest = false) {
  const found = questionIn(turn.text, coordinatorDigest);
  if (found || !turn.block) return found;
  const first = turn.block.questions[0];
  const label = blockQuestionLabel(first);
  return { question: label.slice(0, 340), markdown: label, context: turn.text === first.text ? "" : contextBefore(turn.text.split("\n")) };
}

